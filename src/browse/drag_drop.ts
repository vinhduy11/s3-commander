// In-app drag and drop between and within the panels, built on pointer events (not the HTML5
// draggable API: that is unreliable inside the Tauri webview across WebKit and WebKitGTK and
// conflicts with Tauri's native drag-drop handler). A press on a row becomes a drag after a small
// movement; a press that never moves stays an ordinary click. Drops go through the same flow
// functions as F5 and F6 (startTransferOf). Esc cancels.

import { create } from "zustand";
import { startTransferOf } from "../ops/ops_flow";
import { useOpsStore } from "../ops/ops_store";
import { useBrowseStore, type Side } from "./browse_store";
import { autoScrollStep, dragSet, exceedsThreshold, hitTest, resolveDrop, type HitTarget } from "./drag_drop_logic";

export type DropCue = "copy" | "move" | "refused";
type Hover = { side: Side; /** The folder row under the pointer, or null for the panel body. */ name: string | null };

type DragView = {
  /** A drag is in progress: the ghost is shown. */
  active: boolean;
  x: number;
  y: number;
  label: string;
  hover: Hover | null;
  verdict: DropCue | null;
  reason: string;
  toast: string;
  setHover: (hover: Hover | null, verdict: DropCue | null) => void;
  showToast: (message: string) => void;
  reset: () => void;
};

const TOAST_MS = 3500;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const idle = { active: false, x: 0, y: 0, label: "", hover: null, verdict: null, reason: "" };

export const useDragStore = create<DragView>((set) => ({
  ...idle,
  toast: "",
  setHover: (hover, verdict) => set({ hover, verdict }),
  showToast: (message) => {
    clearTimeout(toastTimer);
    set({ toast: message });
    if (message) toastTimer = setTimeout(() => set({ toast: "" }), TOAST_MS);
  },
  reset: () => {
    clearTimeout(toastTimer);
    set({ ...idle, toast: "" });
  },
}));

type Press = { side: Side; name: string; x: number; y: number };
type Session = { side: Side; names: string[] };

let press: Press | null = null;
let session: Session | null = null;
let cancelled = false;
let last = { x: 0, y: 0, shift: false };
let frame = 0;

/** Row-level hover for a panel's folder rows and body: what the panel should highlight. */
export function useDropHighlight(side: Side): { panelCue: DropCue | null; rowName: string | null; rowCue: DropCue | null } {
  const hover = useDragStore((view) => view.hover);
  const verdict = useDragStore((view) => view.verdict);
  if (!hover || hover.side !== side || !verdict) return { panelCue: null, rowName: null, rowCue: null };
  return hover.name === null ? { panelCue: verdict, rowName: null, rowCue: null } : { panelCue: null, rowName: hover.name, rowCue: verdict };
}

const hoverOf = (hit: HitTarget): Hover => ({ side: hit.side, name: hit.name !== null && hit.isDir ? hit.name : null });

function evaluate(hit: HitTarget | null, shift: boolean) {
  if (!hit || !session) return null;
  return resolveDrop(useBrowseStore.getState(), { from: session.side, names: session.names, to: hit, shift });
}

function refreshView() {
  if (!session) return;
  const hit = hitTest(last.x, last.y);
  const verdict = evaluate(hit, last.shift);
  useDragStore.setState({
    active: true,
    x: last.x,
    y: last.y,
    label: session.names.length === 1 ? session.names[0] : `${session.names.length} items`,
    hover: hit ? hoverOf(hit) : null,
    verdict: !verdict ? null : verdict.ok ? verdict.mode : "refused",
    reason: verdict && !verdict.ok ? verdict.reason : "",
  });
  scrollNearEdge(hit);
}

/** Scroll the hovered list while the pointer rests near its top or bottom edge. */
function scrollNearEdge(hit: HitTarget | null) {
  if (frame || !hit) return;
  const tick = () => {
    frame = 0;
    if (!session) return;
    const list = document.querySelector<HTMLElement>(`[data-panel="${hitTest(last.x, last.y)?.side}"] .list`);
    const rect = list?.getBoundingClientRect();
    if (!list || !rect || rect.bottom <= rect.top) return;
    const step = autoScrollStep(last.y, rect);
    if (!step) return;
    list.scrollTop += step;
    refreshView();
    if (!frame) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}

function swallowNextClick() {
  const swallow = (event: Event) => event.stopPropagation();
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 80);
}

function endAll() {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onAbort);
  window.removeEventListener("blur", onAbort);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("keyup", onShift, true);
  cancelAnimationFrame(frame);
  frame = 0;
  press = null;
  session = null;
  cancelled = false;
  document.body.classList.remove("dragging");
  useDragStore.setState({ ...idle });
}

function onMove(event: PointerEvent | MouseEvent) {
  last = { x: event.clientX, y: event.clientY, shift: event.shiftKey };
  if (cancelled) return;
  if (!session && press && exceedsThreshold(press, { x: last.x, y: last.y })) {
    const names = dragSet(useBrowseStore.getState()[press.side], press.name);
    if (!names.length) return endAll();
    session = { side: press.side, names };
    document.body.classList.add("dragging");
  }
  if (session) {
    event.preventDefault();
    refreshView();
  }
}

function onUp(event: PointerEvent | MouseEvent) {
  const dragging = session;
  if (dragging) swallowNextClick();
  if (dragging && !cancelled) {
    const hit = hitTest(event.clientX, event.clientY);
    const verdict = evaluate(hit, event.shiftKey);
    if (verdict?.ok) void startTransferOf(verdict.operation, verdict.mode);
    else if (verdict) useDragStore.getState().showToast(verdict.reason);
  } else if (cancelled) swallowNextClick();
  endAll();
}

const onAbort = () => endAll();

function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape") return onShift(event);
  event.preventDefault();
  event.stopPropagation();
  cancelled = true;
  session = null;
  cancelAnimationFrame(frame);
  frame = 0;
  document.body.classList.remove("dragging");
  useDragStore.setState({ ...idle });
}

function onShift(event: KeyboardEvent) {
  if (event.key !== "Shift" || !session) return;
  last = { ...last, shift: event.shiftKey };
  refreshView();
}

/** Start tracking a press on a row. False when it cannot start a drag (button, "..", dialog open). */
export function pressRow(side: Side, name: string, x: number, y: number, button = 0): boolean {
  if (button !== 0 || name === ".." || useOpsStore.getState().dialog) return false;
  if (press) endAll();
  press = { side, name, x, y };
  last = { x, y, shift: false };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onAbort);
  window.addEventListener("blur", onAbort);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onShift, true);
  return true;
}

/** Props for a panel's root element: the hit-test marker and the pointer-down entry point. */
export function panelDragProps(side: Side) {
  return {
    "data-panel": side,
    onPointerDown: (event: React.PointerEvent) => {
      const row = (event.target as Element).closest<HTMLElement>("[data-row-name]");
      if (row?.dataset.rowName) pressRow(side, row.dataset.rowName, event.clientX, event.clientY, event.button);
    },
  };
}
