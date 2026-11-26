import { describe, expect, it } from "vitest";
import type { PanelEntry } from "./browse_store";
import { DEFAULT_SORT, nextSort, sortEntries, type SortState } from "./sort";

const file = (name: string, size = 1, modified: number | null = 1): PanelEntry => ({ name, isDir: false, size, modified });
const dir = (name: string): PanelEntry => ({ name, isDir: true, size: 0, modified: null });
const names = (entries: PanelEntry[]) => entries.map((entry) => entry.name);
const sorted = (entries: PanelEntry[], key: SortState["key"], dirn: SortState["dir"] = "asc") =>
  names(sortEntries(entries, { key, dir: dirn }));

describe("sortEntries", () => {
  it("defaults to Name ascending", () => {
    expect(DEFAULT_SORT).toEqual({ key: "name", dir: "asc" });
  });

  it("Name: case-insensitive, natural number order, both directions", () => {
    const list = [file("file10"), file("File2"), file("file1"), file("b"), file("A")];
    expect(sorted(list, "name")).toEqual(["A", "b", "file1", "File2", "file10"]);
    expect(sorted(list, "name", "desc")).toEqual(["file10", "File2", "file1", "b", "A"]);
  });

  it("Ext: case-insensitive natural, empty ext first, ties by name ascending", () => {
    const list = [file("z.TXT"), file("a.md"), file("noext"), file("b.txt"), file("c.mp10"), file("d.mp2")];
    expect(sorted(list, "ext")).toEqual(["noext", "a.md", "d.mp2", "c.mp10", "b.txt", "z.TXT"]);
    expect(sorted(list, "ext", "desc")).toEqual(["b.txt", "z.TXT", "c.mp10", "d.mp2", "a.md", "noext"]);
  });

  it("Size: numeric, ties by name ascending even when descending", () => {
    const list = [file("c", 5), file("a", 5), file("b", 100), file("d", 0)];
    expect(sorted(list, "size")).toEqual(["d", "a", "c", "b"]);
    expect(sorted(list, "size", "desc")).toEqual(["b", "a", "c", "d"]);
  });

  it("Date: numeric, missing dates first when ascending, ties by name", () => {
    const list = [file("c", 1, 30), file("a", 1, 30), file("b", 1, 10), file("n", 1, null)];
    expect(sorted(list, "date")).toEqual(["n", "b", "a", "c"]);
    expect(sorted(list, "date", "desc")).toEqual(["a", "c", "b", "n"]);
  });

  it("folders stay above files and sort by name only", () => {
    const list = [file("a", 1, 99), dir("Zed"), dir("alpha"), dir("beta10"), dir("beta2"), file("b", 9, 1)];
    expect(sorted(list, "size", "desc")).toEqual(["alpha", "beta2", "beta10", "Zed", "b", "a"]);
    expect(sorted(list, "date", "desc")).toEqual(["alpha", "beta2", "beta10", "Zed", "a", "b"]);
    expect(sorted(list, "ext", "desc")).toEqual(["alpha", "beta2", "beta10", "Zed", "a", "b"]);
  });

  it("folders follow the direction for Name only", () => {
    const list = [dir("a"), dir("c"), dir("b"), file("x")];
    expect(sorted(list, "name", "desc")).toEqual(["c", "b", "a", "x"]);
    expect(sorted(list, "size", "desc")).toEqual(["a", "b", "c", "x"]);
  });

  it("does not mutate its input", () => {
    const list = [file("b"), file("a")];
    sortEntries(list, DEFAULT_SORT);
    expect(names(list)).toEqual(["b", "a"]);
  });
});

describe("nextSort", () => {
  it("a new key starts ascending, the same key reverses, then cycles", () => {
    let sort = nextSort(DEFAULT_SORT, "size");
    expect(sort).toEqual({ key: "size", dir: "asc" });
    sort = nextSort(sort, "size");
    expect(sort).toEqual({ key: "size", dir: "desc" });
    expect(nextSort(sort, "size")).toEqual({ key: "size", dir: "asc" });
    expect(nextSort(DEFAULT_SORT, "name")).toEqual({ key: "name", dir: "desc" });
  });
});
