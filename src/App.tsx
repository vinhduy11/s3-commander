import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useBrowseStore } from "./browse/browse_store";
import { attachQueueEvents } from "./queue/queue_events";
import { useQueueStore } from "./queue/queue_store";
import { useOpsStore } from "./ops/ops_store";
import { useSettingsStore } from "./security/settings_store";
import { useAutoLock } from "./security/use_auto_lock";
import { keepUnsavedForLock } from "./viewer/viewer_store";
import { BrowserScreen } from "./screens/browser_screen";
import { MasterKeyScreen } from "./screens/master_key_screen";
import { ProfilesScreen } from "./screens/profiles_screen";
import "./styles.css";

type VaultStatus = { exists: boolean; unlocked: boolean };
type View = "browser" | "profiles";

function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [view, setView] = useState<View>("browser");

  async function refreshStatus() {
    setStatus(await invoke<VaultStatus>("vault_status"));
  }

  useEffect(() => {
    refreshStatus();
  }, []);

  // Locking drops the Rust client and resets the S3 side of the panels; Local keeps its state.
  async function lock() {
    await invoke("vault_lock");
    keepUnsavedForLock();
    useOpsStore.getState().setDialog(null); // no stale question waits behind the lock screen
    useQueueStore.getState().clear();
    useBrowseStore.getState().lock();
    setView("browser");
    await refreshStatus();
  }

  // The queue listens while the app is unlocked, also on the profiles screen, so no event is lost.
  const unlocked = status?.unlocked ?? false;
  useEffect(() => {
    if (!unlocked) return;
    const attached = attachQueueEvents();
    return () => void attached.then((stop) => stop());
  }, [unlocked]);

  // Settings are read once the vault is open; the idle timer runs only while it is.
  useEffect(() => {
    if (unlocked) void useSettingsStore.getState().load();
  }, [unlocked]);
  useAutoLock(unlocked, () => void lock());

  if (!status) return null;
  if (!status.unlocked) return <MasterKeyScreen exists={status.exists} onDone={refreshStatus} />;
  if (view === "profiles") return <ProfilesScreen onBack={() => setView("browser")} onLock={lock} />;
  return <BrowserScreen onManageProfiles={() => setView("profiles")} onLock={lock} />;
}

export default App;
