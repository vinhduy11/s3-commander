// Pure rules of the resizable panel columns (Ext, Size, Date; Name takes the rest). Each panel has
// its own widths. Persisted in localStorage; every access is guarded because storage can be
// unavailable (private mode, blocked, quota). Stored garbage falls back per field.

export type ColumnKey = "ext" | "size" | "date";
export type ColumnWidths = Record<ColumnKey, number>;
export type PanelColumns = { left: ColumnWidths; right: ColumnWidths };

export const COLUMN_KEYS: ColumnKey[] = ["ext", "size", "date"];
/** min: `<DIR>`, "1023.99 GB" and "2026-11-26 14:30" fit in the 12 px mono font. */
export const COLUMN_LIMITS: Record<ColumnKey, { min: number; max: number; def: number }> = {
  ext: { min: 48, max: 160, def: 56 },
  size: { min: 80, max: 200, def: 84 },
  date: { min: 120, max: 220, def: 124 },
};
export const COLUMNS_KEY = "s3c.panel-columns.v1";
export const STEP_PX = 8;
export const BIG_STEP_PX = 32;
/** Name never gets less than this while the other columns can still shrink. */
export const NAME_MIN_PX = 96;
/** Same value as the `@container (max-width: 420px)` rule in styles.css that hides Date. */
export const HIDE_DATE_PX = 420;
// row chrome: list margin 2x4 + row padding 2x8 + header/scrollbar match; one 8 px gap per column after Name
const CHROME_PX = 34;
const GAP_PX = 8;

export const defaultWidths = (): ColumnWidths => ({ ext: COLUMN_LIMITS.ext.def, size: COLUMN_LIMITS.size.def, date: COLUMN_LIMITS.date.def });

export function clampWidth(col: ColumnKey, px: number): number {
  const { min, max, def } = COLUMN_LIMITS[col];
  return Number.isFinite(px) ? Math.min(max, Math.max(min, Math.round(px))) : def;
}
export const stepWidth = (col: ColumnKey, px: number, deltaPx: number): number => clampWidth(col, px + deltaPx);
export const resetWidth = (col: ColumnKey): number => COLUMN_LIMITS[col].def;

/**
 * Widths to show in a panel `panelPx` wide (0 = unknown, no fitting). Date is dropped from the
 * budget when the panel is narrow (it is hidden). Shrinks Date, then Size, then Ext, never below
 * a minimum, so Name keeps NAME_MIN_PX where possible. The user's widths are never changed.
 */
export function fitWidths(widths: ColumnWidths, panelPx: number): ColumnWidths {
  if (panelPx <= 0) return widths;
  const shown = panelPx <= HIDE_DATE_PX ? (["ext", "size"] as ColumnKey[]) : COLUMN_KEYS;
  let excess = shown.reduce((sum, col) => sum + widths[col], 0) - (panelPx - CHROME_PX - GAP_PX * shown.length - NAME_MIN_PX);
  const fit = { ...widths };
  for (const col of [...shown].reverse()) {
    if (excess <= 0) break;
    const cut = Math.min(excess, fit[col] - COLUMN_LIMITS[col].min);
    fit[col] -= cut;
    excess -= cut;
  }
  return fit;
}

const field = (value: unknown, col: ColumnKey) => (typeof value === "number" ? clampWidth(col, value) : COLUMN_LIMITS[col].def);
function parseSide(value: unknown): ColumnWidths {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return { ext: field(obj.ext, "ext"), size: field(obj.size, "size"), date: field(obj.date, "date") };
}

export function loadColumns(): PanelColumns {
  try {
    const raw = localStorage.getItem(COLUMNS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const obj = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    return { left: parseSide(obj.left), right: parseSide(obj.right) };
  } catch {
    return { left: defaultWidths(), right: defaultWidths() };
  }
}

export function saveColumns(columns: PanelColumns): void {
  try {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns));
  } catch {
    // storage unavailable: the widths just do not persist
  }
}
