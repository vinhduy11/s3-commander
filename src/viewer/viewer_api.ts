// Typed wrappers over the text commands. Field names match the Rust structs (snake_case).
// File content only travels through these calls: it is never logged or stored outside the viewer state.

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

export type LocalTextOpen = { text: string; bom: boolean; size: number; stamp: string };
export type S3TextOpen = {
  text: string;
  bom: boolean;
  size: number;
  etag: string;
  content_type: string | null;
  metadata: Record<string, string>;
};
/** `changed`: the file or object differs from what was opened; nothing was written. */
export type SaveOutcome = { status: "saved"; stamp: string } | { status: "changed" };

export const localTextOpen = (path: string) => invoke<LocalTextOpen>("local_text_open", { path });

/** `expectedStamp` null overwrites without checking (Overwrite, Save as copy). */
export const localTextSave = (path: string, text: string, bom: boolean, expectedStamp: string | null) =>
  invoke<SaveOutcome>("local_text_save", { path, text, bom, expectedStamp });

export const s3TextOpen = (profileId: string, bucket: string, key: string) =>
  invoke<S3TextOpen>("s3_text_open", { profileId, bucket, key });

export type S3TextSaveArgs = {
  profileId: string;
  bucket: string;
  key: string;
  text: string;
  bom: boolean;
  contentType: string | null;
  metadata: Record<string, string>;
  /** null overwrites without checking. */
  expectedEtag: string | null;
  /** Save as copy: refuse a key that already exists. */
  createOnly: boolean;
};

export const s3TextSave = (args: S3TextSaveArgs) => invoke<SaveOutcome>("s3_text_save", { ...args });

/** The native save dialog for "Save as copy" of a local file; null when the user cancels. */
export const chooseCopyPath = (defaultPath: string) => save({ defaultPath });
