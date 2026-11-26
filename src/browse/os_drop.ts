// Drop from the OS file manager (Finder, Files) onto a server panel. Tauri's webview drag-drop
// event gives absolute paths and a position in physical pixels relative to the webview; the
// position is mapped to a panel and a folder row with devicePixelRatio. The upload then goes
// through the same flow as F5 (plan, conflicts, busy, result). OS drops always copy.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { localStatPaths, type DroppedPath, type Location, type TopItem } from "../ops/ops_api";
import { startTransferOf } from "../ops/ops_flow";
import { useOpsStore } from "../ops/ops_store";
import { panelLocation } from "../ops/ops_targets";
import { useBrowseStore, type BrowseState, type Side } from "./browse_store";
import { useDragStore } from "./drag_drop";
import { hitTest, type HitTarget } from "./drag_drop_logic";
import { childLocation } from "./drop_locations";

export const physicalToCss = (position: { x: number; y: number }, ratio: number) => {
  const scale = ratio > 0 ? ratio : 1;
  return { x: position.x / scale, y: position.y / scale };
};

export function locateOsDrop(position: { x: number; y: number }, ratio: number): HitTarget | null {
  const point = physicalToCss(position, ratio);
  return hitTest(point.x, point.y);
}

export type OsTarget = { ok: true; destSide: Side; dest: Location } | { ok: false; message: string };

/** Where an OS drop on `target` would upload to. An empty message means "ignore silently". */
export function resolveOsDropTarget(state: BrowseState, target: HitTarget | null): OsTarget {
  if (!target) return { ok: false, message: "" };
  const panel = state[target.side];
  if (!panel.source) return { ok: false, message: "Choose a source for that panel first" };
  if (panel.source.kind === "local") return { ok: false, message: "Drop files onto a server panel to upload them" };
  if (target.isUp) return { ok: false, message: 'Cannot drop onto ".."' };
  const location = panelLocation(panel);
  if (!location) return { ok: false, message: "Choose a source for that panel first" };
  const dest = target.name !== null && target.isDir ? childLocation(location, target.name) : location;
  return { ok: true, destSide: target.side, dest };
}

/** Items relative to their one shared folder; items from different folders are refused. */
export function groupByParent(infos: DroppedPath[]): { parent: string; items: TopItem[] } | { error: string } {
  const parent = infos[0]?.parent;
  if (parent === undefined) return { error: "Nothing to drop" };
  if (infos.some((info) => info.parent !== parent)) return { error: "Drop items from one folder at a time" };
  return { parent, items: infos.map((info) => ({ name: info.name, is_dir: info.is_dir })) };
}

export async function handleOsDrop(paths: string[], position: { x: number; y: number }, ratio = window.devicePixelRatio): Promise<void> {
  if (useOpsStore.getState().dialog) return;
  const toast = useDragStore.getState().showToast;
  const target = resolveOsDropTarget(useBrowseStore.getState(), locateOsDrop(position, ratio));
  if (!target.ok) return target.message ? toast(target.message) : undefined;
  try {
    const group = groupByParent(await localStatPaths(paths));
    if ("error" in group) return toast(group.error);
    const source: Location = { kind: "local", path: group.parent };
    await startTransferOf({ side: target.destSide, destSide: target.destSide, source, dest: target.dest, items: group.items }, "copy");
  } catch (err) {
    toast(String(err));
  }
}

/** Highlight the panel or folder an OS drag is over. */
function showOsHover(position: { x: number; y: number }) {
  const hit = locateOsDrop(position, window.devicePixelRatio);
  const target = resolveOsDropTarget(useBrowseStore.getState(), hit);
  const hover = hit && { side: hit.side, name: hit.name !== null && hit.isDir && !hit.isUp ? hit.name : null };
  useDragStore.getState().setHover(hover, hit ? (target.ok ? "copy" : "refused") : null);
}

/** Listen to the webview's drag-drop events; returns the unlisten function (a no-op outside Tauri). */
export async function listenOsDrop(): Promise<() => void> {
  try {
    return await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") showOsHover(payload.position);
      else if (payload.type === "leave") useDragStore.getState().setHover(null, null);
      else {
        useDragStore.getState().setHover(null, null);
        void handleOsDrop(payload.paths, payload.position);
      }
    });
  } catch {
    return () => {};
  }
}
