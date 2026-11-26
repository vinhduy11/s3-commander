// Pure helpers: which items an operation acts on and where it goes. No store writes, no I/O.

import { type BrowseState, type PanelEntry, type PanelState, type Side } from "../browse/browse_store";
import { buildRows } from "../browse/navigation";
import type { Location, TopItem } from "./ops_api";

export type Operation = { side: Side; destSide: Side; source: Location; dest: Location; items: TopItem[] };

const toItem = (entry: { name: string; isDir: boolean }): TopItem => ({ name: entry.name, is_dir: entry.isDir });

/** The directory a panel shows, or null while it has no source (or no resolved local path yet). */
export function panelLocation(panel: PanelState): Location | null {
  if (!panel.source) return null;
  if (panel.source.kind === "bucket") return { kind: "bucket", bucket: panel.source.bucket, prefix: panel.path };
  return panel.path ? { kind: "local", path: panel.path } : null;
}

/** The row under the cursor as an item; null on the ".." row or in an empty listing. */
export function cursorTarget(panel: PanelState): TopItem | null {
  const row = buildRows(panel.source, panel.path, panel.entries)[panel.cursor];
  return !row || row.isUp ? null : toItem(row);
}

/** Marked entries (listing order) when there are any, otherwise the item under the cursor. */
export function selectTargets(panel: PanelState): TopItem[] {
  const marked = panel.entries.filter((entry: PanelEntry) => panel.marked[entry.name]);
  if (marked.length) return marked.map(toItem);
  const current = cursorTarget(panel);
  return current ? [current] : [];
}

export const otherSide = (side: Side): Side => (side === "left" ? "right" : "left");

/** Source = the panel `side`, destination = the other panel's current source and path. */
export function resolveOperation(state: BrowseState, side: Side): Operation | { error: string } {
  const destSide = otherSide(side);
  const items = selectTargets(state[side]);
  if (!items.length) return { error: "Nothing selected" };
  const source = panelLocation(state[side]);
  const dest = panelLocation(state[destSide]);
  if (!source || !dest) return { error: "Choose a source for the other panel first" };
  return { side, destSide, source, dest, items };
}
