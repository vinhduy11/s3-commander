//! The state of one background transfer job and its items, as a pure state machine (no Tauri, no
//! SDK, no I/O): the queue drives it, the UI only sees its snapshots. Illegal transitions are
//! errors, never silently ignored.
//!
//! Job: queued -> running -> done | failed | cancelling -> cancelled; a queued job cancels at once;
//! failed and cancelled jobs can be retried (back to queued). Item: pending -> running -> done |
//! failed(message); items the conflict policy skipped start as skipped. A cancel puts the running
//! item back to pending, a retry puts failed items back to pending and keeps finished ones.

use serde::Serialize;

use crate::transfer_plan::{direction, Direction, ItemFailure, Location, Mode, TransferRequest};

/// Failures listed in one snapshot; `failures_total` always says how many there are.
pub const MAX_LISTED_FAILURES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelling,
    Cancelled,
}

impl JobState {
    fn name(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelling => "cancelling",
            Self::Cancelled => "cancelled",
        }
    }

    /// Nothing more happens to the job unless the user retries it.
    pub fn is_finished(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemState {
    Pending,
    Running,
    Done,
    Skipped,
    Failed(String),
}

/// A transition the current state does not allow.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("cannot {action} a {state} job", state = from.name())]
pub struct IllegalTransition {
    pub from: JobState,
    pub action: &'static str,
}

type Transition = Result<(), IllegalTransition>;

#[derive(Debug, Clone)]
struct JobItem {
    label: String,
    size: u64,
    state: ItemState,
}

#[derive(Debug)]
pub struct JobModel {
    id: String,
    title: String,
    state: JobState,
    message: Option<String>,
    items: Vec<JobItem>,
    current: Option<usize>,
    current_done: u64,
    extra_failures: Vec<ItemFailure>,
}

/// What the UI gets on `transfer://state`: counts, the current item and the failures.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct JobSnapshot {
    pub id: String,
    pub title: String,
    pub state: JobState,
    pub message: Option<String>,
    pub item_count: usize,
    pub items_done: usize,
    pub items_skipped: usize,
    pub items_failed: usize,
    pub bytes_total: u64,
    pub bytes_done: u64,
    pub current_name: Option<String>,
    pub failures: Vec<ItemFailure>,
    pub failures_total: usize,
}

/// What the UI gets on `transfer://progress` (throttled by the queue).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProgressEvent {
    pub job_id: String,
    pub item_name: String,
    pub item_index: usize,
    pub item_count: usize,
    pub item_bytes_done: u64,
    pub item_bytes_total: u64,
    pub job_bytes_done: u64,
    pub job_bytes_total: u64,
}

/// The last path segment of an item label (`/a/b.txt`, `bucket/a/b.txt`).
fn short_name(label: &str) -> &str {
    label.trim_end_matches('/').rsplit('/').next().unwrap_or(label)
}

impl JobModel {
    pub fn new(id: String, title: String) -> Self {
        Self { id, title, state: JobState::Queued, message: None, items: Vec::new(), current: None, current_done: 0, extra_failures: Vec::new() }
    }

    pub fn state(&self) -> JobState {
        self.state
    }

    pub fn item_state(&self, index: usize) -> &ItemState {
        &self.items[index].state
    }

    pub fn is_running_work(&self) -> bool {
        matches!(self.state, JobState::Running | JobState::Cancelling)
    }

    pub fn can_dismiss(&self) -> bool {
        self.state.is_finished()
    }

    fn illegal(&self, action: &'static str) -> Transition {
        Err(IllegalTransition { from: self.state, action })
    }

    pub fn start(&mut self) -> Transition {
        if self.state != JobState::Queued {
            return self.illegal("start");
        }
        self.state = JobState::Running;
        Ok(())
    }

    /// The plan is known: `(label, size, skipped)` per item.
    pub fn set_items(&mut self, items: Vec<(String, u64, bool)>) {
        self.items = items
            .into_iter()
            .map(|(label, size, skipped)| JobItem { label, size, state: if skipped { ItemState::Skipped } else { ItemState::Pending } })
            .collect();
    }

