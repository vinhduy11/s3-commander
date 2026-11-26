//! The background job runner: a transfer (what F5, F6 and drag and drop start) becomes a job that
//! waits in a queue, runs on a tokio task (at most `MAX_RUNNING_JOBS` at once; the items of one job
//! run one after another, the parts inside an item are already parallel) and reports through an
//! `EventSink`. No Tauri dependency; `lib.rs` plugs in the Tauri events.
//!
//! Retry: a multipart upload that failed is KEPT (the engine does not abort it); its id is held in
//! the job's memory and Retry resumes it through ListParts. Cancel, Dismiss and Lock abort it. The
//! id lives only in memory: an app crash or quit leaves the incomplete upload on the server.
//!
//! Nothing secret goes into an event: titles, item names, counts and readable error messages only.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use aws_sdk_s3::Client;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::app_error::AppError;
use crate::multipart_upload::abort_upload;
use crate::s3_ops;
use crate::transfer_control::{CancelToken, ProgressSink, RetryPolicy, TransferEnv};
use crate::transfer_job::{job_title, ItemState, JobModel, JobSnapshot, JobState, ProgressEvent};
use crate::transfer_plan::{ItemRef, Mode, PlanItem, Resolutions, TransferRequest};
use crate::transfer_run::{copy_item, prepare_plan, remove_emptied_local_dirs, CopyFailure, Removal};
use crate::transfer_settings::EffectiveTransferSettings;

/// Jobs that run at the same time; the rest wait in start order.
pub const MAX_RUNNING_JOBS: usize = 3;
/// `transfer://progress` is sent at most once per interval per job (10 per second).
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Where job events go. Implementations must be cheap and non-blocking.
pub trait EventSink: Send + Sync {
    /// The job changed state (or got a failure, or finished).
    fn state(&self, snapshot: &JobSnapshot);
    /// Throttled progress of the running item.
    fn progress(&self, event: &ProgressEvent);
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Everything one item run needs.
pub struct ItemCall<'a> {
    pub client: Option<&'a Client>,
    pub item: &'a PlanItem,
    pub mode: Mode,
    pub env: &'a TransferEnv,
    pub resume_upload_id: Option<&'a str>,
}

/// Runs one planned item. The queue owns scheduling and state; this is the only part that touches
/// files and the server, so tests can script it.
pub trait ItemRunner: Send + Sync {
    fn run<'a>(&'a self, call: ItemCall<'a>) -> BoxFuture<'a, Result<Removal, CopyFailure>>;
}

/// The real thing: the 4a engine through `transfer_run::copy_item`.
pub struct EngineRunner;

impl ItemRunner for EngineRunner {
    fn run<'a>(&'a self, call: ItemCall<'a>) -> BoxFuture<'a, Result<Removal, CopyFailure>> {
        Box::pin(copy_item(call.client, call.item, call.mode, call.env, call.resume_upload_id))
    }
}

/// Lets one progress event through per interval.
pub struct ProgressThrottle {
    interval: Duration,
    last: Option<Instant>,
}

impl ProgressThrottle {
    pub fn new(interval: Duration) -> Self {
        Self { interval, last: None }
    }

    pub fn allow(&mut self, now: Instant) -> bool {
        match self.last {
            Some(last) if now.saturating_duration_since(last) < self.interval => false,
            _ => {
                self.last = Some(now);
                true
            }
        }
    }

    pub fn reset(&mut self) {
        self.last = None;
    }
}

/// What a job needs to run; the client and settings are those of the profile when it was started.
pub struct JobSpec {
    pub request: TransferRequest,
    pub resolutions: Resolutions,
    pub client: Option<Client>,
    pub settings: EffectiveTransferSettings,
}

/// A multipart upload that failed and waits for Retry (or an abort).
struct KeptUpload {
    upload_id: String,
    bucket: String,
    key: String,
}

struct Job {
    spec: Arc<JobSpec>,
    model: JobModel,
    plan: Option<Arc<Vec<PlanItem>>>,
    cancel: CancelToken,
    kept: HashMap<usize, KeptUpload>,
    /// Server sources of finished items of a move, deleted in one batch per bucket at the end of a run.
    removals: HashMap<String, Vec<String>>,
    throttle: ProgressThrottle,
    task: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct Table {
    jobs: HashMap<String, Job>,
    /// Start order of the jobs still in the table.
    order: Vec<String>,
}

struct Shared {
    events: Arc<dyn EventSink>,
    runner: Arc<dyn ItemRunner>,
    table: Mutex<Table>,
    max_running: usize,
    retry: RetryPolicy,
    next_id: AtomicU64,
    changed: Notify,
}

/// Cheap to clone; every clone is the same queue.
#[derive(Clone)]
pub struct TransferQueue(Arc<Shared>);

/// Progress of the item that is running, fed by the engine.
struct ItemSink {
    queue: TransferQueue,
    job_id: String,
    upload_id: Arc<Mutex<Option<String>>>,
}

impl ProgressSink for ItemSink {
    fn upload_created(&self, upload_id: &str) {
        *self.upload_id.lock().unwrap_or_else(PoisonError::into_inner) = Some(upload_id.to_string());
    }

    fn bytes_done(&self, done: u64) {
        let event = self.queue.with_job(&self.job_id, |job| {
            job.model.progress(done);
            if job.throttle.allow(Instant::now()) { job.model.progress_event() } else { None }
        });
        if let Some(event) = event.flatten() {
            self.queue.0.events.progress(&event);
        }
    }
}

fn not_found(job_id: &str) -> AppError {
    AppError::Invalid(format!("no such transfer: {job_id}"))
}

impl TransferQueue {
    pub fn new(events: Arc<dyn EventSink>, runner: Arc<dyn ItemRunner>, max_running: usize, retry: RetryPolicy) -> Self {
        Self(Arc::new(Shared { events, runner, table: Mutex::default(), max_running, retry, next_id: AtomicU64::new(0), changed: Notify::new() }))
    }

