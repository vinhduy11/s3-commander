// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "./browse_store";

vi.mock("./panel_loader", () => ({ openRowAt: vi.fn(), openPath: vi.fn(), openSource: vi.fn(), enterDir: vi.fn(), goUp: vi.fn(), loadMore: vi.fn(), loadAll: vi.fn() }));
import { FilePanel } from "./file_panel";
import { COLUMNS_KEY, COLUMN_LIMITS, defaultWidths } from "./panel_columns";
// @ts-expect-error no @types/node in this project; vitest runs in node
import { readFileSync } from "node:fs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const observers: (() => void)[] = [];
const resize = () => observers.forEach((cb) => cb());
vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} });

const entries: PanelEntry[] = [
  { name: "docs", isDir: true, size: 0, modified: null },
  { name: "a.txt", isDir: false, size: 10, modified: 9 },
];
let root: Root;
let host: HTMLElement;
let panelWidth = 0;
const widths = (side: "left" | "right" = "left") => useBrowseStore.getState().columnWidths[side];
const sep = (name: string, side = "left") => document.querySelector<HTMLElement>(`#panel-${side} .list-head [role="separator"][aria-label="Resize ${name} column"]`)!;
const ptr = (target: Element, type: string, x: number) =>
  act(() => void target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: 5, bubbles: true, button: 0 })));
const key = (target: Element, k: string, shiftKey = false) => act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true })));
const panelVar = (v: string, side = "left") => document.getElementById(`panel-${side}`)!.style.getPropertyValue(v);

function mount() {
  useBrowseStore.setState({
    ...initialBrowseState(),
    profileId: "p1",
    left: { ...emptyPanel(), source: { kind: "local" }, path: "/home/me", entries },
    right: { ...emptyPanel(), source: { kind: "local" }, path: "/home/me", entries },
  });
  act(() => root.render(<><FilePanel side="left" /><FilePanel side="right" /></>));
}

