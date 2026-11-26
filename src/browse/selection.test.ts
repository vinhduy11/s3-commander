import { beforeEach, describe, expect, it } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "./browse_store";
import { allNames, bandRows, globToRegExp, invertMarks, matchNames, rangeNames, selectionText, toContentY, toggleName } from "./selection";
import { autoScrollStep } from "./drag_drop_logic";

const rows = [".." , "docs", "a.csv", "b.csv", "c.txt"].map((name) => ({ name, isDir: name === "docs" || name === "..", size: 1, modified: 1, isUp: name === ".." || undefined }));

describe("range, toggle, all, invert", () => {
  it("rangeNames is the contiguous block between anchor and target in either direction, never ..", () => {
    expect(rangeNames(rows, "a.csv", "c.txt")).toEqual(["a.csv", "b.csv", "c.txt"]);
    expect(rangeNames(rows, "c.txt", "docs")).toEqual(["docs", "a.csv", "b.csv", "c.txt"]);
    expect(rangeNames(rows, "..", "b.csv")).toEqual(["docs", "a.csv", "b.csv"]);
    expect(rangeNames(rows, "b.csv", "b.csv")).toEqual(["b.csv"]);
  });
  it("rangeNames without a usable anchor is just the target", () => {
    expect(rangeNames(rows, null, "b.csv")).toEqual(["b.csv"]);
    expect(rangeNames(rows, "gone", "b.csv")).toEqual(["b.csv"]);
    expect(rangeNames(rows, "a.csv", "..")).toEqual(["docs", "a.csv"]);
  });
  it("toggleName adds or removes one name without mutating, and ignores ..", () => {
    const before = { "a.csv": true as const };
    expect(toggleName(before, "b.csv")).toEqual({ "a.csv": true, "b.csv": true });
    expect(toggleName(before, "a.csv")).toEqual({});
    expect(before).toEqual({ "a.csv": true });
    expect(toggleName(before, "..")).toEqual(before);
  });
  it("allNames skips .. and invertMarks flips the rest", () => {
    expect(allNames(rows)).toEqual(["docs", "a.csv", "b.csv", "c.txt"]);
    expect(invertMarks(rows, { "a.csv": true, docs: true })).toEqual({ "b.csv": true, "c.txt": true });
  });
  it("selectionText is singular-agnostic", () => {
    expect(selectionText(0)).toBe("Selection cleared");
    expect(selectionText(3)).toBe("3 selected");
  });
});

describe("glob matcher", () => {
  const names = ["a.csv", "B.CSV", "report-01.txt", "report-1.txt", "report-ab.txt", "notes.csv.bak", "c+d (1).txt", "x.y", "docs"];
  it("* matches any run, anchored to the whole name including the extension", () => {
    expect(matchNames(names, "*.csv")).toEqual(["a.csv", "B.CSV"]);
    expect(matchNames(names, "docs")).toEqual(["docs"]);
    expect(matchNames(names, "*")).toEqual(names);
  });
  it("? matches exactly one character", () => {
    expect(matchNames(names, "report-??.txt")).toEqual(["report-01.txt", "report-ab.txt"]);
  });
  it("is case-insensitive", () => {
    expect(matchNames(names, "*.Csv")).toEqual(["a.csv", "B.CSV"]);
  });
  it("regex special characters in the pattern are literal", () => {
    expect(matchNames(names, "c+d (1).txt")).toEqual(["c+d (1).txt"]);
    expect(matchNames(names, "x.y")).toEqual(["x.y"]);
    expect(matchNames(["xzy", "x.y"], "x.y")).toEqual(["x.y"]);
    expect(matchNames(["a", "aa"], "a+")).toEqual([]);
    expect(matchNames(["[a]", "a"], "[a]")).toEqual(["[a]"]);
  });
  it("an empty pattern matches nothing", () => {
    expect(globToRegExp("")).toBeNull();
    expect(globToRegExp("   ")).toBeNull();
    expect(matchNames(names, "")).toEqual([]);
  });
});

describe("rubber band hit-testing", () => {
  it("rows whose 22px band intersects the rectangle, either drag direction, clamped to the list", () => {
    expect(bandRows(30, 100, 22, 8)).toEqual({ first: 1, last: 4 });
    expect(bandRows(100, 30, 22, 8)).toEqual({ first: 1, last: 4 });
    expect(bandRows(-50, 10, 22, 8)).toEqual({ first: 0, last: 0 });
    expect(bandRows(150, 900, 22, 8)).toEqual({ first: 6, last: 7 });
  });
  it("a rectangle entirely below the last row touches nothing", () => {
    expect(bandRows(300, 400, 22, 8)).toBeNull();
    expect(bandRows(0, 10, 22, 0)).toBeNull();
  });
  it("client y converts to content y with the list's top and scroll", () => {
    expect(toContentY(150, 100, 60)).toBe(110);
  });
  it("auto-scroll step is negative at the top edge, positive at the bottom, zero between", () => {
    const rect = { top: 100, bottom: 500 };
    expect(autoScrollStep(101, rect)).toBeLessThan(0);
    expect(autoScrollStep(499, rect)).toBeGreaterThan(0);
    expect(autoScrollStep(300, rect)).toBe(0);
  });
});

