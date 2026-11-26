// The drag ghost and the short refusal message. Purely visual; all state is in drag_drop.ts.

import { useDragStore } from "./drag_drop";

const CUE_TEXT = { copy: "Copy", move: "Move", refused: "Not allowed" } as const;

export function DragLayer() {
  const { active, x, y, label, verdict, reason, toast } = useDragStore();
  return (
    <>
      {active && (
        <div className={`drag-ghost${verdict ? ` ${verdict}` : ""}`} style={{ left: x + 14, top: y + 14 }} aria-hidden="true">
          <span className="drag-label">{label}</span>
          {verdict && <span className="drag-cue">{reason && verdict === "refused" ? reason : CUE_TEXT[verdict]}</span>}
        </div>
      )}
      {toast && (
        <div className="drag-toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
