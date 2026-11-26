// Remember the last folder of each panel and open it again at the next launch. Saving watches the
// store and writes (debounced) what is settled: a panel that is loading, empty or without a source
// keeps its earlier remembered value. Restoring runs in two stages because a server location needs
// the bucket list of the profile: local panels at mount, server panels when the buckets arrive.

import { useBrowseStore, type BrowseState, type PanelState, type Side } from "./browse_store";
import { flushMemory, memory, MAX_PATH_CHARS, MAX_PROFILES, SAVE_DELAY_MS, updateMemory, type Memory } from "./location_memory";
import { restoreLocation } from "./panel_loader";

const SIDES: Side[] = ["left", "right"];
const LOCAL = { kind: "local" } as const;

const isSettled = (panel: PanelState) => panel.source !== null && !panel.loading;

/** The remembered state after taking over what the panels show now. */
export function snapshotLocations(state: BrowseState, before: Memory): Memory {
  const next: Memory = { ...before, active: state.active, kinds: { ...before.kinds }, local: { ...before.local }, servers: { ...before.servers } };
  for (const side of SIDES) {
    const panel = state[side];
    if (panel.source === null) continue;
    next.kinds[side] = panel.source.kind === "local" ? "local" : "server";
    if (!isSettled(panel) || panel.path.length > MAX_PATH_CHARS) continue;
    if (panel.source.kind === "local") {
      if (panel.path !== "") next.local[side] = panel.path;
    } else if (state.profileId !== null) {
      const profileId = state.profileId;
      const sides = { ...next.servers[profileId], [side]: { bucket: panel.source.bucket, prefix: panel.path } };
      delete next.servers[profileId]; // re-insert last: the oldest profiles are the ones dropped at the cap
      next.servers[profileId] = sides;
    }
  }
  for (const profileId of Object.keys(next.servers).slice(0, Math.max(0, Object.keys(next.servers).length - MAX_PROFILES))) delete next.servers[profileId];
  return next;
}

const locationKey = (state: BrowseState) =>
  [state.active, state.profileId, ...SIDES.flatMap((side) => [state[side].source?.kind, (state[side].source as { bucket?: string } | null)?.bucket, state[side].path, state[side].loading])].join("\u0000");

/** Start saving after every navigation; the returned function stops and writes what is pending. */
export function installLocationSave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    timer = null;
    updateMemory((before) => snapshotLocations(useBrowseStore.getState(), before));
    flushMemory();
  };
  const unsubscribe = useBrowseStore.subscribe((state, previous) => {
    if (locationKey(state) === locationKey(previous)) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY_MS);
  });
  return () => {
    unsubscribe();
    if (timer !== null) {
      clearTimeout(timer);
      save();
    }
  };
}

const isEmpty = (side: Side) => useBrowseStore.getState()[side].source === null;

/** Local panels: the remembered folder; first run (nothing remembered) is the old behaviour: the left panel opens home, the right stays empty. */
export async function restoreLocalPanels(): Promise<void> {
  const saved = memory();
  const wanted = SIDES.filter((side) => isEmpty(side) && (saved.kinds[side] === "local" || (saved.kinds[side] === undefined && side === "left")));
  if (!wanted.length) return;
  useBrowseStore.getState().setActive(saved.active);
  await Promise.all(wanted.map((side) => restoreLocation(side, LOCAL, saved.local[side] ?? "")));
}

/** Server panels of `profileId`, once its bucket list is known. A remembered bucket that is gone is replaced by the default start. */
export async function restoreServerPanels(profileId: string, buckets: string[]): Promise<void> {
  const saved = memory();
  const jobs: Promise<void>[] = [];
  for (const side of SIDES) {
    if (!isEmpty(side)) continue;
    const kind = saved.kinds[side];
    const location = saved.servers[profileId]?.[side];
    if (kind === "server" && location && buckets.includes(location.bucket)) {
      jobs.push(restoreLocation(side, { kind: "bucket", bucket: location.bucket }, location.prefix));
    } else if (side === "right" && kind !== "local" && buckets.length) {
      jobs.push(restoreLocation(side, { kind: "bucket", bucket: buckets[0] }, ""));
    } else if (side === "left" && kind === "server") {
      jobs.push(restoreLocation(side, LOCAL, ""));
    }
  }
  await Promise.all(jobs);
}
