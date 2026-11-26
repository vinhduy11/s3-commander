// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeEditor, type CodeEditorProps } from "./code_editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const props = (extra: Partial<CodeEditorProps> = {}): CodeEditorProps => ({
  value: "one\r\ntwo\r\n", readOnly: false, language: "plain", wrap: false, lineEnding: "\r\n", ariaLabel: "x, editor", onChange: vi.fn(), ...extra,
});
const mount = (p: CodeEditorProps) => act(() => root.render(<CodeEditor {...p} />));
const view = () => EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;

describe("CodeEditor (CodeMirror)", () => {
  it("shows the text and keeps CRLF line breaks in what it reports", () => {
    const onChange = vi.fn();
    mount(props({ onChange }));
    expect(view().state.doc.lines).toBe(3);
    act(() => view().dispatch({ changes: { from: 3, insert: "!" } }));
    expect(onChange).toHaveBeenLastCalledWith("one!\r\ntwo\r\n");
  });

  it("an untouched LF document reports exactly what it was given, trailing newline included", () => {
    const onChange = vi.fn();
    mount(props({ value: "a\nb\n", lineEnding: "\n", onChange }));
    act(() => view().dispatch({ changes: { from: 0, insert: "" } }));
    act(() => view().dispatch({ changes: { from: 0, to: 1, insert: "a" } }));
    expect(view().state.doc.toString()).toBe("a\nb\n");
  });

  it("a mixed-ending file keeps every byte: the CR of a CRLF line is plain text in LF mode", () => {
    const onChange = vi.fn();
    mount(props({ value: "a\r\nb\nc", lineEnding: "\n", onChange }));
    act(() => view().dispatch({ changes: { from: 0, insert: "x" } }));
    expect(onChange).toHaveBeenLastCalledWith("xa\r\nb\nc");
  });

  it("read-only blocks edits made through the view's input handling but keeps the text", () => {
    mount(props({ readOnly: true }));
    expect(view().state.readOnly).toBe(true);
    mount(props({ readOnly: false }));
    expect(view().state.readOnly).toBe(false);
  });

  it("replaces the document when the value changes from outside, without echoing it back", () => {
    const onChange = vi.fn();
    mount(props({ value: "a", lineEnding: "\n", onChange }));
    mount(props({ value: "{\n  \"a\": 1\n}", lineEnding: "\n", onChange }));
    expect(view().state.doc.toString()).toBe('{\n  "a": 1\n}');
  });

  it("jumps to an offset on reveal", () => {
    mount(props({ value: "abcdef", lineEnding: "\n", reveal: { offset: 4, nonce: 1 } }));
    expect(view().state.selection.main.head).toBe(4);
  });

  it("toggles line wrapping", () => {
    mount(props({ wrap: true }));
    expect(host.querySelector(".cm-lineWrapping")).toBeTruthy();
    mount(props({ wrap: false }));
    expect(host.querySelector(".cm-lineWrapping")).toBeNull();
  });
});
