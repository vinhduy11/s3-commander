// Panel state lives here, outside the React tree, so it survives switching views and remounts.
// One slice per panel; components subscribe with selectors. Never put secrets in this store:
// the secret key stays in Rust.

import { create } from "zustand";
import { buildRows } from "./navigation";
import { clampWidth, loadColumns, resetWidth, saveColumns, type ColumnKey, type PanelColumns } from "./panel_columns";
import { clampRatio, loadSplit, saveSplit } from "./panel_split";
import { keepAfterReload } from "./reload_state";
import { allNames, invertMarks, marksOf, matchNames, rangeNames, selectionText, toggleName, type Marks } from "./selection";
import { DEFAULT_SORT, nextSort, sortEntries, type SortKey, type SortState } from "./sort";

export type Side = "left" | "right";
export type PanelSource = { kind: "local" } | { kind: "bucket"; bucket: string };
export type PanelEntry = { name: string; isDir: boolean; size: number; modified: number | null };

export type PanelState = {
  source: PanelSource | null;
  /** Local: absolute dir. Bucket: key prefix ("" or "a/b/"). */
  path: string;
  entries: PanelEntry[];
  /** Continuation token for the next page of a bucket listing. */
  nextToken: string | null;
  /** Index into the rows (the ".." row counts when present). */
  cursor: number;
  marked: Marks;
  /** Name of the row of the last plain or Cmd/Ctrl click (or where a Shift extension started); the fixed end of a range. */
  anchor: string | null;
  /** Polite text for the screen-reader live region, set by bulk selection actions. */
  selectionNote: string;
  scrollTop: number;
  loading: boolean;
  error: string;
  /** Short non-error text for the footer (a reload fell back to a parent folder); cleared by the next listing. */
  notice: string;
  /** Per panel; survives source switches, not an app restart. */
  sort: SortState;
};

type Listing = { path: string; entries: PanelEntry[]; nextToken: string | null };
/** `keep`: a reload of the same path; cursor, marks, anchor and scroll are kept (see reload_state.ts). */
type ListingOptions = { append?: boolean; focusName?: string; keep?: boolean };

export type BrowseState = {
  left: PanelState;
  right: PanelState;
  active: Side;
  profileId: string | null;
  buckets: string[];
  /** Layout slice: the left panel's share of the free width, persisted in localStorage. */
  splitRatio: number;
  setSplitRatio: (ratio: number) => void;
  /** Layout slice: Ext/Size/Date widths per panel (the user's values; the panel fits them to its width), persisted. */
  columnWidths: PanelColumns;
  setColumnWidth: (side: Side, col: ColumnKey, px: number) => void;
  resetColumnWidth: (side: Side, col: ColumnKey) => void;
  setSource: (side: Side, source: PanelSource | null) => void;
  setListing: (side: Side, listing: Listing, options?: ListingOptions) => void;
  /** Header click and context menu: a new key sorts ascending, the active key reverses. */
  sortBy: (side: Side, key: SortKey) => void;
  reverseSort: (side: Side) => void;
  setCursor: (side: Side, cursor: number) => void;
  toggleMark: (side: Side, name: string) => void;
  clearMarks: (side: Side) => void;
  /** Plain click: just this row (cursor row is the implicit selection), the marks clear. */
  selectOnly: (side: Side, index: number) => void;
  /** Cmd/Ctrl+click: toggle the row, move the cursor and the anchor. */
  toggleAt: (side: Side, index: number) => void;
  /** Shift+click and Shift+keys: the cursor moves to `index` and the marks become anchor..index. */
  extendSelection: (side: Side, index: number) => void;
  markAll: (side: Side) => void;
  invertSelection: (side: Side) => void;
  /** Rubber band: replace the marks (no announcement while the band moves). */
  setMarks: (side: Side, marks: Marks, announce?: boolean) => void;
  /** Select or deselect the entries matching a glob; returns how many matched. */
  applyPattern: (side: Side, pattern: string, mode: "select" | "deselect") => number;
  setScrollTop: (side: Side, scrollTop: number) => void;
  setLoading: (side: Side, loading: boolean) => void;
  setError: (side: Side, error: string) => void;
  setNotice: (side: Side, notice: string) => void;
  setActive: (side: Side) => void;
  setBuckets: (buckets: string[]) => void;
  setProfile: (profileId: string | null) => void;
  lock: () => void;
};

