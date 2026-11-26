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

type Stored = { auto_lock_minutes: number };

export const useSettingsStore = create<{
  autoLockMinutes: number;
  error: string;
  load: () => Promise<void>;
  setAutoLock: (minutes: number) => Promise<void>;
}>((set) => ({
  autoLockMinutes: 15,
  error: "",
  load: async () => {
    try {
      const stored = await invoke<Stored>("settings_get");
      set({ autoLockMinutes: stored.auto_lock_minutes, error: "" });
    } catch (err) {
      set({ error: String(err) });
    }
  },
  setAutoLock: async (minutes) => {
    try {
      const stored = await invoke<Stored>("settings_set", { settings: { auto_lock_minutes: minutes } });
      set({ autoLockMinutes: stored.auto_lock_minutes, error: "" });
    } catch (err) {
      set({ error: String(err) });
    }
  },
}));
