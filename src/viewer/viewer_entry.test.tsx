// @vitest-environment jsdom
// The ways into the viewer: Enter and double-click on a file, the right-click menu, F3 and F4.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "../browse/browse_store";
import { useOpsStore } from "../ops/ops_store";

vi.mock("./viewer_flow", () => ({ startViewer: vi.fn() }));
vi.mock("../ops/ops_flow", () => ({ startTransfer: vi.fn(), startDelete: vi.fn(), startRename: vi.fn(), startNewFolder: vi.fn() }));
vi.mock("../ops/presign_flow", () => ({ startPresign: vi.fn() }));
vi.mock("../browse/panel_loader", () => ({
  openRowAt: vi.fn(), openPath: vi.fn(), openSource: vi.fn(), enterDir: vi.fn(), goUp: vi.fn(), loadMore: vi.fn(), loadAll: vi.fn(),
}));
vi.mock("../browse/browse_api", () => ({ listProfiles: vi.fn().mockResolvedValue([]), listBuckets: vi.fn().mockResolvedValue([]) }));
vi.mock("../browse/os_drop", () => ({ listenOsDrop: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("./viewer_host", () => ({ ViewerHost: () => null }));
import { startViewer } from "./viewer_flow";
import { startTransfer } from "../ops/ops_flow";
import { openRowAt } from "../browse/panel_loader";
import { buildMenuItems, closeMenu } from "../browse/context_menu";
import { FilePanel } from "../browse/file_panel";
import { BrowserScreen } from "../screens/browser_screen";
import { useViewerStore } from "./viewer_store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });

const file = (name: string): PanelEntry => ({ name, isDir: false, size: 1, modified: 1 });
const dir = (name: string): PanelEntry => ({ name, isDir: true, size: 0, modified: null });
const entries = [dir("sub"), file("a.txt"), file("b.txt")]; // rows: 0 "..", 1 sub, 2 a.txt, 3 b.txt

function setup(cursor: number) {
  useBrowseStore.setState({
    ...initialBrowseState(), profileId: "p1", active: "left",
    left: { ...emptyPanel(), source: { kind: "local" }, path: "/home/me", entries, cursor },
    right: { ...emptyPanel(), source: { kind: "bucket", bucket: "alpha" }, path: "in/", entries, cursor },
  });
}
const byId = (side: "left" | "right" = "left") => Object.fromEntries(buildMenuItems(side, "row").map((item) => [item.id, item]));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  useOpsStore.getState().setDialog(null);
  useViewerStore.setState({ session: null });
  closeMenu();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("right-click menu", () => {
  it("offers View and Edit for one file, calling the same flow as F3 and F4", () => {
    setup(2);
    const items = byId();
    expect(items.view).toMatchObject({ label: "View", shortcut: "F3", enabled: true });
    expect(items.edit).toMatchObject({ label: "Edit", shortcut: "F4", enabled: true });
    items.view.run();
    items.edit.run();
    expect(startViewer).toHaveBeenNthCalledWith(1, "view", "left");
    expect(startViewer).toHaveBeenNthCalledWith(2, "edit", "left");
  });

  it("works on a server panel too, and is disabled on a folder and on the .. row", () => {
    setup(2);
    expect(byId("right").view.enabled).toBe(true);
    setup(1);
    expect(byId().view.enabled).toBe(false);
    expect(byId().edit.enabled).toBe(false);
    setup(0);
    expect(byId().view.enabled).toBe(false);
  });

  it("is disabled when several items are marked", () => {
    setup(2);
    useBrowseStore.getState().toggleMark("left", "a.txt");
    useBrowseStore.getState().toggleMark("left", "b.txt");
    expect(byId().view.enabled).toBe(false);
  });

  it("keeps the existing entries", () => {
    setup(2);
    expect(Object.keys(byId())).toEqual(expect.arrayContaining(["copy", "move", "rename", "delete", "new-folder"]));
  });
});

describe("Enter and double-click in the panel", () => {
  const mountPanel = () => act(() => root.render(<FilePanel side="left" />));
  const press = (key: string) => act(() => { document.getElementById("panel-left")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

  it("Enter on a file opens the viewer in View mode", () => {
    setup(2);
    mountPanel();
    press("Enter");
    expect(startViewer).toHaveBeenCalledWith("view", "left");
    expect(openRowAt).not.toHaveBeenCalled();
  });

  it("Enter on a folder or .. still navigates", () => {
    setup(1);
    mountPanel();
    press("Enter");
    expect(openRowAt).toHaveBeenCalledWith("left", 1);
    expect(startViewer).not.toHaveBeenCalled();
  });

  it("double-click on a file opens it", () => {
    setup(2);
    mountPanel();
    const row = document.querySelector<HTMLElement>("[data-row-name='a.txt']")!;
    act(() => row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(startViewer).toHaveBeenCalledWith("view", "left");
  });
});

describe("function keys", () => {
  const mountScreen = () => act(() => root.render(<BrowserScreen onManageProfiles={() => undefined} onLock={() => undefined} />));
  const press = (key: string) => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  const fkey = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>(".fkeys button")).find((node) => node.textContent?.includes(label))!;

  it("F3 and F4 are enabled in the bar and open the viewer", () => {
    setup(2);
    mountScreen();
    expect(fkey("View").disabled).toBe(false);
    expect(fkey("Edit").disabled).toBe(false);
    press("F3");
    press("F4");
    expect(startViewer).toHaveBeenNthCalledWith(1, "view");
    expect(startViewer).toHaveBeenNthCalledWith(2, "edit");
    act(() => fkey("View").click());
    expect(startViewer).toHaveBeenCalledTimes(3);
  });

  it("no function key acts while the viewer is open", () => {
    setup(2);
    mountScreen();
    useViewerStore.setState({ session: { name: "a.txt" } as never });
    press("F5");
    press("F3");
    expect(startTransfer).not.toHaveBeenCalled();
    expect(startViewer).not.toHaveBeenCalled();
    act(() => fkey("View").click());
    expect(startViewer).not.toHaveBeenCalled();
  });

  it("F5 still works without the viewer", () => {
    setup(2);
    mountScreen();
    press("F5");
    expect(startTransfer).toHaveBeenCalledWith("copy");
  });
});
