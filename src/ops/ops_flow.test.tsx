// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "../browse/browse_store";
import type { ConflictInfo, PlanSummary, RunReport } from "./ops_api";
import * as api from "./ops_api";
import * as browseApi from "../browse/browse_api";
import {
  cancelDialog,
  confirmDelete,
  confirmPlan,
  resolveAllConflicts,
  resolveConflict,
  startDelete,
  startNewFolder,
  startRename,
  startTransfer,
  submitName,
} from "./ops_flow";
import { OpsDialogs } from "./ops_dialogs";
import { useOpsStore } from "./ops_store";

vi.mock("./ops_api");
vi.mock("../browse/browse_api");

const file = (name: string, size = 1): PanelEntry => ({ name, isDir: false, size, modified: 1 });
const ops = () => useOpsStore.getState();
const dialog = () => ops().dialog;

const conflict = (name: string): ConflictInfo => ({
  dest: `alpha/in/${name}`,
  incoming_size: 5,
  incoming_modified: 100,
  existing_size: 3,
  existing_modified: 50,
});
const summary = (conflicts: ConflictInfo[] = []): PlanSummary => ({
  direction: "upload",
  files: 3,
  dirs: 0,
  total_bytes: 30,
  conflict_count: conflicts.length,
  conflicts,
  too_large_count: 0,
});
const report = (overrides: Partial<RunReport> = {}): RunReport => ({ transferred: 3, skipped: 0, bytes: 30, sources_removed: 0, failed: [], ...overrides });

