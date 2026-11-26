// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "./browse_store";

vi.mock("./browse_api", () => ({ listLocalDir: vi.fn(), listBucketDir: vi.fn(), homeDir: vi.fn() }));
import { listBucketDir, listLocalDir } from "./browse_api";
import { LOCATION_KEY, SAVE_DELAY_MS, memory, parseMemory, resetMemoryCache, updateMemory } from "./location_memory";
import { installLocationSave, restoreLocalPanels, restoreServerPanels, snapshotLocations } from "./last_location";

const store = () => useBrowseStore.getState();
const dir = (name: string): PanelEntry => ({ name, isDir: true, size: 0, modified: null });
const okLocal = (path: string) => ({ path, entries: [dir("x")] });
const page = { entries: [dir("x")], nextToken: null };
const stored = () => parseMemory(localStorage.getItem(LOCATION_KEY));

beforeEach(() => {
  localStorage.clear();
  resetMemoryCache();
  vi.mocked(listLocalDir).mockReset();
  vi.mocked(listBucketDir).mockReset().mockResolvedValue(page);
  useBrowseStore.setState({ ...initialBrowseState(), profileId: null, buckets: [] });
});
afterEach(() => vi.useRealTimers());

const remember = (value: Parameters<typeof updateMemory>[0] extends (current: infer M) => unknown ? Partial<M> : never) =>
  updateMemory((current) => ({ ...current, ...value }));

describe("snapshotLocations", () => {
  const listed = (extra = {}) => ({ ...emptyPanel(), ...extra });
  it("records a listed local panel and a listed server panel under the profile", () => {
    useBrowseStore.setState({
      profileId: "p1", active: "right",
      left: listed({ source: { kind: "local" }, path: "/a" }),
      right: listed({ source: { kind: "bucket", bucket: "alpha" }, path: "x/" }),
    });
    const next = snapshotLocations(store(), memory());
    expect(next.active).toBe("right");
    expect(next.kinds).toEqual({ left: "local", right: "server" });
    expect(next.local).toEqual({ left: "/a" });
    expect(next.servers).toEqual({ p1: { right: { bucket: "alpha", prefix: "x/" } } });
  });

  it("keeps the previous value for a panel that is loading, empty, or has no source", () => {
    remember({ local: { left: "/old" }, kinds: { left: "local" } });
    useBrowseStore.setState({ left: listed({ source: { kind: "local" }, path: "/new", loading: true }) });
    expect(snapshotLocations(store(), memory()).local.left).toBe("/old");
    useBrowseStore.setState({ left: listed({ source: { kind: "local" }, path: "" }) });
    expect(snapshotLocations(store(), memory()).local.left).toBe("/old");
    useBrowseStore.setState({ left: listed() });
    expect(snapshotLocations(store(), memory()).local.left).toBe("/old");
  });

  it("does not record a server location without a profile", () => {
    useBrowseStore.setState({ right: listed({ source: { kind: "bucket", bucket: "alpha" }, path: "x/" }) });
    expect(snapshotLocations(store(), memory()).servers).toEqual({});
  });

  it("another profile's location is left untouched", () => {
    remember({ servers: { p2: { left: { bucket: "b", prefix: "" } } } });
    useBrowseStore.setState({ profileId: "p1", right: listed({ source: { kind: "bucket", bucket: "alpha" }, path: "" }) });
    const next = snapshotLocations(store(), memory());
    expect(next.servers.p2).toEqual({ left: { bucket: "b", prefix: "" } });
    expect(next.servers.p1).toEqual({ right: { bucket: "alpha", prefix: "" } });
  });
});

