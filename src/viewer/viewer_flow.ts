// The viewer flows: open a file (F3 View, F4 Edit, Enter, the context menu), edit state, the
// unsaved-changes guard and the saves with their conflict handling. Plain Zustand stores, so it is
// testable without React. Same dialog rules as ops_flow: nothing opens while another dialog is up.

import { useBrowseStore, type Side } from "../browse/browse_store";
import { formatSize, childPath } from "../browse/navigation";
import { openPath } from "../browse/panel_loader";
import { useOpsStore } from "../ops/ops_store";
import { cursorTarget, panelLocation } from "../ops/ops_targets";
import { showToast } from "../ops/toast";
import { detectDelimiter, type Delimiter } from "./csv";
import { validateJson } from "./json_tools";
import { copyName, fileKind, lineEndingOf, MAX_VIEW_BYTES } from "./text_kind";
import { chooseCopyPath, localTextOpen, localTextSave, s3TextOpen, s3TextSave, type SaveOutcome } from "./viewer_api";
import { useViewerStore, type ViewerSession } from "./viewer_store";

const browse = () => useBrowseStore.getState();
const session = () => useViewerStore.getState().session;
const showDialog = (dialog: Parameters<ReturnType<typeof useOpsStore.getState>["setDialog"]>[0]) => useOpsStore.getState().setDialog(dialog);
const refuse = (message: string) => showDialog({ kind: "result", title: "Cannot open", lines: [message], failed: [] });

function patch(change: Partial<ViewerSession>): void {
  useViewerStore.setState((state) => (state.session ? { session: { ...state.session, ...change } } : state));
}

export const isDirty = (current: ViewerSession) => current.text !== current.savedText;

const tooLarge = (size: number) =>
  `This file is ${formatSize(size)}; the viewer opens files up to ${MAX_VIEW_BYTES / (1024 * 1024)} MiB. Download it to a Local panel with F5 to open it elsewhere.`;

/** F3 (view) and F4 (edit): the file under the cursor of `side`. */
export async function startViewer(mode: "view" | "edit", side: Side = browse().active): Promise<void> {
  if (useOpsStore.getState().dialog || session()) return;
  const panel = browse()[side];
  const target = cursorTarget(panel);
  if (!target || target.is_dir) return refuse("Select a file to open.");
  const entry = panel.entries.find((candidate) => candidate.name === target.name);
  if (entry && entry.size > MAX_VIEW_BYTES) return refuse(tooLarge(entry.size));
  const location = panelLocation(panel);
  const { profileId } = browse();
  if (!panel.source || !location) return refuse("Choose a source first.");
  if (panel.source.kind === "bucket" && !profileId) return refuse("Choose a server profile first.");

  showDialog({ kind: "busy", label: "Opening..." });
  try {
    const base = { side, profileId, name: target.name, mode, kind: fileKind(target.name), view: "text" as const, headerRow: true, wrap: false, saving: false, guard: null, closeAfterSave: false, error: "" };
    let opened: Pick<ViewerSession, "text" | "bom" | "source" | "stamp">;
    if (panel.source.kind === "local") {
      const result = await localTextOpen(childPath(panel.source, panel.path, target.name));
      opened = { text: result.text, bom: result.bom, stamp: result.stamp, source: { kind: "local", path: childPath(panel.source, panel.path, target.name) } };
    } else {
      const key = panel.path + target.name;
      const result = await s3TextOpen(profileId as string, panel.source.bucket, key);
      opened = {
        text: result.text,
        bom: result.bom,
        stamp: "",
        source: { kind: "bucket", bucket: panel.source.bucket, key, etag: result.etag, contentType: result.content_type, metadata: result.metadata },
      };
    }
    const delimiter: Delimiter = base.kind === "csv" ? detectDelimiter(opened.text, target.name) : ",";
    useViewerStore.setState({ session: { ...base, ...opened, savedText: opened.text, lineEnding: lineEndingOf(opened.text), delimiter } });
    showDialog(null);
  } catch (err) {
    refuse(String(err));
  }
}

export const setViewerText = (text: string) => patch({ text, error: "" });
export const switchToEdit = () => patch({ mode: "edit" });
export const setViewerView = (view: "text" | "table") => patch({ view });
export const setViewerDelimiter = (delimiter: Delimiter) => patch({ delimiter });
export const setHeaderRow = (headerRow: boolean) => patch({ headerRow });
export const setWrap = (wrap: boolean) => patch({ wrap });

export const closeViewer = () => useViewerStore.setState({ session: null });

/** Esc and the close button: closes at once, or asks first when there are unsaved changes. */
export function requestClose(): void {
  const current = session();
  if (!current || current.saving) return;
  if (isDirty(current)) patch({ guard: "close" });
  else closeViewer();
}

export const discardAndClose = closeViewer;
export const dismissGuard = () => patch({ guard: null, closeAfterSave: false, error: "" });