    pub fn begin_item(&mut self, index: usize) -> Transition {
        let is_pending = matches!(self.items.get(index).map(|item| &item.state), Some(ItemState::Pending));
        if self.state != JobState::Running || self.current.is_some() || !is_pending {
            return self.illegal("begin an item of");
        }
        self.items[index].state = ItemState::Running;
        self.current = Some(index);
        self.current_done = 0;
        Ok(())
    }

    /// Bytes of the current item finished so far (never goes back, never above the item size).
    pub fn progress(&mut self, done: u64) {
        if let Some(index) = self.current {
            self.current_done = self.current_done.max(done.min(self.items[index].size));
        }
    }

    fn end_item(&mut self, index: usize, state: ItemState) -> Transition {
        if self.current != Some(index) {
            return self.illegal("end an item of");
        }
        self.items[index].state = state;
        self.current = None;
        self.current_done = 0;
        Ok(())
    }

    pub fn item_done(&mut self, index: usize) -> Transition {
        self.end_item(index, ItemState::Done)
    }

    pub fn item_failed(&mut self, index: usize, message: String) -> Transition {
        self.end_item(index, ItemState::Failed(message))
    }

    /// Add a note to an item's failure message (e.g. that the abort of its kept upload failed). An
    /// item that was reset to pending by a Retry becomes failed with just the note, so the report
    /// is not lost when the job is cancelled before it runs.
    pub fn append_to_failure(&mut self, index: usize, note: &str) {
        let item = &mut self.items[index];
        match &mut item.state {
            ItemState::Failed(message) => message.push_str(note),
            ItemState::Pending => item.state = ItemState::Failed(note.trim().to_string()),
            _ => {}
        }
    }

    /// A failure that belongs to no item (a refused source delete after a move).
    pub fn add_failure(&mut self, name: String, message: String) {
        self.extra_failures.push(ItemFailure { name, message });
    }

    /// A note for the whole job (shown next to its state).
    pub fn set_message(&mut self, message: String) {
        self.message = Some(message);
    }

    /// The job cannot go on (e.g. the folder could not be listed): failed with a message.
    pub fn fail(&mut self, message: String) -> Transition {
        if self.state != JobState::Running {
            return self.illegal("fail");
        }
        self.message = Some(message);
        self.state = JobState::Failed;
        Ok(())
    }

    /// The run is over: done or failed (any failed item), or cancelled when a cancel was asked.
    pub fn finish(&mut self) -> Transition {
        match self.state {
            JobState::Running => {
                let failed = self.message.is_some() || !self.extra_failures.is_empty() || self.items.iter().any(|item| matches!(item.state, ItemState::Failed(_)));
                self.state = if failed { JobState::Failed } else { JobState::Done };
                Ok(())
            }
            JobState::Cancelling => {
                if let Some(index) = self.current.take() {
                    self.items[index].state = ItemState::Pending;
                }
                self.current_done = 0;
                self.state = JobState::Cancelled;
                Ok(())
            }
            _ => self.illegal("finish"),
        }
    }

    /// Queued -> cancelled at once; running -> cancelling (the task stops and calls `finish`).
    pub fn request_cancel(&mut self) -> Result<JobState, IllegalTransition> {
        self.state = match self.state {
            JobState::Queued => JobState::Cancelled,
            JobState::Running | JobState::Cancelling => JobState::Cancelling,
            _ => return Err(IllegalTransition { from: self.state, action: "cancel" }),
        };
        Ok(self.state)
    }

    /// Failed or cancelled -> queued again; failed and unfinished items go back to pending.
    pub fn retry(&mut self) -> Transition {
        if !matches!(self.state, JobState::Failed | JobState::Cancelled) {
            return self.illegal("retry");
        }
        for item in &mut self.items {
            if matches!(item.state, ItemState::Failed(_) | ItemState::Running) {
                item.state = ItemState::Pending;
            }
        }
        self.extra_failures.clear();
        self.message = None;
        self.current = None;
        self.current_done = 0;
        self.state = JobState::Queued;
        Ok(())
    }

    pub fn bytes_total(&self) -> u64 {
        self.items.iter().filter(|item| item.state != ItemState::Skipped).map(|item| item.size).sum()
    }