describe("installLocationSave", () => {
  it("saves after navigation, debounced, and stops on the returned function", () => {
    vi.useFakeTimers();
    const stop = installLocationSave();
    useBrowseStore.setState({ left: { ...emptyPanel(), source: { kind: "local" }, path: "/a" } });
    useBrowseStore.setState({ left: { ...emptyPanel(), source: { kind: "local" }, path: "/b" } });
    expect(localStorage.getItem(LOCATION_KEY)).toBeNull();
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(stored().local.left).toBe("/b");
    stop();
    useBrowseStore.setState({ left: { ...emptyPanel(), source: { kind: "local" }, path: "/c" } });
    vi.advanceTimersByTime(SAVE_DELAY_MS * 2);
    expect(stored().local.left).toBe("/b");
  });

  it("stop flushes a pending save", () => {
    vi.useFakeTimers();
    const stop = installLocationSave();
    useBrowseStore.setState({ left: { ...emptyPanel(), source: { kind: "local" }, path: "/z" } });
    stop();
    expect(stored().local.left).toBe("/z");
  });

  it("saves the active panel", () => {
    vi.useFakeTimers();
    installLocationSave();
    useBrowseStore.setState({ active: "right", left: { ...emptyPanel(), source: { kind: "local" }, path: "/a" } });
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(stored().active).toBe("right");
  });

  it("writes nothing for a locked store (no profile, no panels)", () => {
    vi.useFakeTimers();
    installLocationSave();
    useBrowseStore.setState({ profileId: null });
    vi.advanceTimersByTime(SAVE_DELAY_MS * 2);
    expect(stored().servers).toEqual({});
  });
});

describe("restoreLocalPanels", () => {
  it("first run: the left panel opens the home directory (empty path), the right stays empty, as before", async () => {
    vi.mocked(listLocalDir).mockResolvedValue(okLocal("/Users/me"));
    await restoreLocalPanels();
    expect(listLocalDir).toHaveBeenCalledTimes(1);
    expect(listLocalDir).toHaveBeenCalledWith("");
    expect(store().left.source).toEqual({ kind: "local" });
    expect(store().right.source).toBeNull();
    expect(store().active).toBe("left");
  });

  it("opens the remembered folder of each local side and the active panel", async () => {
    remember({ active: "right", kinds: { left: "local", right: "local" }, local: { left: "/a", right: "/b" } });
    vi.mocked(listLocalDir).mockImplementation(async (path) => okLocal(path));
    await restoreLocalPanels();
    expect(store().left.path).toBe("/a");
    expect(store().right.path).toBe("/b");
    expect(store().active).toBe("right");
  });

  it("a vanished folder falls back to its nearest existing parent with the notice", async () => {
    remember({ kinds: { left: "local" }, local: { left: "/a/gone/deeper" } });
    vi.mocked(listLocalDir).mockImplementation(async (path) => {
      if (path === "/a") return okLocal("/a");
      throw "not found";
    });
    await restoreLocalPanels();
    expect(store().left.path).toBe("/a");
    expect(store().left.notice).toMatch(/\/a/);
    expect(store().left.error).toBe("");
  });

  it("when nothing lists, it falls back to the home directory", async () => {
    remember({ kinds: { left: "local" }, local: { left: "/gone" } });
    vi.mocked(listLocalDir).mockImplementation(async (path) => {
      if (path === "") return okLocal("/Users/me");
      throw "not found";
    });
    await restoreLocalPanels();
    expect(store().left.path).toBe("/Users/me");
  });

  it("a left panel remembered as server does not open Local; it waits for the buckets", async () => {
    remember({ kinds: { left: "server" } });
    await restoreLocalPanels();
    expect(listLocalDir).not.toHaveBeenCalled();
    expect(store().left.source).toBeNull();
  });

  it("does not touch a panel that already has state", async () => {
    remember({ kinds: { left: "local" }, local: { left: "/a" } });
    useBrowseStore.setState({ left: { ...emptyPanel(), source: { kind: "local" }, path: "/kept" } });
    await restoreLocalPanels();
    expect(listLocalDir).not.toHaveBeenCalled();
    expect(store().left.path).toBe("/kept");
  });

  it("garbage in storage behaves as a first run", async () => {
    localStorage.setItem(LOCATION_KEY, "{{{");
    resetMemoryCache();
    vi.mocked(listLocalDir).mockResolvedValue(okLocal("/Users/me"));
    await restoreLocalPanels();
    expect(listLocalDir).toHaveBeenCalledWith("");
  });
});