/** Save (Cmd/Ctrl+S, the Save button, Save in the close question). Invalid JSON asks first. */
export async function saveViewer(): Promise<void> {
  const current = session();
  if (!current || current.mode !== "edit" || current.saving || !isDirty(current)) return;
  if (current.guard === "close") patch({ closeAfterSave: true });
  if (current.kind === "json" && !validateJson(current.text).ok) {
    patch({ guard: "invalid-json" });
    return;
  }
  await performSave(true);
}

export const confirmInvalidJsonSave = () => performSave(true);
export const overwriteSave = () => performSave(false);

/** `check`: refuse when the file or object changed since it was opened. */
async function performSave(check: boolean): Promise<void> {
  const current = session();
  if (!current || current.saving) return;
  const text = current.text;
  patch({ saving: true, guard: null, error: "" });
  try {
    const outcome: SaveOutcome =
      current.source.kind === "local"
        ? await localTextSave(current.source.path, text, current.bom, check ? current.stamp : null)
        : await s3TextSave({
            profileId: current.profileId as string,
            bucket: current.source.bucket,
            key: current.source.key,
            text,
            bom: current.bom,
            contentType: current.source.contentType,
            metadata: current.source.metadata,
            expectedEtag: check ? current.source.etag : null,
            createOnly: false,
          });
    if (outcome.status === "changed") return patch({ saving: false, guard: "conflict" });
    await markSaved(current, text, outcome.stamp, current.source, "Saved");
  } catch (err) {
    patch({ saving: false, error: String(err), closeAfterSave: false });
  }
}

/** The text is on disk or on the server now: it becomes the saved text, the panels refresh. */
async function markSaved(before: ViewerSession, text: string, stamp: string, source: ViewerSession["source"], message: string, name = before.name): Promise<void> {
  const closing = session()?.closeAfterSave ?? false;
  patch({
    saving: false, guard: null, error: "", closeAfterSave: false, savedText: text, name,
    source: source.kind === "bucket" ? { ...source, etag: stamp } : source,
    stamp: source.kind === "local" ? stamp : "",
  });
  showToast(message);
  if (closing) closeViewer();
  await refreshAround(before.source, source);
}

const dirOf = (source: ViewerSession["source"]) =>
  source.kind === "local" ? { kind: "local" as const, path: source.path.slice(0, source.path.lastIndexOf("/")) || "/" } : { kind: "bucket" as const, bucket: source.bucket, path: source.key.slice(0, source.key.lastIndexOf("/") + 1) };

/** Reload every panel that shows the folder the file was in or went to. */
async function refreshAround(...sources: ViewerSession["source"][]): Promise<void> {
  const dirs = sources.map(dirOf);
  const sides = (["left", "right"] as const).filter((side) => {
    const panel = browse()[side];
    return dirs.some((dir) =>
      dir.kind === "local" ? panel.source?.kind === "local" && panel.path === dir.path : panel.source?.kind === "bucket" && panel.source.bucket === dir.bucket && panel.path === dir.path,
    );
  });
  await Promise.all(sides.map((side) => openPath(side, browse()[side].path)));
}

/** From the conflict question: a new local file (native save dialog) or, on a server, a new name. */
export async function startSaveAsCopy(): Promise<void> {
  const current = session();
  if (!current) return;
  if (current.source.kind === "bucket") return patch({ guard: "copy-name", error: "" });
  const path = await chooseCopyPath(`${dirOf(current.source).path.replace(/\/$/, "")}/${copyName(current.name)}`);
  if (!path) return;
  const text = current.text;
  patch({ saving: true, error: "" });
  try {
    const outcome = await localTextSave(path, text, current.bom, null);
    if (outcome.status !== "saved") return patch({ saving: false, error: "The copy could not be saved." });
    await markSaved(current, text, outcome.stamp, { kind: "local", path }, "Saved a copy", path.slice(path.lastIndexOf("/") + 1));
  } catch (err) {
    patch({ saving: false, error: String(err) });
  }
}

/** Server "Save as copy": a new object next to the original, refused when the name is taken. */
export async function submitCopyName(name: string): Promise<void> {
  const current = session();
  if (!current || current.source.kind !== "bucket" || current.saving) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("/")) return patch({ error: "Enter a name without '/'." });
  const text = current.text;
  const key = current.source.key.slice(0, current.source.key.lastIndexOf("/") + 1) + trimmed;
  patch({ saving: true, error: "" });
  try {
    const outcome = await s3TextSave({
      profileId: current.profileId as string,
      bucket: current.source.bucket,
      key,
      text,
      bom: current.bom,
      contentType: current.source.contentType,
      metadata: current.source.metadata,
      expectedEtag: null,
      createOnly: true,
    });
    if (outcome.status !== "saved") return patch({ saving: false, error: "The copy could not be saved." });
    await markSaved(current, text, outcome.stamp, { ...current.source, key }, "Saved a copy", trimmed);
  } catch (err) {
    patch({ saving: false, error: String(err) });
  }
}
