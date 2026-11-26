// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import { useBrowseStore, initialBrowseState, type PanelEntry } from "./browse_store";

const file = (name: string, size = 1): PanelEntry => ({ name, isDir: false, size, modified: 1 });
const dir = (name: string): PanelEntry => ({ name, isDir: true, size: 0, modified: null });
const store = () => useBrowseStore.getState();

beforeEach(() => useBrowseStore.setState(initialBrowseState()));

describe("panel slices", () => {
  it("keep independent state per panel", () => {
    store().setSource("left", { kind: "local" });
    store().setSource("right", { kind: "bucket", bucket: "alpha" });
    store().setListing("left", { path: "/home", entries: [file("a.txt")], nextToken: null });
    store().setListing("right", { path: "logs/", entries: [file("b.log")], nextToken: "t2" });
    store().toggleMark("left", "a.txt");
    store().setCursor("right", 1);
    expect(store().left.marked).toEqual({ "a.txt": true });
    expect(store().right.marked).toEqual({});
    expect(store().left.path).toBe("/home");
    expect(store().right.path).toBe("logs/");
    expect(store().right.nextToken).toBe("t2");
    expect(store().left.cursor).toBe(0);
  });

  it("a change in one panel keeps the other panel object identical (no re-render)", () => {
    const rightBefore = store().right;
    store().toggleMark("left", "x");
    store().setCursor("left", 0);
    expect(store().right).toBe(rightBefore);
  });

  it("sorts directories first, then by name ignoring case", () => {
    store().setListing("left", { path: "/", entries: [file("b"), dir("Z"), file("A"), dir("a")], nextToken: null });
    expect(store().left.entries.map((entry) => entry.name)).toEqual(["a", "Z", "A", "b"]);
  });

  it("append adds the next page and keeps the cursor and marks", () => {
    store().setListing("right", { path: "", entries: [file("a"), file("b")], nextToken: "t" });
    store().setCursor("right", 1);
    store().toggleMark("right", "a");
    store().setListing("right", { path: "", entries: [file("c")], nextToken: null }, { append: true });
    expect(store().right.entries.map((entry) => entry.name)).toEqual(["a", "b", "c"]);
    expect(store().right.nextToken).toBeNull();
    expect(store().right.cursor).toBe(1);
    expect(store().right.marked).toEqual({ a: true });
  });

  it("a new listing clears marks and puts the cursor on the requested name", () => {
    store().setSource("left", { kind: "local" });
    store().toggleMark("left", "old");
    store().setListing("left", { path: "/a", entries: [dir("x"), dir("y")], nextToken: null }, { focusName: "y" });
    expect(store().left.marked).toEqual({});
    // row 0 is the ".." row, so "y" is row 2
    expect(store().left.cursor).toBe(2);
  });

  it("clamps the cursor to the rows", () => {
    store().setListing("left", { path: "/", entries: [file("a")], nextToken: null });
    store().setCursor("left", 99);
    expect(store().left.cursor).toBe(0);
    store().setCursor("left", -4);
    expect(store().left.cursor).toBe(0);
  });
});

describe("profile switch and lock", () => {
  function fillBoth() {
    store().setProfile("p1");
    store().setBuckets(["alpha"]);
    store().setSource("left", { kind: "local" });
    store().setListing("left", { path: "/home", entries: [file("keep.txt")], nextToken: null });
    store().toggleMark("left", "keep.txt");
    store().setSource("right", { kind: "bucket", bucket: "alpha" });
    store().setListing("right", { path: "x/", entries: [file("k")], nextToken: "t" });
  }

  it("resets only the S3 panel when the profile changes", () => {
    fillBoth();
    const localBefore = store().left;
    store().setProfile("p2");
    expect(store().left).toBe(localBefore);
    expect(store().right.source).toBeNull();
    expect(store().right.entries).toEqual([]);
    expect(store().right.nextToken).toBeNull();
    expect(store().buckets).toEqual([]);
    expect(store().profileId).toBe("p2");
  });

  it("selecting the same profile again changes nothing", () => {
    fillBoth();
    const before = store().right;
    store().setProfile("p1");
    expect(store().right).toBe(before);
    expect(store().buckets).toEqual(["alpha"]);
  });

  it("lock clears the S3 side and the profile but keeps Local", () => {
    fillBoth();
    store().lock();
    expect(store().profileId).toBeNull();
    expect(store().right.source).toBeNull();
    expect(store().left.source).toEqual({ kind: "local" });
    expect(store().left.path).toBe("/home");
    expect(store().left.marked).toEqual({ "keep.txt": true });
  });

  it("holds no secret field", () => {
    fillBoth();
    const json = JSON.stringify(store());
    expect(json).not.toMatch(/secret|password/i);
  });
});

