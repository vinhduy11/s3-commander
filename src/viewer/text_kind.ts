// Small pure helpers about a file's name and text that the viewer needs.

import { splitName } from "../browse/navigation";

export type FileKind = "text" | "json" | "csv";
export type LineEnding = "\n" | "\r\n";

/** Largest file the viewer opens (the backend enforces the same cap). */
export const MAX_VIEW_BYTES = 5 * 1024 * 1024;

/** The editor flavour for a name: JSON and CSV/TSV get extra tools, everything else is plain text. */
export function fileKind(name: string): FileKind {
  const ext = splitName(name).ext.toLowerCase();
  if (ext === "json") return "json";
  return ext === "csv" || ext === "tsv" ? "csv" : "text";
}

/** CRLF only when every line break in the text is CRLF; otherwise LF (a mixed file keeps its CR as text). */
export function lineEndingOf(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  return crlf > 0 && crlf === lf ? "\r\n" : "\n";
}

/** "a.txt" becomes "a (copy).txt". */
export function copyName(name: string): string {
  const { base, ext } = splitName(name);
  return ext ? `${base} (copy).${ext}` : `${base} (copy)`;
}