describe("restoreServerPanels", () => {
  const names = ["alpha", "beta"];
  beforeEach(() => useBrowseStore.setState({ profileId: "p1", buckets: names }));

  it("first run: the right panel opens the first bucket root, the left stays as it is", async () => {
    await restoreServerPanels("p1", names);
    expect(listBucketDir).toHaveBeenCalledTimes(1);
    expect(listBucketDir).toHaveBeenCalledWith("p1", "alpha", "", null);
    expect(store().right.source).toEqual({ kind: "bucket", bucket: "alpha" });
    expect(store().left.source).toBeNull();
  });

  it("restores the remembered bucket and prefix of this profile", async () => {
    remember({ kinds: { right: "server" }, servers: { p1: { right: { bucket: "beta", prefix: "a/b/" } }, p2: { right: { bucket: "alpha", prefix: "zzz/" } } } });
    await restoreServerPanels("p1", names);
    expect(listBucketDir).toHaveBeenCalledWith("p1", "beta", "a/b/", null);
    expect(store().right.path).toBe("a/b/");
  });

  it("a profile switch restores the other profile's location", async () => {
    remember({ kinds: { right: "server" }, servers: { p1: { right: { bucket: "beta", prefix: "one/" } }, p2: { right: { bucket: "alpha", prefix: "two/" } } } });
    await restoreServerPanels("p1", names);
    useBrowseStore.getState().setProfile("p2");
    await restoreServerPanels("p2", names);
    expect(store().right.source).toEqual({ kind: "bucket", bucket: "alpha" });
    expect(store().right.path).toBe("two/");
  });

  it("a remembered bucket that no longer exists falls back to the first bucket root", async () => {
    remember({ kinds: { right: "server" }, servers: { p1: { right: { bucket: "gone", prefix: "x/" } } } });
    await restoreServerPanels("p1", names);
    expect(listBucketDir).toHaveBeenCalledWith("p1", "alpha", "", null);
  });

  it("a prefix that cannot be listed falls back to the bucket root", async () => {
    remember({ kinds: { right: "server" }, servers: { p1: { right: { bucket: "beta", prefix: "bad/" } } } });
    vi.mocked(listBucketDir).mockImplementation(async (_profile, _bucket, prefix) => {
      if (prefix === "bad/") throw "denied";
      return page;
    });
    await restoreServerPanels("p1", names);
    expect(store().right.source).toEqual({ kind: "bucket", bucket: "beta" });
    expect(store().right.path).toBe("");
    expect(store().right.error).toBe("");
  });

  it("a left panel remembered as server with a missing bucket opens Local home instead of staying blank", async () => {
    remember({ kinds: { left: "server" }, servers: { p1: { left: { bucket: "gone", prefix: "" } } } });
    vi.mocked(listLocalDir).mockResolvedValue(okLocal("/Users/me"));
    await restoreServerPanels("p1", names);
    expect(store().left.source).toEqual({ kind: "local" });
  });

  it("does not replace a panel that already has a source", async () => {
    remember({ kinds: { right: "server" }, servers: { p1: { right: { bucket: "beta", prefix: "x/" } } } });
    useBrowseStore.setState({ right: { ...emptyPanel(), source: { kind: "bucket", bucket: "alpha" }, path: "kept/" } });
    await restoreServerPanels("p1", names);
    expect(listBucketDir).not.toHaveBeenCalled();
    expect(store().right.path).toBe("kept/");
  });

  it("a response for a profile that was switched away is dropped by the loader (no state of p1 under p2)", async () => {
    remember({ kinds: { right: "server" }, servers: { p1: { right: { bucket: "beta", prefix: "x/" } } } });
    await restoreServerPanels("p1", names);
    useBrowseStore.getState().setProfile("p2");
    expect(store().right.source).toBeNull();
  });
});
