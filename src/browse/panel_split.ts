// Pure rules of the divider between the two panels: the split is the left panel's share of the
// free width (container minus the splitter). Persisted in localStorage; every access is guarded
// because storage can be unavailable (private mode, blocked, quota).

export const SPLITTER_PX = 8;
export const MIN_PANEL_PX = 240;
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;
export const DEFAULT_RATIO = 0.5;
export const SPLIT_KEY = "s3c.panel-split.v1";

/** Allowed ratio range for a free width in px (0 = unknown: only the 0.2..0.8 range applies). */
function bounds(freePx: number): [number, number] {
  const lo = freePx > 0 ? Math.max(MIN_RATIO, MIN_PANEL_PX / freePx) : MIN_RATIO;
  return lo >= 0.5 ? [0.5, 0.5] : [lo, Math.min(MAX_RATIO, 1 - lo)];
}

export function clampRatio(ratio: number, freePx = 0): number {
  if (!Number.isFinite(ratio)) return DEFAULT_RATIO;
  const [lo, hi] = bounds(freePx);
  return Math.min(hi, Math.max(lo, ratio));
}

export const stepRatio = (ratio: number, deltaPx: number, freePx: number): number =>
  clampRatio(ratio + deltaPx / freePx, freePx);

/** Ratio that puts the splitter's centre under pointer `x`. */
export function ratioFromPointer(x: number, grid: { left: number; width: number }): number {
  const free = grid.width - SPLITTER_PX;
  return clampRatio((x - grid.left - SPLITTER_PX / 2) / free, free);
}

export function loadSplit(): number {
  try {
    const raw = localStorage.getItem(SPLIT_KEY);
    if (raw === null || raw.trim() === "") return DEFAULT_RATIO;
    return clampRatio(Number(raw));
  } catch {
    return DEFAULT_RATIO;
  }
}

export function saveSplit(ratio: number): void {
  try {
    localStorage.setItem(SPLIT_KEY, String(ratio));
  } catch {
    // storage unavailable: the split just does not persist
  }
}
