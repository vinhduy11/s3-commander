import { describe, expect, it } from "vitest";
import { fileKind, lineEndingOf, copyName } from "./text_kind";

describe("fileKind", () => {
  it("maps extensions to the editor flavour, case-insensitively", () => {
    expect(fileKind("a.json")).toBe("json");
    expect(fileKind("A.JSON")).toBe("json");
    expect(fileKind("a.csv")).toBe("csv");
    expect(fileKind("a.tsv")).toBe("csv");
    for (const name of ["a.txt", "a.md", "a.log", "a.ini", "a.conf", "a.yaml", "a.yml", "a.xml", "Makefile", ".env", "noext"]) {
      expect(fileKind(name), name).toBe("text");
    }
  });
});

describe("lineEndingOf", () => {
  it("is CRLF only when every line break is CRLF, otherwise LF", () => {
    expect(lineEndingOf("a\r\nb\r\n")).toBe("\r\n");
    expect(lineEndingOf("a\nb\n")).toBe("\n");
    expect(lineEndingOf("a\r\nb\nc")).toBe("\n");
    expect(lineEndingOf("single line")).toBe("\n");
    expect(lineEndingOf("")).toBe("\n");
  });
});

describe("copyName", () => {
  it("inserts (copy) before the extension", () => {
    expect(copyName("a.txt")).toBe("a (copy).txt");
    expect(copyName("noext")).toBe("noext (copy)");
    expect(copyName(".env")).toBe(".env (copy)");
    expect(copyName("a.tar.gz")).toBe("a.tar (copy).gz");
  });
});
