import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "./browse_store";

vi.mock("./browse_api", () => ({ listLocalDir: vi.fn(), listBucketDir: vi.fn() }));
import { listBucketDir, listLocalDir } from "./browse_api";
import { openPath, reloadPanel } from "./panel_loader";

const store = () => useBrowseStore.getState();
const file = (name: string): PanelEntry => ({ name, isDir: false, size: 1, modified: 1 });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

function localPanel(extra = {}) {
  useBrowseStore.setState({
    ...initialBrowseState(),
    left: { ...emptyPanel(), source: { kind: "local" }, path: "/home/me/docs", entries: [file("a"), file("b"), file("c")], cursor: 2, marked: { a: true, c: true }, anchor: "c", scrollTop: 120, ...extra },
  });
}

beforeEach(() => {
  vi.mocked(listLocalDir).mockReset();
  vi.mocked(listBucketDir).mockReset();
});

describe("reloadPanel", () => {
  it("keeps the old rows while loading, then replaces them and keeps cursor, marks, anchor and scroll", async () => {
    localPanel();
    const pending = deferred<{ path: string; entries: PanelEntry[] }>();
    vi.mocked(listLocalDir).mockReturnValue(pending.promise);
    const reloading = reloadPanel("left");
    expect(store().left.loading).toBe(true);
    expect(store().left.entries.map((e) => e.name)).toEqual(["a", "b", "c"]);
    pending.resolve({ path: "/home/me/docs", entries: [file("new"), file("b"), file("c")] });
    await reloading;
    expect(store().left.loading).toBe(false);
    expect(store().left.entries.map((e) => e.name)).toEqual(["b", "c", "new"]);
    expect(store().left.cursor).toBe(1); // the cursor was on "b"; rows are now "..", b, c, new
    expect(store().left.marked).toEqual({ c: true });
    expect(store().left.anchor).toBe("c");
    expect(store().left.scrollTop).toBe(120);
  });

  it("a failed reload keeps the old rows and shows the error (server)", async () => {
    useBrowseStore.setState({ ...initialBrowseState(), profileId: "p1", right: { ...emptyPanel(), source: { kind: "bucket", bucket: "b" }, path: "in/", entries: [file("a")], marked: { a: true } } });
    vi.mocked(listBucketDir).mockRejectedValue("boom");
    await reloadPanel("right");
    expect(store().right.error).toBe("boom");
    expect(store().right.loading).toBe(false);
    expect(store().right.entries.map((e) => e.name)).toEqual(["a"]);
    expect(store().right.marked).toEqual({ a: true });
  });

  it("a vanished local folder falls back to the nearest existing parent with a notice", async () => {
    localPanel();
    vi.mocked(listLocalDir).mockImplementation(async (path: string) => {
      if (path === "/home/me") return { path, entries: [file("x")] };
      throw "no such directory";
    });
    await reloadPanel("left");
    expect(vi.mocked(listLocalDir).mock.calls.map((call) => call[0])).toEqual(["/home/me/docs", "/home/me"]);
    expect(store().left.path).toBe("/home/me");
    expect(store().left.entries.map((e) => e.name)).toEqual(["x"]);
    expect(store().left.notice).toBe("Folder no longer exists, showing /home/me");
    expect(store().left.error).toBe("");
    expect(store().left.cursor).toBe(0);
  });

  it("walks up several levels, and reports the error when nothing lists", async () => {
    localPanel();
    vi.mocked(listLocalDir).mockImplementation(async (path: string) => {
      if (path === "/home") return { path, entries: [] };
      throw "gone";
    });
    await reloadPanel("left");
    expect(store().left.path).toBe("/home");
    expect(store().left.notice).toBe("Folder no longer exists, showing /home");

    localPanel();
    vi.mocked(listLocalDir).mockRejectedValue("denied");
    await reloadPanel("left");
    expect(store().left.error).toBe("denied");
    expect(store().left.path).toBe("/home/me/docs");
    expect(store().left.entries).toHaveLength(3);
  });

  it("a server prefix without objects is an empty listing and the path is kept", async () => {
    useBrowseStore.setState({ ...initialBrowseState(), profileId: "p1", right: { ...emptyPanel(), source: { kind: "bucket", bucket: "b" }, path: "in/", entries: [file("a")] } });
    vi.mocked(listBucketDir).mockResolvedValue({ entries: [], nextToken: null });
    await reloadPanel("right");
    expect(store().right.entries).toEqual([]);
    expect(store().right.path).toBe("in/");
    expect(store().right.error).toBe("");
    expect(store().right.notice).toBe("");
  });

  it("a server reload restarts from the first page and keeps the sort", async () => {
    useBrowseStore.setState({
      ...initialBrowseState(),
      profileId: "p1",
      right: { ...emptyPanel(), source: { kind: "bucket", bucket: "b" }, path: "in/", entries: [file("a")], nextToken: "t1", sort: { key: "size", dir: "desc" } },
    });
    vi.mocked(listBucketDir).mockResolvedValue({ entries: [file("a"), file("b")], nextToken: "t2" });
    await reloadPanel("right");
    expect(vi.mocked(listBucketDir)).toHaveBeenCalledWith("p1", "b", "in/", null);
    expect(store().right.nextToken).toBe("t2");
    expect(store().right.sort).toEqual({ key: "size", dir: "desc" });
  });

  it("drops the response when the user navigated meanwhile", async () => {
    localPanel();
    const slow = deferred<{ path: string; entries: PanelEntry[] }>();
    vi.mocked(listLocalDir).mockImplementation((path: string) => (path === "/home/me/docs" ? slow.promise : Promise.resolve({ path, entries: [file("other")] })));
    const reloading = reloadPanel("left");
    await openPath("left", "/elsewhere");
    slow.resolve({ path: "/home/me/docs", entries: [file("stale")] });
    await reloading;
    expect(store().left.path).toBe("/elsewhere");
    expect(store().left.entries.map((e) => e.name)).toEqual(["other"]);
    expect(store().left.loading).toBe(false);
  });

  it("silent reload never sets loading and swallows a plain failure", async () => {
    localPanel();
    const pending = deferred<{ path: string; entries: PanelEntry[] }>();
    vi.mocked(listLocalDir).mockReturnValue(pending.promise);
    const reloading = reloadPanel("left", { silent: true });
    expect(store().left.loading).toBe(false);
    pending.reject("denied");
    await reloading;
    expect(store().left.error).toBe("");
    expect(store().left.entries).toHaveLength(3);
  });

  it("does nothing without a source", async () => {
    useBrowseStore.setState(initialBrowseState());
    await reloadPanel("left");
    expect(listLocalDir).not.toHaveBeenCalled();
    expect(store().left.loading).toBe(false);
  });
});
