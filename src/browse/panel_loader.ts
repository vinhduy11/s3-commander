// Loads listings into the store. Responses that arrive after the panel moved on (other source,
// other path request, other profile) are dropped.

import { listBucketDir, listLocalDir } from "./browse_api";
import { useBrowseStore, type PanelSource, type Side } from "./browse_store";
import { buildRows, childPath, parentOf, sameSource } from "./navigation";

const requestCounter: Record<Side, number> = { left: 0, right: 0 };

/** `fallback`: a Local folder that no longer lists shows its nearest parent (restore at launch); a reload does the same. */
type LoadOptions = { focusName?: string; reload?: boolean; silent?: boolean; fallback?: boolean };

/** Nearest folder above `path` that lists, with its listing; null when none does (not even "/"). */
async function listNearestParent(path: string, isCurrent: () => boolean) {
  for (let parent = parentOf({ kind: "local" }, path); parent && isCurrent(); parent = parentOf({ kind: "local" }, parent.path)) {
    try {
      return await listLocalDir(parent.path);
    } catch {
      // keep walking up
    }
  }
  return null;
}

async function load(side: Side, path: string, { focusName, reload = false, silent = false, fallback = false }: LoadOptions): Promise<void> {
  const store = useBrowseStore.getState();
  const { source } = store[side];
  const { profileId } = store;
  if (!source || (source.kind === "bucket" && !profileId)) return;
  const ticket = ++requestCounter[side];
  // A Local listing does not depend on the profile, so a profile change must not drop it.
  const isCurrent = () => {
    const now = useBrowseStore.getState();
    const sameProfile = source.kind === "local" || now.profileId === profileId;
    return ticket === requestCounter[side] && sameProfile && sameSource(now[side].source, source);
  };
  // A dropped response must not leave loading=true unless a newer request owns the panel.
  const dropStale = () => {
    if (ticket === requestCounter[side]) useBrowseStore.getState().setLoading(side, false);
  };
  // The old rows stay in the store while loading; only the flag changes. A silent reload does not even show it.
  if (!silent) store.setLoading(side, true);
  try {
    if (source.kind === "local") {
      try {
        const listing = await listLocalDir(path);
        if (isCurrent()) useBrowseStore.getState().setListing(side, { ...listing, nextToken: null }, { focusName, keep: reload });
        else dropStale();
      } catch (err) {
        if (!reload && !fallback) throw err;
        // The folder is gone or unreadable: show the nearest parent that lists.
        const parent = await listNearestParent(path, isCurrent);
        if (!isCurrent()) return dropStale();
        if (!parent) throw err;
        useBrowseStore.getState().setListing(side, { ...parent, nextToken: null });
        useBrowseStore.getState().setNotice(side, `Folder no longer exists, showing ${parent.path}`);
      }
    } else {
      const page = await listBucketDir(profileId as string, source.bucket, path, null);
      if (isCurrent()) useBrowseStore.getState().setListing(side, { path, ...page }, { focusName, keep: reload });
      else dropStale();
    }
  } catch (err) {
    if (!isCurrent()) dropStale();
    else if (silent) useBrowseStore.getState().setLoading(side, false); // a background reload never shows an error
    else useBrowseStore.getState().setError(side, String(err));
  }
}

export const openPath = (side: Side, path: string, focusName?: string): Promise<void> => load(side, path, { focusName });

/**
 * Reload the panel's current path, keeping the user's context (rows stay while loading; cursor, marks,
 * anchor and scroll are kept by name). Server listings restart from the first page. `silent` (the
 * window-focus reload) shows no loading state and no error.
 */
export const reloadPanel = (side: Side, options: { silent?: boolean } = {}): Promise<void> =>
  load(side, useBrowseStore.getState()[side].path, { reload: true, silent: options.silent });

/** Switch the panel to `source` and list `path` there in one request (no extra root listing). */
export async function openLocation(side: Side, source: PanelSource, path: string): Promise<void> {
  useBrowseStore.getState().setSource(side, source);
  await openPath(side, path);
}

/**
 * Open a remembered location. A Local folder that vanished shows its nearest parent that lists; when
 * nothing lists, the default start (home directory / bucket root) is opened instead.
 */
export async function restoreLocation(side: Side, source: PanelSource, path: string): Promise<void> {
  useBrowseStore.getState().setSource(side, source);
  await load(side, path, { fallback: true });
  if (path !== "" && useBrowseStore.getState()[side].error) await openPath(side, "");
}

export async function openSource(side: Side, source: PanelSource | null): Promise<void> {
  useBrowseStore.getState().setSource(side, source);
  await openPath(side, "");
}

export async function loadMore(side: Side): Promise<void> {
  const store = useBrowseStore.getState();
  const panel = store[side];
  const { profileId } = store;
  if (panel.source?.kind !== "bucket" || !panel.nextToken || panel.loading || !profileId) return;
  const { source, path, nextToken } = panel;
  const ticket = ++requestCounter[side];
  store.setLoading(side, true);
  try {
    const page = await listBucketDir(profileId, source.bucket, path, nextToken);
    const now = useBrowseStore.getState();
    if (ticket === requestCounter[side] && now.profileId === profileId && sameSource(now[side].source, source)) {
      now.setListing(side, { path, ...page }, { append: true });
    }
  } catch (err) {
    if (ticket === requestCounter[side]) useBrowseStore.getState().setError(side, String(err));
  }
}

export const LOAD_ALL_CAP = 20_000;

/** Load every remaining page through loadMore, stopping at `cap` items (the panel then says so). */
export async function loadAll(side: Side, cap = LOAD_ALL_CAP): Promise<void> {
  const state = () => useBrowseStore.getState()[side];
  while (state().nextToken) {
    if (state().entries.length >= cap) {
      useBrowseStore.getState().setError(side, `Stopped loading at ${cap} items; scroll down to load more.`);
      return;
    }
    const before = state().entries.length;
    await loadMore(side);
    if (state().error || state().entries.length === before) return; // failed, stale, or another request owns the panel
  }
}

export function enterDir(side: Side, name: string): Promise<void> {
  const { source, path } = useBrowseStore.getState()[side];
  return source ? openPath(side, childPath(source, path, name)) : Promise.resolve();
}

export function goUp(side: Side): Promise<void> {
  const { source, path } = useBrowseStore.getState()[side];
  const parent = source ? parentOf(source, path) : null;
  return parent ? openPath(side, parent.path, parent.focusName) : Promise.resolve();
}

/** Enter (and the context menu's Open): ".." goes up, a folder is entered, a file does nothing yet. */
export function openRowAt(side: Side, index: number): void {
  const { source, path, entries } = useBrowseStore.getState()[side];
  const row = buildRows(source, path, entries)[index];
  if (!row) return;
  if (row.isUp) void goUp(side);
  else if (row.isDir) void enterDir(side, row.name);
}
