import { describe, expect, it } from "vitest";
import { EXPIRY_PRESETS, MAX_EXPIRY_SECS, DEFAULT_EXPIRY_SECS, expiryChoice, joinUrls, parseExpiry } from "./presign_logic";

describe("parseExpiry", () => {
  it("converts a value and a unit to seconds", () => {
    expect(parseExpiry("90", "minutes")).toEqual({ secs: 5400 });
    expect(parseExpiry("2", "hours")).toEqual({ secs: 7200 });
    expect(parseExpiry("3", "days")).toEqual({ secs: 259200 });
    expect(parseExpiry(" 45 ", "seconds")).toEqual({ secs: 45 });
  });

  it("accepts the bounds: 1 second and exactly 7 days", () => {
    expect(parseExpiry("1", "seconds")).toEqual({ secs: 1 });
    expect(parseExpiry("7", "days")).toEqual({ secs: MAX_EXPIRY_SECS });
    expect(parseExpiry("604800", "seconds")).toEqual({ secs: 604800 });
  });

  it("rejects zero, anything over 7 days, and non-integers with a readable message", () => {
    for (const [text, unit] of [["0", "seconds"], ["604801", "seconds"], ["8", "days"], ["169", "hours"], ["1.5", "hours"], ["-1", "hours"], ["", "hours"], ["abc", "days"], ["1e3", "seconds"]] as const) {
      const result = parseExpiry(text, unit);
      expect(result, `${text} ${unit}`).toHaveProperty("error");
      expect((result as { error: string }).error.length).toBeGreaterThan(5);
    }
    expect(parseExpiry("0", "seconds")).toEqual({ error: "Enter a whole number of at least 1." });
    expect(parseExpiry("8", "days")).toEqual({ error: "The longest expiry is 7 days." });
  });
});

describe("presets", () => {
  it("are 15 minutes, 1 hour, 1 day and 7 days, defaulting to 1 hour", () => {
    expect(EXPIRY_PRESETS.map((preset) => [preset.label, preset.secs])).toEqual([
      ["15 minutes", 900],
      ["1 hour", 3600],
      ["1 day", 86400],
      ["7 days", 604800],
    ]);
    expect(DEFAULT_EXPIRY_SECS).toBe(3600);
  });

  it("expiryChoice picks a preset or the custom entry", () => {
    expect(expiryChoice("86400", "seconds", "custom")).toEqual({ secs: 86400 });
    expect(expiryChoice("", "hours", "900")).toEqual({ secs: 900 });
    expect(expiryChoice("2", "hours", "custom")).toEqual({ secs: 7200 });
    expect(expiryChoice("0", "hours", "custom")).toHaveProperty("error");
  });
});

describe("joinUrls", () => {
  it("is one URL per line, skipping failed items", () => {
    const items = [
      { key: "a", name: "a", url: "https://x/a", expires_at: 1, error: null },
      { key: "b", name: "b", url: null, expires_at: null, error: "boom" },
      { key: "c", name: "c", url: "https://x/c", expires_at: 1, error: null },
    ];
    expect(joinUrls(items)).toBe("https://x/a\nhttps://x/c");
  });
});
