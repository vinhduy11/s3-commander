// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SettingsPopover } from "./settings_popover";
import { useSettingsStore } from "./settings_store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) =>
    cmd === "settings_set" ? (args as { settings: unknown }).settings : undefined,
  );
  useSettingsStore.setState({ autoLockMinutes: 15, error: "" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<SettingsPopover />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const trigger = () => host.querySelector<HTMLButtonElement>("button[aria-haspopup]")!;
const open = () => act(() => trigger().click());
const radios = () => Array.from(host.querySelectorAll<HTMLButtonElement>("[role=radio]"));

describe("settings popover", () => {
  it("is closed until the button is pressed", () => {
    expect(host.querySelector("[role=dialog]")).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    open();
    expect(host.querySelector("[role=dialog]")).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("offers 1, 5, 15, 30, 60 minutes and Never, with the current one checked", () => {
    open();
    expect(radios().map((r) => r.textContent)).toEqual(["1 min", "5 min", "15 min", "30 min", "1 hour", "Never"]);
    expect(radios().filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent)).toEqual(["15 min"]);
  });

  it("choosing a value saves it through settings_set and checks it", async () => {
    open();
    await act(async () => radios()[1].click());
    expect(invoke).toHaveBeenCalledWith("settings_set", { settings: { auto_lock_minutes: 5 } });
    expect(useSettingsStore.getState().autoLockMinutes).toBe(5);
    expect(radios()[1].getAttribute("aria-checked")).toBe("true");
  });

  it("Never saves 0", async () => {
    open();
    await act(async () => radios()[5].click());
    expect(invoke).toHaveBeenCalledWith("settings_set", { settings: { auto_lock_minutes: 0 } });
  });

  it("a failed save keeps the old value and shows the error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("disk full");
    open();
    await act(async () => radios()[0].click());
    expect(useSettingsStore.getState().autoLockMinutes).toBe(15);
    expect(host.querySelector("[role=alert]")?.textContent).toContain("disk full");
  });

  it("says that locking cancels transfers and keeps unsaved edits", () => {
    open();
    const text = host.querySelector("[role=dialog]")!.textContent!;
    expect(text).toContain("cancels running transfers");
    expect(text).toContain("unsaved edits");
  });

  it("Esc closes it and returns focus to the button", () => {
    open();
    act(() => void host.querySelector("[role=dialog]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("load reads the stored value", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ auto_lock_minutes: 60 });
    await act(async () => useSettingsStore.getState().load());
    expect(useSettingsStore.getState().autoLockMinutes).toBe(60);
  });
});
