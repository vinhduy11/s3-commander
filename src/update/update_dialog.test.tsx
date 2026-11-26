// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { snapshot } from "../queue/queue_fixtures";
import { useQueueStore } from "../queue/queue_store";
import { UpdateDialog } from "./update_dialog";
import { useUpdateStore } from "./update_store";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Handler = (event: unknown) => void;
let finishDownload: () => void;
let sendProgress: Handler;
const update = {
  version: "1.0.1",
  currentVersion: "1.0.0",
  body: "Fixes a crash.\nAdds a thing.",
  downloadAndInstall: vi.fn((onEvent: Handler) => {
    sendProgress = onEvent;
    return new Promise<void>((resolve) => (finishDownload = resolve));
  }),
};

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  update.downloadAndInstall.mockClear();
  vi.mocked(check).mockResolvedValue(update as never);
  vi.mocked(relaunch).mockReset();
  useUpdateStore.getState().reset();
  useQueueStore.getState().clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<UpdateDialog />));
  await act(async () => useUpdateStore.getState().checkManual());
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const dialog = () => host.querySelector<HTMLElement>("[role=dialog]");
const button = (label: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);
const click = async (label: string) => act(async () => button(label)!.click());
const openIt = () => act(() => useUpdateStore.getState().openDialog());
const esc = () => act(() => void dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

describe("update dialog", () => {
  it("renders nothing while closed", () => {
    expect(dialog()).toBeNull();
  });

  it("shows the new version, the current version and the release notes", async () => {
    await openIt();
    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
    const text = dialog()!.textContent!;
    expect(text).toContain("1.0.1");
    expect(text).toContain("1.0.0");
    expect(host.querySelector("[aria-label='Release notes']")!.textContent).toBe("Fixes a crash.\nAdds a thing.");
    expect(document.activeElement).toBe(button("Download and install"));
  });

  it("says so when there are no release notes", async () => {
    useUpdateStore.setState((s) => ({ update: { ...s.update, notes: "" } }));
    await openIt();
    expect(host.querySelector("[aria-label='Release notes']")!.textContent).toBe("No release notes.");
  });

  it("Esc cancels before the download starts and keeps the update available", async () => {
    await openIt();
    await esc();
    expect(dialog()).toBeNull();
    expect(useUpdateStore.getState().update.phase).toBe("available");
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("Cancel closes it too", async () => {
    await openIt();
    await click("Cancel");
    expect(dialog()).toBeNull();
  });

  it("Download and install shows a progress bar that follows the events; Esc is ignored and it says it cannot be canceled", async () => {
    await openIt();
    await click("Download and install");
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    await act(async () => sendProgress({ event: "Started", data: { contentLength: 200 } }));
    await act(async () => sendProgress({ event: "Progress", data: { chunkLength: 50 } }));
    const bar = host.querySelector<HTMLElement>("[role=progressbar]")!;
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(dialog()!.textContent).toContain("25%");
    expect(dialog()!.textContent).toContain("cannot be canceled");
    expect(button("Cancel")).toBeUndefined();
    await esc();
    expect(dialog()).not.toBeNull();
  });

  it("an unknown size shows an indeterminate bar", async () => {
    await openIt();
    await click("Download and install");
    await act(async () => sendProgress({ event: "Started", data: {} }));
    expect(host.querySelector("[role=progressbar]")!.hasAttribute("aria-valuenow")).toBe(false);
  });

  it("after the install it offers Restart now or Later", async () => {
    await openIt();
    await click("Download and install");
    await act(async () => finishDownload());
    expect(dialog()!.textContent).toContain("Restart");
    expect(document.activeElement).toBe(button("Restart now"));
    await click("Restart now");
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("Later closes the dialog", async () => {
    await openIt();
    await click("Download and install");
    await act(async () => finishDownload());
    await click("Later");
    expect(dialog()).toBeNull();
    expect(useUpdateStore.getState().update.phase).toBe("installed");
  });

  it("a failed install shows the message and Close", async () => {
    update.downloadAndInstall.mockRejectedValueOnce("signature verification failed");
    await openIt();
    await click("Download and install");
    expect(host.querySelector("[role=alert]")!.textContent).toContain("signature verification failed");
    await click("Close");
    expect(dialog()).toBeNull();
  });

  describe("a transfer is running", () => {
    beforeEach(async () => {
      useQueueStore.getState().applyState(snapshot({ state: "running" }));
      await openIt();
      await click("Download and install");
    });

    it("warns before downloading and focuses the safe choice", () => {
      expect(update.downloadAndInstall).not.toHaveBeenCalled();
      expect(host.querySelector(".caution")!.textContent).toContain("transfer is running");
      expect(document.activeElement).toBe(button("Wait for transfers"));
    });

    it("Install anyway goes ahead", async () => {
      await click("Install anyway");
      expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    });

    it("Wait for transfers shows the waiting text and installs when the queue is idle", async () => {
      await click("Wait for transfers");
      expect(dialog()!.textContent).toContain("Waiting for transfers");
      await act(async () => useQueueStore.getState().applyState(snapshot({ state: "done" })));
      expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    });

    it("Stop waiting ends the wait", async () => {
      await click("Wait for transfers");
      await click("Stop waiting");
      expect(useUpdateStore.getState().waiting).toBe(false);
      expect(dialog()).toBeNull();
    });

    it("Esc leaves the warning without installing", async () => {
      await esc();
      expect(dialog()).toBeNull();
      expect(update.downloadAndInstall).not.toHaveBeenCalled();
    });
  });
});
