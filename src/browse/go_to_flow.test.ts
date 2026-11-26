// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "./browse_store";

vi.mock("./browse_api", () => ({ listLocalDir: vi.fn(), listBucketDir: vi.fn(), homeDir: vi.fn() }));
import { homeDir, listBucketDir, listLocalDir } from "./browse_api";
import { goToLocation, recentsFor } from "./go_to_flow";
import { RECENT_CAP, resetMemoryCache } from "./location_memory";

const store = () => useBrowseStore.getState();
const dir = (name: string): PanelEntry => ({ name, isDir: true, size: 0, modified: null });
const listing = (path: string, names: string[] = []) => ({ path, entries: names.map(dir) });
const emptyPage = { entries: [], nextToken: null };

function setup() {
  localStorage.clear();
  resetMemoryCache();
  vi.mocked(listLocalDir).mockReset();
  vi.mocked(listBucketDir).mockReset();
  vi.mocked(homeDir).mockReset().mockResolvedValue("/Users/me");
  useBrowseStore.setState({
    ...initialBrowseState(),
    profileId: "p1",
    buckets: ["alpha", "beta"],
    left: { ...emptyPanel(), source: { kind: "local" }, path: "/Users/me/docs", entries: [dir("old")], cursor: 1, marked: { old: true }, anchor: "old" },
    right: { ...emptyPanel(), source: { kind: "bucket", bucket: "alpha" }, path: "in/", entries: [dir("old")] },
  });
}
beforeEach(setup);

describe("goToLocation, local panel", () => {
  it("lists the parsed absolute path through the loader and resets marks and anchor", async () => {
    vi.mocked(listLocalDir).mockResolvedValue(listing("/Users/me/x", ["a"]));
    expect(await goToLocation("left", "/Users/me/x/")).toBe("");
    expect(listLocalDir).toHaveBeenCalledWith("/Users/me/x");
    expect(store().left.path).toBe("/Users/me/x");
    expect(store().left.marked).toEqual({});
    expect(store().left.anchor).toBeNull();
    expect(store().left.error).toBe("");
  });

  it("expands ~ with the home directory from Rust", async () => {
    vi.mocked(listLocalDir).mockResolvedValue(listing("/Users/me/x"));
    await goToLocation("left", "~/x");
    expect(listLocalDir).toHaveBeenCalledWith("/Users/me/x");
  });

  it("a relative path is resolved against the current folder", async () => {
    vi.mocked(listLocalDir).mockResolvedValue(listing("/Users/me/sub"));
    await goToLocation("left", "../sub");
    expect(listLocalDir).toHaveBeenCalledWith("/Users/me/sub");
  });

  it("a folder that cannot be listed keeps the old location and rows, returns the error, leaves the footer clean", async () => {
    vi.mocked(listLocalDir).mockRejectedValue("not found: /nope");
    expect(await goToLocation("left", "/nope")).toBe("not found: /nope");
    expect(store().left.path).toBe("/Users/me/docs");
    expect(store().left.entries.map((entry) => entry.name)).toEqual(["old"]);
    expect(store().left.error).toBe("");
    expect(store().left.loading).toBe(false);
    expect(recentsFor("left")).toEqual([]);
  });

  it("a parse error is returned without any listing", async () => {
    expect(await goToLocation("left", "   ")).toMatch(/type a path/i);
    expect(listLocalDir).not.toHaveBeenCalled();
  });

  it("records the resolved path as a recent location", async () => {
    vi.mocked(listLocalDir).mockResolvedValue(listing("/real/target"));
    await goToLocation("left", "/link");
    expect(recentsFor("left")).toEqual(["/real/target"]);
  });
});

