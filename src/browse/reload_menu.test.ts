import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore } from "./browse_store";

vi.mock("../ops/presign_flow", () => ({ startPresign: vi.fn() }));
vi.mock("../ops/ops_flow", () => ({ startTransfer: vi.fn(), startDelete: vi.fn(), startRename: vi.fn(), startNewFolder: vi.fn() }));
vi.mock("./panel_loader", () => ({ openRowAt: vi.fn(), reloadPanel: vi.fn() }));
vi.mock("../viewer/viewer_flow", () => ({ startViewer: vi.fn() }));
import { reloadPanel } from "./panel_loader";
import { buildMenuItems } from "./context_menu";

const file = { name: "a.txt", isDir: false, size: 1, modified: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  useBrowseStore.setState({ ...initialBrowseState(), left: { ...emptyPanel(), source: { kind: "local" }, path: "/home/me", entries: [file] } });
});

describe.each(["row", "empty"] as const)("Refresh in the %s menu", (kind) => {
  it("is listed with the shortcut hint and runs reloadPanel for that side", () => {
    const item = buildMenuItems("left", kind).find((entry) => entry.id === "refresh")!;
    expect(item.label).toBe("Refresh");
    expect(item.shortcut).toMatch(/^(⌘R|Ctrl\+R)$/);
    expect(item.enabled).toBe(true);
    item.run();
    expect(reloadPanel).toHaveBeenCalledWith("left");
  });

  it("is disabled when the panel has no source", () => {
    const item = buildMenuItems("right", kind).find((entry) => entry.id === "refresh")!;
    expect(item.enabled).toBe(false);
  });
});
