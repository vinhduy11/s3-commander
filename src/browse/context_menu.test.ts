import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "./browse_store";
import { useOpsStore } from "../ops/ops_store";

vi.mock("../ops/presign_flow", () => ({ startPresign: vi.fn() }));
vi.mock("../ops/ops_flow", () => ({
  startTransfer: vi.fn(),
  startDelete: vi.fn(),
  startRename: vi.fn(),
  startNewFolder: vi.fn(),
}));
vi.mock("./panel_loader", () => ({ openRowAt: vi.fn() }));
vi.mock("../viewer/viewer_flow", () => ({ startViewer: vi.fn() }));
import * as flow from "../ops/ops_flow";
import { openRowAt } from "./panel_loader";
import { startPresign as flow_presign } from "../ops/presign_flow";
import { buildMenuItems, clampMenuPosition, closeMenu, openEmptyMenu, openMenuAtCursor, openRowMenu, useContextMenu } from "./context_menu";

const file = (name: string): PanelEntry => ({ name, isDir: false, size: 1, modified: 1 });
const dir = (name: string): PanelEntry => ({ name, isDir: true, size: 0, modified: null });
const browse = () => useBrowseStore.getState();
const menu = () => useContextMenu.getState().menu;
// rows of each panel: 0 "..", 1 sub, 2 a.txt, 3 b.txt
const entries = [dir("sub"), file("a.txt"), file("b.txt")];

function setup(left: "local" | "bucket" = "local", right: "local" | "bucket" | null = "bucket") {
  const make = (kind: "local" | "bucket" | null) =>
    kind === "local"
      ? { ...emptyPanel(), source: { kind: "local" as const }, path: "/home/me", entries }
      : kind === "bucket"
        ? { ...emptyPanel(), source: { kind: "bucket" as const, bucket: "alpha" }, path: "in/", entries }
        : emptyPanel();
  useBrowseStore.setState({ ...initialBrowseState(), profileId: "p1", active: "right", left: make(left), right: make(right) });
}
const ids = (items: { id: string }[]) => items.map((item) => item.id);
const byId = (side: "left" | "right", kind: "row" | "empty" = "row") =>
  Object.fromEntries(buildMenuItems(side, kind).map((item) => [item.id, item]));

beforeEach(() => {
  vi.clearAllMocks();
  setup();
  useOpsStore.getState().setDialog(null);
  closeMenu();
});

describe("selection on right-click", () => {
  it("an unmarked row becomes the only selection: cursor moves, marks clear, panel becomes active", () => {
    browse().toggleMark("left", "b.txt");
    openRowMenu("left", 2, 10, 20);
    expect(browse().left.cursor).toBe(2);
    expect(browse().left.marked).toEqual({});
    expect(browse().active).toBe("left");
    expect(menu()).toMatchObject({ side: "left", kind: "row", x: 10, y: 20 });
  });

  it("a marked row keeps all marks and only moves the cursor", () => {
    browse().toggleMark("left", "a.txt");
    browse().toggleMark("left", "b.txt");
    openRowMenu("left", 3, 0, 0);
    expect(browse().left.marked).toEqual({ "a.txt": true, "b.txt": true });
    expect(browse().left.cursor).toBe(3);
  });

  it("empty space keeps cursor and marks, activates the panel, and offers only New folder", () => {
    browse().toggleMark("left", "a.txt");
    openEmptyMenu("left", 5, 6);
    expect(browse().left.marked).toEqual({ "a.txt": true });
    expect(browse().active).toBe("left");
    expect(ids(buildMenuItems("left", "empty"))).toEqual(["sort-name", "sort-ext", "sort-size", "sort-date", "sort-reverse", "new-folder"]);
  });

  it("is ignored while a dialog is open", () => {
    useOpsStore.getState().setDialog({ kind: "busy", label: "x" });
    openRowMenu("left", 2, 1, 1);
    openEmptyMenu("left", 1, 1);
    openMenuAtCursor("left", 1, 1);
    expect(menu()).toBeNull();
    expect(browse().active).toBe("right");
  });

  it("a row index past the end opens nothing", () => {
    openRowMenu("left", 99, 1, 1);
    expect(menu()).toBeNull();
  });

  it("Shift+F10 style open uses the cursor row", () => {
    browse().setCursor("left", 2);
    openMenuAtCursor("left", 7, 8);
    expect(menu()).toMatchObject({ side: "left", kind: "row", x: 7, y: 8 });
    expect(browse().active).toBe("left");
    expect(browse().left.cursor).toBe(2);
  });
});

