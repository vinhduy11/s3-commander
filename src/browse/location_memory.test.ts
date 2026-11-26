// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_MEMORY, LOCATION_KEY, MAX_PATH_CHARS, MAX_PROFILES, RECENT_CAP, flushMemory, memory, parseMemory, pushRecent, resetMemoryCache, updateMemory, SAVE_DELAY_MS,
} from "./location_memory";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetMemoryCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parseMemory", () => {
  it("null, empty, non-JSON and wrong shapes give the empty memory", () => {
    for (const raw of [null, "", "{", "[]", "42", '"x"', "null", '{"v":2}', '{"v":1,"sides":5}']) expect(parseMemory(raw)).toEqual(EMPTY_MEMORY);
  });

  it("round-trips a valid value", () => {
    const value = {
      v: 1, active: "right", kinds: { left: "local", right: "server" },
      local: { left: "/Users/me/a", right: "/tmp" },
      servers: { p1: { left: { bucket: "alpha", prefix: "x/" }, right: { bucket: "beta", prefix: "" } } },
      recents: { local: ["/a", "/b"], server: ["s3://alpha/x/"] },
    };
    expect(parseMemory(JSON.stringify(value))).toEqual(value);
  });

  it("drops invalid parts one by one and keeps the valid ones", () => {
    const raw = JSON.stringify({
      v: 1, active: "middle", kinds: { left: "floppy", right: "local" },
      local: { left: 5, right: "/ok", extra: "/x" },
      servers: { p1: { left: { bucket: "", prefix: "x/" }, right: { bucket: "b", prefix: 7 } }, p2: { left: { bucket: "b", prefix: "p/" } } },
      recents: { local: ["/a", 3, "", "/b"], server: "nope" },
    });
    expect(parseMemory(raw)).toEqual({
      v: 1, active: "left", kinds: { right: "local" }, local: { right: "/ok" },
      servers: { p2: { left: { bucket: "b", prefix: "p/" } } }, recents: { local: ["/a", "/b"], server: [] },
    });
  });

  it("clamps lengths and counts", () => {
    const longPath = "/" + "a".repeat(MAX_PATH_CHARS);
    const servers = Object.fromEntries(Array.from({ length: MAX_PROFILES + 5 }, (_, idx) => [`p${idx}`, { left: { bucket: "b", prefix: "" } }]));
    const recents = Array.from({ length: RECENT_CAP + 10 }, (_, idx) => `/r${idx}`);
    const parsed = parseMemory(JSON.stringify({ v: 1, local: { left: longPath }, servers, recents: { local: [longPath, ...recents], server: [] } }));
    expect(parsed.local.left).toBeUndefined();
    expect(Object.keys(parsed.servers)).toHaveLength(MAX_PROFILES);
    expect(parsed.recents.local).toHaveLength(RECENT_CAP);
    expect(parsed.recents.local[0]).toBe("/r0");
  });

  it("ignores prototype-pollution keys", () => {
    const parsed = parseMemory('{"v":1,"servers":{"__proto__":{"left":{"bucket":"b","prefix":""}},"p":{"left":{"bucket":"b","prefix":""}}}}');
    expect(Object.keys(parsed.servers)).toEqual(["p"]);
  });
});

describe("pushRecent", () => {
  it("puts the newest first, removes the duplicate, and caps at 20", () => {
    expect(pushRecent(["/a", "/b"], "/b")).toEqual(["/b", "/a"]);
    expect(pushRecent(["/a"], "/c")).toEqual(["/c", "/a"]);
    let list: string[] = [];
    for (let idx = 0; idx < 30; idx++) list = pushRecent(list, `/p${idx}`);
    expect(list).toHaveLength(RECENT_CAP);
    expect(list[0]).toBe("/p29");
    expect(list[RECENT_CAP - 1]).toBe("/p10");
  });
});

describe("memory, updateMemory and the debounced save", () => {
  it("reads garbage storage as empty", () => {
    localStorage.setItem(LOCATION_KEY, "{{{");
    expect(memory()).toEqual(EMPTY_MEMORY);
  });

  it("saves once after the delay, not on every update", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    updateMemory((current) => ({ ...current, active: "right" }));
    updateMemory((current) => ({ ...current, local: { ...current.local, left: "/a" } }));
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SAVE_DELAY_MS - 1);
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(parseMemory(localStorage.getItem(LOCATION_KEY))).toMatchObject({ active: "right", local: { left: "/a" } });
  });

  it("flushMemory writes immediately and cancels the timer", () => {
    updateMemory((current) => ({ ...current, active: "right" }));
    flushMemory();
    expect(parseMemory(localStorage.getItem(LOCATION_KEY)).active).toBe("right");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    vi.advanceTimersByTime(5000);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("works with storage unavailable (reads and writes throw)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    resetMemoryCache();
    expect(memory()).toEqual(EMPTY_MEMORY);
    updateMemory((current) => ({ ...current, active: "right" }));
    expect(() => vi.advanceTimersByTime(SAVE_DELAY_MS)).not.toThrow();
    expect(memory().active).toBe("right"); // still held in memory
  });

  it("stores only names: no endpoint, key or URL fields", () => {
    updateMemory((current) => ({ ...current, servers: { p1: { left: { bucket: "alpha", prefix: "x/" } } } }));
    flushMemory();
    const raw = localStorage.getItem(LOCATION_KEY) as string;
    expect(raw).not.toMatch(/secret|password|endpoint|http/i);
  });
});
