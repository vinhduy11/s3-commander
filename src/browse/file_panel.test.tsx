// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "./browse_store";

vi.mock("./panel_loader", () => ({ openRowAt: vi.fn(), openPath: vi.fn(), openSource: vi.fn(), enterDir: vi.fn(), goUp: vi.fn(), loadMore: vi.fn(), loadAll: vi.fn() }));
import { loadAll } from "./panel_loader";
import { FilePanel } from "./file_panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });

const entries: PanelEntry[] = [
  { name: "docs", isDir: true, size: 0, modified: null },
  { name: "big.bin", isDir: false, size: 900, modified: 5 },
  { name: "small.txt", isDir: false, size: 10, modified: 9 },
];
let root: Root;
let host: HTMLElement;

function mount(nextToken: string | null, kind: "local" | "bucket") {
  useBrowseStore.setState({
    ...initialBrowseState(),
    profileId: "p1",
    left: { ...emptyPanel(), source: kind === "local" ? { kind: "local" } : { kind: "bucket", bucket: "alpha" }, path: kind === "local" ? "/home/me" : "in/", entries, nextToken },
  });
  act(() => root.render(<FilePanel side="left" />));
}
const headers = () => Array.from(document.querySelectorAll<HTMLElement>('.list-head [role="columnheader"]'));
const rowNames = () => Array.from(document.querySelectorAll(".list .row .label")).map((node) => node.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("column headers", () => {
  it("are buttons; Name is ascending at first with aria-sort", () => {
    mount(null, "local");
    expect(headers().map((header) => header.querySelector("button")?.textContent?.replace(/[▲▼]/g, "").trim())).toEqual(["Name", "Ext", "Size", "Date"]);
    expect(headers().map((header) => header.getAttribute("aria-sort"))).toEqual(["ascending", "none", "none", "none"]);
  });

  it("a click sorts ascending, a second click reverses, and the arrow follows", () => {
    mount(null, "local");
    const size = headers()[2].querySelector("button")!;
    act(() => size.click());
    expect(rowNames()).toEqual(["..", "docs", "small", "big"]);
    expect(headers()[2].getAttribute("aria-sort")).toBe("ascending");
    expect(headers()[2].textContent).toContain("▲");
    act(() => headers()[2].querySelector("button")!.click());
    expect(rowNames()).toEqual(["..", "docs", "big", "small"]);
    expect(headers()[2].getAttribute("aria-sort")).toBe("descending");
    expect(headers()[2].textContent).toContain("▼");
    expect(headers()[0].getAttribute("aria-sort")).toBe("none");
  });
});

describe("folder marker", () => {
  it("<DIR> is in the Ext cell and the folder Size cell is empty", () => {
    mount(null, "local");
    const cells = document.querySelectorAll(".list .row")[1].querySelectorAll(":scope > span");
    expect(cells[1].textContent).toBe("<DIR>");
    expect(cells[2].textContent).toBe("");
    const fileCells = document.querySelectorAll(".list .row")[2].querySelectorAll(":scope > span");
    expect(fileCells[1].textContent).toBe("bin");
    expect(fileCells[2].textContent).toBe("900 B");
  });
});

describe("sorted over loaded items hint", () => {
  it("shows for a server panel with more pages and Load all calls loadAll", () => {
    mount("t", "bucket");
    const hint = document.querySelector(".pfoot")!;
    expect(hint.textContent).toContain("sorted over loaded items");
    act(() => (Array.from(hint.querySelectorAll("button")).find((b) => b.textContent === "Load all"))!.click());
    expect(loadAll).toHaveBeenCalledWith("left");
  });

  it("is absent for a server panel without more pages and for a local panel", () => {
    mount(null, "bucket");
    expect(document.querySelector(".pfoot")!.textContent).not.toContain("sorted over");
    mount("t", "local");
    expect(document.querySelector(".pfoot")!.textContent).not.toContain("sorted over");
    expect(document.querySelector(".pfoot button")).toBeNull();
  });
});
