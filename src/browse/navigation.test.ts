import { describe, expect, it } from "vitest";
import { buildRows, childPath, parentOf, splitName, formatSize } from "./navigation";
import type { PanelSource } from "./browse_store";

const local: PanelSource = { kind: "local" };
const bucket: PanelSource = { kind: "bucket", bucket: "b" };

describe("paths", () => {
  it("builds child paths for local and bucket", () => {
    expect(childPath(local, "/home", "docs")).toBe("/home/docs");
    expect(childPath(local, "/", "etc")).toBe("/etc");
    expect(childPath(bucket, "", "a")).toBe("a/");
    expect(childPath(bucket, "a/", "b")).toBe("a/b/");
  });

  it("finds the parent and the name to focus after going up", () => {
    expect(parentOf(local, "/home/docs")).toEqual({ path: "/home", focusName: "docs" });
    expect(parentOf(local, "/home")).toEqual({ path: "/", focusName: "home" });
    expect(parentOf(local, "/")).toBeNull();
    expect(parentOf(bucket, "a/b/")).toEqual({ path: "a/", focusName: "b" });
    expect(parentOf(bucket, "a/")).toEqual({ path: "", focusName: "a" });
    expect(parentOf(bucket, "")).toBeNull();
  });
});

describe("rows", () => {
  const entries = [{ name: "d", isDir: true, size: 0, modified: null }];
  it("adds a .. row only below the root", () => {
    expect(buildRows(local, "/x", entries)[0].isUp).toBe(true);
    expect(buildRows(local, "/", entries)[0].name).toBe("d");
    expect(buildRows(bucket, "", entries)).toHaveLength(1);
  });
});

describe("display helpers", () => {
  it("splits name and extension", () => {
    expect(splitName("a.tar.gz")).toEqual({ base: "a.tar", ext: "gz" });
    expect(splitName(".hidden")).toEqual({ base: ".hidden", ext: "" });
    expect(splitName("README")).toEqual({ base: "README", ext: "" });
  });
  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
