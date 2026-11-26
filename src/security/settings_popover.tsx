import { useEffect, useId, useRef, useState } from "react";
import { GearIcon } from "../icons";
import { AUTO_LOCK_CHOICES, useSettingsStore } from "./settings_store";

/** Settings button with a small popover next to Lock. */
export function SettingsPopover() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const minutes = useSettingsStore((state) => state.autoLockMinutes);
  const error = useSettingsStore((state) => state.error);

  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>("[role=radio][aria-checked=true]")?.focus();
    const away = (event: MouseEvent) => !wrap.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function close() {
    setOpen(false);
    button.current?.focus();
  }

  return (
    <div className="popover-wrap" ref={wrap}>
      <button ref={button} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <GearIcon />Settings
      </button>
      {open && (
        <div
          id={id}
          className="popover"
          role="dialog"
          aria-label="Settings"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            close();
          }}
        >
          <h2>Settings</h2>
          <div className="popover-label" id={`${id}-label`}>Lock after being idle for</div>
          <div className="segmented popover-choices" role="radiogroup" aria-labelledby={`${id}-label`}>
            {AUTO_LOCK_CHOICES.map((choice) => (
              <button
                key={choice.minutes}
                type="button"
                role="radio"
                aria-checked={choice.minutes === minutes}
                onClick={() => void useSettingsStore.getState().setAutoLock(choice.minutes)}
              >
                {choice.label}
              </button>
            ))}
          </div>
          <p className="muted popover-note">
            Locking cancels running transfers and returns to the master key screen. Any unsaved edits in an open file are kept and come back after you unlock.
          </p>
          {error && <p className="alert-text" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
