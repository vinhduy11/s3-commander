// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clampRatio, loadSplit, ratioFromPointer, saveSplit, stepRatio, SPLIT_KEY } from "./panel_split";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("clampRatio", () => {
  it("keeps the 0.2..0.8 range", () => {
    expect(clampRatio(0.05, 2000)).toBe(0.2);
    expect(clampRatio(0.95, 2000)).toBe(0.8);
    expect(clampRatio(0.3, 2000)).toBe(0.3);
  });
  it("keeps 240 px per panel when the window is narrow", () => {
    // 1000 px: 240/1000 = 0.24 is the lower bound, 0.76 the upper
    expect(clampRatio(0.2, 1000)).toBeCloseTo(0.24);
    expect(clampRatio(0.8, 1000)).toBeCloseTo(0.76);
  });
  it("falls back to 50/50 when two minimums do not fit, and for garbage", () => {
    expect(clampRatio(0.3, 400)).toBe(0.5);
    expect(clampRatio(Number.NaN, 2000)).toBe(0.5);
    expect(clampRatio(0.3, 0)).toBe(0.3);
  });
});

describe("stepRatio and ratioFromPointer", () => {
  it("moves by pixels of the available width and clamps", () => {
    expect(stepRatio(0.5, 16, 1600)).toBeCloseTo(0.51);
    expect(stepRatio(0.5, -64, 1600)).toBeCloseTo(0.46);
    expect(stepRatio(0.21, -64, 1600)).toBe(0.2);
  });
  it("maps a pointer x to the left share of the free width", () => {
    // container at x=100, width 1008, splitter 8 => free width 1000; splitter centre at x=100+300+4
    expect(ratioFromPointer(404, { left: 100, width: 1008 })).toBeCloseTo(0.3);
    expect(ratioFromPointer(0, { left: 100, width: 1008 })).toBe(0.24);
  });
});

describe("persistence", () => {
  it("round-trips a ratio", () => {
    saveSplit(0.35);
    expect(loadSplit()).toBe(0.35);
  });
  it("defaults to 0.5 when nothing or garbage is stored, clamps stored values", () => {
    expect(loadSplit()).toBe(0.5);
    for (const bad of ["abc", "NaN", "", "{}", "Infinity"]) {
      localStorage.setItem(SPLIT_KEY, bad);
      expect(loadSplit()).toBe(0.5);
    }
    localStorage.setItem(SPLIT_KEY, "0.99");
    expect(loadSplit()).toBe(0.8);
    localStorage.setItem(SPLIT_KEY, "-3");
    expect(loadSplit()).toBe(0.2);
  });
  it("works with storage unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadSplit()).toBe(0.5);
    expect(() => saveSplit(0.4)).not.toThrow();
  });
});
