// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, type BrowseState, type PanelEntry } from "./browse_store";
import {
  autoScrollStep,
  dragSet,
  exceedsThreshold,
  hitTest,
  resolveDrop,
  targetFromElement,
} from "./drag_drop_logic";

const dir = (name: string): PanelEntry => ({ name, isDir: true, size: 0, modified: null });
const file = (name: string): PanelEntry => ({ name, isDir: false, size: 1, modified: 1 });

function state(overrides: Partial<BrowseState> = {}): BrowseState {
  return {
    ...initialBrowseState(),
    left: { ...emptyPanel(), source: { kind: "local" }, path: "/home/u", entries: [dir("docs"), dir("docs2"), dir("pics"), file("a.txt"), file("b.txt")] },
    right: { ...emptyPanel(), source: { kind: "bucket", bucket: "alpha" }, path: "in/", entries: [dir("docs"), file("r.txt")] },
    profileId: "p1",
    ...overrides,
  } as BrowseState;
}
const body = (side: "left" | "right") => ({ side, name: null, isDir: false, isUp: false });
const folder = (side: "left" | "right", name: string) => ({ side, name, isDir: true, isUp: false });

describe("pointer threshold", () => {
  it("does not start a drag below 4 px and starts at 4 px", () => {
    expect(exceedsThreshold({ x: 10, y: 10 }, { x: 12, y: 11 })).toBe(false);
    expect(exceedsThreshold({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(false);
    expect(exceedsThreshold({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(true);
    expect(exceedsThreshold({ x: 10, y: 10 }, { x: 7, y: 13 })).toBe(true);
  });
});

describe("autoScrollStep", () => {
  const rect = { top: 100, bottom: 400 };
  it("is 0 away from the edges, negative near the top, positive near the bottom", () => {
    expect(autoScrollStep(250, rect)).toBe(0);
    expect(autoScrollStep(105, rect)).toBeLessThan(0);
    expect(autoScrollStep(395, rect)).toBeGreaterThan(0);
  });
  it("grows towards the edge and is capped", () => {
    expect(Math.abs(autoScrollStep(101, rect))).toBeGreaterThan(Math.abs(autoScrollStep(120, rect)));
    expect(Math.abs(autoScrollStep(0, rect))).toBeLessThanOrEqual(Math.abs(autoScrollStep(100, rect)));
  });
});

describe("dragSet", () => {
  it("is the marked rows (listing order) when the dragged row is marked", () => {
    const panel = { ...state().left, marked: { "b.txt": true as const, "a.txt": true as const } };
    expect(dragSet(panel, "b.txt")).toEqual(["a.txt", "b.txt"]);
  });
  it("is just the dragged row when it is not marked, even with other marks", () => {
    const panel = { ...state().left, marked: { "a.txt": true as const } };
    expect(dragSet(panel, "docs")).toEqual(["docs"]);
  });
  it("never contains .. or an unknown name", () => {
    expect(dragSet(state().left, "..")).toEqual([]);
    expect(dragSet(state().left, "ghost")).toEqual([]);
  });
});

describe("hit testing", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div data-panel="left"><div class="list"><div data-row-name="docs" data-row-dir="true" id="r-docs"></div>
      <div data-row-name=".." data-row-dir="true" data-row-up="true" id="r-up"></div>
      <div data-row-name="a.txt" id="r-file"></div><div id="blank"></div></div></div>
      <div id="outside"></div>`;
  });
  it("maps a row element to its panel, name and kind", () => {
    expect(targetFromElement(document.getElementById("r-docs"))).toEqual({ side: "left", name: "docs", isDir: true, isUp: false });
    expect(targetFromElement(document.getElementById("r-up"))).toEqual({ side: "left", name: "..", isDir: true, isUp: true });
    expect(targetFromElement(document.getElementById("r-file"))).toEqual({ side: "left", name: "a.txt", isDir: false, isUp: false });
  });
  it("maps blank panel space to the panel body and outside to null", () => {
    expect(targetFromElement(document.getElementById("blank"))).toEqual({ side: "left", name: null, isDir: false, isUp: false });
    expect(targetFromElement(document.getElementById("outside"))).toBeNull();
    expect(targetFromElement(null)).toBeNull();
  });
  it("hitTest asks the document for the element under the point", () => {
    const spy = vi.fn(() => document.getElementById("r-docs"));
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = spy;
    expect(hitTest(30, 40)?.name).toBe("docs");
    expect(spy).toHaveBeenCalledWith(30, 40);
  });
});

describe("resolveDrop mapping", () => {
  it("plain drop on the other panel body copies to its current path", () => {
    const verdict = resolveDrop(state(), { from: "left", names: ["a.txt"], to: body("right"), shift: false });
    expect(verdict).toEqual({
      ok: true,
      mode: "copy",
      operation: {
        side: "left",
        destSide: "right",
        source: { kind: "local", path: "/home/u" },
        dest: { kind: "bucket", bucket: "alpha", prefix: "in/" },
        items: [{ name: "a.txt", is_dir: false }],
      },
    });
  });
  it("Shift at drop moves", () => {
    const verdict = resolveDrop(state(), { from: "left", names: ["a.txt", "docs"], to: body("right"), shift: true });
    expect(verdict.ok && verdict.mode).toBe("move");
    expect(verdict.ok && verdict.operation.items).toEqual([{ name: "a.txt", is_dir: false }, { name: "docs", is_dir: true }]);
  });
  it("dropping on a folder row targets that folder inside the panel location", () => {
    const toServer = resolveDrop(state(), { from: "left", names: ["a.txt"], to: folder("right", "docs"), shift: false });
    expect(toServer.ok && toServer.operation.dest).toEqual({ kind: "bucket", bucket: "alpha", prefix: "in/docs/" });
    const toLocal = resolveDrop(state(), { from: "right", names: ["r.txt"], to: folder("left", "pics"), shift: false });
    expect(toLocal.ok && toLocal.operation.dest).toEqual({ kind: "local", path: "/home/u/pics" });
    expect(toLocal.ok && toLocal.operation.source).toEqual({ kind: "bucket", bucket: "alpha", prefix: "in/" });
  });
  it("dropping on a file row of the other panel acts as the panel body", () => {
    const verdict = resolveDrop(state(), { from: "left", names: ["a.txt"], to: { side: "right", name: "r.txt", isDir: false, isUp: false }, shift: false });
    expect(verdict.ok && verdict.operation.dest).toEqual({ kind: "bucket", bucket: "alpha", prefix: "in/" });
  });
  it("within the same panel a folder row means move into it, with or without Shift", () => {
    for (const shift of [false, true]) {
      const verdict = resolveDrop(state(), { from: "left", names: ["a.txt"], to: folder("left", "pics"), shift });
      expect(verdict.ok && verdict.mode).toBe("move");
      expect(verdict.ok && verdict.operation.dest).toEqual({ kind: "local", path: "/home/u/pics" });
      expect(verdict.ok && verdict.operation.destSide).toBe("left");
    }
  });
});

describe("resolveDrop refusals", () => {
  const refused = (verdict: ReturnType<typeof resolveDrop>) => (verdict.ok ? "" : verdict.reason);
  it("refuses the same panel body and a same-panel file row", () => {
    expect(refused(resolveDrop(state(), { from: "left", names: ["a.txt"], to: body("left"), shift: false }))).not.toBe("");
    expect(refused(resolveDrop(state(), { from: "left", names: ["a.txt"], to: { side: "left", name: "b.txt", isDir: false, isUp: false }, shift: false }))).not.toBe("");
  });
  it("refuses a folder dropped onto itself", () => {
    expect(refused(resolveDrop(state(), { from: "left", names: ["docs", "a.txt"], to: folder("left", "docs"), shift: false }))).toMatch(/itself/);
  });
  it("refuses a folder dropped into its own child (other panel shows the same place)", () => {
    const both = state({ right: { ...emptyPanel(), source: { kind: "local" }, path: "/home/u/docs/deep", entries: [] } });
    expect(refused(resolveDrop(both, { from: "left", names: ["docs"], to: body("right"), shift: false }))).toMatch(/itself|inside/);
    const inside = state({ right: { ...emptyPanel(), source: { kind: "local" }, path: "/home/u", entries: [dir("docs")] } });
    expect(refused(resolveDrop(inside, { from: "left", names: ["docs"], to: folder("right", "docs"), shift: false }))).toMatch(/itself|inside/);
  });
  it("does not mistake a sibling with the same name prefix for a child", () => {
    const sibling = state({ right: { ...emptyPanel(), source: { kind: "local" }, path: "/home/u/docs2", entries: [] } });
    expect(resolveDrop(sibling, { from: "left", names: ["docs"], to: body("right"), shift: false }).ok).toBe(true);
  });
  it("refuses a server folder into its own child prefix", () => {
    const left = { ...emptyPanel(), source: { kind: "bucket", bucket: "alpha" } as const, path: "a/", entries: [dir("b")] };
    const right = { ...emptyPanel(), source: { kind: "bucket", bucket: "alpha" } as const, path: "a/b/c/", entries: [] };
    expect(resolveDrop(state({ left, right }), { from: "left", names: ["b"], to: body("right"), shift: false }).ok).toBe(false);
  });
  it("refuses both panels showing the same folder", () => {
    const same = state({ right: { ...emptyPanel(), source: { kind: "local" }, path: "/home/u", entries: [] } });
    expect(resolveDrop(same, { from: "left", names: ["a.txt"], to: body("right"), shift: false }).ok).toBe(false);
  });
  it("refuses the .. row", () => {
    expect(refused(resolveDrop(state(), { from: "right", names: ["r.txt"], to: { side: "left", name: "..", isDir: true, isUp: true }, shift: false }))).toMatch(/\.\./);
  });
  it("refuses when the destination panel has no source", () => {
    const none = state({ right: emptyPanel() });
    expect(refused(resolveDrop(none, { from: "left", names: ["a.txt"], to: body("right"), shift: false }))).toMatch(/source/i);
  });
  it("refuses an empty set", () => {
    expect(resolveDrop(state(), { from: "left", names: [], to: body("right"), shift: false }).ok).toBe(false);
  });
});
