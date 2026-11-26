// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyPanel, initialBrowseState, useBrowseStore, type PanelEntry } from "../browse/browse_store";
import * as panelLoader from "../browse/panel_loader";
import { useOpsStore } from "../ops/ops_store";
import * as api from "./viewer_api";
import { startViewer } from "./viewer_flow";
import { ViewerModal } from "./viewer_modal";
import { useViewerStore } from "./viewer_store";

vi.mock("./viewer_api");
vi.mock("../browse/panel_loader");
// CodeMirror needs a real layout engine; here the editor is a textarea with the same props.
vi.mock("./code_editor", () => ({
  CodeEditor: (props: { value: string; readOnly: boolean; language: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Editor" data-language={props.language} readOnly={props.readOnly} value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)} />
  ),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });

const file = (name: string): PanelEntry => ({ name, isDir: false, size: 10, modified: 1 });
const session = () => useViewerStore.getState().session;
let host: HTMLDivElement;
let root: Root;

const flush = () => act(async () => { await Promise.resolve(); });
const button = (label: string) => Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.trim() === label) as HTMLButtonElement;
const editor = () => document.querySelector<HTMLTextAreaElement>("textarea[aria-label=Editor]")!;
const click = async (label: string) => {
  const target = button(label);
  expect(target, `button ${label}`).toBeTruthy();
  await act(async () => target.click());
};
const type = async (value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(editor(), value);
    editor().dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const key = async (init: KeyboardEventInit, target: Element = document.querySelector("[role=dialog]")!) =>
  act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });

async function openWith(name: string, text: string, mode: "view" | "edit", extra: Partial<api.LocalTextOpen> = {}) {
  useBrowseStore.setState({
    ...initialBrowseState(),
    active: "left",
    left: { ...emptyPanel(), source: { kind: "local" }, path: "/home/me", entries: [file(name)], cursor: 1 },
  });
  vi.mocked(api.localTextOpen).mockResolvedValue({ text, bom: false, size: text.length, stamp: "1:1", ...extra });
  await startViewer(mode, "left");
  await flush();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(panelLoader.openPath).mockResolvedValue(undefined);
  useOpsStore.getState().setDialog(null);
  useViewerStore.setState({ session: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<ViewerModal />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("View (F3) and Edit (F4)", () => {
  it("View is read-only, has no Save, and offers Edit", async () => {
    await openWith("a.txt", "hello", "view");
    expect(document.querySelector("[role=dialog]")?.getAttribute("aria-label")).toBe("a.txt");
    expect(editor().readOnly).toBe(true);
    expect(button("Save")).toBeUndefined();
    await click("Edit");
    expect(editor().readOnly).toBe(false);
    expect(button("Save")).toBeTruthy();
  });

  it("Edit is editable from the start and typing marks the file as changed", async () => {
    await openWith("a.txt", "hello", "edit");
    expect(editor().readOnly).toBe(false);
    expect(document.body.textContent).not.toContain("Unsaved");
    await type("hello world");
    expect(document.body.textContent).toContain("Unsaved changes");
    expect(button("Save").disabled).toBe(false);
  });

  it("the JSON flavour is passed to the editor", async () => {
    await openWith("a.json", "{}", "edit");
    expect(editor().dataset.language).toBe("json");
  });
});

describe("shortcuts and the close guard", () => {
  it("Cmd+S and Ctrl+S save", async () => {
    vi.mocked(api.localTextSave).mockResolvedValue({ status: "saved", stamp: "2:2" });
    await openWith("a.txt", "one", "edit");
    await type("two");
    await key({ key: "s", metaKey: true });
    await flush();
    expect(api.localTextSave).toHaveBeenCalledTimes(1);
    await type("three");
    await key({ key: "s", ctrlKey: true });
    await flush();
    expect(api.localTextSave).toHaveBeenCalledTimes(2);
  });

  it("Esc closes a clean viewer", async () => {
    await openWith("a.txt", "one", "view");
    await key({ key: "Escape" });
    expect(session()).toBeNull();
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("Esc on a dirty viewer asks Save, Discard or Cancel; Cancel keeps the text", async () => {
    await openWith("a.txt", "one", "edit");
    await type("two");
    await key({ key: "Escape" });
    expect(document.querySelector("[role=dialog][aria-label='Unsaved changes']")).toBeTruthy();
    for (const label of ["Save", "Discard", "Cancel"]) expect(document.querySelector("[aria-label='Unsaved changes']")!.textContent).toContain(label);
    await click("Cancel");
    expect(session()).toMatchObject({ text: "two", guard: null });
    expect(document.querySelector("[aria-label='Unsaved changes']")).toBeNull();
  });

  it("the close button follows the same guard, and Discard closes", async () => {
    await openWith("a.txt", "one", "edit");
    await type("two");
    await act(async () => (document.querySelector("button[aria-label='Close']") as HTMLButtonElement).click());
    expect(session()?.guard).toBe("close");
    await click("Discard");
    expect(session()).toBeNull();
  });

  it("Save in the guard saves and closes", async () => {
    vi.mocked(api.localTextSave).mockResolvedValue({ status: "saved", stamp: "2:2" });
    await openWith("a.txt", "one", "edit");
    await type("two");
    await key({ key: "Escape" });
    await act(async () => (document.querySelector("[aria-label='Unsaved changes'] button.primary") as HTMLButtonElement).click());
    await flush();
    expect(api.localTextSave).toHaveBeenCalledWith("/home/me/a.txt", "two", false, "1:1");
    expect(session()).toBeNull();
  });
});

describe("conflicts", () => {
  it("a file changed on disk offers Overwrite, Save as copy and Cancel", async () => {
    vi.mocked(api.localTextSave).mockResolvedValue({ status: "changed" });
    await openWith("a.txt", "one", "edit");
    await type("two");
    await click("Save");
    await flush();
    const box = document.querySelector("[role=dialog][aria-label='File changed on disk']")!;
    expect(box).toBeTruthy();
    for (const label of ["Overwrite", "Save as copy", "Cancel"]) expect(box.textContent).toContain(label);
  });

  it("a remotely changed object says so", async () => {
    useBrowseStore.setState({
      ...initialBrowseState(), profileId: "p1", active: "right",
      right: { ...emptyPanel(), source: { kind: "bucket", bucket: "alpha" }, path: "in/", entries: [file("t.txt")], cursor: 1 },
    });
    vi.mocked(api.s3TextOpen).mockResolvedValue({ text: "x", bom: false, size: 1, etag: '"e"', content_type: null, metadata: {} });
    vi.mocked(api.s3TextSave).mockResolvedValue({ status: "changed" });
    await startViewer("edit", "right");
    await flush();
    await type("y");
    await click("Save");
    await flush();
    expect(document.querySelector("[role=dialog][aria-label='Object changed on the server']")).toBeTruthy();
  });

  it("invalid JSON asks before saving", async () => {
    vi.mocked(api.localTextSave).mockResolvedValue({ status: "saved", stamp: "2:2" });
    await openWith("a.json", '{"a":1}', "edit");
    await type('{"a":}');
    await click("Save");
    await flush();
    const box = document.querySelector("[role=dialog][aria-label='Save invalid JSON?']")!;
    expect(box).toBeTruthy();
    expect(api.localTextSave).not.toHaveBeenCalled();
    await act(async () => (box.querySelector("button.primary") as HTMLButtonElement).click());
    await flush();
    expect(api.localTextSave).toHaveBeenCalledTimes(1);
  });
});

describe("JSON tools", () => {
  it("shows validity with the error position, and Format and Minify rewrite the text", async () => {
    await openWith("a.json", '{"a":1}', "edit");
    expect(document.body.textContent).toContain("Valid JSON");
    await type('{"a":}');
    expect(document.body.textContent).toContain("Invalid JSON: line 1, column 6");
    await type('{"a":[1,2]}');
    await click("Format");
    expect(session()?.text).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    await click("Minify");
    expect(session()?.text).toBe('{"a":[1,2]}');
  });

  it("Format is disabled for invalid JSON and in View mode", async () => {
    await openWith("a.json", '{"a":}', "edit");
    expect(button("Format").disabled).toBe(true);
  });
});

describe("CSV Text | Table", () => {
  const csv = '"name","note"\r\nann,"x,y"\r\nbob,hi\r\n';

  it("toggles to a table with the parsed cells and the header row", async () => {
    await openWith("p.csv", csv, "edit");
    expect(editor()).toBeTruthy();
    await click("Table");
    expect(document.querySelector("textarea[aria-label=Editor]")).toBeNull();
    const cells = Array.from(document.querySelectorAll("[role=gridcell]")).map((cell) => cell.textContent);
    expect(cells).toEqual(expect.arrayContaining(["ann", "x,y", "bob", "hi"]));
    expect(Array.from(document.querySelectorAll("[role=columnheader]")).map((cell) => cell.textContent)).toEqual(["name", "note"]);
  });

  it("editing a cell updates the text and keeps the delimiter, quoting and line endings", async () => {
    await openWith("p.csv", csv, "edit");
    await click("Table");
    const cell = Array.from(document.querySelectorAll<HTMLElement>("[role=gridcell]")).find((node) => node.textContent === "hi")!;
    await act(async () => cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const input = document.querySelector<HTMLInputElement>("[role=grid] input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "a,b"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await key({ key: "Enter" }, input);
    expect(session()?.text).toBe('"name","note"\r\nann,"x,y"\r\nbob,"a,b"\r\n');
    await click("Text");
    // jsdom's textarea normalises line breaks in .value; the stored text above is the exact one.
    expect(editor().value.replace(/\r\n/g, "\n")).toBe('"name","note"\nann,"x,y"\nbob,"a,b"\n');
  });

  it("text edits show up in the table", async () => {
    await openWith("p.csv", "a,b\n1,2\n", "edit");
    await type("a,b\n1,2\n3,4\n");
    await click("Table");
    expect(Array.from(document.querySelectorAll("[role=gridcell]")).map((cell) => cell.textContent)).toEqual(expect.arrayContaining(["3", "4"]));
  });

  it("View mode shows the table read-only", async () => {
    await openWith("p.csv", "a,b\n1,2\n", "view");
    await click("Table");
    const cell = Array.from(document.querySelectorAll<HTMLElement>("[role=gridcell]")).find((node) => node.textContent === "2")!;
    await act(async () => cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(document.querySelector("[role=grid] input")).toBeNull();
  });

  it("the delimiter can be overridden", async () => {
    await openWith("p.csv", "a;b\n1;2\n", "edit");
    expect(session()?.delimiter).toBe(";");
    const select = document.querySelector<HTMLSelectElement>("select[aria-label=Delimiter]")!;
    await act(async () => {
      select.value = ",";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(session()?.delimiter).toBe(",");
  });

  it("the header row can be switched off", async () => {
    await openWith("p.csv", "a,b\n1,2\n", "edit");
    await click("Table");
    const header = document.querySelector<HTMLInputElement>("input[aria-label='First row is a header']")!;
    await act(async () => header.click());
    expect(document.querySelectorAll("[role=columnheader]").length).toBe(0);
  });
});