describe("view lifecycle", () => {
  it("state survives unmount and remount of the view", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    function View() {
      const path = useBrowseStore((state) => state.left.path);
      const active = useBrowseStore((state) => state.active);
      return <p>{`${path}|${active}`}</p>;
    }
    const host = document.createElement("div");
    let root = createRoot(host);
    act(() => root.render(<View />));
    expect(host.textContent).toBe("|left");
    act(() => {
      store().setListing("left", { path: "/data", entries: [], nextToken: null });
      store().setActive("right");
    });
    expect(host.textContent).toBe("/data|right");
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<View />));
    expect(host.textContent).toBe("/data|right");
    act(() => root.unmount());
  });
});

describe("per-panel sort", () => {
  const big = (name: string, size: number): PanelEntry => ({ name, isDir: false, size, modified: 1 });
  const rowNames = () => store().left.entries.map((entry) => entry.name);

  it("each panel keeps its own sort and defaults to Name ascending", () => {
    expect(store().left.sort).toEqual({ key: "name", dir: "asc" });
    store().sortBy("left", "size");
    expect(store().left.sort).toEqual({ key: "size", dir: "asc" });
    expect(store().right.sort).toEqual({ key: "name", dir: "asc" });
  });

  it("sortBy re-sorts, a second call on the same key reverses, reverseSort flips the direction", () => {
    store().setListing("left", { path: "/", entries: [big("a", 5), big("b", 1), big("c", 9)], nextToken: null });
    store().sortBy("left", "size");
    expect(rowNames()).toEqual(["b", "a", "c"]);
    store().sortBy("left", "size");
    expect(rowNames()).toEqual(["c", "a", "b"]);
    store().reverseSort("left");
    expect(store().left.sort).toEqual({ key: "size", dir: "asc" });
    expect(rowNames()).toEqual(["b", "a", "c"]);
  });

  it("the sort survives a source switch and a new listing", () => {
    store().setSource("left", { kind: "local" });
    store().sortBy("left", "date");
    store().setSource("left", { kind: "bucket", bucket: "alpha" });
    expect(store().left.sort).toEqual({ key: "date", dir: "asc" });
    store().setListing("left", { path: "", entries: [big("b", 1), big("a", 2)], nextToken: null });
    expect(store().left.sort.key).toBe("date");
  });

  it("the cursor stays on the same item after a re-sort", () => {
    store().setSource("left", { kind: "local" });
    store().setListing("left", { path: "/", entries: [big("a", 5), big("b", 1), big("c", 9)], nextToken: null });
    store().setCursor("left", 1); // b
    store().sortBy("left", "size");
    expect(rowNames()).toEqual(["b", "a", "c"]);
    expect(store().left.cursor).toBe(0);
    store().sortBy("left", "size"); // desc: c a b
    expect(store().left.cursor).toBe(2);
  });

  it("the cursor stays on the same item after a page load that inserts rows above it", () => {
    store().setSource("right", { kind: "bucket", bucket: "alpha" });
    store().setListing("right", { path: "", entries: [big("m", 1), big("z", 1)], nextToken: "t" });
    store().setCursor("right", 1); // z
    store().setListing("right", { path: "", entries: [big("a", 1), big("b", 1)], nextToken: null }, { append: true });
    expect(store().right.entries.map((entry) => entry.name)).toEqual(["a", "b", "m", "z"]);
    expect(store().right.cursor).toBe(3);
  });

  it("the cursor on the .. row stays there", () => {
    store().setSource("left", { kind: "local" });
    store().setListing("left", { path: "/a", entries: [big("a", 5), big("b", 1)], nextToken: null });
    store().sortBy("left", "size");
    expect(store().left.cursor).toBe(0);
  });
});
