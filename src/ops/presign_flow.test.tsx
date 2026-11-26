// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "../browse/browse_store";
import * as api from "./ops_api";
import type { PresignReport } from "./ops_api";
import { OpsDialogs } from "./ops_dialogs";
import { useOpsStore } from "./ops_store";
import { copyPresigned, savePresignedUrls, startPresign, submitPresignOptions, confirmPresign } from "./presign_flow";
import { useToast } from "./toast";
import * as clipboard from "./clipboard";

vi.mock("./ops_api");
vi.mock("./clipboard");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = (name: string): PanelEntry => ({ name, isDir: false, size: 1, modified: 1 });
const dir = (name: string): PanelEntry => ({ name, isDir: true, size: 0, modified: null });
const dialog = () => useOpsStore.getState().dialog;
const SECRET_URL = "https://s3.example.test/alpha/in/a.txt?X-Amz-Signature=abc";

function setup(entries: PanelEntry[], cursor = 1) {
  useBrowseStore.setState({
    ...initialBrowseState(),
    profileId: "p1",
    active: "right",
    left: { ...emptyPanel(), source: { kind: "local" }, path: "/home/me", entries: [file("l.txt")], cursor: 1 },
    right: { ...emptyPanel(), source: { kind: "bucket", bucket: "alpha" }, path: "in/", entries, cursor },
  });
}

