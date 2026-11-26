// Pure rule for what a reload keeps: the cursor follows its entry by name, the marks and the anchor
// survive only for names that still exist. Scroll, sort and column widths are not touched here.

import { buildRows } from "./navigation";
import type { PanelEntry, PanelSource } from "./browse_store";
import type { Marks } from "./selection";

type Before = { source: PanelSource | null; path: string; entries: PanelEntry[]; cursor: number; marked: Marks; anchor: string | null };

/** `entries` are the fresh, already sorted entries of the same path. */
export function keepAfterReload(before: Before, entries: PanelEntry[]): { cursor: number; marked: Marks; anchor: string | null } {
  const name = buildRows(before.source, before.path, before.entries)[before.cursor]?.name;
  const rows = buildRows(before.source, before.path, entries);
  const found = name === undefined ? -1 : rows.findIndex((row) => row.name === name);
  const cursor = found >= 0 ? found : Math.max(0, Math.min(before.cursor, rows.length - 1));
  const exists = new Set(entries.map((entry) => entry.name));
  const marked = Object.fromEntries(Object.keys(before.marked).filter((key) => exists.has(key)).map((key) => [key, true as const]));
  return { cursor, marked, anchor: before.anchor !== null && rows.some((row) => row.name === before.anchor) ? before.anchor : null };
}