beforeEach(() => {
  localStorage.clear();
  panelWidth = 0;
  observers.length = 0;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => panelWidth);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mount();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("separator semantics", () => {
  it("each of Ext, Size, Date has a focusable vertical separator with px values", () => {
    for (const [name, col] of [["Ext", "ext"], ["Size", "size"], ["Date", "date"]] as const) {
      const s = sep(name);
      expect(s.getAttribute("role")).toBe("separator");
      expect(s.getAttribute("aria-orientation")).toBe("vertical");
      expect(s.tabIndex).toBe(0);
      expect(s.getAttribute("aria-valuenow")).toBe(String(COLUMN_LIMITS[col].def));
      expect(s.getAttribute("aria-valuemin")).toBe(String(COLUMN_LIMITS[col].min));
      expect(s.getAttribute("aria-valuemax")).toBe(String(COLUMN_LIMITS[col].max));
    }
    expect(document.querySelectorAll("#panel-left .list-head [role=separator]").length).toBe(3);
  });
  it("header and rows share the widths through CSS custom properties on the panel", () => {
    expect(panelVar("--w-size")).toBe("84px");
    const css: string = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.row\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*var\(--w-ext/);
    expect(css).toMatch(/\.col-resizer[^{]*\{[^}]*cursor:\s*col-resize/);
  });
});

describe("pointer drag", () => {
  it("changes only the dragged column; dragging left widens it", () => {
    const s = sep("Size");
    ptr(s, "pointerdown", 500);
    ptr(s, "pointermove", 470);
    expect(widths().size).toBe(114);
    expect(widths().ext).toBe(COLUMN_LIMITS.ext.def);
    expect(widths().date).toBe(COLUMN_LIMITS.date.def);
    expect(panelVar("--w-size")).toBe("114px");
    ptr(s, "pointerup", 470);
    ptr(s, "pointermove", 300);
    expect(widths().size).toBe(114);
    expect(JSON.parse(localStorage.getItem(COLUMNS_KEY)!).left.size).toBe(114);
  });
  it("clamps to the limits", () => {
    const s = sep("Ext");
    ptr(s, "pointerdown", 500);
    ptr(s, "pointermove", 5000);
    expect(widths().ext).toBe(COLUMN_LIMITS.ext.min);
    ptr(s, "pointermove", -5000);
    expect(widths().ext).toBe(COLUMN_LIMITS.ext.max);
  });
  it("does not sort and does not start a row interaction", () => {
    const s = sep("Size");
    ptr(s, "pointerdown", 500);
    ptr(s, "pointermove", 480);
    ptr(s, "pointerup", 480);
    act(() => void s.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(useBrowseStore.getState().left.sort.key).toBe("name");
    expect(document.querySelector('#panel-left [role="columnheader"][aria-sort="ascending"]')!.textContent).toContain("Name");
  });
  it("a click on the header label still sorts", () => {
    const btn = document.querySelector<HTMLElement>("#panel-left .list-head .num .sort-btn")!;
    act(() => void btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(useBrowseStore.getState().left.sort.key).toBe("size");
  });
});

describe("keyboard and reset", () => {
  it("ArrowLeft widens by 8 px, ArrowRight narrows, Shift = 32 px, Home resets", () => {
    const s = sep("Date");
    key(s, "ArrowLeft");
    expect(widths().date).toBe(132);
    key(s, "ArrowLeft", true);
    expect(widths().date).toBe(164);
    key(s, "ArrowRight");
    expect(widths().date).toBe(156);
    expect(s.getAttribute("aria-valuenow")).toBe("156");
    key(s, "Home");
    expect(widths().date).toBe(COLUMN_LIMITS.date.def);
  });
  it("lets Tab through and prevents handled keys", () => {
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => void sep("Ext").dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(false);
    const arrow = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
    act(() => void sep("Ext").dispatchEvent(arrow));
    expect(arrow.defaultPrevented).toBe(true);
  });
  it("does not move the panel cursor (key does not bubble to panel navigation)", () => {
    const before = useBrowseStore.getState().left.cursor;
    key(sep("Size"), "Home");
    expect(useBrowseStore.getState().left.cursor).toBe(before);
  });
  it("double-click resets only that column", () => {
    useBrowseStore.getState().setColumnWidth("left", "size", 150);
    useBrowseStore.getState().setColumnWidth("left", "ext", 90);
    act(() => void sep("Size").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(widths().size).toBe(COLUMN_LIMITS.size.def);
    expect(widths().ext).toBe(90);
  });
});

describe("per panel and persistence", () => {
  it("left and right keep their own widths", () => {
    key(sep("Size", "left"), "ArrowLeft", true);
    expect(widths("left").size).toBe(116);
    expect(widths("right")).toEqual(defaultWidths());
    expect(panelVar("--w-size", "right")).toBe("84px");
  });
  it("survives unmount and remount through the store", () => {
    key(sep("Ext"), "ArrowLeft", true);
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<FilePanel side="left" />));
    expect(sep("Ext").getAttribute("aria-valuenow")).toBe("88");
    expect(panelVar("--w-ext")).toBe("88px");
  });
  it("initial state is loaded from storage (and works when storage is garbage)", () => {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify({ left: { size: 130 } }));
    expect(initialBrowseState().columnWidths.left.size).toBe(130);
    localStorage.setItem(COLUMNS_KEY, "}{");
    expect(initialBrowseState().columnWidths.left).toEqual(defaultWidths());
  });
  it("setColumnWidth works with storage that throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => useBrowseStore.getState().setColumnWidth("right", "date", 200)).not.toThrow();
    expect(widths("right").date).toBe(200);
  });
});

describe("Name minimum and narrow panel", () => {
  it("clamps the shown widths when the panel shrinks and restores the user's widths when it grows", () => {
    for (const col of ["ext", "size", "date"] as const) useBrowseStore.getState().setColumnWidth("left", col, 9999);
    panelWidth = 600;
    act(() => resize());
    expect(parseInt(panelVar("--w-date"))).toBeLessThan(COLUMN_LIMITS.date.max);
    expect(widths().date).toBe(COLUMN_LIMITS.date.max); // the user's value is kept
    panelWidth = 1600;
    act(() => resize());
    expect(panelVar("--w-date")).toBe(`${COLUMN_LIMITS.date.max}px`);
  });
  it("in a narrow panel (Date hidden) the Date width does not eat the budget", () => {
    useBrowseStore.getState().setColumnWidth("left", "date", 9999);
    panelWidth = 400;
    act(() => resize());
    expect(panelVar("--w-ext")).toBe("56px");
    expect(panelVar("--w-size")).toBe("84px");
  });
  it("the narrow container rule drops the Date column from the single row template", () => {
    const css: string = readFileSync("src/styles.css", "utf8");
    const narrow = css.slice(css.indexOf("@container (max-width: 420px)"));
    expect(narrow).toMatch(/\.date\s*\{\s*display:\s*none/);
    expect(narrow).toMatch(/\.row\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*var\(--w-ext[^;]*var\(--w-size[^;]*\)\s*;/);
  });
});
