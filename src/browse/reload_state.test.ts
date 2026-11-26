import { describe, expect, it } from "vitest";
import type { PanelEntry, PanelSource } from "./browse_store";
import { keepAfterReload } from "./reload_state";

const file = (name: string): PanelEntry => ({ name, isDir: false, size: 1, modified: 1 });
const local: PanelSource = { kind: "local" };
// rows: 0 "..", 1 a, 2 b, 3 c
const before = { source: local, path: "/home/me", entries: [file("a"), file("b"), file("c")], cursor: 2, marked: { a: true, c: true } as Record<string, true>, anchor: "c" as string | null };

describe("keepAfterReload", () => {
  it("cursor follows the same name when rows move", () => {
    const kept = keepAfterReload(before, [file("0new"), file("a"), file("b"), file("c")]);
    expect(kept.cursor).toBe(3); // "..", new, a, b
  });

  it("falls back to the nearest index when the entry is gone", () => {
    expect(keepAfterReload(before, [file("a"), file("c")]).cursor).toBe(2);
    expect(keepAfterReload(before, [file("a")]).cursor).toBe(1); // clamped to the last row
    expect(keepAfterReload(before, []).cursor).toBe(0);
  });

  it("keeps marks only for names that still exist", () => {
    expect(keepAfterReload(before, [file("a"), file("b")]).marked).toEqual({ a: true });
  });

  it("keeps the anchor when its name exists, otherwise drops it", () => {
    expect(keepAfterReload(before, [file("c")]).anchor).toBe("c");
    expect(keepAfterReload(before, [file("a")]).anchor).toBeNull();
  });

  it("works at the root where there is no .. row", () => {
    const root = { ...before, path: "/", cursor: 1 };
    expect(keepAfterReload(root, [file("z"), file("a"), file("b")]).cursor).toBe(2);
  });
});
