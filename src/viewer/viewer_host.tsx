// Mounts the viewer only while one is open, and loads its code (CodeMirror, the table) on first
// use, so the main bundle does not carry the editor.

import { lazy, Suspense } from "react";
import { useViewerStore } from "./viewer_store";

const ViewerModal = lazy(() => import("./viewer_modal").then((module) => ({ default: module.ViewerModal })));

export function ViewerHost() {
  const open = useViewerStore((state) => state.session !== null);
  return open ? (
    <Suspense fallback={null}>
      <ViewerModal />
    </Suspense>
  ) : null;
}
