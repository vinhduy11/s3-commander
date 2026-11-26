import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { launchStatus, readStatus } from "./launch_unlock";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

type Answers = { exists: boolean; unlockedAtStart: boolean; remembered: boolean | "throws" };
let calls: string[];
function answer({ exists, unlockedAtStart, remembered }: Answers) {
  let unlocked = unlockedAtStart;
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    calls.push(cmd);
    if (cmd === "vault_status") return { exists, unlocked };
    if (cmd === "vault_unlock_remembered") {
      if (remembered === "throws") throw "keychain exploded";
      unlocked = remembered;
      return remembered;
    }
    return undefined;
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  calls = [];
});

describe("launch unlock", () => {
  it("shows Unlocking, tries the remembered key once and ends unlocked", async () => {
    answer({ exists: true, unlockedAtStart: false, remembered: true });
    const trying = vi.fn();
    const status = await launchStatus(trying);
    expect(trying).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["vault_status", "vault_unlock_remembered", "vault_status"]);
    expect(status).toEqual({ exists: true, unlocked: true });
  });

  it("falls back to the locked status when the remembered key did not work", async () => {
    answer({ exists: true, unlockedAtStart: false, remembered: false });
    expect(await launchStatus(vi.fn())).toEqual({ exists: true, unlocked: false });
  });

  it("falls back silently when the command fails", async () => {
    answer({ exists: true, unlockedAtStart: false, remembered: "throws" });
    expect(await launchStatus(vi.fn())).toEqual({ exists: true, unlocked: false });
  });

  it("does not try anything when there is no vault yet or it is already open", async () => {
    answer({ exists: false, unlockedAtStart: false, remembered: true });
    const trying = vi.fn();
    await launchStatus(trying);
    answer({ exists: true, unlockedAtStart: true, remembered: true });
    await launchStatus(trying);
    expect(trying).not.toHaveBeenCalled();
    expect(calls).not.toContain("vault_unlock_remembered");
  });

  it("after a lock only the plain status is read, so the master key screen follows", async () => {
    answer({ exists: true, unlockedAtStart: false, remembered: true });
    expect(await readStatus()).toEqual({ exists: true, unlocked: false });
    expect(calls).toEqual(["vault_status"]);
  });
});
