// The operation flows: select targets, show the right dialog, call the backend, refresh the
// panels. Dialog state lives in ops_store, panel state in the browse store; both are plain
// Zustand stores so these functions are testable without React.

import { useBrowseStore, type Side } from "../browse/browse_store";
import { transferStart } from "../queue/queue_api";
import { registerJob } from "../queue/queue_events";
import {
  createFolder,
  deleteItems,
  renameItem,
  transferPreview,
  type ConflictPolicy,
  type Mode,
  type Resolutions,
  type RunReport,
  type TransferRequest,
} from "./ops_api";
import { refreshPanel } from "./panel_refresh";
import { useOpsStore, type Dialog } from "./ops_store";
import { cursorTarget, otherSide, panelLocation, resolveOperation, selectTargets, type Operation } from "./ops_targets";

const browse = () => useBrowseStore.getState();
const currentDialog = () => useOpsStore.getState().dialog;
const show = (dialog: Dialog | null) => useOpsStore.getState().setDialog(dialog);
const showError = (message: string) => show({ kind: "result", title: "Error", lines: [message], failed: [] });

function showReport(title: string, report: { failed: RunReport["failed"] }, summary: string) {
  if (report.failed.length) show({ kind: "result", title, lines: [summary], failed: report.failed });
  else show(null);
}

export function cancelDialog(): void {
  // Delete, rename and New folder show a busy dialog without Cancel; transfers have none (the queue cancels them).
  if (currentDialog()?.kind !== "busy") show(null);
}

export async function startTransfer(mode: Mode, side: Side = browse().active): Promise<void> {
  if (currentDialog()) return;
  const operation = resolveOperation(browse(), side);
  if ("error" in operation) return showError(operation.error);
  await planTransfer(operation, mode);
}

/** Entry point for drag and drop: the same plan, conflict, busy and result dialogs as F5 and F6. */
export async function startTransferOf(operation: Operation, mode: Mode): Promise<void> {
  if (currentDialog()) return;
  await planTransfer(operation, mode);
}

async function planTransfer(operation: Operation, mode: Mode): Promise<void> {
  const { side } = operation;
  const request: TransferRequest = { source: operation.source, dest: operation.dest, items: operation.items, mode };
  show({ kind: "busy", label: "Planning..." });
  try {
    const summary = await transferPreview(browse().profileId, request);
    show({ kind: "plan", side, destSide: operation.destSide, request, summary });
  } catch (err) {
    showError(String(err));
  }
}

/** Queue the transfer as a background job: the dialogs close at once and the queue shows progress. */
async function startJob(side: Side, request: TransferRequest, resolutions: Resolutions) {
  show(null);
  browse().clearMarks(side);
  try {
    const jobId = await transferStart(browse().profileId, request, resolutions);
    registerJob(jobId, { source: request.source, dest: request.dest, mode: request.mode });
  } catch (err) {
    showError(String(err));
  }
}

export async function confirmPlan(): Promise<void> {
  const dialog = currentDialog();
  if (dialog?.kind !== "plan") return;
  if (dialog.summary.conflict_count > 0) {
    show({ kind: "conflicts", side: dialog.side, destSide: dialog.destSide, request: dialog.request, summary: dialog.summary, index: 0, perItem: {} });
    return;
  }
  await startJob(dialog.side, dialog.request, { per_item: {}, default: null });
}

/** Decide the conflict on screen; run once the last one is decided. */
export async function resolveConflict(policy: ConflictPolicy): Promise<void> {
  const dialog = currentDialog();
  if (dialog?.kind !== "conflicts") return;
  const perItem = { ...dialog.perItem, [dialog.summary.conflicts[dialog.index].dest]: policy };
  if (dialog.index + 1 < dialog.summary.conflicts.length) {
    show({ ...dialog, index: dialog.index + 1, perItem });
    return;
  }
  await startJob(dialog.side, dialog.request, { per_item: perItem, default: null });
}

/** "Overwrite all" / "Skip all" / "Keep both all": the policy becomes the default for what is left. */
export async function resolveAllConflicts(policy: ConflictPolicy): Promise<void> {
  const dialog = currentDialog();
  if (dialog?.kind !== "conflicts") return;
  await startJob(dialog.side, dialog.request, { per_item: dialog.perItem, default: policy });
}

export function startDelete(side: Side = browse().active): void {
  if (currentDialog()) return;
  const panel = browse()[side];
  const items = selectTargets(panel);
  const location = panelLocation(panel);
  if (!items.length || !location) return showError(items.length ? "Choose a source first" : "Nothing selected");
  show({ kind: "delete", side, location, items, permanent: location.kind === "bucket" });
}

export async function confirmDelete(): Promise<void> {
  const dialog = currentDialog();
  if (dialog?.kind !== "delete") return;
  show({ kind: "busy", label: dialog.permanent ? "Deleting..." : "Moving to Trash..." });
  let outcome: Dialog | null = null;
  try {
    const report = await deleteItems(browse().profileId, dialog.location, dialog.items);
    if (report.failed.length) outcome = { kind: "result", title: "Delete finished with errors", lines: [`${report.deleted} deleted, ${report.failed.length} failed`], failed: report.failed };
  } catch (err) {
    outcome = { kind: "result", title: "Error", lines: [String(err)], failed: [] };
  }
  browse().clearMarks(dialog.side);
  await refreshPanel(dialog.side);
  show(outcome);
}

export function startNewFolder(side: Side = browse().active): void {
  if (currentDialog()) return;
  const location = panelLocation(browse()[side]);
  if (!location) return showError("Choose a source first");
  show({ kind: "name", name: "new-folder", side, location, item: null, initial: "", error: "" });
}

export function startRename(side: Side = browse().active): void {
  if (currentDialog()) return;
  const panel = browse()[side];
  const item = cursorTarget(panel);
  const location = panelLocation(panel);
  if (!item || !location) return showError(item ? "Choose a source first" : "Nothing selected");
  show({ kind: "name", name: "rename", side, location, item, initial: item.name, error: "" });
}

export async function submitName(name: string): Promise<void> {
  const dialog = currentDialog();
  if (dialog?.kind !== "name") return;
  const trimmed = name.trim();
  if (!trimmed || (dialog.name === "rename" && trimmed === dialog.item?.name)) {
    show({ ...dialog, initial: name, error: trimmed ? "Enter a different name" : "Enter a name" });
    return;
  }
  const profileId = browse().profileId;
  show({ kind: "busy", label: dialog.name === "rename" ? "Renaming..." : "Creating folder..." });
  try {
    if (dialog.name === "new-folder") {
      await createFolder(profileId, dialog.location, trimmed);
      show(null);
    } else {
      const report = await renameItem(profileId, dialog.location, dialog.item!, trimmed);
      showReport("Rename finished with errors", report, "Some items could not be renamed");
    }
  } catch (err) {
    show({ ...dialog, initial: trimmed, error: String(err) });
    return;
  }
  await refreshPanel(dialog.side, trimmed);
}

export { otherSide };