describe("goToLocation, server panel", () => {
  it("a prefix in the current bucket lists with the right arguments", async () => {
    vi.mocked(listBucketDir).mockResolvedValue(emptyPage);
    expect(await goToLocation("right", "/a/b")).toBe("");
    expect(listBucketDir).toHaveBeenCalledWith("p1", "alpha", "a/b/", null);
    expect(store().right.path).toBe("a/b/");
  });

  it("an empty prefix is just an empty listing, not an error", async () => {
    vi.mocked(listBucketDir).mockResolvedValue(emptyPage);
    expect(await goToLocation("right", "nothing-here/")).toBe("");
    expect(store().right.entries).toEqual([]);
  });

  it("s3://other/p switches the bucket of the panel", async () => {
    vi.mocked(listBucketDir).mockResolvedValue(emptyPage);
    await goToLocation("right", "s3://beta/p");
    expect(listBucketDir).toHaveBeenCalledWith("p1", "beta", "p/", null);
    expect(store().right.source).toEqual({ kind: "bucket", bucket: "beta" });
    expect(store().right.path).toBe("p/");
    expect(recentsFor("right")).toEqual(["s3://beta/p/"]);
  });

  it("a failed bucket switch restores the previous source, path and rows", async () => {
    vi.mocked(listBucketDir).mockRejectedValue("access denied: beta");
    expect(await goToLocation("right", "s3://beta/p")).toBe("access denied: beta");
    expect(store().right.source).toEqual({ kind: "bucket", bucket: "alpha" });
    expect(store().right.path).toBe("in/");
    expect(store().right.entries.map((entry) => entry.name)).toEqual(["old"]);
    expect(store().right.error).toBe("");
  });

  it("a bucket missing from the list is an inline error and nothing is listed", async () => {
    expect(await goToLocation("right", "s3://gamma")).toMatch(/gamma/);
    expect(listBucketDir).not.toHaveBeenCalled();
  });
});

describe("goToLocation, kind switches", () => {
  it("s3:// typed in the local panel switches it to the server with a notice", async () => {
    vi.mocked(listBucketDir).mockResolvedValue(emptyPage);
    expect(await goToLocation("left", "s3://alpha/z")).toBe("");
    expect(store().left.source).toEqual({ kind: "bucket", bucket: "alpha" });
    expect(store().left.path).toBe("z/");
    expect(store().left.notice).toMatch(/server/i);
  });

  it("~ typed in a server panel switches it to Local with a notice", async () => {
    vi.mocked(listLocalDir).mockResolvedValue(listing("/Users/me"));
    expect(await goToLocation("right", "~")).toBe("");
    expect(store().right.source).toEqual({ kind: "local" });
    expect(store().right.path).toBe("/Users/me");
    expect(store().right.notice).toMatch(/local/i);
  });

  it("s3:// with no active profile is an inline error and the local panel stays", async () => {
    useBrowseStore.setState({ profileId: null, buckets: [] });
    expect(await goToLocation("left", "s3://alpha")).toMatch(/profile/i);
    expect(store().left.source).toEqual({ kind: "local" });
  });

  it("a failed switch to Local puts the server panel back", async () => {
    vi.mocked(listLocalDir).mockRejectedValue("not found: /Users/me/zz");
    expect(await goToLocation("right", "~/zz")).toMatch(/not found/);
    expect(store().right.source).toEqual({ kind: "bucket", bucket: "alpha" });
    expect(store().right.path).toBe("in/");
  });
});

describe("recents", () => {
  it("are newest first and capped at 20", async () => {
    vi.mocked(listLocalDir).mockImplementation(async (path) => listing(path));
    for (let idx = 0; idx < 25; idx++) await goToLocation("left", `/p${idx}`);
    const recents = recentsFor("left");
    expect(recents).toHaveLength(RECENT_CAP);
    expect(recents[0]).toBe("/p24");
    expect(recents[RECENT_CAP - 1]).toBe("/p5");
  });

  it("are shared by both panels of the same kind", async () => {
    vi.mocked(listLocalDir).mockImplementation(async (path) => listing(path));
    await goToLocation("left", "/one");
    await goToLocation("right", "~/two"); // the right panel is a server panel: this switches it to Local
    expect(recentsFor("left")).toEqual(["/Users/me/two", "/one"]);
    expect(recentsFor("right")).toEqual(recentsFor("left"));
  });

  it("a server panel has its own list", async () => {
    vi.mocked(listLocalDir).mockResolvedValue(listing("/l"));
    vi.mocked(listBucketDir).mockResolvedValue(emptyPage);
    await goToLocation("left", "/l");
    await goToLocation("right", "/s");
    expect(recentsFor("left")).toEqual(["/l"]);
    expect(recentsFor("right")).toEqual(["s3://alpha/s/"]);
  });

  it("a repeated visit moves to the top without a duplicate", async () => {
    vi.mocked(listLocalDir).mockImplementation(async (path) => listing(path));
    await goToLocation("left", "/a");
    await goToLocation("left", "/b");
    await goToLocation("left", "/a");
    expect(recentsFor("left")).toEqual(["/a", "/b"]);
  });
});
