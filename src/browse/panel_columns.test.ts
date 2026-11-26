// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COLUMNS_KEY, COLUMN_LIMITS, NAME_MIN_PX, clampWidth, defaultWidths, fitWidths, loadColumns, resetWidth, saveColumns, stepWidth,
} from "./panel_columns";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("clampWidth / stepWidth / resetWidth", () => {
  it("keeps each column inside its own min and max", () => {
    expect(clampWidth("ext", 1)).toBe(COLUMN_LIMITS.ext.min);
    expect(clampWidth("size", 9999)).toBe(COLUMN_LIMITS.size.max);
    expect(clampWidth("date", 150)).toBe(150);
  });
  it("rounds and falls back to the default for garbage", () => {
    expect(clampWidth("size", 100.6)).toBe(101);
    expect(clampWidth("size", Number.NaN)).toBe(COLUMN_LIMITS.size.def);
    expect(clampWidth("size", Infinity)).toBe(COLUMN_LIMITS.size.def);
  });
  it("steps by a delta and clamps", () => {
    expect(stepWidth("size", 84, 16)).toBe(100);
    expect(stepWidth("size", 84, -500)).toBe(COLUMN_LIMITS.size.min);
  });
  it("reset gives the default", () => {
    expect(resetWidth("date")).toBe(COLUMN_LIMITS.date.def);
  });
  it("minimums leave room for <DIR> and a full date (chars x 7.5 px mono)", () => {
    expect(COLUMN_LIMITS.ext.min).toBeGreaterThanOrEqual(5 * 7.5);
    expect(COLUMN_LIMITS.date.min).toBeGreaterThanOrEqual(16 * 7.5);
    expect(COLUMN_LIMITS.size.min).toBeGreaterThanOrEqual(10 * 7.5);
  });
});

describe("fitWidths", () => {
  const wide = { ext: 160, size: 200, date: 220 };
  it("is the identity when the panel is unknown (0) or wide enough", () => {
    expect(fitWidths(wide, 0)).toEqual(wide);
    expect(fitWidths(defaultWidths(), 900)).toEqual(defaultWidths());
  });
  it("shrinks Date first, then Size, then Ext, never below a minimum, so Name keeps NAME_MIN_PX", () => {
    const fit = fitWidths(wide, 600);
    const used = fit.ext + fit.size + fit.date;
    expect(600 - 34 - 8 * 3 - used).toBeGreaterThanOrEqual(NAME_MIN_PX);
    expect(fit.ext).toBe(160);
    expect(fit.date).toBeLessThan(220);
    const tight = fitWidths(wide, 440);
    expect(tight.date).toBe(COLUMN_LIMITS.date.min);
    expect(tight.size).toBeLessThan(200);
  });
  it("floors the shown columns at their minimum when the panel is tiny", () => {
    expect(fitWidths(wide, 240)).toEqual({ ext: COLUMN_LIMITS.ext.min, size: COLUMN_LIMITS.size.min, date: 220 });
    expect(fitWidths(wide, 425).date).toBe(COLUMN_LIMITS.date.min);
  });
  it("a hidden Date (narrow panel, <= 420 px) takes no space and no budget", () => {
    const fit = fitWidths(wide, 420);
    expect(420 - 34 - 8 * 2 - fit.ext - fit.size).toBeGreaterThanOrEqual(NAME_MIN_PX);
    expect(fit.date).toBe(220); // untouched, it is just not shown
  });
  it("does not mutate its input and growing again restores the user's widths", () => {
    const user = { ...wide };
    fitWidths(user, 400);
    expect(user).toEqual(wide);
    expect(fitWidths(user, 1200)).toEqual(wide);
  });
});

describe("persistence", () => {
  const both = { left: { ext: 70, size: 100, date: 150 }, right: defaultWidths() };
  it("round-trips", () => {
    saveColumns(both);
    expect(loadColumns()).toEqual(both);
  });
  it("falls back to defaults when nothing is stored, or on garbage", () => {
    const def = { left: defaultWidths(), right: defaultWidths() };
    expect(loadColumns()).toEqual(def);
    for (const raw of ["", "{", "null", "[1]", '"x"', '{"left":5}']) {
      localStorage.setItem(COLUMNS_KEY, raw);
      expect(loadColumns()).toEqual(def);
    }
  });
  it("clamps out-of-range values and replaces non-numbers per field", () => {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify({ left: { ext: 1, size: "abc", date: 99999 }, right: { ext: 60 } }));
    expect(loadColumns()).toEqual({
      left: { ext: COLUMN_LIMITS.ext.min, size: COLUMN_LIMITS.size.def, date: COLUMN_LIMITS.date.max },
      right: { ...defaultWidths(), ext: 60 },
    });
  });
  it("works when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => saveColumns(both)).not.toThrow();
    expect(loadColumns()).toEqual({ left: defaultWidths(), right: defaultWidths() });
  });
});
