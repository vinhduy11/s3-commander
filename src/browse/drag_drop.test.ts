// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as flow from "../ops/ops_flow";
import { useOpsStore } from "../ops/ops_store";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "./browse_store";
import { pressRow, useDragStore } from "./drag_drop";

vi.mock("../ops/ops_flow", () => ({ startTransferOf: vi.fn(async () => {}) }));

const dir = (name: string): PanelEntry => ({ name, isDir: true, size: 0, modified: null });
const file = (name: string): PanelEntry => ({ name, isDir: false, size: 1, modified: 1 });

let under: Element | null = null;
const fire = (type: string, init: MouseEventInit & { key?: string } = {}) =>
  window.dispatchEvent(type === "keydown" ? new KeyboardEvent(type, { bubbles: true, ...init }) : new MouseEvent(type, { bubbles: true, ...init }));
const drag = () => useDragStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = `
    <div data-panel="left"><div class="list" id="ll"></div></div>
    <div data-panel="right"><div class="list" id="rl"><div data-row-name="docs" data-row-dir="true" id="rdocs"></div></div></div>`;
  (document as unknown as { elementFromPoint: unknown }).elementFromPoint = vi.fn(() => under);
  useBrowseStore.setState({
    ...initialBrowseState(),
    left: { ...emptyPanel(), source: { kind: "local" }, path: "/home/u", entries: [dir("pics"), file("a.txt"), file("b.txt")], marked: { "a.txt": true, "b.txt": true } },
    right: { ...emptyPanel(), source: { kind: "bucket", bucket: "alpha" }, path: "in/", entries: [dir("docs")] },
    profileId: "p1",
  });
  useOpsStore.setState({ dialog: null });
  useDragStore.getState().reset();
  under = document.getElementById("rl");
});
afterEach(() => fire("pointerup"));

describe("pointer drag", () => {
  it("a press that never moves 4 px is a click: no ghost, no drop, and the click is not swallowed", () => {
    pressRow("left", "a.txt", 100, 100);
    fire("pointermove", { clientX: 102, clientY: 101 });
    expect(drag().active).toBe(false);
    fire("pointerup", { clientX: 102, clientY: 101 });
    expect(flow.startTransferOf).not.toHaveBeenCalled();
    const clicked = vi.fn();
    document.body.addEventListener("click", clicked, { once: true });
    document.body.click();
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("crossing the threshold shows a ghost labelled with the dragged set", () => {
    pressRow("left", "a.txt", 100, 100);
    fire("pointermove", { clientX: 130, clientY: 100 });
    expect(drag()).toMatchObject({ active: true, label: "2 items", x: 130, y: 100 });
    fire("pointerup", { clientX: 130, clientY: 100 });
    pressRow("left", "pics", 0, 0);
    fire("pointermove", { clientX: 30, clientY: 0 });
    expect(drag().label).toBe("pics");
  });

  it("plain drop on the other panel copies, through the shared flow, then clears the drag", () => {
    pressRow("left", "a.txt", 100, 100);
    fire("pointermove", { clientX: 400, clientY: 100 });
    expect(drag()).toMatchObject({ verdict: "copy", hover: { side: "right", name: null } });
    fire("pointerup", { clientX: 400, clientY: 100 });
    expect(flow.startTransferOf).toHaveBeenCalledWith(
      expect.objectContaining({ side: "left", destSide: "right", dest: { kind: "bucket", bucket: "alpha", prefix: "in/" }, items: [{ name: "a.txt", is_dir: false }, { name: "b.txt", is_dir: false }] }),
      "copy",
    );
    expect(drag().active).toBe(false);
  });

  it("Shift held at the drop moves into the folder under the pointer", () => {
    pressRow("left", "a.txt", 100, 100);
    under = document.getElementById("rdocs");
    fire("pointermove", { clientX: 400, clientY: 100, shiftKey: true });
    expect(drag().verdict).toBe("move");
    fire("pointerup", { clientX: 400, clientY: 100, shiftKey: true });
    expect(flow.startTransferOf).toHaveBeenCalledWith(expect.objectContaining({ dest: { kind: "bucket", bucket: "alpha", prefix: "in/docs/" } }), "move");
  });

  it("a refused target runs nothing and shows a message", () => {
    pressRow("left", "a.txt", 100, 100);
    under = document.getElementById("ll");
    fire("pointermove", { clientX: 50, clientY: 100 });
    expect(drag().verdict).toBe("refused");
    fire("pointerup", { clientX: 50, clientY: 100 });
    expect(flow.startTransferOf).not.toHaveBeenCalled();
    expect(drag().toast).not.toBe("");
  });

  it("a drop outside both panels is silent", () => {
    pressRow("left", "a.txt", 100, 100);
    under = document.body;
    fire("pointermove", { clientX: 50, clientY: 100 });
    fire("pointerup", { clientX: 50, clientY: 100 });
    expect(flow.startTransferOf).not.toHaveBeenCalled();
    expect(drag().toast).toBe("");
  });

  it("Esc cancels the drag", () => {
    pressRow("left", "a.txt", 100, 100);
    fire("pointermove", { clientX: 400, clientY: 100 });
    fire("keydown", { key: "Escape" });
    expect(drag().active).toBe(false);
    fire("pointerup", { clientX: 400, clientY: 100 });
    expect(flow.startTransferOf).not.toHaveBeenCalled();
  });

  it("does not start while a dialog is open, nor from the .. row", () => {
    useOpsStore.setState({ dialog: { kind: "busy", label: "x" } });
    pressRow("left", "a.txt", 0, 0);
    fire("pointermove", { clientX: 50, clientY: 0 });
    expect(drag().active).toBe(false);
    useOpsStore.setState({ dialog: null });
    pressRow("left", "..", 0, 0);
    fire("pointermove", { clientX: 50, clientY: 0 });
    expect(drag().active).toBe(false);
  });

  it("only the primary button starts a drag", () => {
    expect(pressRow("left", "a.txt", 0, 0, 2)).toBe(false);
  });
});