function setupPanels() {
  useBrowseStore.setState({
    ...initialBrowseState(),
    profileId: "p1",
    active: "left",
    left: { ...emptyPanel(), source: { kind: "local" }, path: "/home/me", entries: [file("a.txt"), file("b.txt"), file("c.txt")], cursor: 3 },
    right: { ...emptyPanel(), source: { kind: "bucket", bucket: "alpha" }, path: "in/", entries: [file("old.txt")], cursor: 1 },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  setupPanels();
  ops().setDialog(null);
  vi.mocked(browseApi.listLocalDir).mockResolvedValue({ path: "/home/me", entries: [file("a.txt")] });
  vi.mocked(browseApi.listBucketDir).mockResolvedValue({ entries: [file("a.txt")], nextToken: null });
});

describe("copy and move flow", () => {
  it("shows a plan dialog from the preview of the marked items, with the other panel as destination", async () => {
    useBrowseStore.getState().toggleMark("left", "a.txt");
    useBrowseStore.getState().toggleMark("left", "b.txt");
    vi.mocked(api.transferPreview).mockResolvedValue(summary());
    await startTransfer("copy");
    expect(api.transferPreview).toHaveBeenCalledWith("p1", {
      source: { kind: "local", path: "/home/me" },
      dest: { kind: "bucket", bucket: "alpha", prefix: "in/" },
      items: [
        { name: "a.txt", is_dir: false },
        { name: "b.txt", is_dir: false },
      ],
      mode: "copy",
    });
    expect(dialog()).toMatchObject({ kind: "plan", summary: { files: 3 } });
  });

  it("without marks it operates on the cursor item; a preview error becomes a result dialog", async () => {
    vi.mocked(api.transferPreview).mockRejectedValue("bucket does not exist");
    await startTransfer("move");
    expect(vi.mocked(api.transferPreview).mock.calls[0][1].items).toEqual([{ name: "c.txt", is_dir: false }]);
    expect(dialog()).toMatchObject({ kind: "result", failed: [], lines: ["bucket does not exist"] });
  });

  it("without conflicts, confirming the plan runs once and refreshes the destination, clearing the source marks", async () => {
    useBrowseStore.getState().toggleMark("left", "a.txt");
    vi.mocked(api.transferPreview).mockResolvedValue(summary());
    vi.mocked(api.transferExecute).mockResolvedValue(report());
    await startTransfer("copy");
    await confirmPlan();
    expect(api.transferExecute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.transferExecute).mock.calls[0][2]).toEqual({ per_item: {}, default: null });
    expect(browseApi.listBucketDir).toHaveBeenCalledWith("p1", "alpha", "in/", null);
    expect(browseApi.listLocalDir).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("a move refreshes both panels and clears the source marks", async () => {
    useBrowseStore.getState().toggleMark("left", "a.txt");
    vi.mocked(api.transferPreview).mockResolvedValue(summary());
    vi.mocked(api.transferExecute).mockResolvedValue(report({ sources_removed: 1 }));
    await startTransfer("move");
    await confirmPlan();
    expect(browseApi.listLocalDir).toHaveBeenCalledWith("/home/me");
    expect(browseApi.listBucketDir).toHaveBeenCalled();
    expect(useBrowseStore.getState().left.marked).toEqual({});
  });

  it("per-failure items are listed in a result dialog instead of being swallowed", async () => {
    vi.mocked(api.transferPreview).mockResolvedValue(summary());
    vi.mocked(api.transferExecute).mockResolvedValue(report({ failed: [{ name: "a.txt", message: "access denied" }] }));
    await startTransfer("copy");
    await confirmPlan();
    expect(dialog()).toMatchObject({ kind: "result", failed: [{ name: "a.txt", message: "access denied" }] });
    // the panel is still refreshed so the partial result is visible
    expect(browseApi.listBucketDir).toHaveBeenCalled();
  });

  it("a rejected run is shown too and the dialog never stays busy", async () => {
    vi.mocked(api.transferPreview).mockResolvedValue(summary());
    vi.mocked(api.transferExecute).mockRejectedValue("conflict not resolved");
    await startTransfer("copy");
    await confirmPlan();
    expect(dialog()).toMatchObject({ kind: "result", lines: ["conflict not resolved"] });
  });
});

describe("conflict resolution", () => {
  const three = [conflict("a.txt"), conflict("b.txt"), conflict("c.txt")];

  async function openConflicts() {
    vi.mocked(api.transferPreview).mockResolvedValue(summary(three));
    vi.mocked(api.transferExecute).mockResolvedValue(report());
    await startTransfer("copy");
    await confirmPlan();
  }

  it("walks through the conflicts one at a time and runs only after the last one is decided", async () => {
    await openConflicts();
    expect(dialog()).toMatchObject({ kind: "conflicts", index: 0 });
    await resolveConflict("overwrite");
    expect(dialog()).toMatchObject({ kind: "conflicts", index: 1 });
    await resolveConflict("skip");
    expect(api.transferExecute).not.toHaveBeenCalled();
    await resolveConflict("keep_both");
    expect(api.transferExecute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.transferExecute).mock.calls[0][2]).toEqual({
      per_item: { "alpha/in/a.txt": "overwrite", "alpha/in/b.txt": "skip", "alpha/in/c.txt": "keep_both" },
      default: null,
    });
  });

  it.each(["overwrite", "skip", "keep_both"] as const)("'%s all' resolves every remaining conflict at once", async (policy) => {
    await openConflicts();
    await resolveConflict("skip");
    await resolveAllConflicts(policy);
    expect(api.transferExecute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.transferExecute).mock.calls[0][2]).toEqual({ per_item: { "alpha/in/a.txt": "skip" }, default: policy });
  });

  it("Cancel aborts the whole operation before anything runs", async () => {
    await openConflicts();
    await resolveConflict("overwrite");
    cancelDialog();
    expect(dialog()).toBeNull();
    expect(api.transferExecute).not.toHaveBeenCalled();
    expect(browseApi.listBucketDir).not.toHaveBeenCalled();
  });
});

