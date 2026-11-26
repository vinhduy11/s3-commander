import { describe, expect, it } from "vitest";
import { parseLocation, type LocationContext } from "./parse_location";

const HOME = "/Users/me";
const local = (path = "/Users/me/docs", extra: Partial<LocationContext> = {}): LocationContext =>
  ({ source: { kind: "local" }, path, home: HOME, buckets: ["alpha", "beta"], hasProfile: true, ...extra });
const server = (prefix = "in/deep/", extra: Partial<LocationContext> = {}): LocationContext =>
  ({ source: { kind: "bucket", bucket: "alpha" }, path: prefix, home: HOME, buckets: ["alpha", "beta"], hasProfile: true, ...extra });

const LOCAL = { kind: "local" } as const;
const bucket = (name: string) => ({ kind: "bucket", bucket: name }) as const;
const ok = (source: object, path: string, switched = false) => ({ ok: true, target: { source, path }, switched });

describe("parseLocation, local panel", () => {
  it.each([
    ["/Users/me/x", "/Users/me/x"],
    ["/Users/me/x/", "/Users/me/x"],
    ["/", "/"],
    ["//a///b//", "/a/b"],
    ["~", "/Users/me"],
    ["~/", "/Users/me"],
    ["~/x/y", "/Users/me/x/y"],
    ["~/x/../y", "/Users/me/y"],
    ["sub", "/Users/me/docs/sub"],
    ["./sub", "/Users/me/docs/sub"],
    ["../x", "/Users/me/x"],
    ["../../..", "/"],
    ["../../../../../etc", "/etc"],
    [".", "/Users/me/docs"],
    ["..", "/Users/me"],
    ["/a/./b/../c", "/a/c"],
    ["/../..", "/"],
    ["  /Users/me/x  ", "/Users/me/x"],
    ['"/Users/me/with space"', "/Users/me/with space"],
    ["'/Users/me/q'", "/Users/me/q"],
    [' " /Users/me/x " ', "/Users/me/x"],
    ["file:///Users/me/x", "/Users/me/x"],
    ["file:///Users/me/a%20b/", "/Users/me/a b"],
    ["file:///", "/"],
    ["file:///Users/me/bad%zz", "/Users/me/bad%zz"],
    ["~other", "/Users/me/docs/~other"],
  ])("%j -> %s", (input, path) => {
    expect(parseLocation(input, local())).toEqual(ok(LOCAL, path));
  });

  it("resolves a relative path from the home directory when the current folder is unknown", () => {
    expect(parseLocation("x", local(""))).toEqual(ok(LOCAL, "/Users/me/x"));
    expect(parseLocation("x", local("", { home: "" }))).toEqual(ok(LOCAL, "/x"));
  });

  it.each([
    ["", /type a path/i],
    ["   ", /type a path/i],
    ['""', /type a path/i],
    ["a\0b", /invalid/i],
    ["file://host/x", /file:\/\/\//],
  ])("rejects %j", (input, message) => {
    const result = parseLocation(input, local());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(message);
  });

  it("rejects ~ when the home directory is unknown", () => {
    const result = parseLocation("~/x", local("/a", { home: "" }));
    expect(!result.ok && result.error).toMatch(/home directory/i);
  });

  it("treats a panel without a source as local", () => {
    expect(parseLocation("/x", local("", { source: null }))).toEqual(ok(LOCAL, "/x"));
  });
});

describe("parseLocation, server panel", () => {
  it.each([
    ["s3://alpha", "alpha", ""],
    ["s3://alpha/", "alpha", ""],
    ["s3://beta/p/q", "beta", "p/q/"],
    ["s3://beta/p/q/", "beta", "p/q/"],
    ["s3://beta//p///q//", "beta", "p/q/"],
    ["s3://beta/p/../q/./r", "beta", "q/r/"],
    ["s3://beta/../..", "beta", ""],
    ['  "s3://beta/p"  ', "beta", "p/"],
  ])("%j -> bucket %s prefix %j", (input, name, prefix) => {
    expect(parseLocation(input, server())).toEqual(ok(bucket(name), prefix, false));
  });

  it.each([
    ["/", ""],
    ["/x", "x/"],
    ["/x/y/", "x/y/"],
    ["/x/../..", ""],
    ["sub", "in/deep/sub/"],
    ["sub/", "in/deep/sub/"],
    ["./sub/", "in/deep/sub/"],
    ["../x/", "in/x/"],
    ["../../x", "x/"],
    ["../../../..", ""],
    [".", "in/deep/"],
    ["..", "in/"],
    ["  sub  ", "in/deep/sub/"],
  ])("%j -> prefix %j in the current bucket", (input, prefix) => {
    expect(parseLocation(input, server())).toEqual(ok(bucket("alpha"), prefix));
  });

  it("relative to the bucket root", () => {
    expect(parseLocation("a/b", server(""))).toEqual(ok(bucket("alpha"), "a/b/"));
    expect(parseLocation("..", server(""))).toEqual(ok(bucket("alpha"), ""));
  });

  it("a bucket that is not in the list is an error naming it", () => {
    const result = parseLocation("s3://gamma/x", server());
    expect(!result.ok && result.error).toMatch(/gamma/);
  });

  it.each([["s3://"], ["s3:///x"]])("%j has no bucket name", (input) => {
    const result = parseLocation(input, server());
    expect(!result.ok && result.error).toMatch(/bucket/i);
  });

  it("an object key with spaces is kept as typed", () => {
    expect(parseLocation("my folder/", server(""))).toEqual(ok(bucket("alpha"), "my folder/"));
  });
});

describe("parseLocation, kind switches", () => {
  it("s3:// in a local panel switches to the server and says so", () => {
    expect(parseLocation("s3://beta/p", local())).toEqual(ok(bucket("beta"), "p/", true));
  });

  it("s3:// in a local panel needs an active profile", () => {
    const result = parseLocation("s3://beta", local("/a", { hasProfile: false, buckets: [] }));
    expect(!result.ok && result.error).toMatch(/profile/i);
  });

  it("s3:// to the same bucket in a server panel is not a switch; to another bucket it is not either", () => {
    expect(parseLocation("s3://alpha/z", server())).toEqual(ok(bucket("alpha"), "z/", false));
    expect(parseLocation("s3://beta/z", server())).toEqual(ok(bucket("beta"), "z/", false));
  });

  it("~ and file:// in a server panel switch to Local", () => {
    expect(parseLocation("~", server())).toEqual(ok(LOCAL, "/Users/me", true));
    expect(parseLocation("~/x/", server())).toEqual(ok(LOCAL, "/Users/me/x", true));
    expect(parseLocation("file:///tmp/x", server())).toEqual(ok(LOCAL, "/tmp/x", true));
  });

  it("~ in a server panel without a known home is an error", () => {
    const result = parseLocation("~", server("", { home: "" }));
    expect(!result.ok && result.error).toMatch(/home directory/i);
  });

  it("a kind switch error does not claim a switch", () => {
    expect(parseLocation("s3://nope", local()).ok).toBe(false);
  });
});
