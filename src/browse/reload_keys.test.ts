// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOpsStore } from "../ops/ops_store";
import { useViewerStore } from "../viewer/viewer_store";
import { useDragStore } from "./drag_drop";
import { emptyPanel, initialBrowseState, useBrowseStore } from "./browse_store";
import { useContextMenu } from "./context_menu";

vi.mock("./panel_loader", () => ({ reloadPanel: vi.fn() }));
import { reloadPanel } from "./panel_loader";
import { FOCUS_RELOAD_DELAY_MS, installFocusReload, installReloadKey } from "./reload_triggers";

let stop: () => void;
const local = () => ({ ...emptyPanel(), source: { kind: "local" as const }, path: "/home/me" });
const bucket = () => ({ ...emptyPanel(), source: { kind: "bucket" as const, bucket: "b" }, path: "" });

function press(init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", { key: "r", metaKey: true, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  useBrowseStore.setState({ ...initialBrowseState(), active: "right", left: local(), right: bucket() });
  useOpsStore.setState({ dialog: null });
  useViewerStore.setState({ session: null });
  useContextMenu.setState({ menu: null });
  useDragStore.setState({ active: false });
});
afterEach(() => {
  stop?.();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("Cmd/Ctrl+R", () => {
  beforeEach(() => (stop = installReloadKey()));

  it("reloads the active panel only and prevents the webview reload", () => {
    const event = press();
    expect(reloadPanel).toHaveBeenCalledTimes(1);
    expect(reloadPanel).toHaveBeenCalledWith("right");
    expect(event.defaultPrevented).toBe(true);
    press({ metaKey: false, ctrlKey: true, key: "R" });
    expect(reloadPanel).toHaveBeenCalledTimes(2);
  });

  it("ignores other keys, Shift/Alt variants and a plain R", () => {
    press({ key: "t" });
    press({ shiftKey: true });
    press({ altKey: true });
    press({ metaKey: false });
    expect(reloadPanel).not.toHaveBeenCalled();
  });

  it("does not reload while a dialog, the viewer, a menu or a text input has the focus (the webview still must not reload)", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const cases: [string, () => void, EventTarget][] = [
      ["dialog", () => useOpsStore.setState({ dialog: { kind: "select-pattern", side: "left", mode: "select" } as never }), window],
      ["viewer", () => useViewerStore.setState({ session: {} as never }), window],
      ["menu", () => useContextMenu.setState({ menu: { side: "left", kind: "row", x: 0, y: 0 } }), window],
      ["input", () => undefined, input],
    ];
    for (const [, arrange, target] of cases) {
      arrange();
      const event = press({}, target);
      expect(event.defaultPrevented).toBe(true);
      expect(reloadPanel).not.toHaveBeenCalled();
      useOpsStore.setState({ dialog: null });
      useViewerStore.setState({ session: null });
      useContextMenu.setState({ menu: null });
    }
  });

  it("stops listening after cleanup", () => {
    stop();
    press();
    expect(reloadPanel).not.toHaveBeenCalled();
  });
});

describe("reload when the window regains focus", () => {
  beforeEach(() => (stop = installFocusReload()));
  const focus = () => window.dispatchEvent(new Event("focus"));
  const settle = () => vi.advanceTimersByTime(FOCUS_RELOAD_DELAY_MS);

  it("debounces and reloads local panels silently, never server panels", () => {
    useBrowseStore.setState({ left: local(), right: { ...local(), path: "/tmp" } });
    focus();
    vi.advanceTimersByTime(FOCUS_RELOAD_DELAY_MS - 1);
    focus(); // restarts the wait
    vi.advanceTimersByTime(FOCUS_RELOAD_DELAY_MS - 1);
    expect(reloadPanel).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reloadPanel).toHaveBeenCalledTimes(2);
    expect(reloadPanel).toHaveBeenCalledWith("left", { silent: true });
    expect(reloadPanel).toHaveBeenCalledWith("right", { silent: true });
  });

  it("skips server panels", () => {
    focus();
    settle();
    expect(reloadPanel).toHaveBeenCalledTimes(1);
    expect(reloadPanel).toHaveBeenCalledWith("left", { silent: true });
  });

  it("skips a panel that is loading", () => {
    useBrowseStore.setState({ left: { ...local(), loading: true } });
    focus();
    settle();
    expect(reloadPanel).not.toHaveBeenCalled();
  });

  it.each([
    ["a dialog", () => useOpsStore.setState({ dialog: { kind: "select-pattern", side: "left", mode: "select" } as never })],
    ["the viewer", () => useViewerStore.setState({ session: {} as never })],
    ["a drag", () => useDragStore.setState({ active: true })],
    ["a rubber band", () => document.body.append(Object.assign(document.createElement("div"), { className: "band" }))],
  ])("skips while %s is active", (_name, arrange) => {
    arrange();
    focus();
    settle();
    expect(reloadPanel).not.toHaveBeenCalled();
  });

  it("stops listening after cleanup", () => {
    stop();
    focus();
    settle();
    expect(reloadPanel).not.toHaveBeenCalled();
  });
});
