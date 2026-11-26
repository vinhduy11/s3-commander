// Launch-time unlock with the key kept in the OS keychain ("Remember on this device").

import { invoke } from "@tauri-apps/api/core";

export type VaultStatus = { exists: boolean; unlocked: boolean };

/** The plain status. Used after a Lock: only the master key opens the vault again. */
export const readStatus = () => invoke<VaultStatus>("vault_status");

/**
 * First status of the app run. When the vault is locked, tries the remembered key once (Rust
 * answers false whenever the setting is off, the keychain is missing or the key is stale) and
 * then reads the status again. Any failure falls back to the master key screen.
 */
export async function launchStatus(onTrying: () => void): Promise<VaultStatus> {
  const first = await readStatus();
  if (!first.exists || first.unlocked) return first;
  onTrying();
  try {
    if (await invoke<boolean>("vault_unlock_remembered")) return await readStatus();
  } catch {
    // silent: the master key screen follows
  }
  return first;
}
