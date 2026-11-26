// Pure rules of in-app drag and drop: when a press becomes a drag, what is dragged, which element
// is under the pointer, where a drop goes and when it is refused. No store writes, no I/O.
// Rows are identified by entry name (never by index), so a re-sorted list keeps working.

import { childLocation, isInside, sameLocation } from "./drop_locations";
import type { Mode } from "../ops/ops_api";
import { panelLocation, type Operation } from "../ops/ops_targets";
import type { BrowseState, PanelState, Side } from "./browse_store";

export const DRAG_THRESHOLD_PX = 4;
const AUTOSCROLL_EDGE_PX = 28;
const AUTOSCROLL_MAX_STEP_PX = 16;

type Point = { x: number; y: number };

export const exceedsThreshold = (from: Point, to: Point): boolean =>
  Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD_PX;

/** Pixels to scroll a list per tick: negative near its top edge, positive near the bottom, 0 elsewhere. */
export function autoScrollStep(pointerY: number, rect: { top: number; bottom: number }): number {
  const intoTop = rect.top + AUTOSCROLL_EDGE_PX - pointerY;
  if (intoTop > 0) return -Math.ceil((Math.min(intoTop, AUTOSCROLL_EDGE_PX) / AUTOSCROLL_EDGE_PX) * AUTOSCROLL_MAX_STEP_PX);
  const intoBottom = pointerY - (rect.bottom - AUTOSCROLL_EDGE_PX);
  if (intoBottom > 0) return Math.ceil((Math.min(intoBottom, AUTOSCROLL_EDGE_PX) / AUTOSCROLL_EDGE_PX) * AUTOSCROLL_MAX_STEP_PX);
  return 0;
}

/** Names dragged: the marked rows (listing order) if the dragged row is marked, else just that row. Never "..". */
export function dragSet(panel: PanelState, dragged: string): string[] {
  if (!panel.entries.some((entry) => entry.name === dragged)) return [];
  if (!panel.marked[dragged]) return [dragged];
  return panel.entries.filter((entry) => panel.marked[entry.name]).map((entry) => entry.name);
}

/** What is under the pointer: a panel body (`name` null) or one of its rows. */
export type HitTarget = { side: Side; name: string | null; isDir: boolean; isUp: boolean };

export function targetFromElement(element: Element | null): HitTarget | null {
  const panel = element?.closest<HTMLElement>("[data-panel]");
  if (!element || !panel) return null;
  const side = panel.dataset.panel as Side;
  const row = element.closest<HTMLElement>("[data-row-name]");
  if (!row) return { side, name: null, isDir: false, isUp: false };
  return { side, name: row.dataset.rowName ?? null, isDir: row.dataset.rowDir === "true", isUp: row.dataset.rowUp === "true" };
}

export const hitTest = (x: number, y: number): HitTarget | null => targetFromElement(document.elementFromPoint(x, y));

export type DropRequest = { from: Side; names: string[]; to: HitTarget; shift: boolean };
export type Verdict = { ok: true; mode: Mode; operation: Operation } | { ok: false; reason: string };

const refuse = (reason: string): Verdict => ({ ok: false, reason });

/** Where a drop goes and whether it is allowed. Plain = copy, Shift = move; the same panel always moves. */
export function resolveDrop(state: BrowseState, request: DropRequest): Verdict {
  const { from, names, to, shift } = request;
  if (!names.length) return refuse("Nothing to drop");
  if (to.isUp) return refuse("Cannot drop onto \"..\"");
  const intoFolder = to.name !== null && to.isDir ? to.name : null;
  const samePanel = from === to.side;
  if (samePanel && intoFolder === null) return refuse("Drop on a folder to move items into it");
  const sourcePanel = state[from];
  const source = panelLocation(sourcePanel);
  const panelDest = panelLocation(state[to.side]);
  if (!source) return refuse("Choose a source first");
  if (!panelDest) return refuse("Choose a source for that panel first");
  const items = names.map((name) => ({ name, is_dir: !!sourcePanel.entries.find((entry) => entry.name === name)?.isDir }));
  const dest = intoFolder === null ? panelDest : childLocation(panelDest, intoFolder);
  if (samePanel && names.includes(intoFolder as string)) return refuse("Cannot drop a folder onto itself");
  if (sameLocation(source, dest)) return refuse("Source and destination are the same folder");
  const inside = items.find((item) => item.is_dir && isInside(source, item.name, dest));
  if (inside) return refuse(`Cannot drop "${inside.name}" into itself`);
  return { ok: true, mode: samePanel || shift ? "move" : "copy", operation: { side: from, destSide: to.side, source, dest, items } };
}
