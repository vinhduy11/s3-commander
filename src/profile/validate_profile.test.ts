import { describe, expect, it } from "vitest";
import table from "./validation_cases.json";
import { validateProfile } from "./validate_profile";

describe("shared validation cases (same table as the Rust tests)", () => {
  for (const c of table.cases) {
    it(c.label, () => {
      const result = validateProfile(c.input, c.others, c.isNew);
      expect(Object.keys(result.errors).sort()).toEqual([...c.errors].sort());
      const normalized = c.normalized as Record<string, string> | undefined;
      for (const [key, value] of Object.entries(normalized ?? {})) {
        expect(result.clean[key as keyof typeof result.clean]).toBe(value);
      }
    });
  }
});

const base = { name: "Dev", endpoint: "http://localhost:9000", access_key: "ak", secret_key: "sk-value", region: "" };

describe("http warning", () => {
  it("is shown for a valid http endpoint", () => {
    expect(validateProfile(base, [], true).warnings.endpoint).toMatch(/unencrypted/i);
  });
  it("is not shown for https", () => {
    expect(validateProfile({ ...base, endpoint: "https://minio.example.com" }, [], true).warnings.endpoint).toBeUndefined();
  });
  it("is not shown while the endpoint is invalid", () => {
    expect(validateProfile({ ...base, endpoint: "http://a b" }, [], true).warnings.endpoint).toBeUndefined();
  });
});

describe("messages", () => {
  it("never contain the secret", () => {
    const secret = "s3cr3t\nvalue";
    const r = validateProfile({ ...base, secret_key: secret, endpoint: `http://u:${secret}@h` }, [], true);
    expect(JSON.stringify(r.errors)).not.toContain("s3cr3t");
  });
});
