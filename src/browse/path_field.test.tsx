// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "./browse_store";

vi.mock("./browse_api", () => ({ listLocalDir: vi.fn(), listBucketDir: vi.fn(), homeDir: vi.fn() }));
vi.mock("./panel_loader", () => ({ openRowAt: vi.fn(), openPath: vi.fn(), openSource: vi.fn(), openLocation: vi.fn(), enterDir: vi.fn(), goUp: vi.fn(), loadMore: vi.fn(), loadAll: vi.fn(), reloadPanel: vi.fn() }));
import { homeDir, listBucketDir, listLocalDir } from "./browse_api";
import { FilePanel } from "./file_panel";
import * as loader from "./panel_loader";
import { resetMemoryCache, updateMemory } from "./location_memory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });

const dir = (name: string): PanelEntry => ({ name, isDir: true, size: 0, modified: null });
let root: Root;
let host: HTMLElement;

function mount(kind: "local" | "bucket" = "local") {
  useBrowseStore.setState({
    ...initialBrowseState(),
    profileId: "p1",
    buckets: ["alpha", "beta"],
    left: { ...emptyPanel(), source: kind === "local" ? { kind: "local" } : { kind: "bucket", bucket: "alpha" }, path: kind === "local" ? "/Users/me/docs" : "in/", entries: [dir("sub")] },
  });
  act(() => root.render(<FilePanel side="left" />));
}
const pathButton = () => document.querySelector<HTMLElement>(".phead .path")!;
const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Path of the left panel"]');
const alertText = () => document.querySelector(".path-error")?.textContent ?? "";
const options = () => Array.from(document.querySelectorAll('[role="listbox"][aria-label="Recent locations"] [role="option"]')).map((node) => node.textContent);
const panel = () => document.getElementById("panel-left")!;

function type(text: string) {
  const field = input()!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const press = (key: string, extra: KeyboardEventInit = {}, target: Element = input()!) =>
  act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })));
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetMemoryCache();
  vi.mocked(homeDir).mockResolvedValue("/Users/me");
  vi.mocked(loader.openPath).mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("path field", () => {
  it("shows the path as text with no input until clicked", () => {
    mount();
    expect(pathButton().textContent).toBe("/Users/me/docs");
    expect(input()).toBeNull();
  });

  it("a server path is shown with a leading slash", () => {
    mount("bucket");
    expect(pathButton().textContent).toBe("/in/");
  });

  it("a click opens the field with the full path selected and an aria-label", () => {
    mount();
    act(() => pathButton().click());
    expect(input()).not.toBeNull();
    expect(input()!.value).toBe("/Users/me/docs");
    expect(document.activeElement).toBe(input());
    expect(input()!.selectionStart).toBe(0);
    expect(input()!.selectionEnd).toBe("/Users/me/docs".length);
  });

  it("a server panel field starts with s3://bucket/prefix", () => {
    mount("bucket");
    act(() => pathButton().click());
    expect(input()!.value).toBe("s3://alpha/in/");
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])("Cmd/Ctrl+L on the panel opens the field (%j)", (modifier) => {
    mount();
    press("l", modifier, panel());
    expect(input()).not.toBeNull();
  });

  it("Enter navigates with the typed text through the go-to flow (loader openPath with the parsed path)", async () => {
    vi.mocked(listLocalDir).mockResolvedValue({ path: "/Users/me/x", entries: [] });
    mount();
    act(() => pathButton().click());
    type("/Users/me/x");
    press("Enter");
    await flush();
    expect(loader.openPath).toHaveBeenCalledWith("left", "/Users/me/x");
    expect(input()).toBeNull(); // closed on success
  });

  it("Esc cancels, restores the text and does not navigate", () => {
    mount();
    act(() => pathButton().click());
    type("/elsewhere");
    press("Escape");
    expect(input()).toBeNull();
    expect(pathButton().textContent).toBe("/Users/me/docs");
    expect(loader.openPath).not.toHaveBeenCalled();
  });

  it("blur cancels", () => {
    mount();
    act(() => pathButton().click());
    type("/elsewhere");
    act(() => input()!.blur());
    expect(input()).toBeNull();
    expect(loader.openPath).not.toHaveBeenCalled();
  });

  it("a parse error stays under the field as an alert and keeps the field open", async () => {
    mount();
    act(() => pathButton().click());
    type("s3://alpha");
    useBrowseStore.setState({ profileId: null, buckets: [] });
    press("Enter");
    await flush();
    expect(document.querySelector('.path-error[role="alert"]')).not.toBeNull();
    expect(alertText()).toMatch(/profile/i);
    expect(input()).not.toBeNull();
    expect(loader.openPath).not.toHaveBeenCalled();
  });

  it("a folder that cannot be listed shows its error under the field and keeps the old location", async () => {
    vi.mocked(loader.openPath).mockImplementation(async (side) => void useBrowseStore.getState().setError(side, "not found: /nope"));
    mount();
    act(() => pathButton().click());
    type("/nope");
    press("Enter");
    await flush();
    expect(alertText()).toBe("not found: /nope");
    expect(useBrowseStore.getState().left.path).toBe("/Users/me/docs");
    expect(useBrowseStore.getState().left.error).toBe("");
    expect(input()).not.toBeNull();
  });

  it("typing clears the error", async () => {
    mount();
    act(() => pathButton().click());
    type("   ");
    press("Enter");
    await flush();
    expect(alertText()).not.toBe("");
    type("/x");
    expect(alertText()).toBe("");
  });

  it("the field's keys do not reach the panel (Backspace does not go up, Enter does not open a row)", () => {
    mount();
    act(() => pathButton().click());
    press("Backspace");
    press("ArrowDown");
    expect(loader.goUp).not.toHaveBeenCalled();
    expect(loader.openRowAt).not.toHaveBeenCalled();
  });
});

