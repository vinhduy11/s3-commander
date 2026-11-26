// The transfer queue, docked above the function-key bar: a one-line status that expands into one
// row per job (progress, speed, ETA, Cancel / Retry / Dismiss, failures). Esc collapses it.

import { useRef, useState, type KeyboardEvent } from "react";
import { formatSize } from "../browse/navigation";
import { ChevronIcon } from "../icons";
import { showToast } from "../ops/toast";
import { transferCancel, transferDismiss, transferRetry } from "./queue_api";
import { buttonsFor, etaSeconds, formatEta, formatSpeed, isFinished, jobBytes, speedOf, statusText, type JobAction, type JobState, type QueueJob } from "./queue_logic";
import { useQueueStore } from "./queue_store";

const STATE_LABEL: Record<JobState, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
};
const ACTION_LABEL: Record<JobAction, string> = { cancel: "Cancel", retry: "Retry", dismiss: "Dismiss" };

/** Runs a queue command; a failure is told in a toast (it is not tied to any dialog). */
async function runCommand(command: Promise<void>): Promise<void> {
  try {
    await command;
  } catch (err) {
    showToast(String(err), false);
  }
}

async function runAction(action: JobAction, jobId: string): Promise<void> {
  if (action === "cancel") return runCommand(transferCancel(jobId));
  if (action === "retry") return runCommand(transferRetry(jobId));
  // The backend forgets a job even when aborting its kept upload fails, so the row goes either way.
  await runCommand(transferDismiss(jobId));
  useQueueStore.getState().remove(jobId);
}

function FailureList({ job }: { job: QueueJob }) {
  const { failures, failures_total: total } = job.snapshot;
  return (
    <ul className="queue-failures" aria-label="Failed items">
      {failures.map((failure) => (
        <li key={failure.name + failure.message}>
          <span className="mono wrap-anywhere">{failure.name}</span>
          <span className="muted">{failure.message}</span>
        </li>
      ))}
      {total > failures.length && <li className="muted">and {total - failures.length} more</li>}
    </ul>
  );
}

function JobRow({ job }: { job: QueueJob }) {
  const [showFailures, setShowFailures] = useState(false);
  const { snapshot } = job;
  const { done, total } = jobBytes(job);
  const percent = total > 0 ? Math.min(100, Math.floor((done * 100) / total)) : 0;
  const speed = snapshot.state === "running" ? speedOf(job.samples) : null;
  const eta = etaSeconds(total - done, speed);
  const currentName = job.progress?.item_name ?? snapshot.current_name;
  const itemText = job.progress && snapshot.state === "running" ? `Item ${job.progress.item_index + 1} of ${job.progress.item_count}` : `${snapshot.items_done + snapshot.items_skipped} of ${snapshot.item_count} items`;
  const facts = [
    total > 0 && `${formatSize(done)} / ${formatSize(total)}`,
    speed !== null && formatSpeed(speed),
    eta !== null && snapshot.state === "running" && formatEta(eta),
    snapshot.item_count > 0 && itemText,
    snapshot.items_skipped > 0 && `${snapshot.items_skipped} skipped`,
  ].filter(Boolean);
  return (
    <div className="queue-row" role="listitem" data-state={snapshot.state}>
      <div className="queue-line">
        <span className="queue-title" title={snapshot.title}>{snapshot.title}</span>
        <span className="queue-state">{STATE_LABEL[snapshot.state]}</span>
        <span className="queue-actions">
          {buttonsFor(snapshot.state).map((action) => (
            <button key={action} type="button" onClick={() => void runAction(action, snapshot.id)}>{ACTION_LABEL[action]}</button>
          ))}
        </span>
      </div>
      <div className="queue-bar" role="progressbar" aria-label={`Progress of ${snapshot.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="queue-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="queue-meta muted">
        {currentName && snapshot.state === "running" && <span className="queue-current mono" title={currentName}>{currentName}</span>}
        {facts.map((fact) => <span key={String(fact)}>{fact}</span>)}
      </div>
      {snapshot.message && <div className="alert-text">{snapshot.message}</div>}
      {isFinished(snapshot.state) && snapshot.failures_total > 0 && (
        <>
          <button type="button" className="queue-link" aria-expanded={showFailures} onClick={() => setShowFailures(!showFailures)}>
            {snapshot.failures_total} failed
          </button>
          {showFailures && <FailureList job={job} />}
        </>
      )}
    </div>
  );
}

export function TransferQueuePanel() {
  const jobs = useQueueStore((state) => state.jobs);
  const expanded = useQueueStore((state) => state.expanded);
  const headRef = useRef<HTMLButtonElement>(null);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !expanded) return;
    event.stopPropagation();
    useQueueStore.getState().setExpanded(false);
    headRef.current?.focus();
  }

  return (
    <section className="queue" aria-label="Transfers" onKeyDown={onKeyDown}>
      <button ref={headRef} type="button" className="queue-head" aria-expanded={expanded} aria-controls="queue-body" onClick={() => useQueueStore.getState().setExpanded(!expanded)}>
        <ChevronIcon open={expanded} />
        <span className="queue-heading">Transfers</span>
        <span className="muted" role="status">{statusText(jobs)}</span>
      </button>
      {expanded && (
        <div id="queue-body" className="queue-body" role="list">
          {jobs.length === 0 && <div className="queue-empty muted">No transfers.</div>}
          {jobs.map((job) => <JobRow key={job.snapshot.id} job={job} />)}
        </div>
      )}
    </section>
  );
}
