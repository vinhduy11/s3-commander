// Pure logic of the transfer queue: the job types (mirror of the Rust snapshots), the reducer for
// the `transfer://state` and `transfer://progress` events, speed and ETA, the status line and
// which buttons a job state offers. No React, no Tauri, no store.

import { formatSize } from "../browse/navigation";

export type JobState = "queued" | "running" | "done" | "failed" | "cancelling" | "cancelled";
export type ItemFailure = { name: string; message: string };

/** `transfer://state`: the job as the backend sees it now. */
export type JobSnapshot = {
  id: string;
  title: string;
  state: JobState;
  message: string | null;
  item_count: number;
  items_done: number;
  items_skipped: number;
  items_failed: number;
  bytes_total: number;
  bytes_done: number;
  current_name: string | null;
  failures: ItemFailure[];
  failures_total: number;
};

/** `transfer://progress`: throttled by the backend to about 10 per second per job. */
export type ProgressEvent = {
  job_id: string;
  item_name: string;
  item_index: number;
  item_count: number;
  item_bytes_done: number;
  item_bytes_total: number;
  job_bytes_done: number;
  job_bytes_total: number;
};

export type Sample = { at: number; bytes: number };
export type QueueJob = { snapshot: JobSnapshot; progress: ProgressEvent | null; samples: Sample[] };
export type JobAction = "cancel" | "retry" | "dismiss";

/** Speed is measured over the last few seconds, so it follows the transfer but does not jump. */
export const SPEED_WINDOW_MS = 5000;

export const isFinished = (state: JobState) => state === "done" || state === "failed" || state === "cancelled";

/** A state event adds a job at the end or replaces it in place; progress only survives while it keeps running. */
export function applyStateEvent(jobs: QueueJob[], incoming: JobSnapshot): QueueJob[] {
  const stillRunning = incoming.state === "running";
  const known = jobs.some((entry) => entry.snapshot.id === incoming.id);
  if (!known) return [...jobs, { snapshot: incoming, progress: null, samples: [] }];
  return jobs.map((entry) =>
    entry.snapshot.id !== incoming.id
      ? entry
      : { snapshot: incoming, progress: stillRunning ? entry.progress : null, samples: stillRunning ? entry.samples : [] },
  );
}

/** Progress for a running job; unknown and finished jobs are ignored (a late event must not revive a row). */
export function applyProgressEvent(jobs: QueueJob[], event: ProgressEvent, nowMs: number): QueueJob[] {
  const target = jobs.find((entry) => entry.snapshot.id === event.job_id);
  if (!target || target.snapshot.state !== "running") return jobs;
  const samples = [...target.samples, { at: nowMs, bytes: event.job_bytes_done }].filter((sample) => sample.at >= nowMs - SPEED_WINDOW_MS);
  return jobs.map((entry) => (entry === target ? { ...entry, progress: event, samples } : entry));
}

export const removeJob = (jobs: QueueJob[], jobId: string): QueueJob[] => jobs.filter((entry) => entry.snapshot.id !== jobId);

/** Bytes of the job: the newer of the last state event and the last progress event. */
export function jobBytes(job: QueueJob): { done: number; total: number } {
  return {
    done: Math.max(job.snapshot.bytes_done, job.progress?.job_bytes_done ?? 0),
    total: Math.max(job.snapshot.bytes_total, job.progress?.job_bytes_total ?? 0),
  };
}

/** Bytes per second between the first and last sample of the window; null until there are two. */
export function speedOf(samples: Sample[]): number | null {
  if (samples.length < 2) return null;
  const [first, last] = [samples[0], samples[samples.length - 1]];
  return last.at > first.at ? ((last.bytes - first.bytes) * 1000) / (last.at - first.at) : null;
}

/** Whole seconds left at `speed`; null while the speed is unknown or zero. */
export function etaSeconds(remainingBytes: number, speed: number | null): number | null {
  if (remainingBytes <= 0) return 0;
  return speed && speed > 0 ? Math.ceil(remainingBytes / speed) : null;
}

export const formatSpeed = (bytesPerSecond: number): string => `${formatSize(Math.round(bytesPerSecond))}/s`;

export function formatEta(seconds: number | null): string {
  if (seconds === null) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  const [hours, minutes, rest] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** The collapsed one-liner: "Idle", or "2 running, 1 queued, 40%". */
export function statusText(jobs: QueueJob[]): string {
  const running = jobs.filter((entry) => entry.snapshot.state === "running" || entry.snapshot.state === "cancelling");
  const queued = jobs.filter((entry) => entry.snapshot.state === "queued");
  if (!running.length && !queued.length) {
    const failed = jobs.filter((entry) => entry.snapshot.state === "failed").length;
    return failed ? `Idle, ${failed} failed` : "Idle";
  }
  const totals = running.map(jobBytes).reduce((sum, bytes) => ({ done: sum.done + bytes.done, total: sum.total + bytes.total }), { done: 0, total: 0 });
  const parts = [];
  if (running.length) parts.push(`${running.length} running`);
  if (queued.length) parts.push(`${queued.length} queued`);
  if (totals.total > 0) parts.push(`${Math.floor((totals.done * 100) / totals.total)}%`);
  return parts.join(", ");
}

const BUTTONS: Record<JobState, JobAction[]> = {
  queued: ["cancel"],
  running: ["cancel"],
  cancelling: [],
  failed: ["retry", "dismiss"],
  cancelled: ["retry", "dismiss"],
  done: ["dismiss"],
};

export const buttonsFor = (state: JobState): JobAction[] => BUTTONS[state];
