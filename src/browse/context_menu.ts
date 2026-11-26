// Right-click context menu: state, the item list and the selection rules. Pure of React so it is
// testable on its own. Every item's handler calls the same flow the F-key calls (ops_flow), so
// there is one implementation of each operation. To add an action later append one entry in `rowItems`; nothing else changes.

import { create } from "zustand";
import { startDelete, startNewFolder, startRename, startTransfer } from "../ops/ops_flow";
import { useOpsStore } from "../ops/ops_store";
import { startPresign } from "../ops/presign_flow";
import { startViewer } from "../viewer/viewer_flow";
import { useViewerStore } from "../viewer/viewer_store";
import { cursorTarget, panelLocation, presignSelection, selectTargets } from "../ops/ops_targets";
import { useBrowseStore, type Side } from "./browse_store";
import { buildRows } from "./navigation";
import { openRowAt } from "./panel_loader";
import { openPatternDialog } from "./selection_flow";
import { SORT_KEYS, type SortKey } from "./sort";

export type MenuKind = "row" | "empty";
/** `checked` (radio item) is set only on the sort entries: true for the active one. */
export type MenuItem = { id: string; label: string; shortcut?: string; enabled: boolean; checked?: boolean; run: () => void };
type OpenMenu = { side: Side; kind: MenuKind; x: number; y: number };

export const useContextMenu = create<{ menu: OpenMenu | null }>(() => ({ menu: null }));
export const closeMenu = () => useContextMenu.setState({ menu: null });

const MARGIN = 4;

/** Keep a menu of `size` inside the window, at least MARGIN from every edge. */
export function clampMenuPosition(
  x: number,
  y: number,
  size: { width: number; height: number },
  win: { width: number; height: number },
): { x: number; y: number } {
  const fit = (pos: number, extent: number, limit: number) => Math.max(MARGIN, Math.min(pos, limit - extent - MARGIN));
  return { x: fit(x, size.width, win.width), y: fit(y, size.height, win.height) };
}

const browse = () => useBrowseStore.getState();
const dialogOpen = () => useOpsStore.getState().dialog !== null || useViewerStore.getState().session !== null;

function activate(side: Side) {
  browse().setActive(side);
}

/** Right-click on row `index`: an unmarked row becomes the only selection; a marked row keeps the marks. */
export function openRowMenu(side: Side, index: number, x: number, y: number): void {
  if (dialogOpen()) return;
  const panel = browse()[side];
  const row = buildRows(panel.source, panel.path, panel.entries)[index];
  if (!row) return;
  if (row.isUp || !panel.marked[row.name]) browse().clearMarks(side);
  browse().setCursor(side, index);
  activate(side);
  useContextMenu.setState({ menu: { side, kind: "row", x, y } });
}

export function openEmptyMenu(side: Side, x: number, y: number): void {
  if (dialogOpen()) return;
  activate(side);
  useContextMenu.setState({ menu: { side, kind: "empty", x, y } });
}

/** Keyboard (Shift+F10 / ContextMenu key): the menu of the cursor row. */
export function openMenuAtCursor(side: Side, x: number, y: number): void {
  if (dialogOpen()) return;
  const panel = browse()[side];
  if (panel.cursor >= buildRows(panel.source, panel.path, panel.entries).length) return openEmptyMenu(side, x, y);
  openRowMenu(side, panel.cursor, x, y);
}

/** Verb for the other panel: local to server uploads, server to local downloads, otherwise copies. */
function transferVerb(side: Side): string {
  const here = browse()[side].source?.kind;
  const there = browse()[side === "left" ? "right" : "left"].source?.kind;
  if (here === "local" && there === "bucket") return "Upload";
  if (here === "bucket" && there === "local") return "Download";
  return "Copy";
}

