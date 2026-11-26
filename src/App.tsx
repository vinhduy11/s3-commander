import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useBrowseStore } from "./browse/browse_store";
import { BrowserScreen } from "./screens/browser_screen";
import { MasterKeyScreen } from "./screens/master_key_screen";
import { ProfilesScreen } from "./screens/profiles_screen";
import "./App.css";

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
    useBrowseStore.getState().lock();
    setView("browser");
    await refreshStatus();
  }

  if (!status) return null;
  if (!status.unlocked) return <MasterKeyScreen exists={status.exists} onDone={refreshStatus} />;
  if (view === "profiles") return <ProfilesScreen onBack={() => setView("browser")} onLock={lock} />;
  return <BrowserScreen onManageProfiles={() => setView("profiles")} onLock={lock} />;
}

export default App;
