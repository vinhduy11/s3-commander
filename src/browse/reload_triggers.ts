// Cmd/Ctrl+R (reload the active panel) and the reload of Local panels when the window regains
// focus. Both are plain window listeners installed once by the browser screen.

import { useOpsStore } from "../ops/ops_store";
import { useViewerStore } from "../viewer/viewer_store";
import { useBrowseStore, type Side } from "./browse_store";
import { useContextMenu } from "./context_menu";
import { useDragStore } from "./drag_drop";
import { reloadPanel } from "./panel_loader";

export const FOCUS_RELOAD_DELAY_MS = 1000;

const overlayOpen = () => useOpsStore.getState().dialog !== null || useViewerStore.getState().session !== null;
const typingIn = (target: EventTarget | null) =>
  target instanceof HTMLElement && (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable);

/** Reload shortcut label for menus and tooltips. */
export const reloadShortcut = () => (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘R" : "Ctrl+R");

export function installReloadKey(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "r") return;
    event.preventDefault(); // the webview itself must never reload
    if (overlayOpen() || useContextMenu.getState().menu !== null || typingIn(event.target)) return;
    void reloadPanel(useBrowseStore.getState().active);
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

/** The user usually changes files in Finder and comes back: refresh Local panels, silently. Server panels never. */
export function installFocusReload(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    // A rubber band is local to its hook; its rectangle element exists only while it is drawn.
    if (overlayOpen() || useDragStore.getState().active || document.querySelector(".band")) return;
    for (const side of ["left", "right"] as Side[]) {
      const panel = useBrowseStore.getState()[side];
      if (panel.source?.kind === "local" && !panel.loading) void reloadPanel(side, { silent: true });
    }
  };
  const onFocus = () => {
    clearTimeout(timer);
    timer = setTimeout(run, FOCUS_RELOAD_DELAY_MS);
  };
  window.addEventListener("focus", onFocus);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("focus", onFocus);
  };
}
