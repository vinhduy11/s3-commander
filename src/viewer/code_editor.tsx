// The CodeMirror 6 editor. This file (and CodeMirror with it) is loaded lazily with the viewer.
// Colors come from the CSS tokens, so light and dark follow the app theme with no second theme.

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { bracketMatching, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import type { LineEnding } from "./text_kind";

export type CodeEditorProps = {
  value: string;
  readOnly: boolean;
  language: "json" | "plain";
  wrap: boolean;
  lineEnding: LineEnding;
  ariaLabel: string;
  onChange: (value: string) => void;
  /** Move the cursor to this offset and scroll to it; a new `nonce` repeats the jump. */
  reveal?: { offset: number; nonce: number };
};

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--surface)", color: "var(--fg)", fontSize: "var(--text-md)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55", overflow: "auto" },
  ".cm-content": { caretColor: "var(--accent)", padding: "var(--sp-2) 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-gutters": { backgroundColor: "var(--surface-2)", color: "var(--muted)", border: "none", borderRight: "1px solid var(--line-soft)" },
  ".cm-activeLine": { backgroundColor: "var(--cursor-off)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--cursor-off)", color: "var(--fg)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-soft)" },
  ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
  ".cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "1px solid var(--accent)" },
  ".cm-searchMatch": { backgroundColor: "var(--warn-soft)", outline: "1px solid var(--warn)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent-soft)", outline: "1px solid var(--accent)" },
  ".cm-panels": { backgroundColor: "var(--surface-2)", color: "var(--fg)", borderTop: "1px solid var(--line)" },
  ".cm-panel.cm-search": { padding: "var(--sp-2)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--sp-1)", fontFamily: "var(--font-ui)", fontSize: "var(--text-sm)" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "var(--text-sm)", margin: "0" },
  ".cm-panel.cm-search label": { display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--muted)" },
  ".cm-panel.cm-search [name=close]": { position: "static", marginLeft: "auto", background: "transparent", border: "0", color: "var(--muted)" },
});

const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--accent)" },
  { tag: tags.string, color: "var(--ok)" },
  { tag: tags.number, color: "var(--warn)" },
  { tag: [tags.bool, tags.null], color: "var(--icon-image)" },
  { tag: [tags.punctuation, tags.separator, tags.squareBracket, tags.brace], color: "var(--muted)" },
  { tag: tags.invalid, color: "var(--danger)" },
]);

const isDark = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;

export function CodeEditor({ value, readOnly, language, wrap, lineEnding, ariaLabel, onChange, reveal }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const emitted = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const readOnlyPart = useRef(new Compartment());
  const wrapPart = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          EditorState.lineSeparator.of(lineEnding),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          bracketMatching(),
          search({ top: false }),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          language === "json" ? [json(), syntaxHighlighting(highlight)] : [],
          EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
          readOnlyPart.current.of(EditorState.readOnly.of(readOnly)),
          wrapPart.current.of(wrap ? EditorView.lineWrapping : []),
          EditorView.theme({}, { dark: isDark() }),
          theme,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            // sliceDoc joins lines with the document's own line break (CRLF stays CRLF); doc.toString() would use LF.
            emitted.current = update.state.sliceDoc();
            onChangeRef.current(emitted.current);
          }),
        ],
      }),
    });
    view.current = created;
    created.focus();
    return () => {
      created.destroy();
      view.current = null;
    };
    // The editor is created once per mount; later prop changes go through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: readOnlyPart.current.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapPart.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  // Text changed from outside (Format, Minify, a table edit): replace it in one undoable step.
  useEffect(() => {
    const current = view.current;
    if (!current || value === emitted.current) return;
    emitted.current = value;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const current = view.current;
    if (!current || !reveal) return;
    const anchor = Math.min(reveal.offset, current.state.doc.length);
    current.dispatch({ selection: { anchor }, scrollIntoView: true });
    current.focus();
  }, [reveal]);

  return <div className="code-editor" ref={host} />;
}
