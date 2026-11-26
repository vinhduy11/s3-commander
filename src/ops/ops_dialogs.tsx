import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useBrowseStore } from "../browse/browse_store";
import { formatDate, formatSize } from "../browse/navigation";
import type { ConflictPolicy, Direction, Location, Mode } from "./ops_api";
import {
  cancelDialog,
  confirmDelete,
  confirmPlan,
  resolveAllConflicts,
  resolveConflict,
  submitName,
} from "./ops_flow";
import { useOpsStore } from "./ops_store";

const MAX_LISTED_ITEMS = 5;
const FOCUSABLE = "button:not(:disabled), input, [tabindex]:not([tabindex='-1'])";

/** Verb shown for an operation: the direction names Upload and Download, a move is always Move. */
export function actionName(direction: Direction, mode: Mode): string {
  if (mode === "move") return "Move";
  return direction === "upload" ? "Upload" : direction === "download" ? "Download" : "Copy";
}

const locationLabel = (location: Location) => (location.kind === "local" ? location.path : `${location.bucket}/${location.prefix}`);

function Modal({
  title,
  children,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  onCancel?: () => void;
  onConfirm?: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    (box.querySelector<HTMLElement>("[data-autofocus]") ?? box).focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && onConfirm && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      onConfirm();
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

  return (
    <div className="scrim">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={boxRef} onKeyDown={onKeyDown}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

const Buttons = ({ children }: { children: ReactNode }) => <div className="modal-actions">{children}</div>;

function NameForm({ title, initial, error, onSubmit }: { title: string; initial: string; error: string; onSubmit: (name: string) => void }) {
  const [text, setText] = useState(initial);
  return (
    <Modal title={title} onCancel={cancelDialog} onConfirm={() => onSubmit(text)}>
      <input
        data-autofocus
        aria-label="Name"
        value={text}
        spellCheck={false}
        onChange={(event) => setText(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
      />
      {error && <div className="alert" role="alert">{error}</div>}
      <Buttons>
        <button type="button" onClick={cancelDialog}>Cancel</button>
        <button type="button" className="primary" onClick={() => onSubmit(text)}>OK</button>
      </Buttons>
    </Modal>
  );
}

const sizeAndDate = (size: number | null, modified: number | null) =>
  [size === null ? "unknown size" : formatSize(size), modified === null ? "" : formatDate(modified)].filter(Boolean).join("  ");

function ConflictButtons({ onChoose, onChooseAll }: { onChoose: (policy: ConflictPolicy) => void; onChooseAll: (policy: ConflictPolicy) => void }) {
  return (
    <>
      <div className="modal-actions wrap">
        <button type="button" onClick={() => onChoose("overwrite")}>Overwrite</button>
        <button type="button" data-autofocus onClick={() => onChoose("skip")}>Skip</button>
        <button type="button" onClick={() => onChoose("keep_both")}>Keep both</button>
      </div>
      <div className="modal-actions wrap">
        <button type="button" onClick={() => onChooseAll("overwrite")}>Overwrite all</button>
        <button type="button" onClick={() => onChooseAll("skip")}>Skip all</button>
        <button type="button" onClick={() => onChooseAll("keep_both")}>Keep both all</button>
        <button type="button" onClick={cancelDialog}>Cancel</button>
      </div>
    </>
  );
}

export function OpsDialogs() {
  const dialog = useOpsStore((state) => state.dialog);
  const wasOpen = useRef(false);

  // Hand the keyboard back to the active panel when the last dialog closes.
  useEffect(() => {
    if (dialog === null && wasOpen.current) document.getElementById(`panel-${useBrowseStore.getState().active}`)?.focus();
    wasOpen.current = dialog !== null;
  }, [dialog]);

  if (!dialog) return null;
  switch (dialog.kind) {
    case "delete": {
      const shown = dialog.items.slice(0, MAX_LISTED_ITEMS);
      return (
        <Modal title="Delete" onCancel={cancelDialog} onConfirm={() => void confirmDelete()}>
          <p>Delete {dialog.items.length} item(s) from {locationLabel(dialog.location)}?</p>
          <ul className="modal-list">
            {shown.map((item) => <li key={item.name}>{item.name}{item.is_dir ? "/" : ""}</li>)}
            {dialog.items.length > shown.length && <li className="muted">and {dialog.items.length - shown.length} more</li>}
          </ul>
          <div className={dialog.permanent ? "alert" : "notice"}>
            {dialog.permanent ? "Permanent: the objects are deleted from the server and cannot be restored." : "Local items are moved to the Trash."}
          </div>
          <Buttons>
            <button type="button" onClick={cancelDialog}>Cancel</button>
            <button type="button" data-autofocus className={dialog.permanent ? "primary danger-fill" : "primary"} onClick={() => void confirmDelete()}>
              {dialog.permanent ? "Delete permanently" : "Move to Trash"}
            </button>
          </Buttons>
        </Modal>
      );
    }
    case "name":
      return (
        <NameForm
          key={dialog.initial + dialog.error}
          title={dialog.name === "rename" ? "Rename" : "New folder"}
          initial={dialog.initial}
          error={dialog.error}
          onSubmit={(name) => void submitName(name)}
        />
      );
    case "plan": {
      const { summary, request } = dialog;
      const verb = actionName(summary.direction, request.mode);
      return (
        <Modal title={verb} onCancel={cancelDialog} onConfirm={() => void confirmPlan()}>
          <p>
            {verb} {request.items.length} selected item(s) to <span className="mono">{locationLabel(request.dest)}</span>
          </p>
          <dl className="modal-facts">
            <dt>Files</dt><dd>{summary.files}</dd>
            {summary.dirs > 0 && <><dt>Empty folders</dt><dd>{summary.dirs}</dd></>}
            <dt>Total size</dt><dd>{formatSize(summary.total_bytes)}</dd>
            <dt>Already exist</dt><dd>{summary.conflict_count}</dd>
          </dl>
          {summary.conflict_count > 0 && <p className="muted">You will choose what to do with each existing item next.</p>}
          {request.mode === "move" && <p className="muted">Each source is deleted only after its copy is verified.</p>}
          {summary.too_large_count > 0 && (
            <div className="alert">
              {summary.too_large_count} item(s) are above 5 GiB and will fail: large files arrive with step 4.
            </div>
          )}
          <Buttons>
            <button type="button" onClick={cancelDialog}>Cancel</button>
            <button type="button" data-autofocus className="primary" onClick={() => void confirmPlan()}>
              {summary.conflict_count > 0 ? "Resolve conflicts" : verb}
            </button>
          </Buttons>
        </Modal>
      );
    }
    case "conflicts": {
      const conflict = dialog.summary.conflicts[dialog.index];
      return (
        <Modal title={`Already exists (${dialog.index + 1} of ${dialog.summary.conflicts.length})`} onCancel={cancelDialog}>
          <p className="mono wrap-anywhere">{conflict.dest}</p>
          <dl className="modal-facts">
            <dt>Existing</dt><dd>{sizeAndDate(conflict.existing_size, conflict.existing_modified)}</dd>
            <dt>Incoming</dt><dd>{sizeAndDate(conflict.incoming_size, conflict.incoming_modified)}</dd>
          </dl>
          <ConflictButtons onChoose={(policy) => void resolveConflict(policy)} onChooseAll={(policy) => void resolveAllConflicts(policy)} />
        </Modal>
      );
    }
    case "busy":
      return (
        <Modal title="Working">
          <div className="busy-line" role="status"><span className="spinner" />{dialog.label}</div>
        </Modal>
      );
    case "result":
      return (
        <Modal title={dialog.title} onCancel={cancelDialog} onConfirm={cancelDialog}>
          {dialog.lines.map((line) => <p key={line}>{line}</p>)}
          {dialog.failed.length > 0 && (
            <ul className="modal-list failures" aria-label="Failed items">
              {dialog.failed.map((failure) => (
                <li key={failure.name + failure.message}>
                  <span className="mono">{failure.name}</span>
                  <span className="muted">{failure.message}</span>
                </li>
              ))}
            </ul>
          )}
          <Buttons>
            <button type="button" data-autofocus className="primary" onClick={cancelDialog}>OK</button>
          </Buttons>
        </Modal>
      );
  }
}