    /// The production queue: the real engine, three jobs at a time.
    pub fn with_engine(events: Arc<dyn EventSink>) -> Self {
        Self::new(events, Arc::new(EngineRunner), MAX_RUNNING_JOBS, RetryPolicy::default())
    }

    fn table(&self) -> MutexGuard<'_, Table> {
        self.0.table.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Run `change` on one job under the lock; `None` when the job is gone.
    fn with_job<R>(&self, job_id: &str, change: impl FnOnce(&mut Job) -> R) -> Option<R> {
        self.table().jobs.get_mut(job_id).map(change)
    }

    /// Like `with_job`, then tell the UI the new state.
    fn change_state<R>(&self, job_id: &str, change: impl FnOnce(&mut Job) -> R) -> Option<R> {
        let (outcome, snapshot) = {
            let mut table = self.table();
            let job = table.jobs.get_mut(job_id)?;
            let outcome = change(job);
            (outcome, job.model.snapshot())
        };
        self.publish(&[snapshot]);
        Some(outcome)
    }

    fn publish(&self, snapshots: &[JobSnapshot]) {
        for snapshot in snapshots {
            self.0.events.state(snapshot);
        }
        self.0.changed.notify_waiters();
    }

    pub fn snapshot(&self, job_id: &str) -> Option<JobSnapshot> {
        self.table().jobs.get(job_id).map(|job| job.model.snapshot())
    }

    /// Every job in start order (the UI asks once when it attaches).
    pub fn snapshots(&self) -> Vec<JobSnapshot> {
        let table = self.table();
        table.order.iter().filter_map(|id| table.jobs.get(id)).map(|job| job.model.snapshot()).collect()
    }

    /// Completes when the job is done, failed or cancelled (or is gone).
    pub async fn wait_settled(&self, job_id: &str) {
        loop {
            let notified = self.0.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.snapshot(job_id).is_none_or(|snapshot| snapshot.state.is_finished()) {
                return;
            }
            notified.await;
        }
    }

    /// Queue a job and return its id at once.
    pub fn start(&self, spec: JobSpec) -> String {
        let id = format!("job-{}", self.0.next_id.fetch_add(1, Ordering::SeqCst) + 1);
        let model = JobModel::new(id.clone(), job_title(&spec.request));
        let snapshot = model.snapshot();
        let job = Job {
            spec: Arc::new(spec),
            model,
            plan: None,
            cancel: CancelToken::default(),
            kept: HashMap::new(),
            removals: HashMap::new(),
            throttle: ProgressThrottle::new(PROGRESS_INTERVAL),
            task: None,
        };
        {
            let mut table = self.table();
            table.jobs.insert(id.clone(), job);
            table.order.push(id.clone());
        }
        self.publish(&[snapshot]);
        self.schedule();
        id
    }

    /// Start queued jobs while there is a free slot.
    fn schedule(&self) {
        let mut started = Vec::new();
        {
            let mut table = self.table();
            loop {
                let running = table.jobs.values().filter(|job| job.model.is_running_work()).count();
                if running >= self.0.max_running {
                    break;
                }
                let next = table.order.iter().find(|id| table.jobs.get(*id).is_some_and(|job| job.model.state() == JobState::Queued)).cloned();
                let Some(job_id) = next else { break };
                let Some(job) = table.jobs.get_mut(&job_id) else { break };
                if job.model.start().is_err() {
                    break;
                }
                job.cancel = CancelToken::default();
                started.push(job.model.snapshot());
                let queue = self.clone();
                job.task = Some(tokio::spawn(async move { queue.run_job(job_id).await }));
            }
        }
        if !started.is_empty() {
            self.publish(&started);
        }
    }

    pub async fn cancel(&self, job_id: &str) -> Result<(), AppError> {
        let (kept, snapshot) = {
            let mut table = self.table();
            let job = table.jobs.get_mut(job_id).ok_or_else(|| not_found(job_id))?;
            let kept = match job.model.request_cancel().map_err(|err| AppError::Invalid(err.to_string()))? {
                JobState::Cancelled => std::mem::take(&mut job.kept),
                _ => {
                    job.cancel.cancel();
                    HashMap::new()
                }
            };
            (kept, job.model.snapshot())
        };
        self.publish(&[snapshot]);
        if !kept.is_empty() {
            let client = self.with_job(job_id, |job| job.spec.client.clone()).flatten();
            let failures = abort_kept(client.as_ref(), kept).await;
            self.change_state(job_id, |job| {
                for (index, note) in failures {
                    job.model.append_to_failure(index, &note);
                }
            });
        }
        Ok(())
    }

    pub fn retry(&self, job_id: &str) -> Result<(), AppError> {
        self.change_state(job_id, |job| job.model.retry().map_err(|err| AppError::Invalid(err.to_string()))).ok_or_else(|| not_found(job_id))??;
        self.schedule();
        Ok(())
    }

    /// Forget a finished job and abort what it kept on the server. The job is forgotten even when an
    /// abort fails; the error then names the upload that may remain.
    pub async fn dismiss(&self, job_id: &str) -> Result<(), AppError> {
        let job = {
            let mut table = self.table();
            let can_dismiss = table.jobs.get(job_id).ok_or_else(|| not_found(job_id))?.model.can_dismiss();
            if !can_dismiss {
                return Err(AppError::Invalid("only a finished transfer can be dismissed; cancel it first".into()));
            }
            table.order.retain(|id| id != job_id);
            table.jobs.remove(job_id)
        };
        self.0.changed.notify_waiters();
        let Some(job) = job else { return Err(not_found(job_id)) };
        let failures = abort_kept(job.spec.client.as_ref(), job.kept).await;
        if failures.is_empty() {
            return Ok(());
        }
        Err(AppError::S3(failures.into_iter().map(|(_, note)| note.trim().to_string()).collect::<Vec<_>>().join("; ")))
    }

