// Locks after the idle time from the settings. Pointer, key, wheel and focus events reset it.

import { useEffect, useRef } from "react";
import { createIdleTimer, type IdleTimer } from "./idle_timer";
import { useSettingsStore } from "./settings_store";

const EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "focus", "touchstart"] as const;

/** Active while `enabled` (the vault is unlocked). `onIdle` runs the normal lock flow. */
export function useAutoLock(enabled: boolean, onIdle: () => void): void {
  const minutes = useSettingsStore((state) => state.autoLockMinutes);
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;
  const timerRef = useRef<IdleTimer | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const timer = createIdleTimer({ minutes: useSettingsStore.getState().autoLockMinutes, onIdle: () => onIdleRef.current() });
    timerRef.current = timer;
    const poke = () => timer.activity();
    EVENTS.forEach((name) => window.addEventListener(name, poke, { capture: true, passive: true }));
    return () => {
      EVENTS.forEach((name) => window.removeEventListener(name, poke, { capture: true }));
      timer.stop();
      timerRef.current = null;
    };
  }, [enabled]);

  useEffect(() => timerRef.current?.setMinutes(minutes), [minutes]);
}
