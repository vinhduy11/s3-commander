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
export type RememberStatus = { available: boolean; enabled: boolean };

export const useSettingsStore = create<{
  autoLockMinutes: number;
  error: string;
  remember: RememberStatus;
  load: () => Promise<void>;
  setAutoLock: (minutes: number) => Promise<void>;
  loadRemember: () => Promise<void>;
  setRemember: (enabled: boolean) => Promise<void>;
  forgetRemember: () => Promise<void>;
}>((set) => ({
  autoLockMinutes: 15,
  error: "",
  remember: { available: true, enabled: false },
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
}));
