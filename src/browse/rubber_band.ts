// Rubber-band selection: press on empty list space, drag, and the rows the rectangle touches are
// marked. Pointer capture keeps the gesture on the list; Esc cancels and restores the earlier
// marks. Row presses never reach here (the drag module owns them), and the column borders and the
// splitter sit outside the list.

import { useEffect, useRef, useState, type RefObject } from "react";
import { useOpsStore } from "../ops/ops_store";
import { useBrowseStore, type Side } from "./browse_store";
import { autoScrollStep, exceedsThreshold } from "./drag_drop_logic";
import { buildRows } from "./navigation";
import { bandRows, marksOf, toContentY, type Marks } from "./selection";

export type BandRect = { left: number; top: number; width: number; height: number };

type Session = { startX: number; startY: number; x: number; y: number; clientX: number; clientY: number; base: Marks; additive: boolean; moved: boolean; id: number };

export function useRubberBand(side: Side, listRef: RefObject<HTMLDivElement | null>, rowHeight: number) {
  const [band, setBand] = useState<BandRect | null>(null);
  const session = useRef<Session | null>(null);
  const frame = useRef(0);
  const stopEsc = useRef<(() => void) | null>(null);

  const finish = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    stopEsc.current?.();
    stopEsc.current = null;
    const list = listRef.current;
    if (list && session.current && list.hasPointerCapture?.(session.current.id)) list.releasePointerCapture(session.current.id);
    session.current = null;
    setBand(null);
  };
  useEffect(() => finish, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Marks for the rectangle between the press and the pointer, in the list's scrolled content coordinates. */
  function update() {
    const list = listRef.current;
    const current = session.current;
    if (!list || !current) return;
    const rect = list.getBoundingClientRect();
    const width = list.clientWidth || rect.width;
    const x = Math.max(0, Math.min(current.clientX - rect.left, width));
    const y = toContentY(current.clientY, rect.top, list.scrollTop);
    const top = Math.min(current.startY, y);
    const left = Math.min(current.startX, x);
    setBand({ left, top, width: Math.abs(x - current.startX), height: Math.abs(y - current.startY) });
    const state = useBrowseStore.getState()[side];
    const rows = buildRows(state.source, state.path, state.entries);
    const hit = bandRows(current.startY, y, rowHeight, rows.length);
    const names = hit ? rows.slice(hit.first, hit.last + 1).filter((row) => !row.isUp).map((row) => row.name) : [];
    useBrowseStore.getState().setMarks(side, { ...current.base, ...marksOf(names) });
  }

  function tick() {
    frame.current = 0;
    const list = listRef.current;
    const current = session.current;
    if (!list || !current?.moved) return;
    const rect = list.getBoundingClientRect();
    if (rect.bottom <= rect.top) return;
    const step = autoScrollStep(current.clientY, rect);
    if (!step) return;
    list.scrollTop += step;
    update();
    frame.current = requestAnimationFrame(tick);
  }

  return {
    band,
    handlers: {
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
        const list = listRef.current;
        if (!list || event.button !== 0 || useOpsStore.getState().dialog) return;
        if ((event.target as Element).closest("[data-row-name]")) return;
        const rect = list.getBoundingClientRect();
        if (list.clientWidth > 0 && event.clientX - rect.left >= list.clientWidth) return; // the scrollbar
        const additive = event.shiftKey || event.metaKey || event.ctrlKey;
        const x = event.clientX - rect.left;
        session.current = {
          startX: x, startY: toContentY(event.clientY, rect.top, list.scrollTop), x, y: 0, clientX: event.clientX, clientY: event.clientY,
          base: additive ? { ...useBrowseStore.getState()[side].marked } : {}, additive, moved: false, id: event.pointerId,
        };
        useBrowseStore.getState().setActive(side);
        try { list.setPointerCapture?.(event.pointerId); } catch { /* synthetic or already released pointer */ }
        const onKey = (key: KeyboardEvent) => {
          if (key.key !== "Escape") return;
          key.preventDefault();
          key.stopPropagation();
          if (session.current) useBrowseStore.getState().setMarks(side, session.current.base, true);
          finish();
        };
        window.addEventListener("keydown", onKey, true);
        stopEsc.current = () => window.removeEventListener("keydown", onKey, true);
      },
      onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
        const current = session.current;
        if (!current) return;
        current.clientX = event.clientX;
        current.clientY = event.clientY;
        const list = listRef.current;
        if (!current.moved) {
          const rect = list?.getBoundingClientRect();
          const from = { x: (rect?.left ?? 0) + current.startX, y: (rect?.top ?? 0) + current.startY - (list?.scrollTop ?? 0) };
          if (!exceedsThreshold(from, { x: event.clientX, y: event.clientY })) return;
          current.moved = true;
        }
        update();
        if (!frame.current) frame.current = requestAnimationFrame(tick);
      },
      onPointerUp: () => {
        const current = session.current;
        if (!current) return;
        const state = useBrowseStore.getState();
        if (current.moved) state.setMarks(side, state[side].marked, true);
        else if (!current.additive) state.clearMarks(side);
        finish();
      },
      onPointerCancel: () => finish(),
    },
  };
}