    pub fn bytes_done(&self) -> u64 {
        let finished: u64 = self.items.iter().filter(|item| item.state == ItemState::Done).map(|item| item.size).sum();
        finished + self.current_done
    }

    fn count(&self, wanted: impl Fn(&ItemState) -> bool) -> usize {
        self.items.iter().filter(|item| wanted(&item.state)).count()
    }

    pub fn snapshot(&self) -> JobSnapshot {
        let mut failures: Vec<ItemFailure> = self
            .items
            .iter()
            .filter_map(|item| match &item.state {
                ItemState::Failed(message) => Some(ItemFailure { name: item.label.clone(), message: message.clone() }),
                _ => None,
            })
            .collect();
        failures.extend(self.extra_failures.iter().cloned());
        let failures_total = failures.len();
        failures.truncate(MAX_LISTED_FAILURES);
        JobSnapshot {
            id: self.id.clone(),
            title: self.title.clone(),
            state: self.state,
            message: self.message.clone(),
            item_count: self.items.len(),
            items_done: self.count(|state| *state == ItemState::Done),
            items_skipped: self.count(|state| *state == ItemState::Skipped),
            items_failed: self.count(|state| matches!(state, ItemState::Failed(_))),
            bytes_total: self.bytes_total(),
            bytes_done: self.bytes_done(),
            current_name: self.current.map(|index| short_name(&self.items[index].label).to_string()),
            failures,
            failures_total,
        }
    }

    /// Progress of the current item, if one is running.
    pub fn progress_event(&self) -> Option<ProgressEvent> {
        let index = self.current?;
        Some(ProgressEvent {
            job_id: self.id.clone(),
            item_name: short_name(&self.items[index].label).to_string(),
            item_index: index,
            item_count: self.items.len(),
            item_bytes_done: self.current_done,
            item_bytes_total: self.items[index].size,
            job_bytes_done: self.bytes_done(),
            job_bytes_total: self.bytes_total(),
        })
    }
}

fn location_label(location: &Location) -> String {
    match location {
        Location::Local { path } => path.clone(),
        Location::Bucket { bucket, prefix } => format!("{bucket}/{prefix}"),
    }
}

