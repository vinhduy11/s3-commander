// Opens the pattern dialog; shared by the keyboard (+ and -) and the context menu.

import { useOpsStore } from "../ops/ops_store";
import type { Side } from "./browse_store";

export function openPatternDialog(side: Side, mode: "select" | "deselect"): void {
  if (useOpsStore.getState().dialog) return;
  useOpsStore.getState().setDialog({ kind: "select-pattern", side, mode });
}
