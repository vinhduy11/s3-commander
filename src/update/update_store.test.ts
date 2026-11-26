import { beforeEach, describe, expect, it, vi } from "vitest";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { snapshot } from "../queue/queue_fixtures";
import { useQueueStore } from "../queue/queue_store";
import { useSettingsStore } from "../security/settings_store";
import { useUpdateStore } from "./update_store";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

type Handler = (event: unknown) => void;
const fakeUpdate = (downloadAndInstall?: (onEvent: Handler) => Promise<void>) => ({
  version: "1.0.1",
  currentVersion: "1.0.0",
  body: "Release notes",
  downloadAndInstall: vi.fn(
    downloadAndInstall ??
      (async (onEvent: Handler) => {
        onEvent({ event: "Started", data: { contentLength: 100 } });
        onEvent({ event: "Progress", data: { chunkLength: 40 } });
        onEvent({ event: "Progress", data: { chunkLength: 60 } });
        onEvent({ event: "Finished" });
      }),
  ),
});
const state = () => useUpdateStore.getState();

beforeEach(() => {
  vi.mocked(check).mockReset();
  vi.mocked(relaunch).mockReset();
  useUpdateStore.getState().reset();
  useQueueStore.getState().clear();
  useSettingsStore.setState({ checkUpdatesAtLaunch: true });
});

describe("manual check", () => {
  it("reports up to date", async () => {
    vi.mocked(check).mockResolvedValue(null);
    await state().checkManual();
    expect(state().update.phase).toBe("up_to_date");
  });

  it("reports an available update without opening the dialog", async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate() as never);
    await state().checkManual();
    expect(state().update).toMatchObject({ phase: "available", version: "1.0.1", currentVersion: "1.0.0", notes: "Release notes" });
    expect(state().dialogOpen).toBe(false);
  });

  it("shows the error text, also for a thrown string", async () => {
    vi.mocked(check).mockRejectedValue("could not reach the update server");
    await state().checkManual();
    expect(state().update).toMatchObject({ phase: "error", error: "could not reach the update server" });
    vi.mocked(check).mockRejectedValue(new Error("signature mismatch"));
    await state().checkManual();
    expect(state().update.error).toBe("signature mismatch");
  });
});

describe("launch check", () => {
  it("runs once in a release build", async () => {
    vi.mocked(check).mockResolvedValue(null);
    await state().checkAtLaunch({ dev: false });
    await state().checkAtLaunch({ dev: false });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("does nothing in a dev build", async () => {
    await state().checkAtLaunch({ dev: true });
    expect(check).not.toHaveBeenCalled();
  });

  it("does nothing when the setting is off", async () => {
    useSettingsStore.setState({ checkUpdatesAtLaunch: false });
    await state().checkAtLaunch({ dev: false });
    expect(check).not.toHaveBeenCalled();
  });

  it("fails silently: idle and no error", async () => {
    vi.mocked(check).mockRejectedValue("offline");
    await state().checkAtLaunch({ dev: false });
    expect(state().update).toMatchObject({ phase: "idle", error: "" });
    expect(state().dialogOpen).toBe(false);
  });

  it("an available update is recorded but the dialog stays closed", async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate() as never);
    await state().checkAtLaunch({ dev: false });
    expect(state().update.phase).toBe("available");
    expect(state().dialogOpen).toBe(false);
  });
});

describe("install", () => {
  async function available() {
    const update = fakeUpdate();
    vi.mocked(check).mockResolvedValue(update as never);
    await state().checkManual();
    state().openDialog();
    return update;
  }

  it("downloads, follows progress and ends installed", async () => {
    const update = await available();
    const seen: number[] = [];
    const stop = useUpdateStore.subscribe((s) => s.update.phase === "downloading" && seen.push(s.update.downloaded));
    await state().install();
    stop();
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(seen).toContain(40);
    expect(state().update.phase).toBe("installed");
  });

  it("a failed install is an error that keeps the version, and closing it offers the update again", async () => {
    const update = await available();
    update.downloadAndInstall.mockRejectedValue("signature verification failed");
    await state().install();
    expect(state().update).toMatchObject({ phase: "error", error: "signature verification failed", version: "1.0.1" });
    state().closeDialog();
    expect(state().update.phase).toBe("available");
    expect(state().dialogOpen).toBe(false);
  });

  it("restart relaunches the app", async () => {
    await available();
    await state().install();
    await state().restart();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("Later closes the dialog and keeps the installed state", async () => {
    await available();
    await state().install();
    state().closeDialog();
    expect(state().dialogOpen).toBe(false);
    expect(state().update.phase).toBe("installed");
  });

  it("closing before the download starts keeps the update available", async () => {
    await available();
    state().closeDialog();
    expect(state().update.phase).toBe("available");
  });

  it("a download in progress cannot be closed", async () => {
    let finish: () => void = () => undefined;
    await available();
    vi.mocked(check).mockReset();
    const update = fakeUpdate(() => new Promise<void>((resolve) => (finish = resolve)));
    vi.mocked(check).mockResolvedValue(update as never);
    useUpdateStore.getState().reset();
    await state().checkManual();
    state().openDialog();
    const pending = state().install();
    expect(state().update.phase).toBe("downloading");
    state().closeDialog();
    expect(state().dialogOpen).toBe(true);
    finish();
    await pending;
  });
});

describe("transfers running", () => {
  async function availableWithRunningJob() {
    const update = fakeUpdate();
    vi.mocked(check).mockResolvedValue(update as never);
    await state().checkManual();
    state().openDialog();
    useQueueStore.getState().applyState(snapshot({ state: "running" }));
    return update;
  }

  it("install warns first and downloads nothing", async () => {
    const update = await availableWithRunningJob();
    await state().install();
    expect(state().transferWarning).toBe(true);
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(state().update.phase).toBe("available");
  });

  it("a queued job counts too", async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate() as never);
    await state().checkManual();
    useQueueStore.getState().applyState(snapshot({ state: "queued" }));
    await state().install();
    expect(state().transferWarning).toBe(true);
  });

  it("finished jobs do not warn", async () => {
    const update = fakeUpdate();
    vi.mocked(check).mockResolvedValue(update as never);
    await state().checkManual();
    useQueueStore.getState().applyState(snapshot({ state: "done" }));
    await state().install();
    expect(update.downloadAndInstall).toHaveBeenCalled();
  });

  it("Install anyway downloads at once", async () => {
    const update = await availableWithRunningJob();
    await state().install();
    await state().installAnyway();
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(state().transferWarning).toBe(false);
    expect(state().update.phase).toBe("installed");
  });

  it("Wait installs when the last job finishes", async () => {
    const update = await availableWithRunningJob();
    await state().install();
    state().waitForTransfers();
    expect(state().waiting).toBe(true);
    expect(state().transferWarning).toBe(false);
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    useQueueStore.getState().applyState(snapshot({ state: "done" }));
    await vi.waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledTimes(1));
    expect(state().waiting).toBe(false);
  });

  it("Stop waiting cancels the wait for good", async () => {
    const update = await availableWithRunningJob();
    await state().install();
    state().waitForTransfers();
    state().stopWaiting();
    expect(state().waiting).toBe(false);
    useQueueStore.getState().applyState(snapshot({ state: "done" }));
    await Promise.resolve();
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("closing the dialog while waiting stops the wait", async () => {
    await availableWithRunningJob();
    await state().install();
    state().waitForTransfers();
    state().closeDialog();
    expect(state().waiting).toBe(false);
    expect(state().dialogOpen).toBe(false);
  });
});
