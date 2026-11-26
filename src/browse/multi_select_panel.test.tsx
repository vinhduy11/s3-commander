// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "./browse_store";
import { useOpsStore } from "../ops/ops_store";
import { useViewerStore } from "../viewer/viewer_store";

vi.mock("./panel_loader", () => ({ openRowAt: vi.fn(), openPath: vi.fn(), openSource: vi.fn(), enterDir: vi.fn(), goUp: vi.fn(), loadMore: vi.fn(), loadAll: vi.fn() }));
vi.mock("../ops/ops_flow", () => ({ startTransferOf: vi.fn(async () => {}), startTransfer: vi.fn(), startDelete: vi.fn(), startRename: vi.fn(), startNewFolder: vi.fn(), cancelDialog: () => useOpsStore.getState().setDialog(null), confirmDelete: vi.fn(), confirmPlan: vi.fn(), resolveAllConflicts: vi.fn(), resolveConflict: vi.fn(), submitName: vi.fn() }));
vi.mock("../viewer/viewer_flow", () => ({ startViewer: vi.fn() }));
import { startTransferOf } from "../ops/ops_flow";
import { OpsDialogs } from "../ops/ops_dialogs";
import { FilePanel } from "./file_panel";
import { ContextMenu } from "./context_menu_view";
import { closeMenu, openEmptyMenu, useContextMenu } from "./context_menu";
import { useDragStore } from "./drag_drop";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });

const entry = (name: string, isDir = false, size = 100): PanelEntry => ({ name, isDir, size, modified: 1 });
// Rows: 0 "..", 1 docs, 2 a.csv, 3 b.csv, 4 report-01.txt, 5 report-02.txt, 6 Notes.TXT
const entries = [entry("docs", true, 0), entry("a.csv"), entry("b.csv"), entry("report-01.txt"), entry("report-02.txt"), entry("Notes.TXT")];
let root: Root;
let host: HTMLElement;
const marks = () => Object.keys(useBrowseStore.getState().left.marked).sort();
const left = () => useBrowseStore.getState().left;
const row = (name: string) => document.querySelector<HTMLElement>(`#panel-left [data-row-name="${name}"]`)!;
const list = () => document.querySelector<HTMLElement>("#panel-left .list")!;
const panel = () => document.getElementById("panel-left")!;
const click = (name: string, init: MouseEventInit = {}) => act(() => void row(name).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init })));
const key = (init: KeyboardEventInit, target: Element = panel()) => act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));
const ptr = (target: Element | Window, type: string, init: MouseEventInit = {}) => act(() => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })));

