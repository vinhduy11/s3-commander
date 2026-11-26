// The presigned URL flow: options dialog, confirmation for a folder, result dialog.
// URLs exist only in the open dialog state (ops_store): never logged, never persisted.

import { useBrowseStore, type Side } from "../browse/browse_store";
import { chooseSavePath, presignPreview, presignUrls, writeTextFile, type PresignTarget } from "./ops_api";
import { copyText } from "./clipboard";
import { useOpsStore, type Dialog } from "./ops_store";
import { presignSelection } from "./ops_targets";
import { joinUrls } from "./presign_logic";
import { showToast } from "./toast";

const browse = () => useBrowseStore.getState();
const currentDialog = () => useOpsStore.getState().dialog;
const show = (dialog: Dialog | null) => useOpsStore.getState().setDialog(dialog);
const showPresignError = (message: string) => show({ kind: "result", title: "Presigned URL", lines: [message], failed: [] });

export const SAVE_FILE_NAME = "presigned-urls.txt";

export function startPresign(side: Side = browse().active): void {
  if (currentDialog()) return;
  const panel = browse()[side];
  if (panel.source?.kind !== "bucket") return showPresignError("Presigned URLs are available on a server panel only.");
  const selection = presignSelection(panel);
  if (!selection) return showPresignError("Nothing selected");
  show({ kind: "presign-options", ...selection });
}

/** Options chosen: a folder selection is counted and confirmed first, files are presigned directly. */
export async function submitPresignOptions(expiresSecs: number, downloadFilename: string): Promise<void> {
  const dialog = currentDialog();
  if (dialog?.kind !== "presign-options") return;
  const filename = downloadFilename.trim() || null;
  if (!dialog.hasFolder) return generate(dialog.bucket, dialog.items, expiresSecs, filename);
  show({ kind: "busy", label: "Counting objects..." });
  try {
    const preview = await presignPreview(profileId(), dialog.bucket, dialog.items);
    if (preview.object_count === 0) return showPresignError("No objects under the selection.");
    show({ kind: "presign-confirm", bucket: dialog.bucket, items: dialog.items, expiresSecs, downloadFilename: filename, count: preview.object_count, cap: preview.cap, capped: preview.capped });
  } catch (err) {
    showPresignError(String(err));
  }
}

export async function confirmPresign(): Promise<void> {
  const dialog = currentDialog();
  if (dialog?.kind !== "presign-confirm") return;
  await generate(dialog.bucket, dialog.items, dialog.expiresSecs, dialog.downloadFilename);
}

const profileId = () => browse().profileId ?? "";

async function generate(bucket: string, items: PresignTarget[], expiresSecs: number, downloadFilename: string | null): Promise<void> {
  show({ kind: "busy", label: "Generating URLs..." });
  try {
    const report = await presignUrls(profileId(), bucket, items, expiresSecs, downloadFilename);
    show({ kind: "presign-result", items: report.items, total: report.total, capped: report.capped });
  } catch (err) {
    showPresignError(String(err));
  }
}

/** Call from the click handler itself: the clipboard needs the user gesture. */
export async function copyPresigned(text: string, okMessage = "Copied"): Promise<void> {
  const copied = await copyText(text);
  showToast(copied ? okMessage : "Copy failed: select the URL and press Ctrl or Cmd+C", copied);
}

export async function savePresignedUrls(): Promise<void> {
  const dialog = currentDialog();
  if (dialog?.kind !== "presign-result") return;
  const contents = joinUrls(dialog.items);
  try {
    const path = await chooseSavePath(SAVE_FILE_NAME);
    if (!path) return;
    await writeTextFile(path, `${contents}\n`);
    showToast("Saved the URL list");
  } catch (err) {
    showToast(`Save failed: ${String(err)}`, false);
  }
}
