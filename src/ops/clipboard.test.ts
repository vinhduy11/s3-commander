// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

const setClipboard = (writeText?: (text: string) => Promise<void>) =>
  Object.defineProperty(navigator, "clipboard", { value: writeText ? { writeText } : undefined, configurable: true });
const setExecCommand = (impl: () => boolean) => Object.defineProperty(document, "execCommand", { value: vi.fn(impl), configurable: true });

afterEach(() => {
  setClipboard(undefined);
  document.body.innerHTML = "";
});

describe("copyText", () => {
  it("uses navigator.clipboard.writeText when it works", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to select + execCommand('copy') when the clipboard API is missing", async () => {
    setClipboard(undefined);
    let copied = "";
    setExecCommand(() => {
      copied = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    });
    expect(await copyText("line1\nline2")).toBe(true);
    expect(copied).toBe("line1\nline2");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when writeText rejects, and reports failure when both fail", async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    setExecCommand(() => true);
    expect(await copyText("x")).toBe(true);
    setExecCommand(() => false);
    expect(await copyText("x")).toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });
});