const report = (names: string[], extra: Partial<PresignReport> = {}): PresignReport => ({
  items: names.map((name) => ({ key: `in/${name}`, name, url: `https://s3.example.test/alpha/in/${name}?X-Amz-Signature=abc`, expires_at: 1800000000, error: null })),
  total: names.length,
  capped: false,
  ...extra,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(clipboard.copyText).mockResolvedValue(true);
  setup([file("a.txt"), file("b.txt"), dir("d")]);
  useOpsStore.getState().setDialog(null);
  useToast.setState({ message: "", ok: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<OpsDialogs />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (label: string) => Array.from(document.querySelectorAll("button, [role=radio]")).find((node) => node.textContent?.trim() === label) as HTMLElement;
const click = async (label: string) => {
  const target = button(label);
  expect(target, label).toBeTruthy();
  await act(async () => target.click());
};
const begin = () => act(async () => startPresign("right"));
const text = () => document.body.textContent ?? "";

describe("starting", async () => {
  it("opens the options dialog for the cursor file of a server panel", async () => {
    await begin();
    expect(dialog()).toMatchObject({ kind: "presign-options", bucket: "alpha", items: [{ key: "in/a.txt", is_dir: false }], hasFolder: false });
  });

  it("refuses a local panel, an empty selection and an open dialog", async () => {
    await act(async () => startPresign("left"));
    expect(dialog()).toMatchObject({ kind: "result", title: "Presigned URL" });
    useOpsStore.getState().setDialog(null);
    setup([file("a.txt")], 0);
    await begin();
    expect(dialog()).toMatchObject({ kind: "result" });
    useOpsStore.getState().setDialog({ kind: "busy", label: "x" });
    await begin();
    expect(dialog()).toMatchObject({ kind: "busy" });
  });
});

describe("options dialog", async () => {
  it("defaults to 1 hour and generates for a file straight away, then shows the result", async () => {
    vi.mocked(api.presignUrls).mockResolvedValue(report(["a.txt"]));
    await begin();
    await act(async () => void 0);
    expect(button("1 hour").getAttribute("aria-checked")).toBe("true");
    await click("Generate");
    expect(api.presignUrls).toHaveBeenCalledWith("p1", "alpha", [{ key: "in/a.txt", is_dir: false }], 3600, null);
    expect(api.presignPreview).not.toHaveBeenCalled();
    expect(dialog()).toMatchObject({ kind: "presign-result" });
  });

  it("a preset changes the expiry; a custom value uses its unit", async () => {
    vi.mocked(api.presignUrls).mockResolvedValue(report(["a.txt"]));
    await begin();
    await click("7 days");
    await click("Generate");
    expect(vi.mocked(api.presignUrls).mock.calls[0][3]).toBe(604800);

    useOpsStore.getState().setDialog(null);
    await begin();
    await click("Custom");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Custom expiry value"]')!;
    const unit = document.querySelector<HTMLSelectElement>('select[aria-label="Custom expiry unit"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(unit, "days");
      unit.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Generate");
    expect(vi.mocked(api.presignUrls).mock.calls[1][3]).toBe(172800);
  });

  it("a custom value out of range stays on the dialog with a message and calls nothing", async () => {
    await begin();
    await click("Custom");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Custom expiry value"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "8");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const unit = document.querySelector<HTMLSelectElement>('select[aria-label="Custom expiry unit"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(unit, "days");
      unit.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Generate");
    expect(text()).toContain("The longest expiry is 7 days.");
    expect(api.presignUrls).not.toHaveBeenCalled();
    expect(dialog()).toMatchObject({ kind: "presign-options" });
  });

  it("offers a download file name for a single file only, and sends it", async () => {
    vi.mocked(api.presignUrls).mockResolvedValue(report(["a.txt"]));
    await begin();
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Download file name"]')!;
    expect(name).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "report.txt");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Generate");
    expect(vi.mocked(api.presignUrls).mock.calls[0][4]).toBe("report.txt");

    useOpsStore.getState().setDialog(null);
    useBrowseStore.getState().toggleMark("right", "a.txt");
    useBrowseStore.getState().toggleMark("right", "b.txt");
    await begin();
    expect(document.querySelector('input[aria-label="Download file name"]')).toBeNull();
  });

  it("says the URL uses the profile endpoint and that holders can read the object", async () => {
    await begin();
    expect(text()).toContain("profile endpoint");
  });

  it("Esc cancels and Enter confirms", async () => {
    vi.mocked(api.presignUrls).mockResolvedValue(report(["a.txt"]));
    await begin();
    const box = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => void box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dialog()).toBeNull();
    await begin();
    const again = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => void again.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(api.presignUrls).toHaveBeenCalled();
  });
});

describe("folder expansion", async () => {
  beforeEach(() => useBrowseStore.getState().setCursor("right", 3));

  it("counts the objects first and asks to confirm before presigning", async () => {
    vi.mocked(api.presignPreview).mockResolvedValue({ object_count: 42, cap: 1000, capped: false });
    vi.mocked(api.presignUrls).mockResolvedValue(report(["d/x", "d/y"]));
    await begin();
    await click("Generate");
    expect(api.presignPreview).toHaveBeenCalledWith("p1", "alpha", [{ key: "in/d/", is_dir: true }]);
    expect(api.presignUrls).not.toHaveBeenCalled();
    expect(dialog()).toMatchObject({ kind: "presign-confirm", count: 42, capped: false });
    expect(text()).toContain("42 objects");
    await click("Generate 42 URLs");
    expect(api.presignUrls).toHaveBeenCalledWith("p1", "alpha", [{ key: "in/d/", is_dir: true }], 3600, null);
    expect(dialog()).toMatchObject({ kind: "presign-result" });
  });

  it("a capped selection says how many will be generated; cancelling runs nothing", async () => {
    vi.mocked(api.presignPreview).mockResolvedValue({ object_count: 5000, cap: 1000, capped: true });
    await begin();
    await click("Generate");
    expect(text()).toContain("5000 objects");
    expect(text()).toContain("only the first 1000");
    await click("Cancel");
    expect(dialog()).toBeNull();
    expect(api.presignUrls).not.toHaveBeenCalled();
  });

  it("an empty folder reports that there is nothing to presign", async () => {
    vi.mocked(api.presignPreview).mockResolvedValue({ object_count: 0, cap: 1000, capped: false });
    await begin();
    await click("Generate");
    expect(dialog()).toMatchObject({ kind: "result", title: "Presigned URL" });
    expect(text()).toContain("No objects");
  });

  it("a preview error is shown", async () => {
    vi.mocked(api.presignPreview).mockRejectedValue("access denied");
    await begin();
    await click("Generate");
    expect(text()).toContain("access denied");
  });
});

describe("result dialog", async () => {
  async function openResult(names: string[], extra: Partial<PresignReport> = {}) {
    vi.mocked(api.presignUrls).mockResolvedValue(report(names, extra));
    await begin();
    await act(async () => submitPresignOptions(3600, ""));
  }

  it("lists name, expiry and a Copy button per URL, with the warning", async () => {
    await openResult(["a.txt", "b.txt"]);
    expect(text()).toContain("a.txt");
    expect(text()).toContain("b.txt");
    expect(text()).toContain("Expires");
    expect(text()).toContain("anyone who has a URL");
    expect(Array.from(document.querySelectorAll("button")).filter((node) => node.textContent === "Copy")).toHaveLength(2);
  });

  it("Copy copies that URL; Copy all copies one URL per line", async () => {
    await openResult(["a.txt", "b.txt"]);
    await click("Copy all");
    expect(clipboard.copyText).toHaveBeenLastCalledWith("https://s3.example.test/alpha/in/a.txt?X-Amz-Signature=abc\nhttps://s3.example.test/alpha/in/b.txt?X-Amz-Signature=abc");
    await act(async () => Array.from(document.querySelectorAll("button")).filter((node) => node.textContent === "Copy")[1].click());
    expect(clipboard.copyText).toHaveBeenLastCalledWith("https://s3.example.test/alpha/in/b.txt?X-Amz-Signature=abc");
    expect(useToast.getState()).toMatchObject({ message: "Copied", ok: true });
  });

  it("a failed copy shows a failure toast", async () => {
    vi.mocked(clipboard.copyText).mockResolvedValue(false);
    await openResult(["a.txt"]);
    await act(async () => void copyPresigned("x"));
    expect(useToast.getState().ok).toBe(false);
    expect(useToast.getState().message).toContain("Copy failed");
  });

  it("a single file has no Copy all and no Save as text file", async () => {
    await openResult(["a.txt"]);
    expect(button("Copy all")).toBeUndefined();
    expect(button("Save as text file")).toBeUndefined();
  });

  it("many files: Save as text file warns about live URLs, picks a path and writes one URL per line", async () => {
    vi.mocked(api.chooseSavePath).mockResolvedValue("/home/me/urls.txt");
    vi.mocked(api.writeTextFile).mockResolvedValue(undefined);
    await openResult(["a.txt", "b.txt"]);
    expect(text()).toContain("live signed URLs");
    await click("Save as text file");
    expect(api.chooseSavePath).toHaveBeenCalledWith("presigned-urls.txt");
    expect(api.writeTextFile).toHaveBeenCalledWith("/home/me/urls.txt", "https://s3.example.test/alpha/in/a.txt?X-Amz-Signature=abc\nhttps://s3.example.test/alpha/in/b.txt?X-Amz-Signature=abc\n");
    expect(useToast.getState()).toMatchObject({ ok: true });
  });

  it("cancelling the save dialog writes nothing; a write error is a failure toast", async () => {
    vi.mocked(api.chooseSavePath).mockResolvedValue(null);
    await openResult(["a.txt", "b.txt"]);
    await act(async () => void (await savePresignedUrls()));
    expect(api.writeTextFile).not.toHaveBeenCalled();
    vi.mocked(api.chooseSavePath).mockResolvedValue("/home/me/urls.txt");
    vi.mocked(api.writeTextFile).mockRejectedValue("permission denied");
    await act(async () => void (await savePresignedUrls()));
    expect(useToast.getState()).toMatchObject({ ok: false });
    expect(useToast.getState().message).toContain("permission denied");
  });

  it("shows a per-item error without a Copy button, and the cap message", async () => {
    vi.mocked(api.presignUrls).mockResolvedValue({
      items: [
        { key: "in/a", name: "a", url: SECRET_URL, expires_at: 1800000000, error: null },
        { key: "in/b", name: "b", url: null, expires_at: null, error: "bucket and key are required" },
      ],
      total: 2500,
      capped: true,
    });
    await begin();
    await act(async () => submitPresignOptions(3600, ""));
    expect(text()).toContain("bucket and key are required");
    expect(text()).toContain("only the first 2");
    expect(Array.from(document.querySelectorAll("button")).filter((node) => node.textContent === "Copy")).toHaveLength(1);
  });

  it("closing the dialog drops the URLs from the store and the page", async () => {
    await openResult(["a.txt", "b.txt"]);
    expect(JSON.stringify(dialog())).toContain("X-Amz-Signature");
    await click("Close");
    expect(dialog()).toBeNull();
    expect(JSON.stringify(useOpsStore.getState())).not.toContain("X-Amz-Signature");
    expect(JSON.stringify(useBrowseStore.getState())).not.toContain("X-Amz-Signature");
    expect(document.body.textContent).not.toContain("X-Amz-Signature");
  });

  it("unmounting the dialogs (lock) also drops the URLs", async () => {
    await openResult(["a.txt"]);
    act(() => root.unmount());
    expect(dialog()).toBeNull();
    root = createRoot(host);
  });

  it("a backend error is shown as an error dialog without any URL", async () => {
    vi.mocked(api.presignUrls).mockRejectedValue("expiry cannot be more than 7 days");
    await begin();
    await act(async () => submitPresignOptions(999999999, ""));
    expect(dialog()).toMatchObject({ kind: "result", title: "Presigned URL" });
    expect(text()).toContain("expiry cannot be more than 7 days");
  });

  it("never writes URLs to localStorage", async () => {
    await openResult(["a.txt", "b.txt"]);
    await click("Copy all");
    expect(JSON.stringify({ ...localStorage })).not.toContain("X-Amz-Signature");
  });
});

describe("confirmPresign without a dialog", async () => {
  it("does nothing", async () => {
    await confirmPresign();
    expect(api.presignUrls).not.toHaveBeenCalled();
  });
});
