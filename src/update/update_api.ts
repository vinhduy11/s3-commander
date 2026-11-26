// The only file that talks to the updater and process plugins (mocked in tests).

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { DownloadProgress, FoundUpdate } from "./update_logic";

export type PendingUpdate = { found: FoundUpdate; install: (onProgress: (event: DownloadProgress) => void) => Promise<void> };

/** Asks the release endpoint; null when this version is the newest. Throws on network or signature errors. */
export async function checkForUpdate(): Promise<PendingUpdate | null> {
  const update: Update | null = await check();
  if (!update) return null;
  return {
    found: { version: update.version, currentVersion: update.currentVersion, notes: update.body ?? "" },
    install: (onProgress) => update.downloadAndInstall(onProgress),
  };
}

export const restartApp = () => relaunch();

export const readableError = (err: unknown): string => (err instanceof Error ? err.message : String(err));
