//! What the transfer engines share: progress sink, cancel token, retry policy, the engine error
//! and a bounded-parallelism runner. No Tauri dependency; the UI (step 4b) plugs in a sink and a
//! token, the 3a engine passes the no-op sink and a token nobody cancels.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};
use aws_smithy_runtime_api::client::orchestrator::HttpResponse;
use tokio::sync::Notify;

use crate::app_error::AppError;
use crate::s3::map_sdk_error;
use crate::transfer_settings::{effective_transfer_settings, EffectiveTransferSettings, TransferFields};

/// Receives progress from an engine. Every method has a no-op default; implementations must be
/// cheap and non-blocking (they run inside the transfer). Totals are monotonic.
pub trait ProgressSink: Send + Sync {
    /// A multipart upload exists on the server (its id is needed to resume or clean it up).
    fn upload_created(&self, _upload_id: &str) {}
    /// Size of the object being transferred, sent once before the first `bytes_done`.
    fn bytes_total(&self, _total: u64) {}
    /// Bytes finished so far (never decreases, ends at the total on success).
    fn bytes_done(&self, _done: u64) {}
    /// One part (upload) or one range (download) is finished; `part_number` is 1-based.
    fn part_done(&self, _part_number: i32, _total_parts: usize) {}
}

/// Progress sink that ignores everything.
pub struct NoProgress;

impl ProgressSink for NoProgress {}

/// Cooperative cancellation: cheap to clone, every clone shares the flag. Engines check it
/// between parts / ranges and wake from waits when it flips.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<CancelState>);

#[derive(Default)]
struct CancelState {
    flag: AtomicBool,
    wake: Notify,
}

impl CancelToken {
    pub fn cancel(&self) {
        self.0.flag.store(true, Ordering::SeqCst);
        self.0.wake.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.flag.load(Ordering::SeqCst)
    }

    /// Completes once the token is cancelled (immediately if it already is).
    pub async fn cancelled(&self) {
        loop {
            let notified = self.0.wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// Retry of one part or range: `max_attempts` tries in total, the wait before try n+1 is
/// `base_delay * 2^(n-1)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { max_attempts: 3, base_delay: Duration::from_millis(200) }
    }
}

/// Why an engine stopped. `leftover_upload_id` is set when a multipart upload may still exist on
/// the server (the abort failed, or the resume could not even list the parts), so the caller can
/// show it.
#[derive(Debug)]
pub enum EngineError {
    Cancelled { leftover_upload_id: Option<String> },
    Failed { error: AppError, leftover_upload_id: Option<String> },
}

impl EngineError {
    pub fn failed(error: AppError) -> Self {
        Self::Failed { error, leftover_upload_id: None }
    }

    pub fn cancelled() -> Self {
        Self::Cancelled { leftover_upload_id: None }
    }

    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled { .. })
    }

    pub fn leftover_upload_id(&self) -> Option<&str> {
        match self {
            Self::Cancelled { leftover_upload_id } | Self::Failed { leftover_upload_id, .. } => leftover_upload_id.as_deref(),
        }
    }

    pub fn with_leftover(self, upload_id: String) -> Self {
        match self {
            Self::Cancelled { .. } => Self::Cancelled { leftover_upload_id: Some(upload_id) },
            Self::Failed { error, .. } => Self::Failed { error, leftover_upload_id: Some(upload_id) },
        }
    }
}

impl From<EngineError> for AppError {
    fn from(err: EngineError) -> Self {
        let leftover = err
            .leftover_upload_id()
            .map(|id| format!(" (an incomplete upload with id {id} may remain on the server)"))
            .unwrap_or_default();
        match err {
            EngineError::Cancelled { .. } => AppError::Local(format!("cancelled{leftover}")),
            EngineError::Failed { error: AppError::S3(message), .. } => AppError::S3(format!("{message}{leftover}")),
            EngineError::Failed { error: AppError::Local(message), .. } => AppError::Local(format!("{message}{leftover}")),
            EngineError::Failed { error, .. } => error,
        }
    }
}

/// One failed attempt of a retryable request.
#[derive(Debug)]
pub struct AttemptError {
    pub error: AppError,
    pub is_transient: bool,
}

impl AttemptError {
    pub fn permanent(error: AppError) -> Self {
        Self { error, is_transient: false }
    }
}

