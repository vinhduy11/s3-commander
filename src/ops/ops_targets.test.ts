import { beforeEach, describe, expect, it } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry, type PanelState } from "../browse/browse_store";
import { cursorTarget, panelLocation, presignSelection, resolveOperation, selectTargets } from "./ops_targets";

const file = (name: string): PanelEntry => ({ name, isDir: false, size: 1, modified: 1 });
const dir = (name: string): PanelEntry => ({ name, isDir: true, size: 0, modified: null });

function localPanel(entries: PanelEntry[], path = "/home/me", cursor = 0): PanelState {
  return { ...emptyPanel(), source: { kind: "local" }, path, entries, cursor };
}
function bucketPanel(entries: PanelEntry[], path = "", cursor = 0): PanelState {
  return { ...emptyPanel(), source: { kind: "bucket", bucket: "alpha" }, path, entries, cursor };
}

beforeEach(() => useBrowseStore.setState(initialBrowseState()));

describe("panelLocation", () => {
  it("maps a local panel to its directory and a bucket panel to bucket plus prefix", () => {
    expect(panelLocation(localPanel([]))).toEqual({ kind: "local", path: "/home/me" });
    expect(panelLocation(bucketPanel([], "a/b/"))).toEqual({ kind: "bucket", bucket: "alpha", prefix: "a/b/" });
  });

  it("is null while the panel has no source or no loaded local path", () => {
    expect(panelLocation(emptyPanel())).toBeNull();
    expect(panelLocation(localPanel([], ""))).toBeNull();
  });
});

describe("operation targets", () => {
  it("uses the marked entries when there are any, in listing order", () => {
    const panel = { ...localPanel([file("a"), dir("d"), file("z")]), marked: { z: true as const, d: true as const } };
    expect(selectTargets(panel)).toEqual([
      { name: "d", is_dir: true },
      { name: "z", is_dir: false },
    ]);
  });

  it("falls back to the item under the cursor, accounting for the '..' row", () => {
    // not at the root, so row 0 is "..", row 1 is the first entry
    const panel = localPanel([file("a"), file("b")], "/home/me", 2);
    expect(selectTargets(panel)).toEqual([{ name: "b", is_dir: false }]);
    expect(cursorTarget(panel)).toEqual({ name: "b", is_dir: false });
  });

  it("selects nothing on the '..' row or in an empty listing", () => {
    expect(selectTargets(localPanel([file("a")], "/home/me", 0))).toEqual([]);
    expect(cursorTarget(localPanel([], "/", 0))).toBeNull();
  });

  it("ignores marks for rename: the cursor item is the target", () => {
    const panel = { ...localPanel([file("a"), file("b")], "/", 0), marked: { a: true as const } };
    expect(cursorTarget(panel)).toEqual({ name: "a", is_dir: false });
  });
});

describe("resolveOperation", () => {
  it("takes the other panel as the destination with its current source and path", () => {
    useBrowseStore.setState({
      left: localPanel([file("a")], "/", 0),
      right: bucketPanel([], "in/"),
      active: "left",
      profileId: "p1",
    });
    const operation = resolveOperation(useBrowseStore.getState(), "left");
    expect(operation).toEqual({
      side: "left",
      destSide: "right",
      source: { kind: "local", path: "/" },
      dest: { kind: "bucket", bucket: "alpha", prefix: "in/" },
      items: [{ name: "a", is_dir: false }],
    });
  });

  it("reports a readable error when nothing is selected or the other panel has no source", () => {
    useBrowseStore.setState({ left: localPanel([], "/"), right: bucketPanel([]) });
    expect(resolveOperation(useBrowseStore.getState(), "left")).toEqual({ error: "Nothing selected" });
    useBrowseStore.setState({ left: localPanel([file("a")], "/", 0), right: emptyPanel() });
    expect(resolveOperation(useBrowseStore.getState(), "left")).toEqual({ error: "Choose a source for the other panel first" });
  });
});

describe("presignSelection", () => {
  it("is null for a local panel, a panel without a source, and nothing selected", () => {
    expect(presignSelection(localPanel([file("a")], "/home/me", 1))).toBeNull();
    expect(presignSelection(emptyPanel())).toBeNull();
    expect(presignSelection(bucketPanel([], "in/", 0))).toBeNull();
  });

  it("never targets the '..' row", () => {
    expect(presignSelection(bucketPanel([file("a")], "in/", 0))).toBeNull();
  });

  it("uses the cursor item when nothing is marked, with the full key", () => {
    expect(presignSelection(bucketPanel([file("a.txt"), file("b.txt")], "in/", 2))).toEqual({
      bucket: "alpha",
      items: [{ key: "in/b.txt", is_dir: false }],
      hasFolder: false,
    });
    expect(presignSelection(bucketPanel([file("a.txt")], "", 0))?.items).toEqual([{ key: "a.txt", is_dir: false }]);
  });

  it("uses the marked items over the cursor; folders get a trailing slash and set hasFolder", () => {
    const panel = { ...bucketPanel([file("a.txt"), dir("d"), file("z.txt")], "in/", 1), marked: { "a.txt": true as const, d: true as const } };
    expect(presignSelection(panel)).toEqual({
      bucket: "alpha",
      items: [
        { key: "in/a.txt", is_dir: false },
        { key: "in/d/", is_dir: true },
      ],
      hasFolder: true,
    });
  });
});
