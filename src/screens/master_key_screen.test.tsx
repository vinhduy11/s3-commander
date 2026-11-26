// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MasterKeyScreen } from "./master_key_screen";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let wait = 0; // what vault_unlock_wait answers, in ms
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
  wait = 0;
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "vault_unlock_wait") return wait;
    if (cmd === "vault_unlock") throw "wrong master key or corrupted vault";
    return undefined;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const render = async (exists = true) => {
  await act(async () => root.render(<MasterKeyScreen exists={exists} onDone={vi.fn()} />));
};
const button = () => host.querySelector<HTMLButtonElement>("button[type=submit]")!;
const notice = () => host.querySelector(".caution")?.textContent ?? "";

describe("unlock throttle on the master key screen", () => {
  it("shows nothing and keeps the button enabled when there is no wait", async () => {
    await render();
    expect(notice()).toBe("");
    expect(button().disabled).toBe(false);
  });

  it("shows the remaining wait from the start and disables the button", async () => {
    wait = 4_000;
    await render();
    expect(notice()).toContain("Try again in 4 s");
    expect(button().disabled).toBe(true);
  });

  it("counts down and enables the button when the wait is over", async () => {
    wait = 3_000;
    await render();
    await act(async () => void vi.advanceTimersByTime(1_000));
    expect(notice()).toContain("Try again in 2 s");
    await act(async () => void vi.advanceTimersByTime(2_100));
    expect(notice()).toBe("");
    expect(button().disabled).toBe(false);
  });

  it("asks again after a failed unlock and shows the new wait next to the error", async () => {
    await render();
    wait = 2_000;
    await act(async () => button().click());
    expect(host.querySelector("[role=alert]")?.textContent).toContain("wrong master key");
    expect(notice()).toContain("Try again in 2 s");
    expect(button().disabled).toBe(true);
  });

  it("formats long waits in minutes", async () => {
    wait = 256_000;
    await render();
    expect(notice()).toContain("Try again in 4 min 16 s");
  });

  it("does not ask for a wait when creating a vault", async () => {
    await render(false);
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("vault_unlock_wait");
  });
});

describe("launch unlock with the remembered key", () => {
  it("shows Unlocking... and no key field while the remembered key is tried", async () => {
    await act(async () => root.render(<MasterKeyScreen exists unlocking onDone={vi.fn()} />));
    expect(host.textContent).toContain("Unlocking...");
    expect(host.querySelector("input")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("vault_unlock_wait");
  });

  it("shows the normal form again when the attempt is over", async () => {
    await act(async () => root.render(<MasterKeyScreen exists unlocking onDone={vi.fn()} />));
    await act(async () => root.render(<MasterKeyScreen exists onDone={vi.fn()} />));
    expect(host.textContent).not.toContain("Unlocking...");
    expect(host.querySelector("input[type=password]")).not.toBeNull();
  });
});
