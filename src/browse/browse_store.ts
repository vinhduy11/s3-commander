// Panel state lives here, outside the React tree, so it survives switching views and remounts.
// One slice per panel; components subscribe with selectors. Never put secrets in this store:
// the secret key stays in Rust.

import { create } from "zustand";
import { buildRows } from "./navigation";

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
};

type Listing = { path: string; entries: PanelEntry[]; nextToken: string | null };
type ListingOptions = { append?: boolean; focusName?: string };

export type BrowseState = {
  left: PanelState;
  right: PanelState;
  active: Side;
  profileId: string | null;
  buckets: string[];
  setSource: (side: Side, source: PanelSource | null) => void;
  setListing: (side: Side, listing: Listing, options?: ListingOptions) => void;
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
});

export const initialBrowseState = () => ({
  left: emptyPanel(),
  right: emptyPanel(),
  active: "left" as Side,
  profileId: null as string | null,
  buckets: [] as string[],
});

const SIDES: Side[] = ["left", "right"];

function sortEntries(entries: PanelEntry[]): PanelEntry[] {
  return [...entries].sort(
    (first, second) =>
      Number(second.isDir) - Number(first.isDir) ||
      first.name.toLowerCase().localeCompare(second.name.toLowerCase()) ||
      first.name.localeCompare(second.name),
  );
}

const rowCount = (panel: PanelState) => buildRows(panel.source, panel.path, panel.entries).length;

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
    setSource: (side, source) => patchPanel(side, () => ({ ...emptyPanel(), source })),
    setListing: (side, listing, options = {}) =>
      patchPanel(side, (panel) => {
        const entries = sortEntries(options.append ? [...panel.entries, ...listing.entries] : listing.entries);
        const next = { ...panel, entries, path: listing.path, nextToken: listing.nextToken, loading: false, error: "" };
        if (options.append) return next;
        const rows = buildRows(panel.source, listing.path, entries);
        const focused = options.focusName === undefined ? -1 : rows.findIndex((row) => row.name === options.focusName);
        return { ...next, cursor: Math.max(focused, 0), marked: {}, scrollTop: 0 };
      }),
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
    setActive: (active) => set({ active }),
    setBuckets: (buckets) => set({ buckets }),
    setProfile: (profileId) =>
      set((state) => (state.profileId === profileId ? state : { ...withoutBucketPanels(state), profileId })),
    lock: () => set((state) => ({ ...withoutBucketPanels(state), profileId: null })),
  };
});
