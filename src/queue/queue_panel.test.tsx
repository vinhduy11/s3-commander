// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as queueApi from "./queue_api";
import { TransferQueuePanel } from "./queue_panel";
import { snapshot } from "./queue_fixtures";
import { useQueueStore } from "./queue_store";
import { useToast } from "../ops/toast";
import type { JobSnapshot } from "./queue_logic";

vi.mock("./queue_api");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  useQueueStore.getState().clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function show(...snapshots: JobSnapshot[]) {
  act(() => snapshots.forEach((entry) => useQueueStore.getState().applyState(entry)));
  act(() => root.render(<TransferQueuePanel />));
}
const head = () => host.querySelector<HTMLButtonElement>(".queue-head")!;
const expand = () => act(() => head().click());
const buttonLabels = (row: Element) => Array.from(row.querySelectorAll(".queue-actions button")).map((button) => button.textContent);
const press = (label: string) => act(() => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === label)!.click());

describe("collapsed and expanded", () => {
  it("is one line saying Idle when nothing runs, and the list is hidden", () => {
    show();
    expect(head().textContent).toContain("Idle");
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".queue-body")).toBeNull();
  });

  it("collapsed it shows the running, queued and percent summary", () => {
    show(snapshot({ id: "a", bytes_done: 400 }), snapshot({ id: "b", bytes_done: 400 }), snapshot({ id: "c", state: "queued", bytes_total: 0 }));
    expect(head().textContent).toContain("2 running, 1 queued, 40%");
  });

  it("expands on click with one row per job and collapses with Esc, focus back on the header", () => {
    show(snapshot({ id: "a" }), snapshot({ id: "b", title: "Download 1 item to /home/me" }));
    expand();
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll(".queue-row")).toHaveLength(2);
    const cancelButton = host.querySelector<HTMLButtonElement>(".queue-actions button")!;
    cancelButton.focus();
    act(() => cancelButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector(".queue-body")).toBeNull();
    expect(document.activeElement).toBe(head());
  });
});

describe("a row", () => {
  it("shows title, state, current item, bytes, a progress bar, speed, ETA and item counts", () => {
    show(snapshot({ bytes_total: 4096, bytes_done: 1024 }));
    act(() =>
      useQueueStore.getState().applyProgress(
        { job_id: "job-1", item_name: "big.bin", item_index: 1, item_count: 3, item_bytes_done: 10, item_bytes_total: 20, job_bytes_done: 1024, job_bytes_total: 4096 },
        0,
      ),
    );
    act(() =>
      useQueueStore.getState().applyProgress(
        { job_id: "job-1", item_name: "big.bin", item_index: 1, item_count: 3, item_bytes_done: 15, item_bytes_total: 20, job_bytes_done: 2048, job_bytes_total: 4096 },
        1000,
      ),
    );
    expand();
    const row = host.querySelector(".queue-row")!;
    expect(row.textContent).toContain("Upload 3 items to alpha/in/");
    expect(row.textContent).toContain("big.bin");
    expect(row.textContent).toContain("2.0 KB / 4.0 KB");
    expect(row.textContent).toContain("1.0 KB/s");
    expect(row.textContent).toContain("0:02");
    expect(row.textContent).toContain("Item 2 of 3");
    const bar = row.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
  });

  it("queued: only Cancel; running: only Cancel", () => {
    show(snapshot({ id: "a", state: "queued" }), snapshot({ id: "b" }));
    expand();
    const rows = host.querySelectorAll(".queue-row");
    expect(buttonLabels(rows[0])).toEqual(["Cancel"]);
    expect(buttonLabels(rows[1])).toEqual(["Cancel"]);
  });

  it("failed and cancelled: Retry and Dismiss; done: Dismiss; cancelling: nothing", () => {
    show(snapshot({ id: "a", state: "failed" }), snapshot({ id: "b", state: "cancelled" }), snapshot({ id: "c", state: "done" }), snapshot({ id: "d", state: "cancelling" }));
    expand();
    const rows = Array.from(host.querySelectorAll(".queue-row"));
    expect(rows.map(buttonLabels)).toEqual([["Retry", "Dismiss"], ["Retry", "Dismiss"], ["Dismiss"], []]);
  });

  it("Cancel, Retry and Dismiss call their commands with the job id; Dismiss removes the row", async () => {
    vi.mocked(queueApi.transferCancel).mockResolvedValue(undefined);
    vi.mocked(queueApi.transferRetry).mockResolvedValue(undefined);
    vi.mocked(queueApi.transferDismiss).mockResolvedValue(undefined);
    show(snapshot({ id: "run" }), snapshot({ id: "bad", state: "failed" }));
    expand();
    press("Cancel");
    expect(queueApi.transferCancel).toHaveBeenCalledWith("run");
    press("Retry");
    expect(queueApi.transferRetry).toHaveBeenCalledWith("bad");
    await act(async () => press("Dismiss"));
    expect(queueApi.transferDismiss).toHaveBeenCalledWith("bad");
    expect(useQueueStore.getState().jobs.map((entry) => entry.snapshot.id)).toEqual(["run"]);
  });

  it("a failed dismiss still removes the row (the backend forgets the job) and says what went wrong", async () => {
    vi.mocked(queueApi.transferDismiss).mockRejectedValue("could not abort the incomplete upload u1");
    show(snapshot({ id: "bad", state: "failed" }));
    expand();
    await act(async () => press("Dismiss"));
    expect(useQueueStore.getState().jobs).toHaveLength(0);
    expect(useToast.getState()).toMatchObject({ ok: false, message: expect.stringContaining("could not abort the incomplete upload u1") });
  });

  it("lists per-item failures behind an expander and shows the job message", () => {
    show(
      snapshot({
        state: "failed",
        message: "cannot list the folder",
        items_failed: 2,
        failures_total: 2,
        failures: [{ name: "/home/me/a.bin", message: "access denied" }, { name: "/home/me/b.bin", message: "timeout" }],
      }),
    );
    expand();
    const row = host.querySelector(".queue-row")!;
    expect(row.textContent).toContain("cannot list the folder");
    expect(row.querySelector(".queue-failures")).toBeNull();
    press("2 failed");
    expect(row.querySelector(".queue-failures")!.textContent).toContain("access denied");
    expect(row.textContent).toContain("/home/me/b.bin");
  });

  it("says when the failure list is cut", () => {
    show(snapshot({ state: "failed", items_failed: 300, failures_total: 300, failures: [{ name: "a", message: "x" }] }));
    expand();
    press("300 failed");
    expect(host.querySelector(".queue-failures")!.textContent).toContain("and 299 more");
  });
});
