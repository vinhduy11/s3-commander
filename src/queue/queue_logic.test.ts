import { describe, expect, it } from "vitest";
import {
  SPEED_WINDOW_MS,
  applyProgressEvent,
  applyStateEvent,
  buttonsFor,
  etaSeconds,
  formatEta,
  formatSpeed,
  jobBytes,
  removeJob,
  speedOf,
  statusText,
  type JobState,
  type ProgressEvent,
  type QueueJob,
} from "./queue_logic";
import { snapshot } from "./queue_fixtures";

const progress = (overrides: Partial<ProgressEvent> = {}): ProgressEvent => ({
  job_id: "job-1",
  item_name: "big.bin",
  item_index: 0,
  item_count: 3,
  item_bytes_done: 100,
  item_bytes_total: 500,
  job_bytes_done: 100,
  job_bytes_total: 1000,
  ...overrides,
});

const job = (overrides: Partial<ReturnType<typeof snapshot>> = {}): QueueJob => ({ snapshot: snapshot(overrides), progress: null, samples: [] });

describe("event reducer", () => {
  it("a state event adds a new job at the end and replaces a known one in place", () => {
    const first = applyStateEvent([], snapshot({ id: "a" }));
    const two = applyStateEvent(first, snapshot({ id: "b" }));
    expect(two.map((entry) => entry.snapshot.id)).toEqual(["a", "b"]);
    const replaced = applyStateEvent(two, snapshot({ id: "a", state: "done" }));
    expect(replaced.map((entry) => [entry.snapshot.id, entry.snapshot.state])).toEqual([["a", "done"], ["b", "running"]]);
  });

  it("a progress event updates the running job and records a speed sample", () => {
    const jobs = applyProgressEvent([job()], progress(), 1000);
    expect(jobs[0].progress).toMatchObject({ item_name: "big.bin", job_bytes_done: 100 });
    expect(jobs[0].samples).toEqual([{ at: 1000, bytes: 100 }]);
  });

  it("progress for an unknown job or a finished job is ignored", () => {
    expect(applyProgressEvent([job({ id: "x" })], progress(), 1)).toEqual([job({ id: "x" })]);
    const done = [job({ state: "done" })];
    expect(applyProgressEvent(done, progress(), 1)).toBe(done);
  });

  it("samples older than the window are dropped", () => {
    let jobs = applyProgressEvent([job()], progress({ job_bytes_done: 10 }), 0);
    jobs = applyProgressEvent(jobs, progress({ job_bytes_done: 20 }), 1000);
    jobs = applyProgressEvent(jobs, progress({ job_bytes_done: 30 }), SPEED_WINDOW_MS + 1500);
    expect(jobs[0].samples.map((sample) => sample.bytes)).toEqual([30]);
  });

  it("a state event that leaves running clears the progress and the samples; running keeps them", () => {
    const running = applyProgressEvent([job()], progress(), 1000);
    expect(applyStateEvent(running, snapshot({ state: "running" }))[0].samples).toHaveLength(1);
    const failed = applyStateEvent(running, snapshot({ state: "failed" }));
    expect(failed[0].samples).toEqual([]);
    expect(failed[0].progress).toBeNull();
  });

  it("removeJob drops one job", () => {
    expect(removeJob([job({ id: "a" }), job({ id: "b" })], "a").map((entry) => entry.snapshot.id)).toEqual(["b"]);
  });

  it("bytes shown never go below what the last progress event said", () => {
    const running = applyProgressEvent([job({ bytes_done: 50 })], progress({ job_bytes_done: 300 }), 5);
    expect(jobBytes(running[0])).toEqual({ done: 300, total: 1000 });
    expect(jobBytes(applyStateEvent(running, snapshot({ state: "done", bytes_done: 1000 }))[0])).toEqual({ done: 1000, total: 1000 });
  });
});

describe("speed and ETA", () => {
  it("speed is bytes over time between the first and last sample of the window", () => {
    expect(speedOf([{ at: 0, bytes: 0 }, { at: 1000, bytes: 1000 }, { at: 2000, bytes: 3000 }])).toBe(1500);
  });

  it("no speed with fewer than two samples or no time between them", () => {
    expect(speedOf([])).toBeNull();
    expect(speedOf([{ at: 0, bytes: 5 }])).toBeNull();
    expect(speedOf([{ at: 7, bytes: 5 }, { at: 7, bytes: 9 }])).toBeNull();
  });

  it("a speed of zero (stalled) is reported as zero, not as unknown", () => {
    expect(speedOf([{ at: 0, bytes: 5 }, { at: 1000, bytes: 5 }])).toBe(0);
  });

  it("ETA is the remaining bytes over the speed, rounded up; unknown without a speed", () => {
    expect(etaSeconds(3000, 1000)).toBe(3);
    expect(etaSeconds(2500, 1000)).toBe(3);
    expect(etaSeconds(0, 1000)).toBe(0);
    expect(etaSeconds(100, 0)).toBeNull();
    expect(etaSeconds(100, null)).toBeNull();
  });

  it("formats speed and time", () => {
    expect(formatSpeed(1536)).toBe("1.5 KB/s");
    expect(formatSpeed(0)).toBe("0 B/s");
    expect(formatEta(5)).toBe("0:05");
    expect(formatEta(65)).toBe("1:05");
    expect(formatEta(3725)).toBe("1:02:05");
    expect(formatEta(null)).toBe("");
  });
});

describe("status text and buttons", () => {
  it("is Idle with no active job", () => {
    expect(statusText([])).toBe("Idle");
    expect(statusText([job({ state: "done" })])).toBe("Idle");
  });

  it("counts running and queued jobs with the overall percentage of the running ones", () => {
    const jobs = [job({ id: "a", bytes_total: 1000, bytes_done: 400 }), job({ id: "b", bytes_total: 1000, bytes_done: 400 }), job({ id: "c", state: "queued", bytes_total: 0 })];
    expect(statusText(jobs)).toBe("2 running, 1 queued, 40%");
  });

  it("omits what is zero, counts cancelling as running, and mentions failures when idle", () => {
    expect(statusText([job({ state: "queued", bytes_total: 0 })])).toBe("1 queued");
    expect(statusText([job({ state: "cancelling", bytes_total: 0 })])).toBe("1 running");
    expect(statusText([job({ state: "failed" }), job({ id: "b", state: "done" })])).toBe("Idle, 1 failed");
  });

  it.each<[JobState, string[]]>([
    ["queued", ["cancel"]],
    ["running", ["cancel"]],
    ["cancelling", []],
    ["failed", ["retry", "dismiss"]],
    ["cancelled", ["retry", "dismiss"]],
    ["done", ["dismiss"]],
  ])("a %s job offers %j", (state, expected) => {
    expect(buttonsFor(state)).toEqual(expected);
  });
});
