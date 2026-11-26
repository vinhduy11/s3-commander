// App settings (auto-lock). Rust owns the file; this mirrors it for the UI.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export const AUTO_LOCK_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 1, label: "1 min" },
  { minutes: 5, label: "5 min" },
  { minutes: 15, label: "15 min" },
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 hour" },
  { minutes: 0, label: "Never" },
];

type Stored = { auto_lock_minutes: number; check_updates_at_launch?: boolean };
export type RememberStatus = { available: boolean; enabled: boolean };

const fromStored = (stored: Stored) => ({
  autoLockMinutes: stored.auto_lock_minutes,
  checkUpdatesAtLaunch: stored.check_updates_at_launch ?? true,
  error: "",
});

export const useSettingsStore = create<{
  autoLockMinutes: number;
  checkUpdatesAtLaunch: boolean;
  error: string;
  remember: RememberStatus;
  load: () => Promise<void>;
  setAutoLock: (minutes: number) => Promise<void>;
  setCheckUpdatesAtLaunch: (enabled: boolean) => Promise<void>;
  loadRemember: () => Promise<void>;
  setRemember: (enabled: boolean) => Promise<void>;
  forgetRemember: () => Promise<void>;
}>((set, get) => {
  // Both values are always sent: Rust replaces the whole file (it keeps only the remember flag itself).
  const save = async (settings: Stored) => {
    try {
      set(fromStored(await invoke<Stored>("settings_set", { settings })));
    } catch (err) {
      set({ error: String(err) });
    }
  };
  return {
    autoLockMinutes: 15,
    checkUpdatesAtLaunch: true,
    error: "",
    remember: { available: true, enabled: false },
    load: async () => {
      try {
        set(fromStored(await invoke<Stored>("settings_get")));
      } catch (err) {
        set({ error: String(err) });
      }
    },
    setAutoLock: (minutes) => save({ auto_lock_minutes: minutes, check_updates_at_launch: get().checkUpdatesAtLaunch }),
    setCheckUpdatesAtLaunch: (enabled) => save({ auto_lock_minutes: get().autoLockMinutes, check_updates_at_launch: enabled }),
    // The three keychain calls share one shape: ask Rust, show its answer or its message.
    loadRemember: async () => {
      try {
        set({ remember: await invoke<RememberStatus>("remember_status"), error: "" });
      } catch (err) {
        set({ error: String(err) });
      }
    },
    setRemember: async (enabled) => {
      try {
        set({ remember: await invoke<RememberStatus>("remember_set", { enabled }), error: "" });
      } catch (err) {
        set({ error: String(err) });
      }
    },
    forgetRemember: async () => {
      try {
        set({ remember: await invoke<RememberStatus>("remember_forget"), error: "" });
      } catch (err) {
        set({ error: String(err) });
      }
    },
  };
});
