// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialBrowseState, useBrowseStore } from "./browse_store";
import { hitTest } from "./drag_drop_logic";
import { PanelSplitter } from "./panel_splitter";
import { SPLIT_KEY } from "./panel_split";
// @ts-expect-error no @types/node in this project; vitest runs in node
import { readFileSync } from "node:fs";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
const ratio = () => useBrowseStore.getState().splitRatio;
const sep = () => host.querySelector<HTMLElement>('[role="separator"]')!;

function mount() {
  root = createRoot(host);
  act(() => root.render(<div id="grid"><div data-panel="left" /><PanelSplitter /><div data-panel="right" /></div>));
  vi.spyOn(sep(), "getBoundingClientRect").mockReturnValue({ left: 600, width: 8, right: 608, top: 0, bottom: 500, height: 500, x: 600, y: 0, toJSON() {} });
  // 1008 px wide grid at x=100 => 1000 px free next to the 8 px splitter
  vi.spyOn(host.querySelector("#grid")!, "getBoundingClientRect").mockReturnValue({ left: 100, width: 1008, right: 1108, top: 0, bottom: 500, height: 500, x: 100, y: 0, toJSON() {} });
}
const key = (k: string, shiftKey = false) => act(() => void sep().dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true })));
const ptr = (type: string, x: number, target: Element = sep()) =>
  act(() => void target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: 10, bubbles: true, button: 0 })));

beforeEach(() => {
  localStorage.clear();
  useBrowseStore.setState({ ...initialBrowseState(), splitRatio: 0.5 });
  host = document.createElement("div");
  document.body.append(host);
  mount();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("splitter semantics", () => {
  it("is a focusable vertical separator with percent values", () => {
    expect(sep().getAttribute("aria-orientation")).toBe("vertical");
    expect(sep().tabIndex).toBe(0);
    expect(sep().getAttribute("aria-valuenow")).toBe("50");
    expect(sep().getAttribute("aria-valuemin")).toBe("20");
    expect(sep().getAttribute("aria-valuemax")).toBe("80");
  });
  it("is hidden in the narrow layout (CSS)", () => {
    const css: string = readFileSync("src/styles.css", "utf8");
    const narrow = css.slice(css.indexOf("@media (max-width: 720px) {\n  .panels"));
    expect(narrow).toMatch(/\.panel-splitter\s*\{\s*display:\s*none/);
    expect(narrow).toMatch(/\.panels\s*\{\s*grid-template-columns:\s*1fr/);
  });
});

describe("keyboard", () => {
  it("moves 16 px per arrow and 64 px with Shift", () => {
    key("ArrowRight");
    expect(ratio()).toBeCloseTo(0.516);
    key("ArrowLeft", true);
    expect(ratio()).toBeCloseTo(0.452);
    expect(sep().getAttribute("aria-valuenow")).toBe("45");
  });
  it("Home and double-click reset to 50/50", () => {
    key("ArrowRight", true);
    key("Home");
    expect(ratio()).toBe(0.5);
    key("ArrowLeft", true);
    act(() => void sep().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(ratio()).toBe(0.5);
  });
  it("never crosses the limits", () => {
    for (let i = 0; i < 30; i++) key("ArrowLeft", true);
    expect(ratio()).toBe(0.24);
  });
  it("lets other keys (Tab) through", () => {
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => void sep().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("pointer drag", () => {
  it("updates the ratio while dragging and keeps it on release", () => {
    // splitter centre now at 100 + 500 + 4 = 604
    ptr("pointerdown", 604);
    ptr("pointermove", 404);
    expect(ratio()).toBeCloseTo(0.3);
    expect(document.body.classList.contains("resizing")).toBe(true);
    ptr("pointermove", 0);
    expect(ratio()).toBe(0.24);
    ptr("pointerup", 0);
    expect(document.body.classList.contains("resizing")).toBe(false);
    ptr("pointermove", 800);
    expect(ratio()).toBe(0.24);
    expect(localStorage.getItem(SPLIT_KEY)).toBe("0.24");
  });
  it("ignores moves without a press", () => {
    ptr("pointermove", 300);
    expect(ratio()).toBe(0.5);
  });
});

describe("store slice", () => {
  it("survives unmount and remount and is persisted", () => {
    key("ArrowLeft", true);
    act(() => root.unmount());
    mount();
    expect(ratio()).toBeCloseTo(0.436);
    expect(sep().getAttribute("aria-valuenow")).toBe("44");
    expect(Number(localStorage.getItem(SPLIT_KEY))).toBeCloseTo(0.436);
  });
  it("clamps ratios set from outside", () => {
    useBrowseStore.getState().setSplitRatio(0.95);
    expect(ratio()).toBe(0.8);
  });
});

describe("drop hit-testing after a resize", () => {
  // jsdom has no layout: fake elementFromPoint from a column model of the live ratio.
  function layout(x: number) {
    const left = 100 + 1000 * ratio();
    const el = x < left ? host.querySelector('[data-panel="left"]') : x < left + 8 ? sep() : host.querySelector('[data-panel="right"]');
    return el;
  }
  beforeEach(() => {
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = (x: number) => layout(x);
  });
  it("maps the same pointer x to a different panel after the ratio changes", () => {
    expect(hitTest(500, 10)?.side).toBe("left");
    useBrowseStore.getState().setSplitRatio(0.3);
    expect(hitTest(500, 10)?.side).toBe("right");
  });
  it("never treats the splitter as a drop target", () => {
    const x = 100 + 1000 * ratio() + 4;
    expect(hitTest(x, 10)).toBeNull();
  });
});
