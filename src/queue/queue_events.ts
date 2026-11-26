// Connects the backend events to the queue store, and refreshes the panels when a job finishes.

import { listen } from "@tauri-apps/api/event";
import { useBrowseStore, type Side } from "../browse/browse_store";
import type { Location } from "../ops/ops_api";
import { refreshPanel } from "../ops/panel_refresh";
import { panelLocation } from "../ops/ops_targets";
import { transferList } from "./queue_api";
import { isFinished, type JobSnapshot, type ProgressEvent } from "./queue_logic";
import { useQueueStore, type JobMeta } from "./queue_store";

export const STATE_EVENT = "transfer://state";
export const PROGRESS_EVENT = "transfer://progress";

const sameLocation = (first: Location | null, second: Location): boolean => JSON.stringify(first) === JSON.stringify(second);

/** The panels showing the job's destination (and, for a move, its source) as they are now. */
function panelsToRefresh(meta: JobMeta): Side[] {
  const state = useBrowseStore.getState();
  const shown = (location: Location) => (["left", "right"] as Side[]).filter((side) => sameLocation(panelLocation(state[side]), location));
  return [...new Set([...shown(meta.dest), ...(meta.mode === "move" ? shown(meta.source) : [])])];
}

/** Once per finished state, when both the finished job and what the flow registered about it are known. */
function refreshIfFinished(jobId: string): void {
  const queue = useQueueStore.getState();
  const job = queue.jobs.find((entry) => entry.snapshot.id === jobId);
  const meta = queue.meta[jobId];
  if (!job || !meta || !isFinished(job.snapshot.state) || queue.refreshed[jobId]) return;
  queue.markRefreshed(jobId);
  panelsToRefresh(meta).forEach((side) => void refreshPanel(side));
}

/** The flow that started the job tells where it was going; the job may already have finished. */
export function registerJob(jobId: string, meta: JobMeta): void {
  useQueueStore.getState().setMeta(jobId, meta);
  refreshIfFinished(jobId);
}

function onState(snapshot: JobSnapshot): void {
  useQueueStore.getState().applyState(snapshot);
  refreshIfFinished(snapshot.id);
}

/** Start listening (and load the jobs the backend already holds). The returned function stops it. */
export async function attachQueueEvents(): Promise<() => void> {
  const stops = await Promise.all([
    listen<JobSnapshot>(STATE_EVENT, (event) => onState(event.payload)),
    listen<ProgressEvent>(PROGRESS_EVENT, (event) => useQueueStore.getState().applyProgress(event.payload)),
  ]);
  try {
    (await transferList()).forEach(onState);
  } catch {
    // The events still arrive; the list only seeds jobs from before this page loaded.
  }
  return () => stops.forEach((stop) => stop());
}
