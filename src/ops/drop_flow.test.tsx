// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore } from "../browse/browse_store";
import * as api from "./ops_api";
import * as queueApi from "../queue/queue_api";
import * as queueEvents from "../queue/queue_events";
import { confirmPlan, startTransferOf } from "./ops_flow";
import { useOpsStore } from "./ops_store";

vi.mock("./ops_api");
vi.mock("../browse/browse_api");
vi.mock("../queue/queue_api");
vi.mock("../queue/queue_events");

const operation = {
  side: "left" as const,
  destSide: "right" as const,
  source: { kind: "local" as const, path: "/home/u" },
  dest: { kind: "bucket" as const, bucket: "alpha", prefix: "in/docs/" },
  items: [{ name: "a.txt", is_dir: false }],
};

beforeEach(() => {
  vi.clearAllMocks();
  useBrowseStore.setState({ ...initialBrowseState(), left: emptyPanel(), right: emptyPanel(), profileId: "p1" });
  useOpsStore.setState({ dialog: null });
  vi.mocked(api.transferPreview).mockResolvedValue({ direction: "upload", files: 1, dirs: 0, total_bytes: 1, conflict_count: 0, conflicts: [] });
});

describe("startTransferOf (drop entry point)", () => {
  it("previews the given operation and opens the same plan dialog as F5/F6", async () => {
    await startTransferOf(operation, "move");
    expect(api.transferPreview).toHaveBeenCalledWith("p1", { source: operation.source, dest: operation.dest, items: operation.items, mode: "move" });
    expect(useOpsStore.getState().dialog).toMatchObject({ kind: "plan", side: "left", destSide: "right" });
  });
  it("confirming the dropped plan starts a job and closes the dialog at once", async () => {
    vi.mocked(queueApi.transferStart).mockResolvedValue("job-9");
    await startTransferOf(operation, "copy");
    await confirmPlan();
    expect(queueApi.transferStart).toHaveBeenCalledWith("p1", { source: operation.source, dest: operation.dest, items: operation.items, mode: "copy" }, { per_item: {}, default: null });
    expect(queueEvents.registerJob).toHaveBeenCalledWith("job-9", { source: operation.source, dest: operation.dest, mode: "copy" });
    expect(useOpsStore.getState().dialog).toBeNull();
  });
  it("does nothing while another dialog is open", async () => {
    useOpsStore.setState({ dialog: { kind: "busy", label: "x" } });
    await startTransferOf(operation, "copy");
    expect(api.transferPreview).not.toHaveBeenCalled();
  });
});
