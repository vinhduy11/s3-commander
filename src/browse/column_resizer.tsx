import { useRef } from "react";
import { useBrowseStore, type Side } from "./browse_store";
import { BIG_STEP_PX, COLUMN_LIMITS, STEP_PX, type ColumnKey } from "./panel_columns";

/**
 * Border on the left edge of a header cell. Dragging it left widens the column (Name gives way);
 * pointer events with capture, never HTML5 drag. Lives beside the sort button, so it never sorts.
 */
export function ColumnResizer({ side, col, label }: { side: Side; col: ColumnKey; label: string }) {
  const width = useBrowseStore((state) => state.columnWidths[side][col]);
  const grab = useRef<{ x: number; width: number } | null>(null);
  const { min, max } = COLUMN_LIMITS[col];
  const set = (px: number) => useBrowseStore.getState().setColumnWidth(side, col, px);

  function onKeyDown(event: React.KeyboardEvent) {
    event.stopPropagation(); // the panel's own keys (Home = first row, Tab = other panel) must not also run
    const sign = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    if (event.key === "Home") useBrowseStore.getState().resetColumnWidth(side, col);
    else if (sign) set(useBrowseStore.getState().columnWidths[side][col] + sign * (event.shiftKey ? BIG_STEP_PX : STEP_PX));
    else return;
    event.preventDefault();
  }

  function onPointerDown(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    grab.current = { x: event.clientX, width: useBrowseStore.getState().columnWidths[side][col] };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // capture is best effort; the drag still works while the pointer stays over the border
    }
    document.body.classList.add("resizing");
    event.preventDefault();
  }
  const end = () => {
    grab.current = null;
    document.body.classList.remove("resizing");
  };

  return (
    <span
      className="col-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => grab.current && set(grab.current.width + (grab.current.x - event.clientX))}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={() => useBrowseStore.getState().resetColumnWidth(side, col)}
    />
  );
}