export const emptyPanel = (): PanelState => ({
  source: null,
  path: "",
  entries: [],
  nextToken: null,
  cursor: 0,
  marked: {},
  anchor: null,
  selectionNote: "",
  scrollTop: 0,
  loading: false,
  error: "",
  notice: "",
  sort: DEFAULT_SORT,
});

export const initialBrowseState = () => ({
  left: emptyPanel(),
  right: emptyPanel(),
  active: "left" as Side,
  profileId: null as string | null,
  buckets: [] as string[],
  splitRatio: loadSplit(),
  columnWidths: loadColumns(),
});

const SIDES: Side[] = ["left", "right"];

const rowsOf = (panel: PanelState) => buildRows(panel.source, panel.path, panel.entries);
const rowCount = (panel: PanelState) => rowsOf(panel).length;
const withMarks = (panel: PanelState, marked: Marks, note = true): PanelState =>
  ({ ...panel, marked, ...(note ? { selectionNote: selectionText(Object.keys(marked).length) } : {}) });

/** Index of the item the cursor was on in `before`, found by name in `after` (rows change when the order or the entries do). */
function cursorAfter(before: PanelState, after: PanelState): number {
  const name = buildRows(before.source, before.path, before.entries)[before.cursor]?.name;
  const found = name === undefined ? -1 : buildRows(after.source, after.path, after.entries).findIndex((row) => row.name === name);
  return found < 0 ? before.cursor : found;
}

function resort(panel: PanelState, sort: SortState): PanelState {
  const next = { ...panel, sort, entries: sortEntries(panel.entries, sort) };
  return { ...next, cursor: cursorAfter(panel, next) };
}

/** Drop everything that belongs to the S3 side; the Local panel keeps its state. */
function withoutBucketPanels(state: BrowseState): Partial<BrowseState> {
  const reset: Partial<BrowseState> = { buckets: [] };
  for (const side of SIDES) {
    if (state[side].source?.kind === "bucket") reset[side] = emptyPanel();
  }
  return reset;
}