describe("store selection actions", () => {
  const entries: PanelEntry[] = ["docs", "a.csv", "b.csv", "c.txt"].map((name) => ({ name, isDir: name === "docs", size: 10, modified: 1 }));
  const left = () => useBrowseStore.getState().left;
  const s = () => useBrowseStore.getState();
  beforeEach(() => {
    useBrowseStore.setState({ ...initialBrowseState(), left: { ...emptyPanel(), source: { kind: "local" }, path: "/h", entries } });
  });

  it("selectOnly sets cursor and anchor and clears marks", () => {
    s().toggleMark("left", "a.csv");
    s().selectOnly("left", 3);
    expect(left()).toMatchObject({ cursor: 3, anchor: "b.csv", marked: {} });
  });
  it("toggleAt toggles the row, moves the cursor, moves the anchor, never marks ..", () => {
    s().toggleAt("left", 2);
    s().toggleAt("left", 4);
    expect(left().marked).toEqual({ "a.csv": true, "c.txt": true });
    expect(left()).toMatchObject({ cursor: 4, anchor: "c.txt" });
    s().toggleAt("left", 0);
    expect(left().marked).toEqual({ "a.csv": true, "c.txt": true });
  });
  it("extendSelection replaces marks with anchor..target; the anchor stays", () => {
    s().selectOnly("left", 2);
    s().extendSelection("left", 4);
    expect(left().marked).toEqual({ "a.csv": true, "b.csv": true, "c.txt": true });
    expect(left().anchor).toBe("a.csv");
    s().extendSelection("left", 1);
    expect(left().marked).toEqual({ docs: true, "a.csv": true });
    expect(left().cursor).toBe(1);
  });
  it("extendSelection without an anchor starts at the cursor row", () => {
    s().setCursor("left", 2);
    s().extendSelection("left", 3);
    expect(left().marked).toEqual({ "a.csv": true, "b.csv": true });
  });
  it("the anchor resets on navigation (setListing), source change, and when its row disappears", () => {
    s().selectOnly("left", 2);
    s().setListing("left", { path: "/h/docs", entries, nextToken: null });
    expect(left().anchor).toBeNull();
    s().selectOnly("left", 2);
    s().setSource("left", { kind: "local" });
    expect(left().anchor).toBeNull();
    s().setListing("left", { path: "/h", entries, nextToken: null });
    useBrowseStore.setState({ left: { ...left(), anchor: "gone.txt" } });
    s().setListing("left", { path: "/h", entries: [], nextToken: null }, { append: true });
    expect(left().anchor).toBeNull();
  });
  it("marks and the anchor survive a sort change and an appended page", () => {
    s().selectOnly("left", 2);
    s().toggleAt("left", 3);
    s().sortBy("left", "size");
    s().setListing("left", { path: "/h", entries: [{ name: "z.txt", isDir: false, size: 1, modified: 1 }], nextToken: null }, { append: true });
    expect(Object.keys(left().marked).sort()).toEqual(["a.csv", "b.csv"]);
    expect(left().anchor).toBe("b.csv");
  });
  it("markAll, invertSelection, clearMarks, applyPattern", () => {
    s().markAll("left");
    expect(Object.keys(left().marked)).toHaveLength(4);
    s().toggleMark("left", "docs");
    s().invertSelection("left");
    expect(left().marked).toEqual({ docs: true });
    expect(s().applyPattern("left", "*.csv", "select")).toBe(2);
    expect(Object.keys(left().marked).sort()).toEqual(["a.csv", "b.csv", "docs"]);
    expect(s().applyPattern("left", "d*", "deselect")).toBe(1);
    expect(Object.keys(left().marked).sort()).toEqual(["a.csv", "b.csv"]);
    s().clearMarks("left");
    expect(left().marked).toEqual({});
  });
  it("bulk actions leave a polite note with the count", () => {
    s().markAll("left");
    expect(left().selectionNote).toBe("4 selected");
    s().clearMarks("left");
    expect(left().selectionNote).toBe("Selection cleared");
  });
});
