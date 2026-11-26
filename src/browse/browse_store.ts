// Panel state lives here, outside the React tree, so it survives switching views and remounts.
// One slice per panel; components subscribe with selectors. Never put secrets in this store:
// the secret key stays in Rust.

import { create } from "zustand";
import { buildRows } from "./navigation";
import { clampWidth, loadColumns, resetWidth, saveColumns, type ColumnKey, type PanelColumns } from "./panel_columns";
import { clampRatio, loadSplit, saveSplit } from "./panel_split";
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
  marked: Record<string, true>;
  scrollTop: number;
  loading: boolean;
  error: string;
  /** Per panel; survives source switches, not an app restart. */
  sort: SortState;
};

type Listing = { path: string; entries: PanelEntry[]; nextToken: string | null };
type ListingOptions = { append?: boolean; focusName?: string };

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
  setScrollTop: (side: Side, scrollTop: number) => void;
  setLoading: (side: Side, loading: boolean) => void;
  setError: (side: Side, error: string) => void;
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
  scrollTop: 0,
  loading: false,
  error: "",
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

const rowCount = (panel: PanelState) => buildRows(panel.source, panel.path, panel.entries).length;

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
        const next = { ...panel, entries, path: listing.path, nextToken: listing.nextToken, loading: false, error: "" };
        if (options.append) return { ...next, cursor: cursorAfter(panel, next) };
        const rows = buildRows(panel.source, listing.path, entries);
        const focused = options.focusName === undefined ? -1 : rows.findIndex((row) => row.name === options.focusName);
        return { ...next, cursor: Math.max(focused, 0), marked: {}, scrollTop: 0 };
      }),
    sortBy: (side, key) => patchPanel(side, (panel) => resort(panel, nextSort(panel.sort, key))),
    reverseSort: (side) => patchPanel(side, (panel) => resort(panel, { ...panel.sort, dir: panel.sort.dir === "asc" ? "desc" : "asc" })),
    setCursor: (side, cursor) =>
      patchPanel(side, (panel) => {
        const clamped = Math.max(0, Math.min(cursor, rowCount(panel) - 1));
        return clamped === panel.cursor ? panel : { ...panel, cursor: clamped };
      }),
    toggleMark: (side, name) =>
      patchPanel(side, (panel) => {
        const marked = { ...panel.marked };
        if (marked[name]) delete marked[name];
        else marked[name] = true;
        return { ...panel, marked };
      }),
    clearMarks: (side) => patchPanel(side, (panel) => (Object.keys(panel.marked).length ? { ...panel, marked: {} } : panel)),
    setScrollTop: (side, scrollTop) => patchPanel(side, (panel) => ({ ...panel, scrollTop })),
    setLoading: (side, loading) => patchPanel(side, (panel) => ({ ...panel, loading })),
    setError: (side, error) => patchPanel(side, (panel) => ({ ...panel, error, loading: false })),
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
