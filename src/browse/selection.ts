// Pure selection rules: the marked set (names), the anchor and the rubber band. No store writes, no DOM.
// A row is identified by name, never by index, so a re-sorted list keeps its selection. ".." is never marked.

export type Marks = Record<string, true>;
type NamedRow = { name: string; isUp?: boolean };

const UP = "..";
const selectable = (row: NamedRow) => !row.isUp && row.name !== UP;

export const marksOf = (names: string[]): Marks => Object.fromEntries(names.map((name) => [name, true as const]));

/** The rows between `from` (the anchor) and `to`, both ends included, in list order. Without a usable anchor it is just `to`. */
export function rangeNames(rows: NamedRow[], from: string | null, to: string): string[] {
  const end = rows.findIndex((row) => row.name === to);
  if (end < 0) return [];
  const start = from === null ? -1 : rows.findIndex((row) => row.name === from);
  const [low, high] = start < 0 ? [end, end] : [Math.min(start, end), Math.max(start, end)];
  return rows.slice(low, high + 1).filter(selectable).map((row) => row.name);
}

export function toggleName(marks: Marks, name: string): Marks {
  if (name === UP) return marks;
  const next = { ...marks };
  if (next[name]) delete next[name];
  else next[name] = true;
  return next;
}

export const allNames = (rows: NamedRow[]): string[] => rows.filter(selectable).map((row) => row.name);

export const invertMarks = (rows: NamedRow[], marks: Marks): Marks => marksOf(allNames(rows).filter((name) => !marks[name]));

export const selectionText = (count: number): string => (count === 0 ? "Selection cleared" : `${count} selected`);

/** Glob with `*` (any run) and `?` (one character), case-insensitive, matched against the whole name. Null for an empty pattern. */
export function globToRegExp(pattern: string): RegExp | null {
  const text = pattern.trim();
  if (!text) return null;
  const body = Array.from(text, (char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${body}$`, "is");
}

export function matchNames(names: string[], pattern: string): string[] {
  const matcher = globToRegExp(pattern);
  return matcher ? names.filter((name) => matcher.test(name)) : [];
}

/** Client y to y inside the scrolled list content. */
export const toContentY = (clientY: number, listTop: number, scrollTop: number): number => clientY - listTop + scrollTop;

/** Rows whose band intersects the rectangle between two content y values; null when it touches no row. */
export function bandRows(y1: number, y2: number, rowHeight: number, rowCount: number): { first: number; last: number } | null {
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  if (rowCount <= 0 || bottom < 0 || top >= rowCount * rowHeight) return null;
  return { first: Math.max(0, Math.floor(top / rowHeight)), last: Math.min(rowCount - 1, Math.floor(bottom / rowHeight)) };
}
