import { useLayoutEffect, useRef, useState } from "react";
import { DiskIcon, RefreshIcon, ServerIcon } from "../icons";
import { EntryIcon } from "../icons";
import { useBrowseStore, type PanelSource, type Side } from "./browse_store";
import { buildRows, formatDate, formatSize, splitName } from "./navigation";
import { goUp, loadAll, loadMore, openRowAt, openSource, reloadPanel } from "./panel_loader";
import { reloadShortcut } from "./reload_triggers";
import { type SortKey } from "./sort";
import { openEmptyMenu, openMenuAtCursor, openRowMenu, useContextMenu } from "./context_menu";
import { useRubberBand } from "./rubber_band";
import { openPatternDialog } from "./selection_flow";
import { useOpsStore } from "../ops/ops_store";
import { useViewerStore } from "../viewer/viewer_store";
import { panelDragProps, useDropHighlight } from "./drag_drop";
import { ColumnResizer } from "./column_resizer";
import { fitWidths, type ColumnKey } from "./panel_columns";
import { startViewer } from "../viewer/viewer_flow";
import { PathField } from "./path_field";

const ROW_HEIGHT = 22;
const OVERSCAN_ROWS = 8;
const LOAD_MORE_DISTANCE_ROWS = 40;
const DEFAULT_VIEWPORT_HEIGHT = 400;

/** The column widths as CSS custom properties; the single `.row` template in styles.css reads them. */
const columnVars = (widths: Record<ColumnKey, number>) =>
  ({ "--w-ext": `${widths.ext}px`, "--w-size": `${widths.size}px`, "--w-date": `${widths.date}px` }) as React.CSSProperties;

const HEADERS: { key: SortKey; label: string; className?: string }[] = [
  { key: "name", label: "Name" },
  { key: "ext", label: "Ext" },
  { key: "size", label: "Size", className: "num" },
  { key: "date", label: "Date", className: "date" },
];
const sourceValue = (source: PanelSource | null) =>
  !source ? "" : source.kind === "local" ? "local" : `bucket:${source.bucket}`;

function parseSource(value: string): PanelSource | null {
  if (value === "local") return { kind: "local" };
  return value.startsWith("bucket:") ? { kind: "bucket", bucket: value.slice("bucket:".length) } : null;
}