    /// Lock: cancel every job, wait until they stopped, abort every kept upload and forget all.
    pub async fn shutdown(&self) {
        let tasks: Vec<JoinHandle<()>> = {
            let mut table = self.table();
            let ids: Vec<String> = table.order.clone();
            let mut tasks = Vec::new();
            for id in ids {
                let Some(job) = table.jobs.get_mut(&id) else { continue };
                if job.model.request_cancel().is_ok() {
                    job.cancel.cancel();
                }
                tasks.extend(job.task.take());
            }
            tasks
        };
        for task in tasks {
            let _ = task.await;
        }
        let jobs: Vec<Job> = {
            let mut table = self.table();
            table.order.clear();
            table.jobs.drain().map(|(_, job)| job).collect()
        };
        for job in jobs {
            abort_kept(job.spec.client.as_ref(), job.kept).await;
        }
        self.0.changed.notify_waiters();
    }

    // ---- the task of one job ----

    async fn run_job(&self, job_id: String) {
        let Some((spec, cancel, known_plan)) = self.with_job(&job_id, |job| (job.spec.clone(), job.cancel.clone(), job.plan.clone())) else { return };
        let plan = match known_plan {
            Some(plan) => plan,
            None => match self.prepare(&job_id, &spec).await {
                Some(plan) => plan,
                None => {
                    self.schedule();
                    return;
                }
            },
        };
        for index in 0..plan.len() {
            if cancel.is_cancelled() {
                break;
            }
            if !self.run_item(&job_id, &spec, &plan, index, &cancel).await {
                break;
            }
        }
        self.flush_removals(&job_id, &spec).await;
        if !cancel.is_cancelled() {
            remove_emptied_local_dirs(&spec.request);
        }
        self.end_run(&job_id, &spec, cancel.is_cancelled()).await;
        self.schedule();
    }

    /// Build the plan (listings, conflict decisions). `None` when the job ended instead.
    async fn prepare(&self, job_id: &str, spec: &JobSpec) -> Option<Arc<Vec<PlanItem>>> {
        match prepare_plan(spec.client.as_ref(), &spec.request, &spec.resolutions).await {
            Ok(planned_items) => {
                let plan = Arc::new(planned_items);
                let labels = plan.iter().map(|planned| (planned.src.label(), planned.size, planned.skip)).collect();
                self.change_state(job_id, |job| {
                    job.model.set_items(labels);
                    job.plan = Some(plan.clone());
                })?;
                Some(plan)
            }
            Err(err) => {
                self.change_state(job_id, |job| {
                    let _ = if job.model.state() == JobState::Cancelling { job.model.finish() } else { job.model.fail(err.to_string()) };
                });
                None
            }
        }
    }

    /// Run one item; `false` when the job has to stop (cancelled).
    async fn run_item(&self, job_id: &str, spec: &Arc<JobSpec>, plan: &[PlanItem], index: usize, cancel: &CancelToken) -> bool {
        let begun = self.with_job(job_id, |job| {
            if *job.model.item_state(index) != ItemState::Pending || job.model.begin_item(index).is_err() {
                return None;
            }
            job.throttle.reset();
            Some((job.kept.remove(&index), job.model.progress_event()))
        });
        let Some(Some((resume, first_event))) = begun else { return true };
        if let Some(event) = first_event {
            self.0.events.progress(&event);
        }
        let planned = &plan[index];
        let upload_id = Arc::new(Mutex::new(resume.as_ref().map(|kept| kept.upload_id.clone())));
        let env = TransferEnv {
            settings: spec.settings.clone(),
            sink: Arc::new(ItemSink { queue: self.clone(), job_id: job_id.to_string(), upload_id: upload_id.clone() }),
            cancel: cancel.clone(),
            retry: self.0.retry,
        };
        let call = ItemCall {
            client: spec.client.as_ref(),
            item: planned,
            mode: spec.request.mode,
            env: &env,
            resume_upload_id: resume.as_ref().map(|kept| kept.upload_id.as_str()),
        };
        match self.0.runner.run(call).await {
            Ok(removal) => {
                let last = self.with_job(job_id, |job| {
                    job.model.progress(planned.size);
                    let event = job.model.progress_event();
                    let _ = job.model.item_done(index);
                    if let Removal::ServerKey { bucket, key } = removal {
                        job.removals.entry(bucket).or_default().push(key);
                    }
                    event
                });
                if let Some(event) = last.flatten() {
                    self.0.events.progress(&event);
                }
                true
            }
            Err(failure) if failure.cancelled || cancel.is_cancelled() => {
                if failure.leftover_upload {
                    self.change_state(job_id, |job| job.model.set_message(format!("Cancelled, but an incomplete upload may remain on the server: {}", failure.message)));
                }
                false
            }
            Err(failure) => {
                let held = upload_id.lock().unwrap_or_else(PoisonError::into_inner).clone();
                self.change_state(job_id, |job| {
                    if let (Some(upload_id), ItemRef::Object { bucket, key }) = (held, &planned.dst) {
                        job.kept.insert(index, KeptUpload { upload_id, bucket: bucket.clone(), key: key.clone() });
                    }
                    let _ = job.model.item_failed(index, failure.message);
                });
                true
            }
        }
    }

