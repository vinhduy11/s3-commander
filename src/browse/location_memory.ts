// What the browser remembers between launches: the last folder of each panel, the active panel
// and the recent locations of the path field. Names only (source kind, bucket, path strings):
// never credentials, endpoints, URLs or file contents. Kept in the webview's localStorage under a
// versioned key. Every storage access is guarded (it can be unavailable or hold garbage) and every
// value read back is validated and clamped. The current value is also held in memory, so the app
// works the same with storage blocked.

import type { Side } from "./browse_store";

export const LOCATION_KEY = "s3c.last-location.v1";
export const SAVE_DELAY_MS = 400;
export const RECENT_CAP = 20;
export const MAX_PATH_CHARS = 2048;
export const MAX_PROFILES = 50;
const MAX_ID_CHARS = 200;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SIDES: Side[] = ["left", "right"];

export type PanelKind = "local" | "server";
export type ServerLocation = { bucket: string; prefix: string };
export type Memory = {
  v: 1;
  active: Side;
  /** Which kind of source each panel had. */
  kinds: Partial<Record<Side, PanelKind>>;
  /** Local panels: absolute folder. */
  local: Partial<Record<Side, string>>;
  /** Server panels: bucket and prefix per profile id. */
  servers: Record<string, Partial<Record<Side, ServerLocation>>>;
  /** Recent locations of the path field per panel kind, newest first. */
  recents: Record<PanelKind, string[]>;
};

export const EMPTY_MEMORY: Memory = { v: 1, active: "left", kinds: {}, local: {}, servers: {}, recents: { local: [], server: [] } };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isName = (value: unknown, max = MAX_PATH_CHARS): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** Keep the sides whose value passes `read`, drop the rest. */
function bySide<T>(value: unknown, read: (item: unknown) => T | undefined): Partial<Record<Side, T>> {
  const out: Partial<Record<Side, T>> = {};
  if (!isRecord(value)) return out;
  for (const side of SIDES) {
    const item = read(value[side]);
    if (item !== undefined) out[side] = item;
  }
  return out;
}

function readServers(value: unknown): Memory["servers"] {
  const out: Memory["servers"] = {};
  if (!isRecord(value)) return out;
  for (const [profileId, sides] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_PROFILES) break;
    if (FORBIDDEN_KEYS.has(profileId) || !isName(profileId, MAX_ID_CHARS)) continue;
    const readLocation = (item: unknown): ServerLocation | undefined =>
      isRecord(item) && isName(item.bucket, MAX_ID_CHARS) && typeof item.prefix === "string" && item.prefix.length <= MAX_PATH_CHARS
        ? { bucket: item.bucket, prefix: item.prefix }
        : undefined;
    const locations = bySide(sides, readLocation);
    if (Object.keys(locations).length) out[profileId] = locations;
  }
  return out;
}

const readRecents = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => isName(item)).slice(0, RECENT_CAP) : [];

export function parseMemory(raw: string | null): Memory {
  if (!raw) return EMPTY_MEMORY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_MEMORY;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return EMPTY_MEMORY;
  const recents = isRecord(parsed.recents) ? parsed.recents : {};
  return {
    v: 1,
    active: parsed.active === "right" ? "right" : "left",
    kinds: bySide(parsed.kinds, (item) => (item === "local" || item === "server" ? item : undefined)),
    local: bySide(parsed.local, (item) => (isName(item) ? item : undefined)),
    servers: readServers(parsed.servers),
    recents: { local: readRecents(recents.local), server: readRecents(recents.server) },
  };
}

/** `entry` on top, an earlier copy removed, at most RECENT_CAP kept. */
export const pushRecent = (list: string[], entry: string): string[] => [entry, ...list.filter((item) => item !== entry)].slice(0, RECENT_CAP);

function readStorage(): string | null {
  try {
    return localStorage.getItem(LOCATION_KEY);
  } catch {
    return null;
  }
}

let current: Memory | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let isDirty = false;

export const memory = (): Memory => (current ??= parseMemory(readStorage()));

/** Write now (guarded); a pending delayed write is cancelled. Nothing is written when nothing changed. */
export function flushMemory(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  if (!isDirty || current === null) return;
  isDirty = false;
  try {
    localStorage.setItem(LOCATION_KEY, JSON.stringify(current));
  } catch {
    // storage unavailable or full: the value stays in memory only
  }
}

/** Replace the value and schedule one delayed write (a burst of updates is one write). */
export function updateMemory(change: (before: Memory) => Memory): void {
  current = change(memory());
  isDirty = true;
  if (saveTimer === null) saveTimer = setTimeout(flushMemory, SAVE_DELAY_MS);
}

/** Forget the in-memory copy so the next read goes to storage again (tests). */
export function resetMemoryCache(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  isDirty = false;
  current = null;
}
