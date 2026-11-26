import { useState } from "react";
import { useBrowseStore, type Side } from "../browse/browse_store";
import { matchNames } from "../browse/selection";
import { Buttons, Modal } from "./modal";
import { cancelDialog } from "./ops_flow";

/** "Select by pattern" / "Deselect by pattern": a glob (`*`, `?`) over the full names of the panel's rows, with the match count shown before it applies. */
export function PatternDialog({ side, mode }: { side: Side; mode: "select" | "deselect" }) {
  const [pattern, setPattern] = useState("");
  const names = useBrowseStore((state) => state[side].entries).map((entry) => entry.name);
  const count = matchNames(names, pattern).length;
  const title = mode === "select" ? "Select by pattern" : "Deselect by pattern";

  function apply() {
    if (!count) return;
    useBrowseStore.getState().applyPattern(side, pattern, mode);
    cancelDialog();
  }

  return (
    <Modal title={title} onCancel={cancelDialog} onConfirm={apply}>
      <input
        data-autofocus
        aria-label="Pattern"
        aria-describedby="pattern-count"
        placeholder="*.csv  report-??.txt"
        value={pattern}
        spellCheck={false}
        onChange={(event) => setPattern(event.currentTarget.value)}
      />
      <div id="pattern-count" data-testid="pattern-count" className="muted" aria-live="polite">{`${count} of ${names.length} match`}</div>
      <Buttons>
        <button type="button" onClick={cancelDialog}>Cancel</button>
        <button type="button" className="primary" disabled={!count} onClick={apply}>{mode === "select" ? "Select" : "Deselect"}</button>
      </Buttons>
    </Modal>
  );
}
