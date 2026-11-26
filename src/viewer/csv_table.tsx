// The CSV Table view: a virtualised grid (rows are windowed like the file list; every column of a
// visible row is rendered, which is fine up to a few hundred columns). Edits go through the CSV
// model, so only the edited cell's text changes in the file.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { columnCount, deleteColumn, deleteRow, insertColumn, insertRow, parseCsv, serializeCsv, setCell, type CsvModel, type Delimiter } from "./csv";

const ROW_H = 26;
const COL_W = 160;
const GUTTER_W = 48;
const OVERSCAN = 6;
const DEFAULT_HEIGHT = 400;

type Props = { text: string; delimiter: Delimiter; headerRow: boolean; editable: boolean; onChangeText: (text: string) => void };
type Pos = { r: number; c: number };

export function CsvTable({ text, delimiter, headerRow, editable, onChangeText }: Props) {
  const model = useMemo(() => parseCsv(text, delimiter), [text, delimiter]);
  const cols = Math.max(1, columnCount(model));
  const [active, setActive] = useState<Pos>({ r: 0, c: 0 });
  const [editing, setEditing] = useState<{ pos: Pos; draft: string } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const scroller = useRef<HTMLDivElement>(null);
  const first = headerRow ? 1 : 0; // index of the first body row in the model
  const bodyRows = Math.max(0, model.rows.length - first);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    setHeight(node.clientHeight || DEFAULT_HEIGHT);
    const observer = new ResizeObserver(() => setHeight(node.clientHeight || DEFAULT_HEIGHT));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Keep the active cell in view.
  useEffect(() => {
    const node = scroller.current;
    if (!node || active.r < first) return;
    const top = (active.r - first) * ROW_H;
    const body = node.clientHeight - ROW_H * (headerRow ? 1 : 0);
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + ROW_H > node.scrollTop + body) node.scrollTop = top + ROW_H - body;
  }, [active.r, first, headerRow]);

  const lastRow = Math.max(0, model.rows.length - 1);
  const clamp = (pos: Pos): Pos => ({ r: Math.min(Math.max(0, pos.r), lastRow), c: Math.min(Math.max(0, pos.c), cols - 1) });
  const valueAt = (r: number, c: number) => model.rows[r]?.[c] ?? "";

  function commit(then?: Pos) {
    if (editing) {
      const next = setCell(model, editing.pos.r, editing.pos.c, editing.draft);
      if (next !== model) onChangeText(serializeCsv(next));
    }
    setEditing(null);
    if (then) setActive(clamp(then));
  }

  const startEdit = (pos: Pos, draft = valueAt(pos.r, pos.c)) => editable && model.rows.length > 0 && setEditing({ pos, draft });

  function apply(change: (current: CsvModel) => CsvModel, then?: Pos) {
    onChangeText(serializeCsv(change(model)));
    if (then) setActive(then);
  }

  function onGridKeyDown(event: KeyboardEvent) {
    if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
    const moves: Record<string, Pos> = {
      ArrowDown: { r: active.r + 1, c: active.c },
      ArrowUp: { r: active.r - 1, c: active.c },
      ArrowRight: { r: active.r, c: active.c + 1 },
      ArrowLeft: { r: active.r, c: active.c - 1 },
      Home: { r: active.r, c: 0 },
      End: { r: active.r, c: cols - 1 },
      PageDown: { r: active.r + 10, c: active.c },
      PageUp: { r: active.r - 10, c: active.c },
    };
    if (moves[event.key]) {
      event.preventDefault();
      setActive(clamp(moves[event.key]));
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      startEdit(active);
    } else if (event.key.length === 1 && editable) {
      event.preventDefault();
      startEdit(active, event.key);
    }
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation(); // the viewer must not treat Esc or Enter from a cell as its own
    if (event.key === "Enter") {
      event.preventDefault();
      commit({ r: active.r + 1, c: active.c });
    } else if (event.key === "Tab") {
      event.preventDefault();
      commit({ r: active.r, c: active.c + (event.shiftKey ? -1 : 1) });
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditing(null);
    }
  }

  const cell = (r: number, c: number, role: "gridcell" | "columnheader") => {
    const isActive = active.r === r && active.c === c;
    const isEditing = editing?.pos.r === r && editing.pos.c === c;
    return (
      <div
        key={c}
        role={role}
        aria-selected={isActive}
        className={`cell${isActive ? " active" : ""}`}
        style={{ left: GUTTER_W + c * COL_W, width: COL_W }}
        title={valueAt(r, c)}
        onMouseDown={() => {
          if (editing && !isEditing) commit();
          setActive({ r, c });
        }}
        onDoubleClick={() => startEdit({ r, c })}
      >
        {isEditing ? (
          <input
            autoFocus
            aria-label={`Row ${r + 1}, column ${c + 1}`}
            value={editing.draft}
            onChange={(event) => setEditing({ pos: editing.pos, draft: event.currentTarget.value })}
            onKeyDown={onInputKeyDown}
            onBlur={() => commit()}
            onFocus={(event) => event.currentTarget.select()}
          />
        ) : (
          valueAt(r, c)
        )}
      </div>
    );
  };

  const from = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const to = Math.min(bodyRows, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const width = GUTTER_W + cols * COL_W;
  const columnIndexes = Array.from({ length: cols }, (_, index) => index);

  return (
    <div className="csv-table">
      {editable && (
        <div className="viewer-tools" role="toolbar" aria-label="Table edits">
          <button type="button" onClick={() => apply((m) => insertRow(m, active.r + 1), { r: active.r + 1, c: active.c })}>Add row</button>
          <button type="button" disabled={model.rows.length === 0} onClick={() => apply((m) => deleteRow(m, active.r), clamp(active))}>Delete row</button>
          <button type="button" onClick={() => apply((m) => insertColumn(m, active.c + 1), { r: active.r, c: active.c + 1 })}>Add column</button>
          <button type="button" disabled={cols <= 1} onClick={() => apply((m) => deleteColumn(m, active.c), clamp(active))}>Delete column</button>
        </div>
      )}
      <div className="grid-scroll" ref={scroller} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        <div role="grid" aria-label="Table" aria-rowcount={model.rows.length} className="grid" tabIndex={0} style={{ width }} onKeyDown={onGridKeyDown}>
          {headerRow && model.rows.length > 0 && (
            <div role="row" className="grid-row head" style={{ height: ROW_H, width }}>
              <div className="gutter" style={{ width: GUTTER_W }} aria-hidden="true">1</div>
              {columnIndexes.map((c) => cell(0, c, "columnheader"))}
            </div>
          )}
          <div className="grid-body" style={{ height: bodyRows * ROW_H, width }}>
            {Array.from({ length: Math.max(0, to - from) }, (_, offset) => {
              const r = first + from + offset;
              return (
                <div role="row" key={r} className="grid-row" style={{ top: (from + offset) * ROW_H, height: ROW_H, width }}>
                  <div className="gutter" style={{ width: GUTTER_W }} aria-hidden="true">{r + 1}</div>
                  {columnIndexes.map((c) => cell(r, c, "gridcell"))}
                </div>
              );
            })}
          </div>
          {model.rows.length === 0 && <div className="grid-empty">Empty file.</div>}
        </div>
      </div>
    </div>
  );
}
