// Typed wrappers over the Tauri commands used by the browser. Only listings cross this
// boundary; the secret key never leaves Rust.

import { invoke } from "@tauri-apps/api/core";
import type { PanelEntry } from "./browse_store";

export type Profile = {
  id: string;
  name: string;
  endpoint: string;
  access_key: string;
  region: string;
};

type S3Entry = { name: string; is_dir: boolean; size: number; modified: number | null };
type DirPage = { entries: S3Entry[]; next_token: string | null };
type LocalListing = { path: string; entries: S3Entry[] };

const toPanelEntry = (entry: S3Entry): PanelEntry => ({
  name: entry.name,
  isDir: entry.is_dir,
  size: entry.size,
  modified: entry.modified,
});

export const listProfiles = () => invoke<Profile[]>("profile_list");

export const listBuckets = (profileId: string) => invoke<string[]>("s3_list_buckets", { profileId });

export async function listBucketDir(profileId: string, bucket: string, prefix: string, token: string | null) {
  const page = await invoke<DirPage>("s3_list_dir", { profileId, bucket, prefix, token });
  return { entries: page.entries.map(toPanelEntry), nextToken: page.next_token };
}

export async function listLocalDir(path: string) {
  const listing = await invoke<LocalListing>("local_list_dir", { path });
  return { path: listing.path, entries: listing.entries.map(toPanelEntry) };
}

export const testProfile = (profileId: string) => invoke<number>("profile_test", { profileId });

export const duplicateProfile = (profileId: string) => invoke<Profile>("profile_duplicate", { profileId });