describe("recent locations dropdown", () => {
  const seed = (local: string[], server: string[] = []) => updateMemory((current) => ({ ...current, recents: { local, server } }));

  it("lists the recents of the panel kind as a listbox of options, most recent first, with an aria-label", () => {
    seed(["/a", "/b"], ["s3://alpha/x/"]);
    mount();
    act(() => pathButton().click());
    expect(options()).toEqual(["/a", "/b"]);
    expect(document.querySelector('[role="listbox"]')!.getAttribute("aria-label")).toBe("Recent locations");
    expect(input()!.getAttribute("aria-expanded")).toBe("true");
  });

  it("a server panel shows the server recents", () => {
    seed(["/a"], ["s3://alpha/x/"]);
    mount("bucket");
    act(() => pathButton().click());
    expect(options()).toEqual(["s3://alpha/x/"]);
  });

  it("no recents, no dropdown", () => {
    mount();
    act(() => pathButton().click());
    expect(document.querySelector('[role="listbox"][aria-label="Recent locations"]')).toBeNull();
  });

  it("Down/Up move the highlight (aria-activedescendant) and Enter navigates to the highlighted recent", async () => {
    seed(["/a", "/b", "/c"]);
    vi.mocked(listLocalDir).mockResolvedValue({ path: "/b", entries: [] });
    mount();
    act(() => pathButton().click());
    press("ArrowDown");
    press("ArrowDown");
    const selected = document.querySelector('[role="option"][aria-selected="true"]')!;
    expect(selected.textContent).toBe("/b");
    expect(input()!.getAttribute("aria-activedescendant")).toBe(selected.id);
    press("ArrowDown");
    press("ArrowUp");
    expect(document.querySelector('[role="option"][aria-selected="true"]')!.textContent).toBe("/b");
    press("Enter");
    await flush();
    expect(loader.openPath).toHaveBeenCalledWith("left", "/b");
  });

  it("Up from the top and Down past the end stay inside the list", () => {
    seed(["/a", "/b"]);
    mount();
    act(() => pathButton().click());
    press("ArrowUp");
    press("ArrowDown"); press("ArrowDown"); press("ArrowDown"); press("ArrowDown");
    expect(document.querySelector('[role="option"][aria-selected="true"]')!.textContent).toBe("/b");
  });

  it("a click on an option navigates to it without the blur cancelling first", async () => {
    seed(["/a", "/b"]);
    vi.mocked(listLocalDir).mockResolvedValue({ path: "/a", entries: [] });
    mount();
    act(() => pathButton().click());
    const option = document.querySelectorAll<HTMLElement>('[role="option"]')[0];
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => void option.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    act(() => option.click());
    await flush();
    expect(loader.openPath).toHaveBeenCalledWith("left", "/a");
  });

  it("a successful jump adds the new location on top of the list the next time the field opens", async () => {
    vi.mocked(loader.openPath).mockImplementation(async (side) => void useBrowseStore.getState().setListing(side, { path: "/Users/me/x", entries: [], nextToken: null }));
    seed(["/a"]);
    mount();
    act(() => pathButton().click());
    type("/Users/me/x");
    press("Enter");
    await flush();
    act(() => pathButton().click());
    expect(options()).toEqual(["/Users/me/x", "/a"]);
  });

  it("Esc with the dropdown open closes the field", () => {
    seed(["/a"]);
    mount();
    act(() => pathButton().click());
    press("Escape");
    expect(input()).toBeNull();
  });
});

describe("through the real flow", () => {
  it("a bucket switch on a server panel reaches the loader with source and path", async () => {
    vi.mocked(loader.openLocation).mockResolvedValue(undefined);
    vi.mocked(listBucketDir).mockResolvedValue({ entries: [], nextToken: null });
    mount("bucket");
    act(() => pathButton().click());
    type("s3://beta/p");
    press("Enter");
    await flush();
    expect(loader.openLocation).toHaveBeenCalledWith("left", { kind: "bucket", bucket: "beta" }, "p/");
  });
});
