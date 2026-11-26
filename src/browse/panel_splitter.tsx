import { useRef } from "react";
import { useBrowseStore } from "./browse_store";
import { DEFAULT_RATIO, MAX_RATIO, MIN_RATIO, ratioFromPointer, SPLITTER_PX, stepRatio } from "./panel_split";

const STEP_PX = 16;
const BIG_STEP_PX = 64;

/** Grid column template for a split: the minimum panel width is enforced by the grid itself. */
export const splitColumns = (ratio: number) =>
  ({ "--col-left": `${Math.round(ratio * 1000)}fr`, "--col-right": `${Math.round((1 - ratio) * 1000)}fr` }) as React.CSSProperties;

/** Draggable divider between the panels. Rendered as a direct child of the `.panels` grid, outside both panels. */
export function PanelSplitter() {
  const ratio = useBrowseStore((state) => state.splitRatio);
  const ref = useRef<HTMLDivElement>(null);
  const grab = useRef<number | null>(null); // pointer x minus splitter centre at press time

  const grid = () => ref.current!.parentElement!.getBoundingClientRect();
  const set = useBrowseStore.getState().setSplitRatio;

  function onKeyDown(event: React.KeyboardEvent) {
    const sign = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (event.key === "Home") set(DEFAULT_RATIO);
    else if (sign) set(stepRatio(useBrowseStore.getState().splitRatio, sign * (event.shiftKey ? BIG_STEP_PX : STEP_PX), grid().width - SPLITTER_PX));
    else return;
    event.preventDefault();
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    grab.current = event.clientX - (rect.left + rect.width / 2);
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // capture is best effort; the drag still works while the pointer stays over the splitter
    }
    document.body.classList.add("resizing");
    event.preventDefault();
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (grab.current !== null) set(ratioFromPointer(event.clientX - grab.current, grid()));
  };
  const end = () => {
    grab.current = null;
    document.body.classList.remove("resizing");
  };

  return (
    <div
      ref={ref}
      className="panel-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panels"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={MIN_RATIO * 100}
      aria-valuemax={MAX_RATIO * 100}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => set(DEFAULT_RATIO)}
    />
  );
}
