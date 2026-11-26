// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore } from "./browse_store";
import * as opsApi from "../ops/ops_api";
import * as flow from "../ops/ops_flow";
import { useOpsStore } from "../ops/ops_store";
import { useDragStore } from "./drag_drop";
import { groupByParent, handleOsDrop, locateOsDrop, physicalToCss, resolveOsDropTarget } from "./os_drop";

vi.mock("../ops/ops_api");
vi.mock("../ops/ops_flow", () => ({ startTransferOf: vi.fn(async () => {}) }));

const state = (overrides = {}) => ({
  ...initialBrowseState(),
  left: { ...emptyPanel(), source: { kind: "local" as const }, path: "/home/u", entries: [] },
  right: { ...emptyPanel(), source: { kind: "bucket" as const, bucket: "alpha" }, path: "in/", entries: [] },
  profileId: "p1",
  ...overrides,
}) as unknown as ReturnType<typeof useBrowseStore.getState>;
const body = (side: "left" | "right") => ({ side, name: null, isDir: false, isUp: false });

describe("physical position to panel", () => {
  it("divides by devicePixelRatio", () => {
    expect(physicalToCss({ x: 200, y: 100 }, 2)).toEqual({ x: 100, y: 50 });
    expect(physicalToCss({ x: 150, y: 90 }, 1.5)).toEqual({ x: 100, y: 60 });
    expect(physicalToCss({ x: 10, y: 10 }, 0)).toEqual({ x: 10, y: 10 });
  });
  it("hit-tests at the CSS position", () => {
    document.body.innerHTML = `<div data-panel="right"><div data-row-name="docs" data-row-dir="true" id="r"></div></div>`;
    const spy = vi.fn(() => document.getElementById("r"));
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = spy;
    expect(locateOsDrop({ x: 600, y: 300 }, 2)).toEqual({ side: "right", name: "docs", isDir: true, isUp: false });
    expect(spy).toHaveBeenCalledWith(300, 150);
  });
});

describe("resolveOsDropTarget", () => {
  it("uploads to the server panel body or a folder row", () => {
    expect(resolveOsDropTarget(state(), body("right"))).toEqual({ ok: true, destSide: "right", dest: { kind: "bucket", bucket: "alpha", prefix: "in/" } });
    expect(resolveOsDropTarget(state(), { side: "right", name: "docs", isDir: true, isUp: false })).toEqual({
      ok: true, destSide: "right", dest: { kind: "bucket", bucket: "alpha", prefix: "in/docs/" },
    });
  });
  it("ignores a Local panel, an empty panel, .. and the outside with a message where useful", () => {
    expect(resolveOsDropTarget(state(), body("left"))).toMatchObject({ ok: false, message: expect.stringMatching(/server/i) });
    expect(resolveOsDropTarget(state({ right: emptyPanel() }), body("right"))).toMatchObject({ ok: false, message: expect.stringMatching(/source/i) });
    expect(resolveOsDropTarget(state(), { side: "right", name: "..", isDir: true, isUp: true })).toMatchObject({ ok: false });
    expect(resolveOsDropTarget(state(), null)).toEqual({ ok: false, message: "" });
  });
});

describe("groupByParent", () => {
  it("builds items relative to the one shared parent", () => {
    expect(groupByParent([{ parent: "/x", name: "a.txt", is_dir: false }, { parent: "/x", name: "d", is_dir: true }])).toEqual({
      parent: "/x", items: [{ name: "a.txt", is_dir: false }, { name: "d", is_dir: true }],
    });
  });
  it("refuses items from different folders", () => {
    expect(groupByParent([{ parent: "/x", name: "a", is_dir: false }, { parent: "/y", name: "b", is_dir: false }])).toMatchObject({ error: expect.any(String) });
  });
});

describe("handleOsDrop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBrowseStore.setState(state());
    useOpsStore.setState({ dialog: null });
    useDragStore.setState({ toast: "" });
    document.body.innerHTML = `<div data-panel="right"><div data-row-name="docs" data-row-dir="true" id="r"></div></div><div data-panel="left" id="l"></div>`;
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = vi.fn(() => document.getElementById("r"));
    vi.mocked(opsApi.localStatPaths).mockResolvedValue([{ parent: "/Users/x", name: "photo.jpg", is_dir: false }, { parent: "/Users/x", name: "album", is_dir: true }]);
  });
  it("starts a copy upload into the folder under the pointer through the shared flow", async () => {
    await handleOsDrop(["/Users/x/photo.jpg", "/Users/x/album"], { x: 400, y: 200 }, 2);
    expect(flow.startTransferOf).toHaveBeenCalledWith(
      {
        side: "right",
        destSide: "right",
        source: { kind: "local", path: "/Users/x" },
        dest: { kind: "bucket", bucket: "alpha", prefix: "in/docs/" },
        items: [{ name: "photo.jpg", is_dir: false }, { name: "album", is_dir: true }],
      },
      "copy",
    );
  });
  it("ignores a drop on a Local panel with a message and runs nothing", async () => {
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = vi.fn(() => document.getElementById("l"));
    await handleOsDrop(["/Users/x/photo.jpg"], { x: 10, y: 10 }, 1);
    expect(flow.startTransferOf).not.toHaveBeenCalled();
    expect(opsApi.localStatPaths).not.toHaveBeenCalled();
    expect(useDragStore.getState().toast).toMatch(/server/i);
  });
  it("ignores everything while a dialog is open", async () => {
    useOpsStore.setState({ dialog: { kind: "busy", label: "x" } });
    await handleOsDrop(["/Users/x/photo.jpg"], { x: 10, y: 10 }, 1);
    expect(flow.startTransferOf).not.toHaveBeenCalled();
  });
  it("reports an unreadable path instead of failing silently", async () => {
    vi.mocked(opsApi.localStatPaths).mockRejectedValue("not found: /Users/x/gone");
    await handleOsDrop(["/Users/x/gone"], { x: 10, y: 10 }, 1);
    expect(flow.startTransferOf).not.toHaveBeenCalled();
    expect(useDragStore.getState().toast).toMatch(/not found/);
  });
});