export function FilePanel({ side }: { side: Side }) {
  const panel = useBrowseStore((state) => state[side]);
  const isActive = useBrowseStore((state) => state.active === side);
  const drop = useDropHighlight(side);
  const buckets = useBrowseStore((state) => state.buckets);
  const { setCursor, toggleMark, setActive, setScrollTop, sortBy, selectOnly, toggleAt, extendSelection } = useBrowseStore.getState();

  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const columnWidths = useBrowseStore((state) => state.columnWidths[side]);
  const [panelPx, setPanelPx] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const [editingPath, setEditingPath] = useState(false);

  const rows = buildRows(panel.source, panel.path, panel.entries);
  const { band, handlers: bandHandlers } = useRubberBand(side, listRef, ROW_HEIGHT);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = useBrowseStore.getState()[side].scrollTop;
    setViewportHeight(list.clientHeight || DEFAULT_VIEWPORT_HEIGHT);
    const observer = new ResizeObserver(() => setViewportHeight(list.clientHeight || DEFAULT_VIEWPORT_HEIGHT));
    observer.observe(list);
    return () => observer.disconnect();
  }, [side]);

  // The panel's own width decides how much of the user's column widths fits (Name keeps a minimum).
  useLayoutEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    setPanelPx(node.clientWidth);
    const observer = new ResizeObserver(() => setPanelPx(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (isActive) panelRef.current?.focus({ preventScroll: true });
  }, [isActive]);

  // Keep the cursor row visible.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const top = panel.cursor * ROW_HEIGHT;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
  }, [panel.cursor]);

  // Fetch the next page when the cursor gets near the end of what is loaded.
  useLayoutEffect(() => {
    if (panel.nextToken && rows.length - panel.cursor < LOAD_MORE_DISTANCE_ROWS) void loadMore(side);
  });

  /** Enter and double-click: a file opens in the viewer, a folder or ".." navigates. */
  const openRow = (index: number) => (rows[index] && !rows[index].isDir ? void startViewer("view", side) : openRowAt(side, index));

  /** Shift+F10 / ContextMenu key: open the menu just under the cursor row. */
  function openMenuOnCursor() {
    const rect = listRef.current?.getBoundingClientRect();
    const top = rect ? rect.top + (panel.cursor + 1) * ROW_HEIGHT - (listRef.current?.scrollTop ?? 0) : 0;
    openMenuAtCursor(side, (rect?.left ?? 0) + ROW_HEIGHT, top);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const page = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1);
    const store = useBrowseStore.getState();
    const mod = event.metaKey || event.ctrlKey;
    const typing = event.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      setEditingPath(true);
      return;
    }
    // Shift extends the marked range from the anchor, otherwise the cursor just moves.
    const move = (to: number) => (event.shiftKey ? extendSelection(side, to) : setCursor(side, to));
    if (event.key === "Escape") {
      const overlay = useOpsStore.getState().dialog !== null || useViewerStore.getState().session !== null || useContextMenu.getState().menu !== null;
      if (overlay || !Object.keys(store[side].marked).length) return;
      event.preventDefault();
      store.clearMarks(side);
      return;
    }
    const selection: Record<string, () => void> = {
      "*": () => store.invertSelection(side),
      "+": () => openPatternDialog(side, "select"),
      "-": () => openPatternDialog(side, "deselect"),
    };
    const selectionHandler = mod ? (event.key.toLowerCase() === "a" ? () => store.markAll(side) : undefined) : typing ? undefined : selection[event.key];
    const handlers: Record<string, () => void> = {
      ArrowDown: () => move(panel.cursor + 1),
      ArrowUp: () => move(panel.cursor - 1),
      PageDown: () => move(panel.cursor + page),
      PageUp: () => move(panel.cursor - page),
      Home: () => move(0),
      End: () => move(rows.length - 1),
      Enter: () => openRow(panel.cursor),
      Backspace: () => void goUp(side),
      " ": () => {
        const row = rows[panel.cursor];
        if (row && !row.isUp) toggleMark(side, row.name);
        setCursor(side, panel.cursor + 1);
      },
      Tab: () => {
        const other: Side = side === "left" ? "right" : "left";
        setActive(other);
        document.getElementById(`panel-${other}`)?.focus();
      },
    };
    const handler = selectionHandler ?? (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey) ? openMenuOnCursor : handlers[event.key]);
    if (!handler) return;
    event.preventDefault();
    handler();
  }

  const { scrollTop } = panel;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN_ROWS);

  const markedNames = Object.keys(panel.marked);
  const markedSize = panel.entries.filter((entry) => panel.marked[entry.name] && !entry.isDir).reduce((sum, entry) => sum + entry.size, 0);

  return (
    <div
      id={`panel-${side}`}
      ref={panelRef}
      className={`panel${isActive ? " active" : ""}${drop.panelCue ? ` drop-${drop.panelCue}` : ""}`}
      style={columnVars(fitWidths(columnWidths, panelPx))}
      {...panelDragProps(side)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={() => setActive(side)}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="phead">
        <span className={`tag${panel.source?.kind === "local" ? " local" : ""}`}>
          {panel.source?.kind === "local" ? <DiskIcon /> : <ServerIcon />}
          {panel.source?.kind === "local" ? "LOCAL" : "SERVER"}
        </span>
        <select
          aria-label={`Source of the ${side} panel`}
          value={sourceValue(panel.source)}
          onChange={(event) => void openSource(side, parseSource(event.currentTarget.value))}
        >
          <option value="">(choose source)</option>
          <option value="local">Local</option>
          {buckets.map((bucket) => (
            <option key={bucket} value={`bucket:${bucket}`}>
              {bucket}
            </option>
          ))}
        </select>
        <PathField
          side={side}
          editing={editingPath}
          onEditingChange={(editing, refocusPanel) => {
            setEditingPath(editing);
            if (refocusPanel) panelRef.current?.focus({ preventScroll: true });
          }}
        />
        <button
          type="button"
          className={`reload-btn${panel.loading ? " spinning" : ""}`}
          aria-label="Reload"
          title={`Reload (${reloadShortcut()})`}
          disabled={!panel.source}
          onClick={() => {
            void reloadPanel(side);
            panelRef.current?.focus({ preventScroll: true }); // keep the panel keys working after a click
          }}
        >
          <RefreshIcon />
        </button>
      </div>
      <div className="list-head row">
        {HEADERS.map(({ key, label, className }) => {
          const active = panel.sort.key === key;
          return (
            <span key={key} className={className} role="columnheader" aria-sort={active ? (panel.sort.dir === "asc" ? "ascending" : "descending") : "none"}>
              <button type="button" className="sort-btn" onClick={() => sortBy(side, key)}>
                {label}
                {active && <span className="sort-arrow" aria-hidden="true">{panel.sort.dir === "asc" ? "▲" : "▼"}</span>}
              </button>
              {key !== "name" && <ColumnResizer side={side} col={key} label={label} />}
            </span>
          );
        })}
      </div>
      <div
        className="list"
        ref={listRef}
        role="listbox"
        aria-multiselectable="true"
        aria-label={`Files of the ${side} panel`}
        {...bandHandlers}
        onContextMenu={(event) => {
          event.preventDefault();
          openEmptyMenu(side, event.clientX, event.clientY);
        }}
        onScroll={(event) => {
          setScrollTop(side, event.currentTarget.scrollTop);
        }}
      >
        <div role="presentation" style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
          {band && <div className="band" style={band} />}
          {rows.slice(first, last).map((row, offset) => {
            const index = first + offset;
            const { base, ext } = row.isDir || row.isUp ? { base: row.name, ext: "" } : splitName(row.name);
            const classes = ["row", row.isDir ? "dir" : "", index === panel.cursor ? "sel" : "", panel.marked[row.name] ? "mark" : "", drop.rowName === row.name ? `drop-row drop-${drop.rowCue}` : ""];
            return (
              <div
                key={row.isUp ? ".." : row.name}
                data-row-name={row.isUp ? ".." : row.name}
                data-row-dir={row.isDir ? "true" : undefined}
                data-row-up={row.isUp ? "true" : undefined}
                role="option"
                aria-selected={!!panel.marked[row.name]}
                className={classes.join(" ")}
                style={{ position: "absolute", top: index * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0 }}
                onClick={(event) => {
                  setActive(side);
                  if (event.shiftKey) extendSelection(side, index);
                  else if (event.metaKey || event.ctrlKey) toggleAt(side, index);
                  else selectOnly(side, index);
                }}
                onDoubleClick={() => openRow(index)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openRowMenu(side, index, event.clientX, event.clientY);
                }}
              >
                <span className="name">
                  <EntryIcon isDir={!!row.isDir} isUp={!!row.isUp} ext={ext} />
                  <span className="label">{row.isUp ? ".." : base}</span>
                </span>
                <span>{row.isDir && !row.isUp ? "<DIR>" : ext}</span>
                <span className="num">{row.isUp || row.isDir ? "" : formatSize(row.size)}</span>
                <span className="date">{row.isUp || row.isDir ? "" : formatDate(row.modified)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="sr-only" role="status" aria-live="polite">{panel.selectionNote}</div>
      <div className={`pfoot${panel.loading && !panel.error ? " loading" : ""}`} role={panel.error ? "alert" : undefined}>
        {panel.error
          ? panel.error
          : panel.loading
            ? "Loading..."
            : panel.notice
              ? panel.notice
              : markedNames.length
              ? `${markedNames.length} selected, ${formatSize(markedSize)}`
              : `${panel.entries.length} item(s)${panel.nextToken ? " (more below)" : ""}`}
        {panel.source?.kind === "bucket" && panel.nextToken && !panel.error && (
          <span className="sort-hint">
            sorted over loaded items
            <button type="button" disabled={panel.loading} onClick={() => void loadAll(side)}>Load all</button>
          </span>
        )}
      </div>
    </div>
  );
}
