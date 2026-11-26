import { useEffect, useId, useRef, useState } from "react";
import { GearIcon } from "../icons";
import { statusLine } from "../update/update_logic";
import { useUpdateStore } from "../update/update_store";
import { AUTO_LOCK_CHOICES, useSettingsStore } from "./settings_store";

/** Settings button with a small popover next to Lock. */
export function SettingsPopover() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const minutes = useSettingsStore((state) => state.autoLockMinutes);
  const error = useSettingsStore((state) => state.error);
  const remember = useSettingsStore((state) => state.remember);
  const checkAtLaunch = useSettingsStore((state) => state.checkUpdatesAtLaunch);
  const update = useUpdateStore((state) => state.update);
  const busy = update.phase === "checking" || update.phase === "downloading";
  const status = statusLine(update);
  const hasDialog = update.phase === "available" || update.phase === "downloading" || update.phase === "installed";

  useEffect(() => {
    if (!open) return;
    void useSettingsStore.getState().loadRemember();
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
          <div className="remember">
            <label className={`remember-row${remember.available ? "" : " disabled"}`}>
              <input
                type="checkbox"
                checked={remember.enabled}
                disabled={!remember.available}
                onChange={(event) => void useSettingsStore.getState().setRemember(event.currentTarget.checked)}
              />
              <span>Remember on this device</span>
            </label>
            {remember.available && remember.enabled && (
              <button type="button" onClick={() => void useSettingsStore.getState().forgetRemember()}>Forget</button>
            )}
          </div>
          <p className="muted popover-note">
            {remember.available
              ? "Keeps a key in the system keychain and opens the vault with it only when the app starts. Lock and auto-lock still ask for the master key."
              : "Not available on this system."}
          </p>
          <div className="updates">
            <label className="remember-row">
              <input
                type="checkbox"
                aria-label="Check for updates at launch"
                checked={checkAtLaunch}
                onChange={(event) => void useSettingsStore.getState().setCheckUpdatesAtLaunch(event.currentTarget.checked)}
              />
              <span>Check for updates at launch</span>
            </label>
            <button type="button" disabled={busy} onClick={() => void useUpdateStore.getState().checkManual()}>
              {update.phase === "checking" ? "Checking..." : "Check for updates"}
            </button>
          </div>
          {status && (
            <p className={update.phase === "error" ? "alert-text" : "muted popover-note"} role={update.phase === "error" ? "alert" : "status"} data-update-status>
              {status}
              {hasDialog && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    useUpdateStore.getState().openDialog();
                    setOpen(false);
                  }}
                >
                  View
                </button>
              )}
            </p>
          )}
          <p className="muted popover-note">
            An update check asks GitHub for the release file and nothing else; nothing from your vault, profiles or files is sent. An update is installed only after its signature matches the key built into this app.
          </p>
          {error && <p className="alert-text" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