describe("delete flow", () => {
  it("asks for confirmation: permanent on a server panel, Trash on a local one", () => {
    startDelete("left");
    expect(dialog()).toMatchObject({ kind: "delete", permanent: false, items: [{ name: "c.txt" }] });
    cancelDialog();
    startDelete("right");
    expect(dialog()).toMatchObject({ kind: "delete", permanent: true, items: [{ name: "old.txt" }] });
  });

  it("confirming deletes the marked items and refreshes that panel only", async () => {
    useBrowseStore.getState().toggleMark("right", "old.txt");
    vi.mocked(api.deleteItems).mockResolvedValue({ deleted: 1, failed: [] });
    startDelete("right");
    await confirmDelete();
    expect(api.deleteItems).toHaveBeenCalledWith("p1", { kind: "bucket", bucket: "alpha", prefix: "in/" }, [{ name: "old.txt", is_dir: false }]);
    expect(browseApi.listBucketDir).toHaveBeenCalled();
    expect(browseApi.listLocalDir).not.toHaveBeenCalled();
    expect(useBrowseStore.getState().right.marked).toEqual({});
    expect(dialog()).toBeNull();
  });

  it("failures are reported", async () => {
    vi.mocked(api.deleteItems).mockResolvedValue({ deleted: 0, failed: [{ name: "c.txt", message: "trash unavailable" }] });
    startDelete("left");
    await confirmDelete();
    expect(dialog()).toMatchObject({ kind: "result", failed: [{ name: "c.txt", message: "trash unavailable" }] });
  });

  it("does nothing when nothing is selected", () => {
    useBrowseStore.setState({ left: { ...useBrowseStore.getState().left, cursor: 0 } }); // the ".." row
    startDelete("left");
    expect(dialog()).toMatchObject({ kind: "result", lines: ["Nothing selected"] });
  });
});

describe("new folder and rename", () => {
  it("new folder creates in the panel's location, refreshes and puts the cursor on it", async () => {
    vi.mocked(api.createFolder).mockResolvedValue(undefined);
    vi.mocked(browseApi.listBucketDir).mockResolvedValue({ entries: [file("old.txt"), { name: "fresh", isDir: true, size: 0, modified: null }], nextToken: null });
    startNewFolder("right");
    expect(dialog()).toMatchObject({ kind: "name", name: "new-folder", initial: "" });
    await submitName("fresh");
    expect(api.createFolder).toHaveBeenCalledWith("p1", { kind: "bucket", bucket: "alpha", prefix: "in/" }, "fresh");
    expect(dialog()).toBeNull();
    // listing is [dir fresh, old.txt] and the panel is below the root, so ".." + fresh = row 1
    expect(useBrowseStore.getState().right.cursor).toBe(1);
  });

  it("a failed new folder keeps the dialog open with the error", async () => {
    vi.mocked(api.createFolder).mockRejectedValue("already exists: x");
    startNewFolder("left");
    await submitName("x");
    expect(dialog()).toMatchObject({ kind: "name", error: "already exists: x" });
  });

  it("an empty or unchanged name is refused without calling the backend", async () => {
    startRename("left");
    expect(dialog()).toMatchObject({ kind: "name", name: "rename", initial: "c.txt" });
    await submitName("   ");
    await submitName("c.txt");
    expect(api.renameItem).not.toHaveBeenCalled();
    expect(dialog()).toMatchObject({ kind: "name" });
  });

  it("rename renames the cursor item (marks ignored) and reports partial failures", async () => {
    useBrowseStore.getState().toggleMark("left", "a.txt");
    vi.mocked(api.renameItem).mockResolvedValue(report({ failed: [{ name: "alpha/in/x", message: "boom" }] }));
    startRename("left");
    await submitName("renamed.txt");
    expect(api.renameItem).toHaveBeenCalledWith("p1", { kind: "local", path: "/home/me" }, { name: "c.txt", is_dir: false }, "renamed.txt");
    expect(browseApi.listLocalDir).toHaveBeenCalled();
    expect(dialog()).toMatchObject({ kind: "result", failed: [{ name: "alpha/in/x" }] });
  });
});

describe("dialog keyboard", () => {
  async function render() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    await act(async () => createRoot(host).render(<OpsDialogs />));
    return host;
  }

  it("Escape cancels and Enter confirms", async () => {
    vi.mocked(api.deleteItems).mockResolvedValue({ deleted: 1, failed: [] });
    startDelete("left");
    const host = await render();
    const box = host.querySelector('[role="dialog"]') as HTMLElement;
    expect(box).not.toBeNull();
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog()).toBeNull();
    expect(api.deleteItems).not.toHaveBeenCalled();
    await act(async () => startDelete("left"));
    await act(async () => {
      (host.querySelector('[role="dialog"]') as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(api.deleteItems).toHaveBeenCalledTimes(1);
  });
});