function rowItems(side: Side): MenuItem[] {
  const panel = browse()[side];
  const other = browse()[side === "left" ? "right" : "left"];
  const row = buildRows(panel.source, panel.path, panel.entries)[panel.cursor];
  const targets = selectTargets(panel);
  const canTransfer = targets.length > 0 && panelLocation(panel) !== null && panelLocation(other) !== null;
  const items: MenuItem[] = [];
  if (row?.isDir && targets.length <= 1) {
    items.push({ id: "open", label: "Open", shortcut: "Enter", enabled: true, run: () => openRowAt(side, panel.cursor) });
  }
  const oneFile = !!row && !row.isDir && !row.isUp && targets.length === 1;
  items.push(
    { id: "view", label: "View", shortcut: "F3", enabled: oneFile, run: () => void startViewer("view", side) },
    { id: "edit", label: "Edit", shortcut: "F4", enabled: oneFile, run: () => void startViewer("edit", side) },
    { id: "copy", label: `${transferVerb(side)} to other panel`, shortcut: "F5", enabled: canTransfer, run: () => void startTransfer("copy", side) },
    { id: "move", label: "Move to other panel", shortcut: "F6", enabled: canTransfer, run: () => void startTransfer("move", side) },
    ...(panel.source?.kind === "bucket"
      ? [{ id: "presign", label: "Copy presigned URL", shortcut: "F9", enabled: presignSelection(panel) !== null, run: () => startPresign(side) }]
      : []),
    { id: "rename", label: "Rename", shortcut: "F2", enabled: targets.length === 1 && cursorTarget(panel) !== null, run: () => startRename(side) },
    { id: "delete", label: "Delete", shortcut: "F8", enabled: targets.length > 0, run: () => startDelete(side) },
  );
  return items;
}

const SORT_LABELS: Record<SortKey, string> = { name: "Name", ext: "Ext", size: "Size", date: "Date" };

/** Same store actions as the column headers; the active key shows its direction. */
function sortItems(side: Side): MenuItem[] {
  const { sort } = browse()[side];
  return [
    ...SORT_KEYS.map((key) => ({
      id: `sort-${key}`,
      label: `Sort by ${SORT_LABELS[key]}`,
      shortcut: sort.key === key ? (sort.dir === "asc" ? "▲" : "▼") : undefined,
      enabled: true,
      checked: sort.key === key,
      run: () => browse().sortBy(side, key),
    })),
    { id: "sort-reverse", label: "Reverse order", enabled: true, run: () => browse().reverseSort(side) },
  ];
}

const modA = () => (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘A" : "Ctrl+A");

/** Empty-area entries; the same store actions the keyboard calls (Cmd/Ctrl+A, *, +, Esc). */
function selectionItems(side: Side): MenuItem[] {
  const panel = browse()[side];
  const hasRows = panel.entries.length > 0;
  return [
    { id: "select-all", label: "Select all", shortcut: modA(), enabled: hasRows, run: () => browse().markAll(side) },
    { id: "invert-selection", label: "Invert selection", shortcut: "*", enabled: hasRows, run: () => browse().invertSelection(side) },
    { id: "select-pattern", label: "Select by pattern...", shortcut: "+", enabled: hasRows, run: () => openPatternDialog(side, "select") },
    { id: "clear-selection", label: "Clear selection", shortcut: "Esc", enabled: Object.keys(panel.marked).length > 0, run: () => browse().clearMarks(side) },
  ];
}

export function buildMenuItems(side: Side, kind: MenuKind): MenuItem[] {
  const newFolder: MenuItem = {
    id: "new-folder",
    label: "New folder",
    shortcut: "F7",
    enabled: panelLocation(browse()[side]) !== null,
    run: () => startNewFolder(side),
  };
  return kind === "empty" ? [...selectionItems(side), ...emptyPresignItems(side), ...sortItems(side), newFolder] : [...rowItems(side), newFolder];
}

/** Server panels only: after marking files, a right-click on empty space can presign the marked rows (never the cursor row alone). */
function emptyPresignItems(side: Side): MenuItem[] {
  const panel = browse()[side];
  if (panel.source?.kind !== "bucket") return [];
  const hasMarks = Object.keys(panel.marked).length > 0;
  return [{ id: "presign", label: "Copy presigned URL", shortcut: "F9", enabled: hasMarks && presignSelection(panel) !== null, run: () => startPresign(side) }];
}
