// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "../browse/browse_store";
import * as panelLoader from "../browse/panel_loader";
import { snapshot } from "./queue_fixtures";
import * as queueApi from "./queue_api";
import { attachQueueEvents, registerJob } from "./queue_events";
import { useQueueStore } from "./queue_store";

type Handler = (event: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    handlers.set(name, handler);
    return unlisten;
  }),
}));
vi.mock("./queue_api");
vi.mock("../browse/panel_loader", () => ({ openPath: vi.fn(async () => undefined) }));

const emit = (name: string, payload: unknown) => handlers.get(name)?.({ payload });
const file = (name: string): PanelEntry => ({ name, isDir: false, size: 1, modified: 1 });
const meta = { source: { kind: "local" as const, path: "/home/me" }, dest: { kind: "bucket" as const, bucket: "alpha", prefix: "in/" } };

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  useQueueStore.getState().clear();
  vi.mocked(queueApi.transferList).mockResolvedValue([]);
  useBrowseStore.setState({
    ...initialBrowseState(),
    profileId: "p1",
    left: { ...emptyPanel(), source: { kind: "local" }, path: "/home/me", entries: [file("a.txt")], cursor: 1 },
    right: { ...emptyPanel(), source: { kind: "bucket", bucket: "alpha" }, path: "in/", entries: [file("old.txt")], cursor: 1 },
  });
});

describe("queue events", () => {
  it("listens to both events, feeds the store and unlistens on stop", async () => {
    const stop = await attachQueueEvents();
    emit("transfer://state", snapshot({ id: "j1" }));
    emit("transfer://progress", { job_id: "j1", item_name: "a.txt", item_index: 0, item_count: 3, item_bytes_done: 5, item_bytes_total: 10, job_bytes_done: 5, job_bytes_total: 1000 });
    expect(useQueueStore.getState().jobs[0].snapshot.id).toBe("j1");
    expect(useQueueStore.getState().jobs[0].progress?.item_name).toBe("a.txt");
    stop();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });

  it("seeds the store from the jobs the backend already holds", async () => {
    vi.mocked(queueApi.transferList).mockResolvedValue([snapshot({ id: "old", state: "failed" })]);
    await attachQueueEvents();
    expect(useQueueStore.getState().jobs.map((entry) => entry.snapshot.id)).toEqual(["old"]);
  });

  it("a finished upload refreshes the destination panel only, once", async () => {
    await attachQueueEvents();
    registerJob("j1", { ...meta, mode: "copy" });
    emit("transfer://state", snapshot({ id: "j1", state: "running" }));
    expect(panelLoader.openPath).not.toHaveBeenCalled();
    emit("transfer://state", snapshot({ id: "j1", state: "done" }));
    emit("transfer://state", snapshot({ id: "j1", state: "done" }));
    expect(panelLoader.openPath).toHaveBeenCalledTimes(1);
    expect(panelLoader.openPath).toHaveBeenCalledWith("right", "in/", undefined);
  });

  it("a finished move refreshes both panels; failed and cancelled jobs refresh too", async () => {
    await attachQueueEvents();
    registerJob("j1", { ...meta, mode: "move" });
    emit("transfer://state", snapshot({ id: "j1", state: "failed" }));
    expect(vi.mocked(panelLoader.openPath).mock.calls.map((call) => call[0]).sort()).toEqual(["left", "right"]);
    registerJob("j2", { ...meta, mode: "copy" });
    emit("transfer://state", snapshot({ id: "j2", state: "cancelled" }));
    expect(panelLoader.openPath).toHaveBeenCalledTimes(3);
  });

  it("the cursor row is kept after a refresh", async () => {
    await attachQueueEvents();
    useBrowseStore.getState().setCursor("right", 1);
    registerJob("j1", { ...meta, mode: "copy" });
    emit("transfer://state", snapshot({ id: "j1", state: "done" }));
    await Promise.resolve();
    expect(useBrowseStore.getState().right.cursor).toBe(1);
  });

  it("a panel that moved elsewhere is not refreshed", async () => {
    await attachQueueEvents();
    useBrowseStore.setState({ right: { ...useBrowseStore.getState().right, path: "other/" } });
    registerJob("j1", { ...meta, mode: "copy" });
    emit("transfer://state", snapshot({ id: "j1", state: "done" }));
    expect(panelLoader.openPath).not.toHaveBeenCalled();
  });

  it("a job that finished before its id was registered is refreshed at registration", async () => {
    await attachQueueEvents();
    emit("transfer://state", snapshot({ id: "j1", state: "done" }));
    expect(panelLoader.openPath).not.toHaveBeenCalled();
    registerJob("j1", { ...meta, mode: "copy" });
    expect(panelLoader.openPath).toHaveBeenCalledTimes(1);
  });

  it("a retried job refreshes again when it finishes again", async () => {
    await attachQueueEvents();
    registerJob("j1", { ...meta, mode: "copy" });
    emit("transfer://state", snapshot({ id: "j1", state: "failed" }));
    emit("transfer://state", snapshot({ id: "j1", state: "queued" }));
    emit("transfer://state", snapshot({ id: "j1", state: "done" }));
    expect(panelLoader.openPath).toHaveBeenCalledTimes(2);
  });
});

describe("queue store", () => {
  it("clear forgets jobs and collapses; remove drops one job and its meta", () => {
    useQueueStore.getState().applyState(snapshot({ id: "a" }));
    useQueueStore.getState().applyState(snapshot({ id: "b" }));
    useQueueStore.getState().setExpanded(true);
    useQueueStore.getState().remove("a");
    expect(useQueueStore.getState().jobs.map((entry) => entry.snapshot.id)).toEqual(["b"]);
    useQueueStore.getState().clear();
    expect(useQueueStore.getState()).toMatchObject({ jobs: [], expanded: false });
  });
});