/// Transient = the request never got an answer (dispatch, timeout) or the server answered 5xx.
/// A 4xx (denied, no such upload, precondition failed) is permanent.
pub fn classify_sdk_error<E>(err: SdkError<E, HttpResponse>) -> AttemptError
where
    E: ProvideErrorMetadata + std::error::Error + 'static,
{
    let is_transient = match &err {
        SdkError::DispatchFailure(_) | SdkError::TimeoutError(_) => true,
        SdkError::ServiceError(_) | SdkError::ResponseError(_) => err.raw_response().is_some_and(|response| response.status().is_server_error()),
        _ => false,
    };
    AttemptError { error: map_sdk_error(err), is_transient }
}

/// Run `operation` up to `policy.max_attempts` times while it fails transiently, waiting with
/// exponential backoff in between. A cancel during the wait or between tries stops at once.
pub async fn with_retry<T, Fut>(
    policy: &RetryPolicy,
    cancel: &CancelToken,
    mut operation: impl FnMut() -> Fut,
) -> Result<T, EngineError>
where
    Fut: Future<Output = Result<T, AttemptError>>,
{
    let mut attempt = 1;
    loop {
        if cancel.is_cancelled() {
            return Err(EngineError::cancelled());
        }
        let failure = match operation().await {
            Ok(done) => return Ok(done),
            Err(failure) => failure,
        };
        if !failure.is_transient || attempt >= policy.max_attempts {
            return Err(EngineError::failed(failure.error));
        }
        let wait = policy.base_delay.saturating_mul(1 << (attempt - 1).min(16));
        tokio::select! {
            () = cancel.cancelled() => return Err(EngineError::cancelled()),
            () = tokio::time::sleep(wait) => {}
        }
        attempt += 1;
    }
}

/// Run `work` over `jobs` with at most `limit` in flight (jobs start in order). The first error or
/// a cancel aborts the jobs still running and is returned; results come back in completion order.
pub async fn run_bounded<J, T, Fut>(
    jobs: Vec<J>,
    limit: usize,
    cancel: &CancelToken,
    work: impl Fn(J) -> Fut,
) -> Result<Vec<T>, EngineError>
where
    J: Send + 'static,
    T: Send + 'static,
    Fut: Future<Output = Result<T, EngineError>> + Send + 'static,
{
    let mut pending = jobs.into_iter();
    let mut running = tokio::task::JoinSet::new();
    let mut finished = Vec::new();
    loop {
        while running.len() < limit.max(1) && !cancel.is_cancelled() {
            match pending.next() {
                Some(job) => {
                    running.spawn(work(job));
                }
                None => break,
            }
        }
        if cancel.is_cancelled() {
            stop_all(running).await;
            return Err(EngineError::cancelled());
        }
        let outcome = tokio::select! {
            () = cancel.cancelled() => None,
            next = running.join_next() => next,
        };
        match outcome {
            None if cancel.is_cancelled() => {
                stop_all(running).await;
                return Err(EngineError::cancelled());
            }
            None => return Ok(finished), // nothing left running and nothing pending
            Some(Ok(Ok(done))) => finished.push(done),
            Some(Ok(Err(err))) => {
                stop_all(running).await;
                return Err(err);
            }
            Some(Err(join_err)) => {
                stop_all(running).await;
                return Err(EngineError::failed(AppError::Local(format!("transfer task failed: {join_err}"))));
            }
        }
    }
}

/// Abort what is still running and wait until it has really stopped.
async fn stop_all<T: 'static>(mut running: tokio::task::JoinSet<T>) {
    running.abort_all();
    while running.join_next().await.is_some() {}
}

/// Bytes finished across concurrent parts, reported to the sink in non-decreasing order.
pub struct ProgressTracker {
    sink: Arc<dyn ProgressSink>,
    done: Mutex<u64>,
}

impl ProgressTracker {
    /// Tells the sink the total right away.
    pub fn new(sink: Arc<dyn ProgressSink>, total: u64) -> Self {
        sink.bytes_total(total);
        Self { sink, done: Mutex::new(0) }
    }

    /// Add finished bytes and tell the sink the new running total.
    pub fn add(&self, bytes: u64) {
        // The sink is called under the lock so concurrent parts cannot report out of order.
        let mut done = self.done.lock().unwrap_or_else(PoisonError::into_inner);
        *done += bytes;
        self.sink.bytes_done(*done);
    }