/// "Upload 3 items to bucket/prefix": the verb from the direction (a move is always Move).
pub fn job_title(request: &TransferRequest) -> String {
    let verb = match (request.mode, direction(&request.source, &request.dest)) {
        (Mode::Move, _) => "Move",
        (Mode::Copy, Direction::Upload) => "Upload",
        (Mode::Copy, Direction::Download) => "Download",
        (Mode::Copy, _) => "Copy",
    };
    let count = request.items.len();
    format!("{verb} {count} item{} to {}", if count == 1 { "" } else { "s" }, location_label(&request.dest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfer_plan::{Location, Mode, TopItem, TransferRequest};

    fn model_with(items: &[(&str, u64)]) -> JobModel {
        let mut model = JobModel::new("j1".into(), "Upload".into());
        model.start().unwrap();
        model.set_items(items.iter().map(|(label, size)| ((*label).to_string(), *size, false)).collect());
        model
    }

    #[test]
    fn a_new_job_is_queued_and_starts_once() {
        let mut model = JobModel::new("j1".into(), "t".into());
        assert_eq!(model.state(), JobState::Queued);
        model.start().unwrap();
        assert_eq!(model.state(), JobState::Running);
        assert!(model.start().is_err(), "a running job cannot start again");
    }

    #[test]
    fn items_run_through_pending_running_done_and_failed() {
        let mut model = model_with(&[("/a/one.txt", 10), ("/a/two.txt", 30)]);
        model.begin_item(0).unwrap();
        assert_eq!(model.item_state(0), &ItemState::Running);
        assert!(model.begin_item(1).is_err(), "one item at a time");
        model.item_done(0).unwrap();
        model.begin_item(1).unwrap();
        model.item_failed(1, "denied".into()).unwrap();
        assert_eq!(model.item_state(1), &ItemState::Failed("denied".into()));
        assert!(model.item_done(1).is_err(), "a failed item cannot be done");
        model.finish().unwrap();
        assert_eq!(model.state(), JobState::Failed);
    }

    #[test]
    fn a_job_with_no_failure_finishes_done_and_skipped_items_do_not_count_for_bytes() {
        let mut model = JobModel::new("j".into(), "t".into());
        model.start().unwrap();
        model.set_items(vec![("a".into(), 10, false), ("b".into(), 99, true)]);
        assert_eq!(model.item_state(1), &ItemState::Skipped);
        model.begin_item(0).unwrap();
        model.item_done(0).unwrap();
        model.finish().unwrap();
        assert_eq!(model.state(), JobState::Done);
        assert_eq!((model.bytes_done(), model.bytes_total()), (10, 10));
    }

    #[test]
    fn progress_counts_finished_items_plus_the_current_one_and_never_goes_back() {
        let mut model = model_with(&[("a", 10), ("b", 30)]);
        model.begin_item(0).unwrap();
        model.item_done(0).unwrap();
        model.begin_item(1).unwrap();
        model.progress(12);
        model.progress(5);
        assert_eq!(model.bytes_done(), 22);
        model.progress(1_000);
        assert_eq!(model.bytes_done(), 40, "clamped to the item size");
        assert_eq!(model.bytes_total(), 40);
    }

    #[test]
    fn cancel_queued_is_immediate_and_cancel_running_goes_through_cancelling() {
        let mut queued = JobModel::new("a".into(), "t".into());
        assert_eq!(queued.request_cancel().unwrap(), JobState::Cancelled);
        let mut running = model_with(&[("a", 1)]);
        assert_eq!(running.request_cancel().unwrap(), JobState::Cancelling);
        assert_eq!(running.request_cancel().unwrap(), JobState::Cancelling, "asking twice is harmless");
        running.begin_item(0).unwrap_err(); // no new item once cancelling
        running.finish().unwrap();
        assert_eq!(running.state(), JobState::Cancelled);
    }

    #[test]
    fn a_cancel_puts_the_running_item_back_to_pending() {
        let mut model = model_with(&[("a", 1), ("b", 1)]);
        model.begin_item(0).unwrap();
        model.request_cancel().unwrap();
        model.finish().unwrap();
        assert_eq!(model.item_state(0), &ItemState::Pending);
        assert_eq!(model.snapshot().current_name, None);
    }

    #[test]
    fn illegal_transitions_are_rejected() {
        let mut done = model_with(&[("a", 1)]);
        done.begin_item(0).unwrap();
        done.item_done(0).unwrap();
        done.finish().unwrap();
        assert!(done.request_cancel().is_err(), "a finished job cannot be cancelled");
        assert!(done.retry().is_err(), "a done job is not retried");
        assert!(done.finish().is_err());
        assert!(done.begin_item(0).is_err());
        let mut queued = JobModel::new("q".into(), "t".into());
        assert!(queued.finish().is_err());
        assert!(queued.retry().is_err());
        assert!(queued.begin_item(0).is_err());
        assert!(!queued.can_dismiss());
        let mut running = model_with(&[("a", 1)]);
        assert!(!running.can_dismiss());
        running.request_cancel().unwrap();
        assert!(!running.can_dismiss(), "cancelling is not finished yet");
        let err = done.request_cancel().unwrap_err();
        assert!(err.to_string().contains("done"), "{err}");
    }

    #[test]
    fn retry_requeues_failed_and_cancelled_jobs_and_keeps_finished_items() {
        let mut model = model_with(&[("a", 5), ("b", 5), ("c", 5)]);
        model.begin_item(0).unwrap();
        model.item_done(0).unwrap();
        model.begin_item(1).unwrap();
        model.item_failed(1, "boom".into()).unwrap();
        model.finish().unwrap();
        model.retry().unwrap();
        assert_eq!(model.state(), JobState::Queued);
        assert_eq!(model.item_state(0), &ItemState::Done);
        assert_eq!(model.item_state(1), &ItemState::Pending);
        assert_eq!(model.item_state(2), &ItemState::Pending);
        assert_eq!(model.snapshot().failures.len(), 0);
        model.start().unwrap();
        model.request_cancel().unwrap();
        model.finish().unwrap();
        assert!(model.retry().is_ok(), "a cancelled job can be retried");
    }

    #[test]
    fn a_failure_before_any_item_exists_fails_the_job_with_a_message_and_can_be_retried() {
        let mut model = JobModel::new("j".into(), "t".into());
        model.start().unwrap();
        model.fail("cannot list the folder".into()).unwrap();
        let snapshot = model.snapshot();
        assert_eq!((snapshot.state, snapshot.message.as_deref()), (JobState::Failed, Some("cannot list the folder")));
        model.retry().unwrap();
        assert_eq!(model.snapshot().message, None);
    }

    #[test]
    fn a_note_on_a_pending_item_turns_it_into_a_failed_one_and_a_note_on_a_done_item_is_ignored() {
        let mut model = model_with(&[("a", 1), ("b", 1)]);
        model.begin_item(0).unwrap();
        model.item_done(0).unwrap();
        model.append_to_failure(0, " (ignored)");
        model.append_to_failure(1, " (could not abort)");
        assert_eq!(model.item_state(0), &ItemState::Done);
        assert_eq!(model.item_state(1), &ItemState::Failed("(could not abort)".into()));
    }

    #[test]
    fn extra_failures_make_the_job_failed_and_are_cleared_by_retry() {
        let mut model = model_with(&[("a", 1)]);
        model.begin_item(0).unwrap();
        model.item_done(0).unwrap();
        model.add_failure("bkt/a".into(), "copied, but the source was not deleted".into());
        model.finish().unwrap();
        assert_eq!(model.state(), JobState::Failed);
        assert_eq!(model.snapshot().failures[0].name, "bkt/a");
        model.retry().unwrap();
        assert!(model.snapshot().failures.is_empty());
    }

    #[test]
    fn snapshot_counts_names_and_caps_the_failure_list() {
        let items: Vec<(String, u64, bool)> = (0..300).map(|number| (format!("/dir/file{number}.txt"), 1, false)).collect();
        let mut model = JobModel::new("j".into(), "t".into());
        model.start().unwrap();
        model.set_items(items);
        for number in 0..300 {
            model.begin_item(number).unwrap();
            model.item_failed(number, "no".into()).unwrap();
        }
        model.finish().unwrap();
        let snapshot = model.snapshot();
        assert_eq!((snapshot.item_count, snapshot.items_failed, snapshot.failures_total), (300, 300, 300));
        assert_eq!(snapshot.failures.len(), MAX_LISTED_FAILURES);
        let mut running = model_with(&[("/dir/file.txt", 9)]);
        running.begin_item(0).unwrap();
        assert_eq!(running.snapshot().current_name.as_deref(), Some("file.txt"));
        let event = running.progress_event().unwrap();
        assert_eq!((event.item_name.as_str(), event.item_index, event.item_count, event.item_bytes_total), ("file.txt", 0, 1, 9));
    }

    #[test]
    fn snapshots_and_events_serialize_with_snake_case_states() {
        let model = model_with(&[("a", 1)]);
        let json = serde_json::to_value(model.snapshot()).unwrap();
        assert_eq!(json["state"], "running");
        assert_eq!(json["id"], "j1");
    }

    fn request(source: Location, dest: Location, count: usize, mode: Mode) -> TransferRequest {
        let items = (0..count).map(|number| TopItem { name: format!("f{number}"), is_dir: false, dest_name: None }).collect();
        TransferRequest { source, dest, items, mode }
    }

    #[test]
    fn titles_name_the_direction_the_count_and_the_destination() {
        let local = Location::Local { path: "/home/me".into() };
        let bucket = Location::Bucket { bucket: "alpha".into(), prefix: "in/".into() };
        assert_eq!(job_title(&request(local.clone(), bucket.clone(), 3, Mode::Copy)), "Upload 3 items to alpha/in/");
        assert_eq!(job_title(&request(bucket.clone(), local.clone(), 1, Mode::Copy)), "Download 1 item to /home/me");
        assert_eq!(job_title(&request(local.clone(), bucket.clone(), 2, Mode::Move)), "Move 2 items to alpha/in/");
        assert_eq!(job_title(&request(bucket.clone(), bucket, 2, Mode::Copy)), "Copy 2 items to alpha/in/");
    }
}
