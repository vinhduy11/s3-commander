// State of the open viewer or editor. One at a time. Holds the file's text while it is open and
// nothing after it closes (and on Lock, see BrowserScreen).

import { create } from "zustand";
import type { Side } from "../browse/browse_store";
import type { Delimiter } from "./csv";
import type { FileKind, LineEnding } from "./text_kind";

export type ViewerSource =
  | { kind: "local"; path: string }
  | { kind: "bucket"; bucket: string; key: string; etag: string; contentType: string | null; metadata: Record<string, string> };

/** The nested question shown over the viewer, if any. */
export type ViewerGuard = "close" | "conflict" | "invalid-json" | "copy-name" | null;

export type ViewerSession = {
  side: Side;
  profileId: string | null;
  name: string;
  kind: FileKind;
  mode: "view" | "edit";
  source: ViewerSource;
  /** Local files: size and modified time at open or last save, checked again before the next save. */
  stamp: string;
  bom: boolean;
  lineEnding: LineEnding;
  /** The text as last read or saved; the file is changed while `text` differs. */
  savedText: string;
  text: string;
  view: "text" | "table";
  delimiter: Delimiter;
  headerRow: boolean;
  wrap: boolean;
  saving: boolean;
  guard: ViewerGuard;
  /** Save was started from the close question: close once it succeeds. */
  closeAfterSave: boolean;
  error: string;
};

export const useViewerStore = create<{ session: ViewerSession | null }>(() => ({ session: null }));