describe("item set and state", () => {
  it("file row: no Open, all actions enabled, shortcut hints, New folder last", () => {
    openRowMenu("left", 2, 0, 0);
    const items = buildMenuItems("left", "row");
    expect(ids(items)).toEqual(["view", "edit", "copy", "move", "rename", "delete", "new-folder"]);
    expect(items.map((item) => item.shortcut)).toEqual(["F3", "F4", "F5", "F6", "F2", "F8", "F7"]);
    expect(items.every((item) => item.enabled)).toBe(true);
  });

  it("directory row: Open first with Enter", () => {
    openRowMenu("left", 1, 0, 0);
    const items = buildMenuItems("left", "row");
    expect(ids(items)[0]).toBe("open");
    expect(items[0]).toMatchObject({ shortcut: "Enter", enabled: true });
  });

  it("'..' row: Open enabled, Copy/Move/Rename/Delete disabled, New folder enabled", () => {
    openRowMenu("left", 0, 0, 0);
    const item = byId("left");
    expect(item.open.enabled).toBe(true);
    for (const id of ["copy", "move", "rename", "delete"]) expect(item[id].enabled).toBe(false);
    expect(item["new-folder"].enabled).toBe(true);
  });

  it("several marked: Rename disabled, Open hidden, Copy/Move/Delete enabled", () => {
    browse().toggleMark("left", "a.txt");
    browse().toggleMark("left", "b.txt");
    openRowMenu("left", 2, 0, 0);
    const item = byId("left");
    expect(item.open).toBeUndefined();
    expect(item.rename.enabled).toBe(false);
    for (const id of ["copy", "move", "delete"]) expect(item[id].enabled).toBe(true);
  });

  it("one marked row: Rename stays enabled", () => {
    browse().toggleMark("left", "a.txt");
    openRowMenu("left", 2, 0, 0);
    expect(byId("left").rename.enabled).toBe(true);
  });

  it("direction label: local to server = Upload, server to local = Download, same kind = Copy", () => {
    openRowMenu("left", 2, 0, 0);
    expect(byId("left").copy.label).toBe("Upload to other panel");
    openRowMenu("right", 2, 0, 0);
    expect(byId("right").copy.label).toBe("Download to other panel");
    setup("local", "local");
    openRowMenu("left", 2, 0, 0);
    expect(byId("left").copy.label).toBe("Copy to other panel");
    setup("bucket", "bucket");
    openRowMenu("left", 2, 0, 0);
    expect(byId("left").copy.label).toBe("Copy to other panel");
    expect(byId("left").move.label).toBe("Move to other panel");
  });

  it("transfers are disabled while the other panel has no source; the rest still work", () => {
    setup("local", null);
    openRowMenu("left", 2, 0, 0);
    const item = byId("left");
    expect(item.copy.enabled).toBe(false);
    expect(item.move.enabled).toBe(false);
    expect(item.copy.label).toBe("Copy to other panel");
    expect(item.delete.enabled).toBe(true);
  });

  it("New folder is disabled on a panel without a source", () => {
    setup("local", null);
    expect(byId("right", "empty")["new-folder"].enabled).toBe(false);
  });
});

describe("handlers call the same flows as the F-keys", () => {
  it("run each item with the right-clicked side", () => {
    openRowMenu("left", 1, 0, 0);
    const item = byId("left");
    item.copy.run();
    item.move.run();
    item.rename.run();
    item.delete.run();
    item["new-folder"].run();
    item.open.run();
    expect(flow.startTransfer).toHaveBeenNthCalledWith(1, "copy", "left");
    expect(flow.startTransfer).toHaveBeenNthCalledWith(2, "move", "left");
    expect(flow.startRename).toHaveBeenCalledWith("left");
    expect(flow.startDelete).toHaveBeenCalledWith("left");
    expect(flow.startNewFolder).toHaveBeenCalledWith("left");
    expect(openRowAt).toHaveBeenCalledWith("left", 1);
  });
});

describe("clampMenuPosition", () => {
  const size = { width: 200, height: 150 };
  const win = { width: 800, height: 600 };
  it("keeps a position that fits", () => expect(clampMenuPosition(100, 100, size, win)).toEqual({ x: 100, y: 100 }));
  it("flips back inside at the right and bottom edges", () => {
    expect(clampMenuPosition(790, 590, size, win)).toEqual({ x: 800 - 200 - 4, y: 600 - 150 - 4 });
  });
  it("never goes negative when the menu is larger than the window", () => {
    expect(clampMenuPosition(5, 5, { width: 900, height: 700 }, win)).toEqual({ x: 4, y: 4 });
  });
});

describe("sort entries in the empty-area menu", () => {
  it("marks the current sort and calls the same store actions as the header", () => {
    const sortBy = vi.spyOn(browse(), "sortBy");
    const reverse = vi.spyOn(browse(), "reverseSort");
    const items = byId("left", "empty");
    expect(items["sort-name"].checked).toBe(true);
    expect(items["sort-size"].checked).toBe(false);
    expect(items["sort-reverse"].checked).toBeUndefined();
    items["sort-size"].run();
    expect(browse().left.sort).toEqual({ key: "size", dir: "asc" });
    expect(byId("left", "empty")["sort-size"].checked).toBe(true);
    items["sort-reverse"].run();
    expect(browse().left.sort).toEqual({ key: "size", dir: "desc" });
    expect(sortBy).toHaveBeenCalledWith("left", "size");
    expect(reverse).toHaveBeenCalledWith("left");
    expect(browse().right.sort.key).toBe("name");
  });

  it("row menus do not carry sort entries", () => {
    expect(ids(buildMenuItems("left", "row")).some((id) => id.startsWith("sort-"))).toBe(false);
  });
});

describe("Copy presigned URL entry", () => {
  const presign = (side: "left" | "right", kind: "row" | "empty" = "row") => byId(side, kind).presign;

  it("is shown for server items only: not on a local panel, not in the empty-space menu", () => {
    openRowMenu("left", 2, 0, 0);
    expect(presign("left")).toBeUndefined();
    expect(presign("left", "empty")).toBeUndefined();
    setup("bucket", "bucket");
    expect(presign("left", "empty")).toBeUndefined();
  });

  it("on a server row it is labelled, enabled, and starts the presign flow of that panel", () => {
    openRowMenu("right", 2, 0, 0);
    expect(presign("right")).toMatchObject({ label: "Copy presigned URL", shortcut: "F9", enabled: true });
    presign("right").run();
    expect(flow_presign).toHaveBeenCalledWith("right");
  });

  it("is disabled on the '..' row and enabled for marked items", () => {
    openRowMenu("right", 0, 0, 0);
    expect(presign("right").enabled).toBe(false);
    browse().toggleMark("right", "a.txt");
    browse().toggleMark("right", "b.txt");
    openRowMenu("right", 2, 0, 0);
    expect(presign("right").enabled).toBe(true);
  });
});
