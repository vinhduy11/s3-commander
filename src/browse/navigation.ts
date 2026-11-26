// Pure helpers for panel paths and rows. Local paths are absolute ("/a/b"); bucket paths are
// key prefixes ("" for the root, "a/b/" below it). macOS and Linux only, so "/" is the separator.

import type { PanelEntry, PanelSource } from "./browse_store";

export type Row = PanelEntry & { isUp?: boolean };

const UP_ROW: Row = { name: "..", isDir: true, size: 0, modified: null, isUp: true };

/** Same kind, and for a bucket the same bucket. */
export const sameSource = (first: PanelSource | null, second: PanelSource | null): boolean =>
  first?.kind === second?.kind && (first?.kind !== "bucket" || first.bucket === (second as typeof first).bucket);

export function isRoot(source: PanelSource, path: string): boolean {
  return source.kind === "local" ? path === "/" || path === "" : path === "";
}

export function childPath(source: PanelSource, path: string, name: string): string {
  if (source.kind === "bucket") return `${path}${name}/`;
  return path === "/" ? `/${name}` : `${path}/${name}`;
}

/** Parent path plus the name of the directory we leave (to put the cursor back on it); null at the root. */
export function parentOf(source: PanelSource, path: string): { path: string; focusName: string } | null {
  if (isRoot(source, path)) return null;
  const trimmed = source.kind === "bucket" ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf("/");
  const focusName = trimmed.slice(cut + 1);
  if (source.kind === "bucket") return { path: trimmed.slice(0, cut + 1), focusName };
  return { path: cut <= 0 ? "/" : trimmed.slice(0, cut), focusName };
}

/** Rows shown in a panel: a ".." row (unless at the root) followed by the entries. */
export function buildRows(source: PanelSource | null, path: string, entries: PanelEntry[]): Row[] {
  return source && !isRoot(source, path) ? [UP_ROW, ...entries] : entries;
}

export function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  return dot < 1 ? { base: name, ext: "" } : { base: name.slice(0, dot), ext: name.slice(dot + 1) };
}

const KB = 1024;
const MB = KB * KB;
const GB = MB * KB;

export function formatSize(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(2)} GB`;
}

export function formatDate(epochSeconds: number | null): string {
  if (epochSeconds === null) return "";
  const date = new Date(epochSeconds * 1000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