export const useBrowseStore = create<BrowseState>((set) => {
  const patchPanel = (side: Side, change: (panel: PanelState) => PanelState) =>
    set((state) => ({ [side]: change(state[side]) }) as Pick<BrowseState, Side>);

  return {
    ...initialBrowseState(),
    setSource: (side, source) => patchPanel(side, (panel) => ({ ...emptyPanel(), source, sort: panel.sort })),
    setListing: (side, listing, options = {}) =>
      patchPanel(side, (panel) => {
        const entries = sortEntries(options.append ? [...panel.entries, ...listing.entries] : listing.entries, panel.sort);
        const next = { ...panel, entries, path: listing.path, nextToken: listing.nextToken, loading: false, error: "", notice: "" };
        if (options.keep && !options.append && listing.path === panel.path) return { ...next, ...keepAfterReload(panel, entries) };
        if (options.append) {
          const anchor = panel.anchor !== null && entries.some((entry) => entry.name === panel.anchor) ? panel.anchor : null;
          return { ...next, anchor, cursor: cursorAfter(panel, next) };
        }
        const rows = buildRows(panel.source, listing.path, entries);
        const focused = options.focusName === undefined ? -1 : rows.findIndex((row) => row.name === options.focusName);
        return { ...next, cursor: Math.max(focused, 0), marked: {}, anchor: null, selectionNote: "", scrollTop: 0 };
      }),
    sortBy: (side, key) => patchPanel(side, (panel) => resort(panel, nextSort(panel.sort, key))),
    reverseSort: (side) => patchPanel(side, (panel) => resort(panel, { ...panel.sort, dir: panel.sort.dir === "asc" ? "desc" : "asc" })),
    setCursor: (side, cursor) =>
      patchPanel(side, (panel) => {
        const clamped = Math.max(0, Math.min(cursor, rowCount(panel) - 1));
        return clamped === panel.cursor ? panel : { ...panel, cursor: clamped };
      }),
    toggleMark: (side, name) => patchPanel(side, (panel) => ({ ...panel, marked: toggleName(panel.marked, name) })),
    clearMarks: (side) => patchPanel(side, (panel) => (Object.keys(panel.marked).length ? withMarks(panel, {}) : panel)),
    selectOnly: (side, index) =>
      patchPanel(side, (panel) => {
        const cursor = Math.max(0, Math.min(index, rowCount(panel) - 1));
        return { ...panel, cursor, marked: {}, anchor: rowsOf(panel)[cursor]?.name ?? null, selectionNote: "" };
      }),
    toggleAt: (side, index) =>
      patchPanel(side, (panel) => {
        const cursor = Math.max(0, Math.min(index, rowCount(panel) - 1));
        const rows = rowsOf(panel);
        const name = rows[cursor]?.name ?? null;
        // The row of a plain click is the implicit selection; it becomes a real mark when a second row joins it.
        const implicit = !Object.keys(panel.marked).length && panel.anchor !== null && panel.anchor === rows[panel.cursor]?.name;
        const base = implicit ? toggleName(panel.marked, panel.anchor as string) : panel.marked;
        return { ...panel, cursor, anchor: name, marked: name === null ? base : toggleName(base, name), selectionNote: "" };
      }),
    extendSelection: (side, index) =>
      patchPanel(side, (panel) => {
        const rows = rowsOf(panel);
        const cursor = Math.max(0, Math.min(index, rows.length - 1));
        const anchor = panel.anchor !== null && rows.some((row) => row.name === panel.anchor) ? panel.anchor : (rows[panel.cursor]?.name ?? null);
        const target = rows[cursor]?.name;
        if (target === undefined) return panel;
        return withMarks({ ...panel, cursor, anchor }, marksOf(rangeNames(rows, anchor, target)));
      }),
    markAll: (side) => patchPanel(side, (panel) => withMarks(panel, marksOf(allNames(rowsOf(panel))))),
    invertSelection: (side) => patchPanel(side, (panel) => withMarks(panel, invertMarks(rowsOf(panel), panel.marked))),
    setMarks: (side, marks, announce = false) => patchPanel(side, (panel) => withMarks(panel, marks, announce)),
    applyPattern: (side, pattern, mode) => {
      const panel = useBrowseStore.getState()[side];
      const matched = matchNames(panel.entries.map((entry) => entry.name), pattern);
      const marked = { ...panel.marked };
      for (const name of matched) {
        if (mode === "select") marked[name] = true;
        else delete marked[name];
      }
      patchPanel(side, (current) => withMarks(current, marked));
      return matched.length;
    },
    setScrollTop: (side, scrollTop) => patchPanel(side, (panel) => ({ ...panel, scrollTop })),
    setLoading: (side, loading) => patchPanel(side, (panel) => ({ ...panel, loading })),
    setError: (side, error) => patchPanel(side, (panel) => ({ ...panel, error, loading: false })),
    setNotice: (side, notice) => patchPanel(side, (panel) => ({ ...panel, notice })),
    setSplitRatio: (ratio) => {
      const next = clampRatio(ratio);
      saveSplit(next);
      set({ splitRatio: next });
    },
    setColumnWidth: (side, col, px) =>
      set((state) => {
        const columnWidths = { ...state.columnWidths, [side]: { ...state.columnWidths[side], [col]: clampWidth(col, px) } };
        saveColumns(columnWidths);
        return { columnWidths };
      }),
    resetColumnWidth: (side, col) => useBrowseStore.getState().setColumnWidth(side, col, resetWidth(col)),
    setActive: (active) => set({ active }),
    setBuckets: (buckets) => set({ buckets }),
    setProfile: (profileId) =>
      set((state) => (state.profileId === profileId ? state : { ...withoutBucketPanels(state), profileId })),
    lock: () => set((state) => ({ ...withoutBucketPanels(state), profileId: null })),
  };
});