    pub fn sink(&self) -> &Arc<dyn ProgressSink> {
        &self.sink
    }
}

/// Memory the in-flight upload parts may hold at once (each part is read into memory).
pub const MAX_INFLIGHT_BYTES: u64 = 1 << 30;

/// Everything an engine call needs besides the client: the profile's effective settings, the
/// progress sink, the cancel token and the retry policy.
#[derive(Clone)]
pub struct TransferEnv {
    pub settings: EffectiveTransferSettings,
    pub sink: Arc<dyn ProgressSink>,
    pub cancel: CancelToken,
    pub retry: RetryPolicy,
}

impl TransferEnv {
    pub fn new(settings: EffectiveTransferSettings) -> Self {
        Self { settings, sink: Arc::new(NoProgress), cancel: CancelToken::default(), retry: RetryPolicy::default() }
    }

    /// Parts in flight at once: the configured concurrency, lowered so that
    /// `parts in flight x part size` stays within `MAX_INFLIGHT_BYTES` (at least one part).
    pub fn upload_concurrency(&self, part_size: u64) -> usize {
        let by_memory = usize::try_from(MAX_INFLIGHT_BYTES / part_size.max(1)).unwrap_or(usize::MAX);
        self.settings.max_concurrent_requests.min(by_memory).max(1)
    }
}

impl Default for TransferEnv {
    fn default() -> Self {
        Self::new(effective_transfer_settings(&TransferFields::default()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, AtomicUsize};
    use std::time::Instant;

    use aws_sdk_s3::operation::upload_part::UploadPartError;
    use aws_smithy_runtime_api::client::result::ConnectorError;
    use aws_smithy_runtime_api::http::StatusCode;
    use aws_smithy_types::body::SdkBody;

    fn http(status: u16) -> HttpResponse {
        HttpResponse::new(StatusCode::try_from(status).unwrap(), SdkBody::empty())
    }

    fn quick(max_attempts: u32) -> RetryPolicy {
        RetryPolicy { max_attempts, base_delay: Duration::ZERO }
    }

    #[test]
    fn five_xx_dispatch_and_timeout_are_transient_but_four_xx_is_not() {
        let service = |status| SdkError::service_error(UploadPartError::unhandled("x"), http(status));
        assert!(classify_sdk_error(service(500)).is_transient);
        assert!(classify_sdk_error(service(503)).is_transient);
        assert!(!classify_sdk_error(service(403)).is_transient);
        assert!(!classify_sdk_error(service(404)).is_transient);
        let dispatch: SdkError<UploadPartError, HttpResponse> = SdkError::dispatch_failure(ConnectorError::io("reset".into()));
        assert!(classify_sdk_error(dispatch).is_transient);
        let timeout: SdkError<UploadPartError, HttpResponse> = SdkError::timeout_error("slow");
        assert!(classify_sdk_error(timeout).is_transient);
    }

    #[tokio::test]
    async fn cancel_token_wakes_waiters_and_stays_cancelled() {
        let token = CancelToken::default();
        assert!(!token.is_cancelled());
        let waiter = {
            let token = token.clone();
            tokio::spawn(async move { token.cancelled().await })
        };
        tokio::task::yield_now().await;
        token.cancel();
        waiter.await.unwrap();
        token.cancelled().await; // already cancelled: returns at once
    }

    #[tokio::test]
    async fn retry_stops_at_the_first_success() {
        let calls = AtomicU32::new(0);
        let finished_on = with_retry(&quick(3), &CancelToken::default(), || {
            let attempt = calls.fetch_add(1, Ordering::SeqCst) + 1;
            async move {
                if attempt < 3 {
                    Err(AttemptError { error: AppError::S3("503".into()), is_transient: true })
                } else {
                    Ok(attempt)
                }
            }
        })
        .await
        .unwrap();
        assert_eq!((finished_on, calls.load(Ordering::SeqCst)), (3, 3));
    }

    #[tokio::test]
    async fn retry_gives_up_after_the_last_attempt_with_the_last_error() {
        let calls = AtomicU32::new(0);
        let err = with_retry(&quick(3), &CancelToken::default(), || {
            let attempt = calls.fetch_add(1, Ordering::SeqCst) + 1;
            async move { Err::<(), _>(AttemptError { error: AppError::S3(format!("failure {attempt}")), is_transient: true }) }
        })
        .await
        .unwrap_err();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert!(AppError::from(err).to_string().contains("failure 3"));
    }

    #[tokio::test]
    async fn retry_does_not_repeat_a_permanent_error() {
        let calls = AtomicU32::new(0);
        let err = with_retry(&quick(3), &CancelToken::default(), || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err::<(), _>(AttemptError::permanent(AppError::S3("access denied".into()))) }
        })
        .await
        .unwrap_err();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(!err.is_cancelled());
    }

