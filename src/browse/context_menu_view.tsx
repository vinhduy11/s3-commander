import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useOpsStore } from "../ops/ops_store";
import { buildMenuItems, clampMenuPosition, closeMenu, useContextMenu, type MenuItem } from "./context_menu";

/** Menu surface at the pointer. Data-driven: renders whatever `buildMenuItems` returns. */
export function ContextMenu() {
  const menu = useContextMenu((state) => state.menu);
  const dialogOpen = useOpsStore((state) => state.dialog !== null);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  // Snapshot the items when the menu opens; they must not change under the pointer.
  const [items, setItems] = useState<MenuItem[]>([]);

  useLayoutEffect(() => {
    if (!menu) return;
    const list = buildMenuItems(menu.side, menu.kind);
    setItems(list);
    const box = ref.current?.getBoundingClientRect();
    setPosition(
      clampMenuPosition(menu.x, menu.y, { width: box?.width ?? 0, height: box?.height ?? 0 }, { width: window.innerWidth, height: window.innerHeight }),
    );
    const first = ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
    (first ?? ref.current)?.focus({ preventScroll: true });
  }, [menu, items.length]);

  useEffect(() => {
    if (!menu) return;
    const outside = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("scroll", closeMenu, true);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
    };
  }, [menu]);

  useEffect(() => {
    if (dialogOpen) closeMenu();
  }, [dialogOpen]);

  if (!menu) return null;

  const backToPanel = () => document.getElementById(`panel-${menu.side}`)?.focus();

  function run(item: MenuItem) {
    if (!item.enabled) return;
    closeMenu();
    backToPanel();
    item.run();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation(); // F-keys and panel keys must not fire behind the menu
    const enabled = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
    const at = enabled.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => enabled[(to + enabled.length) % enabled.length]?.focus();
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at < 0 ? -1 : at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(-1);
    else if (event.key === "Enter" || event.key === " ") {
      const item = items.find((candidate) => candidate.id === (document.activeElement as HTMLElement | null)?.dataset.id);
      if (item) run(item);
    } else if (event.key === "Escape" || event.key === "Tab") {
      closeMenu();
      backToPanel();
    } else return;
    event.preventDefault();
  }

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label="Actions"
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="ctx-item"
          data-id={item.id}
          tabIndex={-1}
          aria-disabled={!item.enabled}
          onClick={() => run(item)}
        >
          <span className="ctx-label">{item.label}</span>
          {item.shortcut && <kbd className="ctx-key">{item.shortcut}</kbd>}
        </button>
      ))}
    </div>
  );
}
