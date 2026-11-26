// The large in-window viewer and editor (F3 / F4). Chrome and dialogs live here; the text editor
// (CodeMirror) and the CSV table are children, so this whole module loads lazily.

import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { formatSize } from "../browse/navigation";
import { DiskIcon, ServerIcon, CloseIcon } from "../icons";
import { Buttons, Modal } from "../ops/modal";
import { CodeEditor } from "./code_editor";
import { DELIMITERS, type Delimiter } from "./csv";
import { CsvTable } from "./csv_table";
import { formatJson, minifyJson, validateJson } from "./json_tools";
import { copyName } from "./text_kind";
import {
  confirmInvalidJsonSave,
  discardAndClose,
  dismissGuard,
  isDirty,
  overwriteSave,
  requestClose,
  saveViewer,
  setHeaderRow,
  setViewerDelimiter,
  setViewerText,
  setViewerView,
  setWrap,
  startSaveAsCopy,
  submitCopyName,
  switchToEdit,
} from "./viewer_flow";
import { useViewerStore, type ViewerSession } from "./viewer_store";

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), select, textarea, [contenteditable='true'], [tabindex]:not([tabindex='-1'])";
const DELIMITER_LABELS: Record<Delimiter, string> = { ",": "Comma ,", ";": "Semicolon ;", "\t": "Tab", "|": "Pipe |" };

export function ViewerModal() {
  const session = useViewerStore((state) => state.session);
  const side = session?.side;
  const open = session !== null;

  // Hand the keyboard back to the panel the file came from when the viewer closes.
  useEffect(() => {
    if (!open || !side) return;
    return () => document.getElementById(`panel-${side}`)?.focus();
  }, [open, side]);

  return session ? <Viewer session={session} /> : null;
}

function Viewer({ session }: { session: ViewerSession }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [reveal, setReveal] = useState<{ offset: number; nonce: number } | undefined>();
  const editable = session.mode === "edit";
  const dirty = isDirty(session);
  const deferredText = useDeferredValue(session.text);
  const json = useMemo(() => (session.kind === "json" ? validateJson(deferredText) : null), [session.kind, deferredText]);
  const bucket = session.source.kind === "bucket";

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveViewer();
    } else if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      requestClose();
    } else if (event.key === "Tab") {
      const focusable = Array.from(boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (!focusable.length) return;
      const edge = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];
      if (document.activeElement === edge) {
        event.preventDefault();
        focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
      }
    }
  }

  const rewrite = (action: typeof formatJson) => {
    const result = action(session.text, session.lineEnding);
    if (result.ok) setViewerText(result.text);
  };

  const info = [
    "UTF-8",
    session.bom ? "BOM" : null,
    session.lineEnding === "\r\n" ? "CRLF" : "LF",
    formatSize(new Blob([session.text]).size),
  ].filter(Boolean).join(" · ");

  return (
    <div className="scrim viewer-scrim">
      <div className="viewer" role="dialog" aria-modal="true" aria-label={session.name} tabIndex={-1} ref={boxRef} onKeyDown={onKeyDown}>
        <div className="viewer-head">
          <span className={`tag${bucket ? "" : " local"}`}>{bucket ? <ServerIcon /> : <DiskIcon />}{bucket ? "SERVER" : "LOCAL"}</span>
          <h2 title={session.source.kind === "local" ? session.source.path : `${session.source.bucket}/${session.source.key}`}>{session.name}</h2>
          <span className="chip">{editable ? "Editing" : "Read only"}</span>
          {dirty && <span className="chip warn">Unsaved changes</span>}
          <span className="spacer" />
          {!editable && <button type="button" onClick={switchToEdit}>Edit</button>}
          {editable && <button type="button" className="primary" disabled={!dirty || session.saving} onClick={() => void saveViewer()}>Save</button>}
          <button type="button" className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={requestClose}><CloseIcon /></button>
        </div>

        <div className="viewer-tools" role="toolbar" aria-label="Viewer options">
          {session.kind === "csv" && (
            <>
              <div className="segmented" role="radiogroup" aria-label="CSV view">
                {(["text", "table"] as const).map((view) => (
                  <button key={view} type="button" role="radio" aria-checked={session.view === view} onClick={() => setViewerView(view)}>
                    {view === "text" ? "Text" : "Table"}
                  </button>
                ))}
              </div>
              <label className="check">
                Delimiter
                <select aria-label="Delimiter" value={session.delimiter} onChange={(event) => setViewerDelimiter(event.currentTarget.value as Delimiter)}>
                  {DELIMITERS.map((delimiter) => <option key={delimiter} value={delimiter}>{DELIMITER_LABELS[delimiter]}</option>)}
                </select>
              </label>
              {session.view === "table" && (
                <label className="check">
                  <input type="checkbox" aria-label="First row is a header" checked={session.headerRow} onChange={(event) => setHeaderRow(event.currentTarget.checked)} />
                  First row is a header
                </label>
              )}
            </>
          )}
          {json && (
            <>
              <span className={`json-state ${json.ok ? "ok" : "bad"}`} role="status">
                {json.ok ? "Valid JSON" : `Invalid JSON: line ${json.line}, column ${json.column}`}
              </span>
              {!json.ok && <button type="button" onClick={() => setReveal({ offset: json.offset, nonce: (reveal?.nonce ?? 0) + 1 })}>Go to error</button>}
              <button type="button" disabled={!editable || !json.ok} onClick={() => rewrite(formatJson)}>Format</button>
              <button type="button" disabled={!editable || !json.ok} onClick={() => rewrite(minifyJson)}>Minify</button>
            </>
          )}
          <span className="spacer" />
          {!(session.kind === "csv" && session.view === "table") && (
            <label className="check">
              <input type="checkbox" aria-label="Wrap lines" checked={session.wrap} onChange={(event) => setWrap(event.currentTarget.checked)} />
              Wrap lines
            </label>
          )}
        </div>

        <div className="viewer-body">
          {session.kind === "csv" && session.view === "table" ? (
            <CsvTable text={session.text} delimiter={session.delimiter} headerRow={session.headerRow} editable={editable} onChangeText={setViewerText} />
          ) : (
            <CodeEditor
              value={session.text}
              readOnly={!editable}
              language={session.kind === "json" ? "json" : "plain"}
              wrap={session.wrap}
              lineEnding={session.lineEnding}
              ariaLabel={`${session.name}, ${editable ? "editor" : "read-only"}`}
              onChange={setViewerText}
              reveal={reveal}
            />
          )}
        </div>

        <div className="viewer-foot">
          {session.error && !session.guard ? <span className="alert-text" role="alert">{session.error}</span> : <span className="muted">{info}</span>}
          <span className="muted">{editable ? "Cmd/Ctrl+S saves, Esc closes" : "Esc closes"}</span>
        </div>
      </div>

      {session.guard === "close" && <CloseGuard saving={session.saving} />}
      {session.guard === "conflict" && <ConflictDialog bucket={bucket} error={session.error} />}
      {session.guard === "invalid-json" && <InvalidJsonDialog />}
      {session.guard === "copy-name" && <CopyNameDialog initial={copyName(session.name)} error={session.error} />}
    </div>
  );
}

