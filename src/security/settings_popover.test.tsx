// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SettingsPopover } from "./settings_popover";
import { useSettingsStore } from "./settings_store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let remember = { available: true, enabled: false }; // what remember_status answers
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  remember = { available: true, enabled: false };
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "settings_set") return (args as { settings: unknown }).settings;
    if (cmd === "remember_status") return remember;
    if (cmd === "remember_set") return (remember = { ...remember, enabled: (args as { enabled: boolean }).enabled });
    if (cmd === "remember_forget") return (remember = { ...remember, enabled: false });
    return undefined;
  });
  useSettingsStore.setState({ autoLockMinutes: 15, error: "", remember: { available: true, enabled: false } });
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
const open = async () => act(async () => trigger().click());
const radios = () => Array.from(host.querySelectorAll<HTMLButtonElement>("[role=radio]"));

describe("settings popover", () => {
  it("is closed until the button is pressed", async () => {
    expect(host.querySelector("[role=dialog]")).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await open();
    expect(host.querySelector("[role=dialog]")).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("offers 1, 5, 15, 30, 60 minutes and Never, with the current one checked", async () => {
    await open();
    expect(radios().map((r) => r.textContent)).toEqual(["1 min", "5 min", "15 min", "30 min", "1 hour", "Never"]);
    expect(radios().filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent)).toEqual(["15 min"]);
  });

  it("choosing a value saves it through settings_set and checks it", async () => {
    await open();
    await act(async () => radios()[1].click());
    expect(invoke).toHaveBeenCalledWith("settings_set", { settings: { auto_lock_minutes: 5 } });
    expect(useSettingsStore.getState().autoLockMinutes).toBe(5);
    expect(radios()[1].getAttribute("aria-checked")).toBe("true");
  });

  it("Never saves 0", async () => {
    await open();
    await act(async () => radios()[5].click());
    expect(invoke).toHaveBeenCalledWith("settings_set", { settings: { auto_lock_minutes: 0 } });
  });

  it("a failed save keeps the old value and shows the error", async () => {
    await open();
    vi.mocked(invoke).mockRejectedValueOnce("disk full");
    await act(async () => radios()[0].click());
    expect(useSettingsStore.getState().autoLockMinutes).toBe(15);
    expect(host.querySelector("[role=alert]")?.textContent).toContain("disk full");
  });

  it("says that locking cancels transfers and keeps unsaved edits", async () => {
    await open();
    const text = host.querySelector("[role=dialog]")!.textContent!;
    expect(text).toContain("cancels running transfers");
    expect(text).toContain("unsaved edits");
  });

  it("Esc closes it and returns focus to the button", async () => {
    await open();
    act(() => void host.querySelector("[role=dialog]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("load reads the stored value", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ auto_lock_minutes: 60 });
    await act(async () => useSettingsStore.getState().load());
    expect(useSettingsStore.getState().autoLockMinutes).toBe(60);
  });

  describe("remember on this device", () => {
    const box = () => host.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    const forget = () => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Forget");

    it("off: an enabled, unchecked box and no Forget button", async () => {
      await open();
      expect(host.textContent).toContain("Remember on this device");
      expect(box().checked).toBe(false);
      expect(box().disabled).toBe(false);
      expect(forget()).toBeUndefined();
    });

    it("on: a checked box and a Forget button", async () => {
      remember = { available: true, enabled: true };
      await open();
      expect(box().checked).toBe(true);
      expect(forget()).toBeDefined();
    });

    it("not available: says so, the box is disabled and no error is shown", async () => {
      remember = { available: false, enabled: false };
      await open();
      expect(host.textContent).toContain("Not available on this system");
      expect(box().disabled).toBe(true);
      expect(host.querySelector("[role=alert]")).toBeNull();
    });

    it("ticking the box stores the key through remember_set and shows it on", async () => {
      await open();
      await act(async () => box().click());
      expect(invoke).toHaveBeenCalledWith("remember_set", { enabled: true });
      expect(box().checked).toBe(true);
      expect(forget()).toBeDefined();
    });

    it("unticking turns it off", async () => {
      remember = { available: true, enabled: true };
      await open();
      await act(async () => box().click());
      expect(invoke).toHaveBeenCalledWith("remember_set", { enabled: false });
      expect(box().checked).toBe(false);
    });

    it("Forget deletes the entry and shows the box unchecked", async () => {
      remember = { available: true, enabled: true };
      await open();
      await act(async () => forget()!.click());
      expect(invoke).toHaveBeenCalledWith("remember_forget");
      expect(box().checked).toBe(false);
      expect(forget()).toBeUndefined();
    });

    it("a failed save keeps the box off and shows the message", async () => {
      await open();
      vi.mocked(invoke).mockRejectedValueOnce("The keychain refused the write.");
      await act(async () => box().click());
      expect(box().checked).toBe(false);
      expect(host.querySelector("[role=alert]")?.textContent).toContain("keychain refused");
    });

    it("explains that it is used only at launch and that locking asks for the master key", async () => {
      await open();
      const text = host.querySelector("[role=dialog]")!.textContent!;
      expect(text).toContain("only when the app starts");
      expect(text).toContain("master key");
    });
  });
});
