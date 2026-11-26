// The queue's state: the jobs in start order, whether the panel is expanded, and what the flows
// registered about each job (where it was going), so a finished job can refresh the right panels.
// Updated only from the backend events and the panel's own buttons; holds no secrets.

import { create } from "zustand";
import type { Location, Mode } from "../ops/ops_api";
import { applyProgressEvent, applyStateEvent, isFinished, removeJob, type JobSnapshot, type ProgressEvent, type QueueJob } from "./queue_logic";

export type JobMeta = { source: Location; dest: Location; mode: Mode };

type QueueState = {
  jobs: QueueJob[];
  expanded: boolean;
  meta: Record<string, JobMeta>;
  /** Jobs whose panels were refreshed for their current finished state. */
  refreshed: Record<string, true>;
  applyState: (snapshot: JobSnapshot) => void;
  applyProgress: (event: ProgressEvent, nowMs?: number) => void;
  setMeta: (jobId: string, meta: JobMeta) => void;
  markRefreshed: (jobId: string) => void;
  remove: (jobId: string) => void;
  setExpanded: (expanded: boolean) => void;
  clear: () => void;
};

const initial = { jobs: [], expanded: false, meta: {}, refreshed: {} };

export const useQueueStore = create<QueueState>((set) => ({
  ...initial,
  applyState: (snapshot) =>
    set((state) => {
      // A job that runs again (Retry) must refresh its panels again when it finishes again.
      const refreshed = { ...state.refreshed };
      if (!isFinished(snapshot.state)) delete refreshed[snapshot.id];
      return { jobs: applyStateEvent(state.jobs, snapshot), refreshed };
    }),
  applyProgress: (event, nowMs = Date.now()) => set((state) => ({ jobs: applyProgressEvent(state.jobs, event, nowMs) })),
  setMeta: (jobId, meta) => set((state) => ({ meta: { ...state.meta, [jobId]: meta } })),
  markRefreshed: (jobId) => set((state) => ({ refreshed: { ...state.refreshed, [jobId]: true } })),
  remove: (jobId) =>
    set((state) => {
      const { [jobId]: _meta, ...meta } = state.meta;
      const { [jobId]: _refreshed, ...refreshed } = state.refreshed;
      return { jobs: removeJob(state.jobs, jobId), meta, refreshed };
    }),
  setExpanded: (expanded) => set({ expanded }),
  clear: () => set({ ...initial }),
}));
