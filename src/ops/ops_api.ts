// Typed wrappers over the operation commands. Field names match the Rust structs (snake_case).
// The secret key never leaves Rust; only the profile id is sent.

import { invoke } from "@tauri-apps/api/core";

export type Location = { kind: "local"; path: string } | { kind: "bucket"; bucket: string; prefix: string };
export type TopItem = { name: string; is_dir: boolean; dest_name?: string | null };
export type Mode = "copy" | "move";
export type ConflictPolicy = "overwrite" | "skip" | "keep_both";
export type Direction = "upload" | "download" | "server_copy" | "local_copy";

export type TransferRequest = { source: Location; dest: Location; items: TopItem[]; mode: Mode };

export type ConflictInfo = {
  /** Destination label; also the key of the resolution map. */
  dest: string;
  incoming_size: number;
  incoming_modified: number | null;
  existing_size: number | null;
  existing_modified: number | null;
};

export type PlanSummary = {
  direction: Direction;
  files: number;
  dirs: number;
  total_bytes: number;
  conflict_count: number;
  conflicts: ConflictInfo[];
  too_large_count: number;
};

/** Decisions per conflicting destination plus a default for the rest (the "all" buttons). */
export type Resolutions = { per_item: Record<string, ConflictPolicy>; default: ConflictPolicy | null };

export type ItemFailure = { name: string; message: string };
export type RunReport = { transferred: number; skipped: number; bytes: number; sources_removed: number; failed: ItemFailure[] };
export type DeleteReport = { deleted: number; failed: ItemFailure[] };

export const transferPreview = (profileId: string | null, request: TransferRequest) =>
  invoke<PlanSummary>("transfer_preview", { profileId, request });

export const transferExecute = (profileId: string | null, request: TransferRequest, resolutions: Resolutions) =>
  invoke<RunReport>("transfer_execute", { profileId, request, resolutions });

export const deleteItems = (profileId: string | null, location: Location, items: TopItem[]) =>
  invoke<DeleteReport>("items_delete", { profileId, location, items });

export const createFolder = (profileId: string | null, location: Location, name: string) =>
  invoke<void>("folder_create", { profileId, location, name });

export const renameItem = (profileId: string | null, location: Location, item: TopItem, newName: string) =>
  invoke<RunReport>("item_rename", { profileId, location, item, newName });

/** A path dropped from the OS file manager, split into its folder and name. */
export type DroppedPath = { parent: string; name: string; is_dir: boolean };

export const localStatPaths = (paths: string[]) => invoke<DroppedPath[]>("local_stat_paths", { paths });