    /// Delete the server sources of the items that finished (a move), one batch per bucket. A refused
    /// key is reported and tried again after a Retry.
    async fn flush_removals(&self, job_id: &str, spec: &JobSpec) {
        let pending = self.with_job(job_id, |job| std::mem::take(&mut job.removals)).unwrap_or_default();
        let Some(client) = spec.client.as_ref() else { return };
        for (bucket, keys) in pending {
            match s3_ops::delete_keys(client, &bucket, &keys).await {
                Ok(refused) => {
                    let refused_keys: Vec<String> = refused.iter().map(|failure| failure.key.clone()).collect();
                    self.change_state(job_id, |job| {
                        for failure in &refused {
                            job.model.add_failure(format!("{bucket}/{}", failure.key), format!("copied, but the source was not deleted: {}", failure.message));
                        }
                        job.removals.entry(bucket.clone()).or_default().extend(refused_keys);
                    });
                }
                Err(err) => {
                    self.change_state(job_id, |job| {
                        job.model.add_failure(bucket.clone(), format!("copied, but the sources were not deleted: {err}"));
                        job.removals.entry(bucket.clone()).or_default().extend(keys);
                    });
                }
            }
        }
    }

    /// The run is over: a cancel aborts what the job kept, then the state settles.
    async fn end_run(&self, job_id: &str, spec: &JobSpec, cancelled: bool) {
        let kept = if cancelled { self.with_job(job_id, |job| std::mem::take(&mut job.kept)).unwrap_or_default() } else { HashMap::new() };
        let failures = abort_kept(spec.client.as_ref(), kept).await;
        self.change_state(job_id, |job| {
            for (index, note) in failures {
                job.model.append_to_failure(index, &note);
            }
            let _ = job.model.finish();
            job.task = None;
        });
    }
}

/// Abort kept uploads; `(item index, note)` for each abort that failed, naming the upload that may
/// remain on the server.
async fn abort_kept(client: Option<&Client>, kept: HashMap<usize, KeptUpload>) -> Vec<(usize, String)> {
    let mut failures = Vec::new();
    let Some(client) = client else { return failures };
    for (index, upload) in kept {
        if let Err(err) = abort_upload(client, &upload.bucket, &upload.key, &upload.upload_id).await {
            failures.push((index, format!(" (could not abort the incomplete upload {}: {err}; it may remain on the server)", upload.upload_id)));
        }
    }
    failures
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::AtomicUsize;

    use aws_sdk_s3::operation::abort_multipart_upload::{AbortMultipartUploadError, AbortMultipartUploadOutput};
    use aws_sdk_s3::operation::complete_multipart_upload::CompleteMultipartUploadOutput;
    use aws_sdk_s3::operation::copy_object::{CopyObjectError, CopyObjectOutput};
    use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
    use aws_sdk_s3::operation::delete_objects::DeleteObjectsOutput;
    use aws_sdk_s3::operation::head_object::{HeadObjectError, HeadObjectOutput};
    use aws_sdk_s3::operation::list_parts::ListPartsOutput;
    use aws_sdk_s3::operation::upload_part::UploadPartOutput;
    use aws_sdk_s3::types::{error::NotFound, Part};
    use aws_smithy_mocks::{mock, mock_client, MockResponse, Rule, RuleMode};
    use aws_smithy_runtime_api::client::orchestrator::HttpResponse;
    use aws_smithy_runtime_api::http::StatusCode;
    use aws_smithy_types::body::SdkBody;
    use tokio::sync::Semaphore;

    use crate::transfer_job::{JobState, MAX_LISTED_FAILURES};
    use crate::transfer_plan::{ConflictPolicy, Location, TopItem};
    use crate::transfer_settings::{AddressingStyle, EffectiveTransferSettings};

    const MIB: u64 = 1 << 20;

    #[derive(Default)]
    struct RecordingSink {
        states: Mutex<Vec<JobSnapshot>>,
        progress: Mutex<Vec<ProgressEvent>>,
    }

    impl EventSink for RecordingSink {
        fn state(&self, snapshot: &JobSnapshot) {
            self.states.lock().unwrap().push(snapshot.clone());
        }
        fn progress(&self, event: &ProgressEvent) {
            self.progress.lock().unwrap().push(event.clone());
        }
    }

    impl RecordingSink {
        fn states_of(&self, job_id: &str) -> Vec<JobState> {
            let mut seen: Vec<JobState> = self.states.lock().unwrap().iter().filter(|snapshot| snapshot.id == job_id).map(|snapshot| snapshot.state).collect();
            seen.dedup();
            seen
        }

        fn everything_as_text(&self) -> String {
            format!("{}{}", serde_json::to_string(&*self.states.lock().unwrap()).unwrap(), serde_json::to_string(&*self.progress.lock().unwrap()).unwrap())
        }
    }

    /// Scripted by item name; anything else goes through the real engine. "block" waits for a permit
    /// (or the cancel), "fail" fails while armed, "burst" reports 1000 progress steps at once.
    struct ScriptedRunner {
        gate: Arc<Semaphore>,
        started: Mutex<Vec<String>>,
        failing: Mutex<bool>,
        active: AtomicUsize,
        most_active: AtomicUsize,
    }

    impl ScriptedRunner {
        fn new() -> Arc<Self> {
            Arc::new(Self { gate: Arc::new(Semaphore::new(0)), started: Mutex::default(), failing: Mutex::new(true), active: AtomicUsize::new(0), most_active: AtomicUsize::new(0) })
        }

        fn started(&self) -> Vec<String> {
            self.started.lock().unwrap().clone()
        }
    }

    impl ItemRunner for Arc<ScriptedRunner> {
        fn run<'a>(&'a self, call: ItemCall<'a>) -> BoxFuture<'a, Result<Removal, CopyFailure>> {
            Box::pin(async move {
                let label = call.item.src.label();
                self.started.lock().unwrap().push(label.clone());
                let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
                self.most_active.fetch_max(now, Ordering::SeqCst);
                tokio::task::yield_now().await;
                let outcome = if label.contains("block") {
                    tokio::select! {
                        permit = self.gate.acquire() => { permit.unwrap().forget(); Ok(Removal::Nothing) }
                        () = call.env.cancel.cancelled() => Err(CopyFailure { message: "cancelled".into(), cancelled: true, leftover_upload: false }),
                    }
                } else if label.contains("fail") && *self.failing.lock().unwrap() {
                    Err(CopyFailure { message: "boom".into(), cancelled: false, leftover_upload: false })
                } else if label.contains("burst") {
                    for done in 1..=1000 {
                        call.env.sink.bytes_done(done);
                    }
                    Ok(Removal::Nothing)
                } else {
                    copy_item(call.client, call.item, call.mode, call.env, call.resume_upload_id).await
                };
                self.active.fetch_sub(1, Ordering::SeqCst);
                outcome
            })
        }
    }

    fn quick_retry() -> RetryPolicy {
        RetryPolicy { max_attempts: 3, base_delay: Duration::ZERO }
    }

    fn fixture(max_running: usize) -> (TransferQueue, Arc<RecordingSink>, Arc<ScriptedRunner>) {
        let sink = Arc::new(RecordingSink::default());
        let runner = ScriptedRunner::new();
        (TransferQueue::new(sink.clone(), Arc::new(runner.clone()), max_running, quick_retry()), sink, runner)
    }

    async fn settle() {
        for _ in 0..60 {
            tokio::task::yield_now().await;
        }
    }

    fn local(path: &Path) -> Location {
        Location::Local { path: path.to_string_lossy().into_owned() }
    }

    fn items(names: &[&str]) -> Vec<TopItem> {
        names.iter().map(|name| TopItem { name: (*name).to_string(), is_dir: false, dest_name: None }).collect()
    }

    fn small_settings() -> EffectiveTransferSettings {
        EffectiveTransferSettings { multipart_threshold: 5 * MIB, multipart_chunksize: 5 * MIB, max_concurrent_requests: 1, addressing_style: AddressingStyle::Path }
    }

    fn spec(request: TransferRequest, client: Option<Client>) -> JobSpec {
        JobSpec { request, resolutions: Resolutions::all(ConflictPolicy::Overwrite), client, settings: small_settings() }
    }

    /// A local to local job over `names`, each file 1000 bytes, under `root/<job>/src` and `.../dst`.
    fn local_job(root: &Path, job: &str, names: &[&str], mode: Mode) -> JobSpec {
        let (src, dst) = (root.join(job).join("src"), root.join(job).join("dst"));
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        for name in names {
            fs::write(src.join(name), vec![b'x'; 1000]).unwrap();
        }
        spec(TransferRequest { source: local(&src), dest: local(&dst), items: items(names), mode }, None)
    }

    async fn states_now(queue: &TransferQueue, ids: &[String]) -> Vec<JobState> {
        ids.iter().map(|id| queue.snapshot(id).unwrap().state).collect()
    }

    // ---- scheduling ----

    #[test]
    fn the_throttle_lets_one_event_through_per_interval() {
        let mut throttle = ProgressThrottle::new(PROGRESS_INTERVAL);
        let start = Instant::now();
        assert!(throttle.allow(start));
        assert!(!throttle.allow(start + Duration::from_millis(40)));
        assert!(!throttle.allow(start + Duration::from_millis(99)));
        assert!(throttle.allow(start + Duration::from_millis(100)));
        throttle.reset();
        assert!(throttle.allow(start + Duration::from_millis(101)));
    }

    #[tokio::test]
    async fn at_most_three_jobs_run_and_the_rest_wait_in_start_order() {
        let root = tempfile::tempdir().unwrap();
        let (queue, _sink, runner) = fixture(MAX_RUNNING_JOBS);
        let ids: Vec<String> = (0..5).map(|number| queue.start(local_job(root.path(), &format!("j{number}"), &["block.txt"], Mode::Copy))).collect();
        settle().await;
        assert_eq!(states_now(&queue, &ids).await, [JobState::Running, JobState::Running, JobState::Running, JobState::Queued, JobState::Queued]);
        assert_eq!(runner.started().len(), 3);
        runner.gate.add_permits(1);
        settle().await;
        let states = states_now(&queue, &ids).await;
        assert_eq!(states.iter().filter(|state| **state == JobState::Done).count(), 1);
        assert_eq!((states[3], states[4]), (JobState::Running, JobState::Queued), "the fourth job takes the free slot");
        runner.gate.add_permits(10);
        queue.wait_settled(&ids[4]).await;
        assert!(states_now(&queue, &ids).await.iter().all(|state| *state == JobState::Done));
    }

    #[tokio::test]
    async fn the_items_of_a_job_run_one_after_another() {
        let root = tempfile::tempdir().unwrap();
        let (queue, _sink, runner) = fixture(MAX_RUNNING_JOBS);
        let id = queue.start(local_job(root.path(), "j", &["a.txt", "b.txt", "c.txt"], Mode::Copy));
        queue.wait_settled(&id).await;
        assert_eq!(runner.started().len(), 3);
        assert_eq!(runner.most_active.load(Ordering::SeqCst), 1);
        let snapshot = queue.snapshot(&id).unwrap();
        assert_eq!((snapshot.state, snapshot.items_done, snapshot.bytes_done, snapshot.bytes_total), (JobState::Done, 3, 3000, 3000));
        assert!(root.path().join("j/dst/b.txt").exists());
    }

    // ---- failures and retry ----

    #[tokio::test]
    async fn a_failed_item_is_reported_with_its_message_and_the_others_still_run() {
        let root = tempfile::tempdir().unwrap();
        let (queue, sink, _runner) = fixture(MAX_RUNNING_JOBS);
        let id = queue.start(local_job(root.path(), "j", &["ok1.txt", "fail1.txt", "ok2.txt"], Mode::Copy));
        queue.wait_settled(&id).await;
        let snapshot = queue.snapshot(&id).unwrap();
        assert_eq!((snapshot.state, snapshot.items_done, snapshot.items_failed), (JobState::Failed, 2, 1));
        assert_eq!(snapshot.failures.len(), 1);
        assert!(snapshot.failures[0].name.ends_with("fail1.txt"));
        assert_eq!(snapshot.failures[0].message, "boom");
        assert_eq!(sink.states_of(&id), [JobState::Queued, JobState::Running, JobState::Failed]);
    }

    #[tokio::test]
    async fn retry_runs_only_the_items_that_did_not_finish() {
        let root = tempfile::tempdir().unwrap();
        let (queue, _sink, runner) = fixture(MAX_RUNNING_JOBS);
        let id = queue.start(local_job(root.path(), "j", &["ok1.txt", "fail1.txt", "ok2.txt"], Mode::Copy));
        queue.wait_settled(&id).await;
        assert_eq!(runner.started().len(), 3);
        *runner.failing.lock().unwrap() = false;
        queue.retry(&id).unwrap();
        queue.wait_settled(&id).await;
        let started = runner.started();
        assert_eq!(started.len(), 4, "{started:?}");
        assert!(started[3].ends_with("fail1.txt"));
        assert_eq!(queue.snapshot(&id).unwrap().state, JobState::Done);
    }

    #[tokio::test]
    async fn a_prepare_failure_fails_the_job_with_a_message_and_retry_prepares_again() {
        let root = tempfile::tempdir().unwrap();
        let (queue, _sink, _runner) = fixture(MAX_RUNNING_JOBS);
        let (src, dst) = (root.path().join("src"), root.path().join("dst"));
        fs::create_dir_all(&dst).unwrap();
        let id = queue.start(spec(TransferRequest { source: local(&src), dest: local(&dst), items: items(&["a.txt"]), mode: Mode::Copy }, None));
        queue.wait_settled(&id).await;
        let snapshot = queue.snapshot(&id).unwrap();
        assert_eq!(snapshot.state, JobState::Failed);
        assert!(snapshot.message.is_some_and(|message| !message.is_empty()));
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.txt"), "hi").unwrap();
        queue.retry(&id).unwrap();
        queue.wait_settled(&id).await;
        assert_eq!(queue.snapshot(&id).unwrap().state, JobState::Done);
        assert!(dst.join("a.txt").exists());
    }

    // ---- cancel, dismiss, illegal commands ----

    #[tokio::test]
    async fn cancelling_a_queued_job_never_starts_it() {
        let root = tempfile::tempdir().unwrap();
        let (queue, sink, runner) = fixture(1);
        let running = queue.start(local_job(root.path(), "a", &["block.txt"], Mode::Copy));
        let waiting = queue.start(local_job(root.path(), "b", &["b.txt"], Mode::Copy));
        settle().await;
        assert_eq!(queue.snapshot(&waiting).unwrap().state, JobState::Queued);
        queue.cancel(&waiting).await.unwrap();
        assert_eq!(queue.snapshot(&waiting).unwrap().state, JobState::Cancelled);
        runner.gate.add_permits(1);
        queue.wait_settled(&running).await;
        settle().await;
        assert!(runner.started().iter().all(|label| !label.ends_with("b.txt")));
        assert_eq!(sink.states_of(&waiting), [JobState::Queued, JobState::Cancelled]);
    }

    #[tokio::test]
    async fn cancelling_a_running_job_goes_through_cancelling_and_starts_no_more_items() {
        let root = tempfile::tempdir().unwrap();
        let (queue, sink, runner) = fixture(MAX_RUNNING_JOBS);
        let id = queue.start(local_job(root.path(), "j", &["block.txt", "zz1.txt", "zz2.txt"], Mode::Copy));
        settle().await;
        queue.cancel(&id).await.unwrap();
        assert_eq!(queue.snapshot(&id).unwrap().state, JobState::Cancelling);
        queue.wait_settled(&id).await;
        let snapshot = queue.snapshot(&id).unwrap();
        assert_eq!((snapshot.state, snapshot.items_done, snapshot.items_failed), (JobState::Cancelled, 0, 0));
        assert_eq!(runner.started().len(), 1);
        assert_eq!(sink.states_of(&id), [JobState::Queued, JobState::Running, JobState::Cancelling, JobState::Cancelled]);
        queue.retry(&id).unwrap();
        runner.gate.add_permits(1);
        queue.wait_settled(&id).await;
        assert_eq!(queue.snapshot(&id).unwrap().state, JobState::Done, "a cancelled job can be retried");
    }

    #[tokio::test]
    async fn commands_that_the_state_does_not_allow_are_errors() {
        let root = tempfile::tempdir().unwrap();
        let (queue, _sink, runner) = fixture(MAX_RUNNING_JOBS);
        let running = queue.start(local_job(root.path(), "a", &["block.txt"], Mode::Copy));
        let finished = queue.start(local_job(root.path(), "b", &["b.txt"], Mode::Copy));
        queue.wait_settled(&finished).await;
        assert!(queue.retry(&running).is_err());
        assert!(queue.dismiss(&running).await.is_err());
        assert!(queue.cancel(&finished).await.is_err());
        assert!(queue.retry(&finished).is_err());
        assert!(queue.cancel("nope").await.is_err());
        assert!(queue.retry("nope").is_err());
        assert!(queue.dismiss("nope").await.is_err());
        queue.dismiss(&finished).await.unwrap();
        assert!(queue.snapshot(&finished).is_none(), "dismiss forgets the job");
        runner.gate.add_permits(1);
        queue.wait_settled(&running).await;
    }

    // ---- events ----

    #[tokio::test]
    async fn progress_is_throttled_but_the_last_event_of_an_item_is_complete() {
        let root = tempfile::tempdir().unwrap();
        let (queue, sink, _runner) = fixture(MAX_RUNNING_JOBS);
        let id = queue.start(local_job(root.path(), "j", &["burst.txt"], Mode::Copy));
        queue.wait_settled(&id).await;
        let progress = sink.progress.lock().unwrap().clone();
        assert!(progress.len() <= 4, "1000 steps came out as {} events", progress.len());
        let last = progress.last().unwrap();
        assert_eq!((last.job_id.as_str(), last.item_name.as_str()), (id.as_str(), "burst.txt"));
        assert_eq!((last.item_bytes_done, last.item_bytes_total, last.job_bytes_done, last.job_bytes_total), (1000, 1000, 1000, 1000));
        assert_eq!((last.item_index, last.item_count), (0, 1));
    }

    #[tokio::test]
    async fn a_failure_list_is_capped_in_the_state_event() {
        assert!(MAX_LISTED_FAILURES >= 100);
        let root = tempfile::tempdir().unwrap();
        let (queue, _sink, _runner) = fixture(MAX_RUNNING_JOBS);
        let id = queue.start(local_job(root.path(), "j", &["fail1.txt", "fail2.txt"], Mode::Copy));
        queue.wait_settled(&id).await;
        let snapshot = queue.snapshot(&id).unwrap();
        assert_eq!((snapshot.failures.len(), snapshot.failures_total), (2, 2));
    }

    // ---- S3: kept uploads, resume, abort ----

    struct S3Mocks {
        client: Client,
        create: Rule,
        part2: Rule,
        list: Rule,
        complete: Rule,
        abort: Rule,
    }

    fn status(code: u16) -> HttpResponse {
        HttpResponse::new(StatusCode::try_from(code).unwrap(), SdkBody::empty())
    }

    /// A bucket that has no objects; part 2 fails once with a 403, then works; ListParts holds part 1.
    fn s3_mocks(abort_fails: bool) -> S3Mocks {
        let head = mock!(Client::head_object).then_error(|| HeadObjectError::NotFound(NotFound::builder().build()));
        let create = mock!(Client::create_multipart_upload).then_output(|| CreateMultipartUploadOutput::builder().upload_id("u1").build());
        let others = mock!(Client::upload_part)
            .match_requests(|req| req.part_number() != Some(2))
            .then_compute_output(|req| UploadPartOutput::builder().e_tag(format!("e{}", req.part_number().unwrap_or(0))).build());
        let part2 = mock!(Client::upload_part)
            .match_requests(|req| req.part_number() == Some(2))
            .sequence()
            .http_response(|| status(403))
            .output(|| UploadPartOutput::builder().e_tag("e2").build())
            .build();
        let list = mock!(Client::list_parts).then_output(|| {
            ListPartsOutput::builder().is_truncated(false).parts(Part::builder().part_number(1).size((5 * MIB) as i64).e_tag("e1").build()).build()
        });
        let complete = mock!(Client::complete_multipart_upload).then_output(|| CompleteMultipartUploadOutput::builder().build());
        let abort = if abort_fails {
            mock!(Client::abort_multipart_upload).then_error(|| AbortMultipartUploadError::unhandled("down"))
        } else {
            mock!(Client::abort_multipart_upload).then_output(|| AbortMultipartUploadOutput::builder().build())
        };
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &create, &others, &part2, &list, &complete, &abort]);
        S3Mocks { client, create, part2, list, complete, abort }
    }

    fn upload_job(root: &Path, client: Client) -> JobSpec {
        fs::File::create(root.join("big.bin")).unwrap().set_len(11 * MIB).unwrap();
        let dest = Location::Bucket { bucket: "bkt".into(), prefix: String::new() };
        spec(TransferRequest { source: local(root), dest, items: items(&["big.bin"]), mode: Mode::Copy }, Some(client))
    }

    #[tokio::test]
    async fn a_failed_upload_is_kept_and_retry_resumes_it_with_the_same_upload_id() {
        let root = tempfile::tempdir().unwrap();
        let mocks = s3_mocks(false);
        let (queue, sink, _runner) = fixture(MAX_RUNNING_JOBS);
        let id = queue.start(upload_job(root.path(), mocks.client.clone()));
        queue.wait_settled(&id).await;
        let failed = queue.snapshot(&id).unwrap();
        assert_eq!(failed.state, JobState::Failed);
        assert_eq!((mocks.create.num_calls(), mocks.abort.num_calls(), mocks.complete.num_calls(), mocks.list.num_calls()), (1, 0, 0, 0));
        queue.retry(&id).unwrap();
        queue.wait_settled(&id).await;
        assert_eq!(queue.snapshot(&id).unwrap().state, JobState::Done);
        assert_eq!((mocks.create.num_calls(), mocks.list.num_calls(), mocks.part2.num_calls(), mocks.complete.num_calls(), mocks.abort.num_calls()), (1, 1, 2, 1, 0));
        let text = sink.everything_as_text();
        assert!(!text.contains("SECRET") && !text.to_lowercase().contains("signature") && !text.to_lowercase().contains("authorization"), "{text}");
    }

    #[tokio::test]
    async fn dismiss_aborts_the_kept_upload_and_forgets_the_job() {
        let root = tempfile::tempdir().unwrap();
        let mocks = s3_mocks(false);
        let (queue, _sink, _runner) = fixture(MAX_RUNNING_JOBS);
        let id = queue.start(upload_job(root.path(), mocks.client.clone()));
        queue.wait_settled(&id).await;
        queue.dismiss(&id).await.unwrap();
        assert_eq!(mocks.abort.num_calls(), 1);
        assert!(queue.snapshot(&id).is_none());
    }

    #[tokio::test]
    async fn a_failed_abort_on_dismiss_is_reported_but_the_job_is_still_forgotten() {
        let root = tempfile::tempdir().unwrap();
        let mocks = s3_mocks(true);
        let (queue, _sink, _runner) = fixture(MAX_RUNNING_JOBS);
        let id = queue.start(upload_job(root.path(), mocks.client.clone()));
        queue.wait_settled(&id).await;
        let err = queue.dismiss(&id).await.unwrap_err().to_string();
        assert!(err.contains("u1") && err.contains("may remain"), "{err}");
        assert!(queue.snapshot(&id).is_none());
    }

    #[tokio::test]
    async fn cancelling_a_retried_job_that_is_still_queued_aborts_its_upload_and_reports_a_failed_abort_in_the_item_message() {
        let root = tempfile::tempdir().unwrap();
        let mocks = s3_mocks(true);
        let (queue, _sink, runner) = fixture(1);
        let failing = queue.start(upload_job(root.path(), mocks.client.clone()));
        queue.wait_settled(&failing).await;
        let blocker = queue.start(local_job(root.path(), "blocker", &["block.txt"], Mode::Copy));
        settle().await;
        queue.retry(&failing).unwrap();
        assert_eq!(queue.snapshot(&failing).unwrap().state, JobState::Queued, "the only slot is taken");
        queue.cancel(&failing).await.unwrap();
        let snapshot = queue.snapshot(&failing).unwrap();
        assert_eq!(snapshot.state, JobState::Cancelled);
        assert_eq!(mocks.abort.num_calls(), 1);
        assert!(snapshot.failures[0].message.contains("u1") && snapshot.failures[0].message.contains("may remain"), "{:?}", snapshot.failures);
        runner.gate.add_permits(1);
        queue.wait_settled(&blocker).await;
    }

    #[tokio::test]
    async fn shutdown_cancels_running_jobs_aborts_kept_uploads_and_forgets_everything() {
        let root = tempfile::tempdir().unwrap();
        let mocks = s3_mocks(false);
        let (queue, _sink, runner) = fixture(MAX_RUNNING_JOBS);
        let failing = queue.start(upload_job(root.path(), mocks.client.clone()));
        queue.wait_settled(&failing).await;
        let running = queue.start(local_job(root.path(), "j", &["block.txt"], Mode::Copy));
        settle().await;
        assert_eq!(queue.snapshot(&running).unwrap().state, JobState::Running);
        queue.shutdown().await;
        assert_eq!(mocks.abort.num_calls(), 1);
        assert_eq!(runner.active.load(Ordering::SeqCst), 0, "the running item has stopped");
        assert!(queue.snapshot(&failing).is_none() && queue.snapshot(&running).is_none());
        assert!(queue.snapshots().is_empty());
    }

    // ---- move ----

    fn size_table(sizes: &'static [(&'static str, i64)]) -> Rule {
        mock!(Client::head_object).then_compute_response(move |req| {
            let name = format!("{}/{}", req.bucket().unwrap_or_default(), req.key().unwrap_or_default());
            match sizes.iter().find(|(known, _)| *known == name) {
                Some((_, size)) => MockResponse::Output(HeadObjectOutput::builder().content_length(*size).build()),
                None => MockResponse::Error(HeadObjectError::NotFound(NotFound::builder().build())),
            }
        })
    }

    #[tokio::test]
    async fn a_server_move_deletes_only_the_sources_that_were_copied() {
        let deleted: Arc<Mutex<Vec<(String, Vec<String>)>>> = Arc::default();
        let head = size_table(&[("b/a.txt", 3), ("b/b.txt", 4), ("b/c.txt", 5), ("c/a.txt", 3), ("c/b.txt", 4), ("c/c.txt", 5)]);
        let copy_ok = mock!(Client::copy_object).match_requests(|req| req.key() != Some("b.txt")).then_output(|| CopyObjectOutput::builder().build());
        let copy_bad = mock!(Client::copy_object).match_requests(|req| req.key() == Some("b.txt")).then_error(|| CopyObjectError::unhandled("boom"));
        let sink_deleted = deleted.clone();
        let delete = mock!(Client::delete_objects).then_compute_output(move |req| {
            let keys = req.delete().map(|batch| batch.objects().iter().map(|object| object.key().to_string()).collect()).unwrap_or_default();
            sink_deleted.lock().unwrap().push((req.bucket().unwrap_or_default().to_string(), keys));
            DeleteObjectsOutput::builder().build()
        });
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &copy_ok, &copy_bad, &delete]);
        let (queue, _sink, _runner) = fixture(MAX_RUNNING_JOBS);
        let request = TransferRequest {
            source: Location::Bucket { bucket: "b".into(), prefix: String::new() },
            dest: Location::Bucket { bucket: "c".into(), prefix: String::new() },
            items: items(&["a.txt", "b.txt", "c.txt"]),
            mode: Mode::Move,
        };
        let id = queue.start(spec(request, Some(client)));
        queue.wait_settled(&id).await;
        let snapshot = queue.snapshot(&id).unwrap();
        assert_eq!((snapshot.state, snapshot.items_done, snapshot.items_failed), (JobState::Failed, 2, 1));
        assert_eq!(snapshot.failures[0].name, "b/b.txt");
        let mut seen = deleted.lock().unwrap().clone();
        seen.iter_mut().for_each(|(_, keys)| keys.sort());
        assert_eq!(seen, [("b".to_string(), vec!["a.txt".to_string(), "c.txt".to_string()])], "the failed item keeps its source");
    }

    #[tokio::test]
    async fn a_local_move_removes_only_the_sources_that_were_moved() {
        let root = tempfile::tempdir().unwrap();
        let (queue, _sink, _runner) = fixture(MAX_RUNNING_JOBS);
        let id = queue.start(local_job(root.path(), "j", &["ok1.txt", "fail1.txt"], Mode::Move));
        queue.wait_settled(&id).await;
        assert!(!root.path().join("j/src/ok1.txt").exists());
        assert!(root.path().join("j/dst/ok1.txt").exists());
        assert!(root.path().join("j/src/fail1.txt").exists(), "the failed item stays where it was");
    }
}
