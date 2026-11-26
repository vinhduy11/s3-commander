// Test fixtures for the queue: a job snapshot with sensible defaults.
import type { JobSnapshot } from "./queue_logic";

export const snapshot = (overrides: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id: "job-1",
  title: "Upload 3 items to alpha/in/",
  state: "running",
  message: null,
  item_count: 3,
  items_done: 0,
  items_skipped: 0,
  items_failed: 0,
  bytes_total: 1000,
  bytes_done: 0,
  current_name: null,
  failures: [],
  failures_total: 0,
  ...overrides,
});
