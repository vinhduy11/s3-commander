import { useLayoutEffect, useRef, useState } from "react";
import { DiskIcon, ServerIcon } from "../icons";
import { EntryIcon } from "../icons";
import { useBrowseStore, type PanelSource, type Side } from "./browse_store";
import { buildRows, formatDate, formatSize, splitName } from "./navigation";
import { goUp, loadAll, loadMore, openRowAt, openSource } from "./panel_loader";
import { type SortKey } from "./sort";
import { openEmptyMenu, openMenuAtCursor, openRowMenu } from "./context_menu";

const ROW_HEIGHT = 22;
const OVERSCAN_ROWS = 8;
const LOAD_MORE_DISTANCE_ROWS = 40;
const DEFAULT_VIEWPORT_HEIGHT = 400;

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
  const buckets = useBrowseStore((state) => state.buckets);
  const { setCursor, toggleMark, setActive, setScrollTop, sortBy } = useBrowseStore.getState();

  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);

  const rows = buildRows(panel.source, panel.path, panel.entries);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = useBrowseStore.getState()[side].scrollTop;
    setViewportHeight(list.clientHeight || DEFAULT_VIEWPORT_HEIGHT);
    const observer = new ResizeObserver(() => setViewportHeight(list.clientHeight || DEFAULT_VIEWPORT_HEIGHT));
    observer.observe(list);
    return () => observer.disconnect();
  }, [side]);

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

  const openRow = (index: number) => openRowAt(side, index);

  /** Shift+F10 / ContextMenu key: open the menu just under the cursor row. */
  function openMenuOnCursor() {
    const rect = listRef.current?.getBoundingClientRect();
    const top = rect ? rect.top + (panel.cursor + 1) * ROW_HEIGHT - (listRef.current?.scrollTop ?? 0) : 0;
    openMenuAtCursor(side, (rect?.left ?? 0) + ROW_HEIGHT, top);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const page = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1);
    const handlers: Record<string, () => void> = {
      ArrowDown: () => setCursor(side, panel.cursor + 1),
      ArrowUp: () => setCursor(side, panel.cursor - 1),
      PageDown: () => setCursor(side, panel.cursor + page),
      PageUp: () => setCursor(side, panel.cursor - page),
      Home: () => setCursor(side, 0),
      End: () => setCursor(side, rows.length - 1),
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
    const handler = event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey) ? openMenuOnCursor : handlers[event.key];
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
      className={`panel${isActive ? " active" : ""}`}
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
        <span className="path" title={panel.path}>{panel.source?.kind === "bucket" ? `/${panel.path}` : panel.path}</span>
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
            </span>
          );
        })}
      </div>
      <div
        className="list"
        ref={listRef}
        onContextMenu={(event) => {
          event.preventDefault();
          openEmptyMenu(side, event.clientX, event.clientY);
        }}
        onScroll={(event) => {
          setScrollTop(side, event.currentTarget.scrollTop);
        }}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
          {rows.slice(first, last).map((row, offset) => {
            const index = first + offset;
            const { base, ext } = row.isDir || row.isUp ? { base: row.name, ext: "" } : splitName(row.name);
            const classes = ["row", row.isDir ? "dir" : "", index === panel.cursor ? "sel" : "", panel.marked[row.name] ? "mark" : ""];
            return (
              <div
                key={row.isUp ? ".." : row.name}
                className={classes.join(" ")}
                style={{ position: "absolute", top: index * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0 }}
                onClick={() => {
                  setActive(side);
                  setCursor(side, index);
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
      <div className={`pfoot${panel.loading && !panel.error ? " loading" : ""}`} role={panel.error ? "alert" : undefined}>
        {panel.error
          ? panel.error
          : panel.loading
            ? "Loading..."
            : markedNames.length
              ? `${formatSize(markedSize)} in ${markedNames.length} marked`
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
