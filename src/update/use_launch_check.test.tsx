// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { check } from "@tauri-apps/plugin-updater";
import { useSettingsStore } from "../security/settings_store";
import { useUpdateStore } from "./update_store";
import { LAUNCH_CHECK_DELAY_MS, useLaunchUpdateCheck } from "./use_launch_check";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ unlocked }: { unlocked: boolean }) {
  useLaunchUpdateCheck(unlocked, { dev: false });
  return null;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(check).mockReset().mockResolvedValue(null);
  useUpdateStore.getState().reset();
  useSettingsStore.setState({ checkUpdatesAtLaunch: true });
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("launch update check", () => {
  it("never runs while the vault is locked (the master key screen)", async () => {
    act(() => root.render(<Probe unlocked={false} />));
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS * 3);
    expect(check).not.toHaveBeenCalled();
  });

  it("runs a few seconds after unlock, not before", async () => {
    act(() => root.render(<Probe unlocked />));
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(LAUNCH_CHECK_DELAY_MS).toBeGreaterThanOrEqual(3000);
  });

  it("locking before the delay cancels it; unlocking again runs it once", async () => {
    act(() => root.render(<Probe unlocked />));
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS - 1000);
    act(() => root.render(<Probe unlocked={false} />));
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS * 2);
    expect(check).not.toHaveBeenCalled();
    act(() => root.render(<Probe unlocked />));
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS);
    act(() => root.render(<Probe unlocked={false} />));
    act(() => root.render(<Probe unlocked />));
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
