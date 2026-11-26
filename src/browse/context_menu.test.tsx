// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore } from "./browse_store";
import { useOpsStore } from "../ops/ops_store";

vi.mock("../ops/ops_flow", () => ({ startTransfer: vi.fn(), startDelete: vi.fn(), startRename: vi.fn(), startNewFolder: vi.fn() }));
vi.mock("./panel_loader", () => ({ openRowAt: vi.fn(), openPath: vi.fn(), openSource: vi.fn(), enterDir: vi.fn(), goUp: vi.fn(), loadMore: vi.fn() }));
vi.mock("../viewer/viewer_flow", () => ({ startViewer: vi.fn() }));
import * as flow from "../ops/ops_flow";
import { startViewer } from "../viewer/viewer_flow";
import { closeMenu, openRowMenu, useContextMenu } from "./context_menu";
import { ContextMenu } from "./context_menu_view";
import { FilePanel } from "./file_panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
let root: Root;
let host: HTMLElement;
const entries = [
  { name: "a.txt", isDir: false, size: 1, modified: 1 },
  { name: "b.txt", isDir: false, size: 1, modified: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
  useBrowseStore.setState({
    ...initialBrowseState(),
    profileId: "p1",
    active: "left",
    left: { ...emptyPanel(), source: { kind: "local" }, path: "/home/me", entries },
    right: { ...emptyPanel(), source: { kind: "bucket", bucket: "alpha" }, path: "in/", entries },
  });
  useOpsStore.getState().setDialog(null);
  closeMenu();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<><FilePanel side="left" /><FilePanel side="right" /><ContextMenu /></>));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const items = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
const key = (target: Element, init: KeyboardEventInit) => act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));

describe("context menu view", () => {
  it("renders role=menu with menuitems, focuses the first enabled item, and disabled ones are aria-disabled", () => {
    act(() => openRowMenu("left", 0, 20, 20)); // ".." row is index 0? path is not root so yes
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.activeElement).toBe(items()[0]);
    expect(items().some((item) => item.getAttribute("aria-disabled") === "true")).toBe(true);
  });

  it("ArrowDown / ArrowUp move focus across enabled items and wrap", () => {
    act(() => openRowMenu("left", 1, 20, 20)); // a.txt
    const menu = document.querySelector('[role="menu"]')!;
    const first = document.activeElement;
    key(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items()[1]);
    key(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    key(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items().filter((item) => item.getAttribute("aria-disabled") !== "true").at(-1));
  });

  it("Enter activates the focused item, closes the menu and runs the flow", () => {
    act(() => openRowMenu("left", 1, 20, 20));
    const menu = document.querySelector('[role="menu"]')!;
    key(menu, { key: "Enter" }); // first item = View
    expect(startViewer).toHaveBeenCalledWith("view", "left");
    expect(flow.startTransfer).not.toHaveBeenCalled();
    expect(useContextMenu.getState().menu).toBeNull();
  });

  it("clicking a disabled item does nothing and keeps the menu", () => {
    act(() => openRowMenu("left", 0, 20, 20));
    const disabled = items().find((item) => item.getAttribute("aria-disabled") === "true")!;
    act(() => disabled.click());
    expect(flow.startDelete).not.toHaveBeenCalled();
    expect(flow.startTransfer).not.toHaveBeenCalled();
    expect(useContextMenu.getState().menu).not.toBeNull();
  });

  it("Esc closes and returns focus to the panel; Tab closes", () => {
    act(() => openRowMenu("right", 1, 20, 20));
    key(document.querySelector('[role="menu"]')!, { key: "Escape" });
    expect(useContextMenu.getState().menu).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("panel-right"));
    act(() => openRowMenu("right", 1, 20, 20));
    key(document.querySelector('[role="menu"]')!, { key: "Tab" });
    expect(useContextMenu.getState().menu).toBeNull();
  });

  it("closes on outside mousedown, window blur, scroll and resize, but not on a mousedown inside", () => {
    const open = () => act(() => openRowMenu("left", 1, 20, 20));
    open();
    act(() => void items()[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(useContextMenu.getState().menu).not.toBeNull();
    act(() => void document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(useContextMenu.getState().menu).toBeNull();
    for (const event of ["blur", "resize"]) {
      open();
      act(() => void window.dispatchEvent(new Event(event)));
      expect(useContextMenu.getState().menu).toBeNull();
    }
    open();
    act(() => void document.dispatchEvent(new Event("scroll")));
    expect(useContextMenu.getState().menu).toBeNull();
  });

  it("closes when a dialog opens", () => {
    act(() => openRowMenu("left", 1, 20, 20));
    act(() => useOpsStore.getState().setDialog({ kind: "busy", label: "x" }));
    expect(useContextMenu.getState().menu).toBeNull();
  });
});

describe("panel wiring", () => {
  it("right-click on a row opens the menu there and prevents the native menu; right-click on the list's empty area opens the empty menu", () => {
    const row = document.querySelectorAll("#panel-left .list .row")[1];
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
    act(() => void row.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(useContextMenu.getState().menu).toMatchObject({ side: "left", kind: "row", x: 30, y: 40 });
    closeMenu();
    const list = document.querySelector("#panel-left .list")!;
    const emptyEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => void list.dispatchEvent(emptyEvent));
    expect(emptyEvent.defaultPrevented).toBe(true);
    expect(useContextMenu.getState().menu).toMatchObject({ side: "left", kind: "empty" });
  });

  it("the native menu is suppressed on the panel header too, without opening ours", () => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => void document.querySelector("#panel-left .phead")!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(useContextMenu.getState().menu).toBeNull();
  });

  it("Shift+F10 and the ContextMenu key open the menu on the cursor row of the focused panel", () => {
    useBrowseStore.getState().setCursor("left", 1);
    key(document.getElementById("panel-left")!, { key: "F10", shiftKey: true });
    expect(useContextMenu.getState().menu).toMatchObject({ side: "left", kind: "row" });
    closeMenu();
    key(document.getElementById("panel-left")!, { key: "ContextMenu" });
    expect(useContextMenu.getState().menu).toMatchObject({ side: "left", kind: "row" });
  });
});
