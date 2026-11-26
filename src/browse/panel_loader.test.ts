import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialBrowseState, useBrowseStore } from "./browse_store";

vi.mock("./browse_api", () => ({ listLocalDir: vi.fn(), listBucketDir: vi.fn() }));
import { listBucketDir, listLocalDir } from "./browse_api";
import { openPath, openSource } from "./panel_loader";

const store = () => useBrowseStore.getState();
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const entry = { name: "a.txt", isDir: false, size: 1, modified: 1 };

beforeEach(() => {
  useBrowseStore.setState(initialBrowseState());
  vi.mocked(listLocalDir).mockReset();
  vi.mocked(listBucketDir).mockReset();
});

describe("panel loading is never left stuck", () => {
  it("Local listing survives setProfile changing profileId while in flight", async () => {
    const pending = deferred<{ path: string; entries: (typeof entry)[] }>();
    vi.mocked(listLocalDir).mockReturnValue(pending.promise);
    const opening = openSource("left", { kind: "local" });
    store().setProfile("p1"); // profile_list resolved while the first Local request is in flight
    pending.resolve({ path: "/home", entries: [entry] });
    await opening;
    expect(store().left.loading).toBe(false);
    expect(store().left.path).toBe("/home");
    expect(store().left.entries).toEqual([entry]);
  });

  it("Local error survives setProfile while in flight", async () => {
    const pending = deferred<never>();
    vi.mocked(listLocalDir).mockReturnValue(pending.promise);
    const opening = openSource("left", { kind: "local" });
    store().setProfile("p1");
    pending.reject("boom");
    await opening;
    expect(store().left.loading).toBe(false);
    expect(store().left.error).toBe("boom");
  });

  it("bucket response dropped by a profile change leaves no loading=true", async () => {
    store().setProfile("p1");
    const pending = deferred<{ entries: (typeof entry)[]; nextToken: string | null }>();
    vi.mocked(listBucketDir).mockReturnValue(pending.promise);
    const opening = openSource("right", { kind: "bucket", bucket: "b" });
    store().setProfile("p2");
    pending.resolve({ entries: [entry], nextToken: null });
    await opening;
    expect(store().right.loading).toBe(false);
    expect(store().right.entries).toEqual([]);
  });

  it("bucket error dropped by a profile change leaves no loading=true", async () => {
    store().setProfile("p1");
    const pending = deferred<never>();
    vi.mocked(listBucketDir).mockReturnValue(pending.promise);
    const opening = openSource("right", { kind: "bucket", bucket: "b" });
    store().setProfile("p2");
    pending.reject("boom");
    await opening;
    expect(store().right.loading).toBe(false);
    expect(store().right.error).toBe("");
  });

  it("bucket source without a profile does not stay loading", async () => {
    await openSource("right", { kind: "bucket", bucket: "b" });
    expect(store().right.loading).toBe(false);
    expect(listBucketDir).not.toHaveBeenCalled();
  });

  it("a superseded request keeps loading for the newer one, which then wins", async () => {
    const first = deferred<{ path: string; entries: (typeof entry)[] }>();
    const second = deferred<{ path: string; entries: (typeof entry)[] }>();
    vi.mocked(listLocalDir).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const opening = openSource("left", { kind: "local" });
    const next = openPath("left", "/x");
    first.resolve({ path: "/old", entries: [] });
    await opening;
    expect(store().left.loading).toBe(true);
    second.resolve({ path: "/x", entries: [entry] });
    await next;
    expect(store().left.loading).toBe(false);
    expect(store().left.path).toBe("/x");
  });
});
