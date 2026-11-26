// Loads listings into the store. Responses that arrive after the panel moved on (other source,
// other path request, other profile) are dropped.

import { listBucketDir, listLocalDir } from "./browse_api";
import { useBrowseStore, type PanelSource, type Side } from "./browse_store";
import { childPath, parentOf } from "./navigation";

const requestCounter: Record<Side, number> = { left: 0, right: 0 };

const sameSource = (first: PanelSource | null, second: PanelSource | null) =>
  first?.kind === second?.kind && (first?.kind !== "bucket" || first.bucket === (second as typeof first).bucket);

export async function openPath(side: Side, path: string, focusName?: string): Promise<void> {
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
  store.setLoading(side, true);
  try {
    if (source.kind === "local") {
      const listing = await listLocalDir(path);
      if (isCurrent()) useBrowseStore.getState().setListing(side, { ...listing, nextToken: null }, { focusName });
      else dropStale();
    } else {
      const page = await listBucketDir(profileId as string, source.bucket, path, null);
      if (isCurrent()) useBrowseStore.getState().setListing(side, { path, ...page }, { focusName });
      else dropStale();
    }
  } catch (err) {
    if (isCurrent()) useBrowseStore.getState().setError(side, String(err));
    else dropStale();
  }
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

export function enterDir(side: Side, name: string): Promise<void> {
  const { source, path } = useBrowseStore.getState()[side];
  return source ? openPath(side, childPath(source, path, name)) : Promise.resolve();
}

export function goUp(side: Side): Promise<void> {
  const { source, path } = useBrowseStore.getState()[side];
  const parent = source ? parentOf(source, path) : null;
  return parent ? openPath(side, parent.path, parent.focusName) : Promise.resolve();
}