beforeEach(() => {
  vi.clearAllMocks();
  useOpsStore.setState({ dialog: null });
  useViewerStore.setState({ session: null } as never);
  useDragStore.getState().reset();
  closeMenu();
  useBrowseStore.setState({
    ...initialBrowseState(),
    profileId: "p1",
    left: { ...emptyPanel(), source: { kind: "local" }, path: "/home/me", entries },
    right: { ...emptyPanel(), source: { kind: "local" }, path: "/x", entries: [] },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<><FilePanel side="left" /><FilePanel side="right" /><ContextMenu /><OpsDialogs /></>));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("click variants", () => {
  it("a plain click selects only that row and clears the marks", () => {
    useBrowseStore.getState().toggleMark("left", "a.csv");
    click("b.csv");
    expect(marks()).toEqual([]);
    expect(left()).toMatchObject({ cursor: 3, anchor: "b.csv" });
  });
  it("Cmd+click and Ctrl+click toggle the row and move the cursor", () => {
    click("a.csv");
    click("b.csv", { metaKey: true });
    click("report-01.txt", { ctrlKey: true });
    expect(marks()).toEqual(["a.csv", "b.csv", "report-01.txt"]); // the plain-clicked row joins the marks
    expect(left().cursor).toBe(4);
    click("b.csv", { metaKey: true });
    expect(marks()).toEqual(["a.csv", "report-01.txt"]);
  });
  it("Shift+click marks the range from the anchor, replacing earlier marks", () => {
    click("a.csv");
    click("docs", { metaKey: true });
    click("b.csv", { metaKey: true });
    click("report-02.txt", { shiftKey: true });
    expect(marks()).toEqual(["b.csv", "report-01.txt", "report-02.txt"]);
    click("a.csv", { shiftKey: true });
    expect(marks()).toEqual(["a.csv", "b.csv"]);
  });
  it(".. is never marked by any click", () => {
    click("b.csv");
    click("..", { shiftKey: true });
    expect(marks()).not.toContain("..");
    click("..", { metaKey: true });
    expect(marks()).not.toContain("..");
  });
  it("a double-click still opens", async () => {
    const { openRowAt } = await import("./panel_loader");
    act(() => void row("docs").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(openRowAt).toHaveBeenCalledWith("left", 1);
  });
});

describe("pointer-down on a marked row", () => {
  beforeEach(() => {
    useBrowseStore.setState({ left: { ...left(), marked: { "a.csv": true, "b.csv": true } } });
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = vi.fn(() => document.querySelector("#panel-right .list"));
  });
  it("followed by a drag keeps the marked set as the drag set and the click is swallowed", () => {
    ptr(row("a.csv"), "pointerdown", { clientX: 10, clientY: 50 });
    ptr(window, "pointermove", { clientX: 30, clientY: 90 });
    expect(useDragStore.getState().active).toBe(true);
    expect(useDragStore.getState().label).toBe("2 items");
    expect(marks()).toEqual(["a.csv", "b.csv"]);
    ptr(window, "pointerup", { clientX: 30, clientY: 90 });
    click("a.csv");
    expect(marks()).toEqual(["a.csv", "b.csv"]);
    expect(startTransferOf).toHaveBeenCalled();
  });
  it("a click without a drag clears the marks only on the click", () => {
    ptr(row("a.csv"), "pointerdown", { clientX: 10, clientY: 50 });
    expect(marks()).toEqual(["a.csv", "b.csv"]);
    ptr(window, "pointerup", { clientX: 10, clientY: 50 });
    click("a.csv");
    expect(marks()).toEqual([]);
    expect(left().cursor).toBe(2);
  });
});

describe("keyboard", () => {
  it("Shift+Arrow extends the range from the anchor as the cursor moves, and back", () => {
    click("a.csv");
    key({ key: "ArrowDown", shiftKey: true });
    key({ key: "ArrowDown", shiftKey: true });
    expect(marks()).toEqual(["a.csv", "b.csv", "report-01.txt"]);
    expect(left().cursor).toBe(4);
    key({ key: "ArrowUp", shiftKey: true });
    expect(marks()).toEqual(["a.csv", "b.csv"]);
  });
  it("Shift+Home / End / PageDown / PageUp extend too", () => {
    click("b.csv");
    key({ key: "End", shiftKey: true });
    expect(marks()).toEqual(["Notes.TXT", "b.csv", "report-01.txt", "report-02.txt"]);
    key({ key: "Home", shiftKey: true });
    expect(marks()).toEqual(["a.csv", "b.csv", "docs"]);
    key({ key: "PageDown", shiftKey: true });
    expect(marks()).toContain("Notes.TXT");
    key({ key: "PageUp", shiftKey: true });
    expect(marks()).toContain("docs");
  });
  it("Cmd+A and Ctrl+A mark every row except .. and prevent the native select-all", () => {
    const event = new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true });
    act(() => void panel().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(marks()).toEqual(["Notes.TXT", "a.csv", "b.csv", "docs", "report-01.txt", "report-02.txt"]);
    click("a.csv");
    key({ key: "a", ctrlKey: true });
    expect(marks()).toHaveLength(6);
    expect(marks()).not.toContain("..");
  });
  it("* inverts the marks", () => {
    useBrowseStore.getState().toggleMark("left", "docs");
    key({ key: "*" });
    expect(marks()).toEqual(["Notes.TXT", "a.csv", "b.csv", "report-01.txt", "report-02.txt"]);
  });
  it("Space still toggles and advances; Insert-style toggle is unchanged", () => {
    click("a.csv");
    key({ key: " " });
    expect(marks()).toEqual(["a.csv"]);
    expect(left().cursor).toBe(3);
  });
  it("Escape clears the marks", () => {
    useBrowseStore.getState().markAll("left");
    key({ key: "Escape" });
    expect(marks()).toEqual([]);
  });
  it("Escape does nothing while a dialog, a menu or the viewer is open", () => {
    useBrowseStore.getState().markAll("left");
    useOpsStore.setState({ dialog: { kind: "busy", label: "x" } });
    key({ key: "Escape" });
    expect(marks()).toHaveLength(6);
    useOpsStore.setState({ dialog: null });
    useContextMenu.setState({ menu: { side: "left", kind: "empty", x: 0, y: 0 } });
    key({ key: "Escape" });
    expect(marks()).toHaveLength(6);
    useContextMenu.setState({ menu: null });
    useViewerStore.setState({ session: { name: "x" } } as never);
    key({ key: "Escape" });
    expect(marks()).toHaveLength(6);
  });
  it("Escape with nothing marked is not swallowed", () => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void panel().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("select by pattern modal", () => {
  const input = () => document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  const type = (text: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const preview = () => document.querySelector('[role="dialog"] [data-testid="pattern-count"]')?.textContent;

  it("+ opens Select by pattern, previews the match count, and Enter marks the matches (folders included, case-insensitive)", () => {
    key({ key: "+" });
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Select by pattern");
    type("*.txt");
    expect(preview()).toBe("3 of 6 match");
    expect(marks()).toEqual([]);
    key({ key: "Enter" }, input());
    expect(marks()).toEqual(["Notes.TXT", "report-01.txt", "report-02.txt"]);
    expect(useOpsStore.getState().dialog).toBeNull();
  });
  it("matches folders too and an empty pattern matches none and does nothing", () => {
    key({ key: "+" });
    expect(preview()).toBe("0 of 6 match");
    key({ key: "Enter" }, input());
    expect(marks()).toEqual([]);
    type("d*");
    expect(preview()).toBe("1 of 6 match");
  });
  it("- opens Deselect by pattern and removes matches from the marks", () => {
    useBrowseStore.getState().markAll("left");
    key({ key: "-" });
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Deselect by pattern");
    type("*.csv");
    key({ key: "Enter" }, input());
    expect(marks()).toEqual(["Notes.TXT", "docs", "report-01.txt", "report-02.txt"]);
  });
  it("Escape cancels without changing the marks", () => {
    key({ key: "+" });
    type("*");
    key({ key: "Escape" }, input());
    expect(marks()).toEqual([]);
    expect(useOpsStore.getState().dialog).toBeNull();
  });
});

describe("context menu entries (empty area)", () => {
  const items = () => Array.from(document.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
  const item = (id: string) => items().find((node) => node.dataset.id === id)!;
  it("lists the four selection entries with shortcut hints, and they act on the panel", () => {
    act(() => openEmptyMenu("left", 5, 5));
    expect(items().slice(0, 4).map((node) => node.dataset.id)).toEqual(["select-all", "invert-selection", "select-pattern", "clear-selection"]);
    expect(item("select-all").textContent).toMatch(/Select all.*(Ctrl\+A|⌘A)/);
    expect(item("invert-selection").textContent).toContain("*");
    expect(item("select-pattern").textContent).toContain("Select by pattern...");
    expect(item("clear-selection").getAttribute("aria-disabled")).toBe("true");
    act(() => item("select-all").click());
    expect(marks()).toHaveLength(6);
    act(() => openEmptyMenu("left", 5, 5));
    act(() => item("invert-selection").click());
    expect(marks()).toEqual([]);
    act(() => openEmptyMenu("left", 5, 5));
    act(() => item("select-pattern").click());
    expect(useOpsStore.getState().dialog).toMatchObject({ kind: "select-pattern", side: "left", mode: "select" });
  });
  it("Clear selection is enabled when something is marked and clears it", () => {
    useBrowseStore.getState().toggleMark("left", "a.csv");
    act(() => openEmptyMenu("left", 5, 5));
    act(() => item("clear-selection").click());
    expect(marks()).toEqual([]);
  });
  it("right-click on an unmarked row selects only it; on a marked row keeps the marks", () => {
    useBrowseStore.getState().setMarks("left", { "a.csv": true, "b.csv": true });
    act(() => void row("b.csv").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    expect(marks()).toEqual(["a.csv", "b.csv"]);
    closeMenu();
    act(() => void row("docs").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    expect(marks()).toEqual([]);
  });
});

describe("aria, footer and live region", () => {
  it("the list is a multiselectable listbox and marked rows are aria-selected", () => {
    expect(list().getAttribute("role")).toBe("listbox");
    expect(list().getAttribute("aria-multiselectable")).toBe("true");
    click("a.csv", { metaKey: true });
    expect(row("a.csv").getAttribute("aria-selected")).toBe("true");
    expect(row("b.csv").getAttribute("aria-selected")).toBe("false");
    expect(row("a.csv").getAttribute("role")).toBe("option");
  });
  it("the footer shows N selected with the total size of marked files, folders add no size", () => {
    expect(document.querySelector("#panel-left .pfoot")?.textContent).toBe("6 item(s)");
    click("docs", { metaKey: true });
    click("a.csv", { metaKey: true });
    click("b.csv", { metaKey: true });
    expect(document.querySelector("#panel-left .pfoot")?.textContent).toBe("3 selected, 200 B");
  });
  it("a polite live region announces the count after select all, a range and a pattern", () => {
    const live = () => document.querySelector("#panel-left [aria-live='polite']")?.textContent;
    key({ key: "a", metaKey: true });
    expect(live()).toBe("6 selected");
    click("a.csv");
    click("report-01.txt", { shiftKey: true });
    expect(live()).toBe("3 selected");
    key({ key: "Escape" });
    expect(live()).toBe("Selection cleared");
  });
  it("marks survive a sort change and a header click", () => {
    click("a.csv", { metaKey: true });
    act(() => void useBrowseStore.getState().sortBy("left", "size"));
    expect(marks()).toEqual(["a.csv"]);
  });
});

describe("rubber band", () => {
  const down = (x: number, y: number, init: MouseEventInit = {}) => ptr(list(), "pointerdown", { clientX: x, clientY: y, ...init });
  const move = (y: number, init: MouseEventInit = {}) => ptr(list(), "pointermove", { clientX: 50, clientY: y, ...init });
  // 7 rows x 22px = 154px of rows; below that is empty space. jsdom has no layout, so pin the scroll offset the cursor-follow effect would move.
  beforeEach(() => void Object.defineProperty(list(), "scrollTop", { get: () => 0, set: () => {}, configurable: true }));
  it("shows a band element while dragging and removes it on release, keeping the marks", () => {
    down(50, 300);
    move(60);
    expect(document.querySelector("#panel-left .band")).not.toBeNull();
    ptr(list(), "pointerup", { clientX: 50, clientY: 60 });
    expect(document.querySelector("#panel-left .band")).toBeNull();
    expect(marks()).toEqual(["Notes.TXT", "a.csv", "b.csv", "report-01.txt", "report-02.txt"]);
  });
  it("hits rows 2..6 for a band from y=300 up to y=50 and a plain band replaces earlier marks", () => {
    useBrowseStore.getState().toggleMark("left", "docs");
    down(50, 300);
    move(50);
    expect(marks()).toEqual(["Notes.TXT", "a.csv", "b.csv", "report-01.txt", "report-02.txt"]);
    ptr(list(), "pointerup", { clientX: 50, clientY: 50 });
  });
  it("Shift adds to the existing marks", () => {
    useBrowseStore.getState().toggleMark("left", "docs");
    down(50, 300, { shiftKey: true });
    move(50, { shiftKey: true });
    expect(marks()).toEqual(["Notes.TXT", "a.csv", "b.csv", "docs", "report-01.txt", "report-02.txt"]);
    ptr(list(), "pointerup", { clientX: 50, clientY: 50 });
  });
  it("Escape cancels and restores the marks from before the press", () => {
    useBrowseStore.getState().toggleMark("left", "docs");
    down(50, 300, { metaKey: true });
    move(50, { metaKey: true });
    expect(marks()).toHaveLength(6);
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(marks()).toEqual(["docs"]);
    expect(document.querySelector("#panel-left .band")).toBeNull();
  });
  it("a click on empty space without moving clears the marks; a press on a row never starts a band", () => {
    useBrowseStore.getState().toggleMark("left", "docs");
    down(50, 300);
    ptr(list(), "pointerup", { clientX: 50, clientY: 300 });
    expect(marks()).toEqual([]);
    useBrowseStore.getState().toggleMark("left", "docs");
    ptr(row("a.csv"), "pointerdown", { clientX: 50, clientY: 60 });
    ptr(window, "pointerup", { clientX: 50, clientY: 60 });
    expect(document.querySelector("#panel-left .band")).toBeNull();
  });
});
