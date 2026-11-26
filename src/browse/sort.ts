// Pure comparator for panel entries. The store keeps entries sorted with it; see docs/claude/rule.md.
// Folders always stay above files and sort by name only (they have no size or date); the direction
// applies to folders for the Name key only. Name and Ext compare case-insensitively with natural
// number order (file2 before file10). Ties fall back to Name ascending, so the order is stable.

import type { PanelEntry } from "./browse_store";
import { splitName } from "./navigation";

export type SortKey = "name" | "ext" | "size" | "date";
export type SortDir = "asc" | "desc";
export type SortState = { key: SortKey; dir: SortDir };

export const DEFAULT_SORT: SortState = { key: "name", dir: "asc" };
export const SORT_KEYS: SortKey[] = ["name", "ext", "size", "date"];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byName = (first: PanelEntry, second: PanelEntry) =>
  collator.compare(first.name, second.name) || (first.name < second.name ? -1 : first.name > second.name ? 1 : 0);

const valueCompare: Record<SortKey, (first: PanelEntry, second: PanelEntry) => number> = {
  name: byName,
  ext: (first, second) => collator.compare(splitName(first.name).ext, splitName(second.name).ext),
  size: (first, second) => first.size - second.size,
  date: (first, second) => (first.modified ?? -Infinity) - (second.modified ?? -Infinity) || 0,
};

export function sortEntries(entries: PanelEntry[], sort: SortState): PanelEntry[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...entries].sort((first, second) => {
    if (first.isDir !== second.isDir) return first.isDir ? -1 : 1;
    if (first.isDir) return (sort.key === "name" ? sign : 1) * byName(first, second);
    const primary = valueCompare[sort.key](first, second);
    return primary ? sign * primary : byName(first, second);
  });
}

/** Header click: a new key starts ascending, the active key reverses. */
export function nextSort(sort: SortState, key: SortKey): SortState {
  return sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
}