    #[tokio::test]
    async fn a_cancel_during_the_backoff_wait_stops_without_another_attempt() {
        let token = CancelToken::default();
        let policy = RetryPolicy { max_attempts: 3, base_delay: Duration::from_secs(30) };
        let calls = Arc::new(AtomicU32::new(0));
        let canceller = {
            let token = token.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                token.cancel();
            })
        };
        let started = Instant::now();
        let err = with_retry(&policy, &token, || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err::<(), _>(AttemptError { error: AppError::S3("503".into()), is_transient: true }) }
        })
        .await
        .unwrap_err();
        canceller.await.unwrap();
        assert!(err.is_cancelled());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn bounded_runner_never_exceeds_the_limit_and_does_reach_it() {
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut results = run_bounded((0..12).collect(), 3, &CancelToken::default(), |job: u32| {
            let (running, peak) = (running.clone(), peak.clone());
            async move {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(15)).await;
                running.fetch_sub(1, Ordering::SeqCst);
                Ok(job)
            }
        })
        .await
        .unwrap();
        assert_eq!(peak.load(Ordering::SeqCst), 3);
        results.sort();
        assert_eq!(results, (0..12).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn bounded_runner_stops_at_the_first_error_and_starts_nothing_more() {
        let started = Arc::new(AtomicU32::new(0));
        let err = run_bounded((0..20).collect(), 2, &CancelToken::default(), |job: u32| {
            let started = started.clone();
            async move {
                started.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
                if job == 1 { Err(EngineError::failed(AppError::S3("boom".into()))) } else { Ok(job) }
            }
        })
        .await
        .unwrap_err();
        assert!(!err.is_cancelled());
        assert!(started.load(Ordering::SeqCst) < 20, "{}", started.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn bounded_runner_cancel_returns_promptly_while_jobs_are_running() {
        let token = CancelToken::default();
        let canceller = {
            let token = token.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                token.cancel();
            })
        };
        let started = Instant::now();
        let err = run_bounded((0..4).collect(), 2, &token, |_job: u32| async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(())
        })
        .await
        .unwrap_err();
        canceller.await.unwrap();
        assert!(err.is_cancelled());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    struct Recorder(Mutex<Vec<u64>>);
    impl ProgressSink for Recorder {
        fn bytes_done(&self, done: u64) {
            self.0.lock().unwrap().push(done);
        }
    }

    #[test]
    fn concurrent_progress_is_reported_in_non_decreasing_order_up_to_the_total() {
        let recorder = Arc::new(Recorder(Mutex::new(Vec::new())));
        let tracker = Arc::new(ProgressTracker::new(recorder.clone(), 800));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let tracker = tracker.clone();
                std::thread::spawn(move || (0..10).for_each(|_| tracker.add(10)))
            })
            .collect();
        threads.into_iter().for_each(|thread| thread.join().unwrap());
        let seen = recorder.0.lock().unwrap().clone();
        assert_eq!(seen.len(), 80);
        assert!(seen.windows(2).all(|pair| pair[0] <= pair[1]), "{seen:?}");
        assert_eq!(*seen.last().unwrap(), 800);
    }

    #[test]
    fn upload_concurrency_is_the_setting_unless_parts_would_exceed_the_memory_budget() {
        let env = TransferEnv::default(); // 10 concurrent requests
        assert_eq!(env.upload_concurrency(8 << 20), 10);
        assert_eq!(env.upload_concurrency(MAX_INFLIGHT_BYTES / 4), 4);
        assert_eq!(env.upload_concurrency(5 << 30), 1);
    }

    #[test]
    fn engine_error_text_mentions_the_leftover_upload_but_never_more() {
        let err: AppError = EngineError::failed(AppError::S3("denied".into())).with_leftover("up-1".into()).into();
        assert_eq!(err.to_string(), "denied (an incomplete upload with id up-1 may remain on the server)");
        assert_eq!(AppError::from(EngineError::cancelled()).to_string(), "cancelled");
    }
}
