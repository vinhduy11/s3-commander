// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore } from "./browse_store";

vi.mock("./panel_loader", () => ({ openRowAt: vi.fn(), openPath: vi.fn(), openSource: vi.fn(), enterDir: vi.fn(), goUp: vi.fn(), loadMore: vi.fn(), loadAll: vi.fn(), reloadPanel: vi.fn() }));
import { reloadPanel } from "./panel_loader";
import { FilePanel } from "./file_panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });

let root: Root;
let host: HTMLElement;
const button = () => document.querySelector<HTMLButtonElement>('button[aria-label="Reload"]')!;
function mount(left = {}) {
  useBrowseStore.setState({ ...initialBrowseState(), left: { ...emptyPanel(), source: { kind: "local" }, path: "/home/me", ...left } });
  act(() => root.render(<FilePanel side="left" />));
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Reload header button", () => {
  it("is in the header, has the shortcut in its title, and reloads this panel on click", () => {
    mount();
    expect(button().closest(".phead")).not.toBeNull();
    expect(button().title).toMatch(/Reload.*(Ctrl\+R|⌘R)/);
    expect(button().disabled).toBe(false);
    act(() => button().click());
    expect(reloadPanel).toHaveBeenCalledWith("left");
  });

  it("spins while the panel loads and not otherwise", () => {
    mount();
    expect(button().classList.contains("spinning")).toBe(false);
    act(() => useBrowseStore.getState().setLoading("left", true));
    expect(button().classList.contains("spinning")).toBe(true);
  });

  it("is disabled without a source", () => {
    mount({ source: null });
    expect(button().disabled).toBe(true);
    act(() => button().click());
    expect(reloadPanel).not.toHaveBeenCalled();
  });

  it("the footer shows the notice of a fallback", () => {
    mount({ notice: "Folder no longer exists, showing /home" });
    expect(document.querySelector(".pfoot")?.textContent).toContain("Folder no longer exists, showing /home");
  });
});