function CloseGuard({ saving }: { saving: boolean }) {
  return (
    <Modal title="Unsaved changes" onCancel={dismissGuard}>
      <p>This file has changes that are not saved yet.</p>
      <Buttons>
        <button type="button" onClick={dismissGuard}>Cancel</button>
        <button type="button" onClick={discardAndClose}>Discard</button>
        <button type="button" className="primary" data-autofocus disabled={saving} onClick={() => void saveViewer()}>Save</button>
      </Buttons>
    </Modal>
  );
}

function ConflictDialog({ bucket, error }: { bucket: boolean; error: string }) {
  return (
    <Modal title={bucket ? "Object changed on the server" : "File changed on disk"} onCancel={dismissGuard}>
      <p className="caution">
        {bucket
          ? "This object was changed on the server after you opened it. Saving over it would lose that change."
          : "This file was changed on disk after you opened it. Saving over it would lose that change."}
      </p>
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="modal-actions wrap">
        <button type="button" onClick={() => void overwriteSave()}>Overwrite</button>
        <button type="button" onClick={() => void startSaveAsCopy()}>Save as copy</button>
        <button type="button" data-autofocus onClick={dismissGuard}>Cancel</button>
      </div>
    </Modal>
  );
}

function InvalidJsonDialog() {
  return (
    <Modal title="Save invalid JSON?" onCancel={dismissGuard}>
      <p className="caution">The text is not valid JSON. You can still save it, for example while you are in the middle of an edit.</p>
      <Buttons>
        <button type="button" data-autofocus onClick={dismissGuard}>Cancel</button>
        <button type="button" className="primary" onClick={() => void confirmInvalidJsonSave()}>Save anyway</button>
      </Buttons>
    </Modal>
  );
}

function CopyNameDialog({ initial, error }: { initial: string; error: string }) {
  const [name, setName] = useState(initial);
  return (
    <Modal title="Save as copy" onCancel={dismissGuard} onConfirm={() => void submitCopyName(name)}>
      <p>Name of the new object, next to the original:</p>
      <input data-autofocus aria-label="Name" value={name} spellCheck={false} onChange={(event) => setName(event.currentTarget.value)} onFocus={(event) => event.currentTarget.select()} />
      {error && <div className="alert" role="alert">{error}</div>}
      <Buttons>
        <button type="button" onClick={dismissGuard}>Cancel</button>
        <button type="button" className="primary" onClick={() => void submitCopyName(name)}>Save copy</button>
      </Buttons>
    </Modal>
  );
}

