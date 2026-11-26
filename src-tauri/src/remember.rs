//! "Remember on this device": the derived vault key in the OS keychain, used only at app launch.
//! Pure logic over the `KeyStore` trait and the settings file; no Tauri dependency. Neither the
//! master key nor the derived key appears in any error, log or event.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::key_store::KeyStore;
use crate::settings;
use crate::unlock_throttle::{unlock_guarded, Clock, UnlockThrottle};
use crate::vault::{Vault, VaultError};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct RememberStatus {
    /// The system has a usable keychain.
    pub available: bool,
    /// The setting is on and can work (an unavailable keychain never reports on).
    pub enabled: bool,
}

pub fn status(store: &dyn KeyStore, settings_path: &Path) -> RememberStatus {
    let available = store.is_available();
    RememberStatus { available, enabled: available && settings::load(settings_path).remember_on_device }
}

/// The remembered key may be tried once per run (at launch). A lock never re-arms it, so after
/// Lock or the idle auto-lock only the master key opens the vault.
pub struct LaunchGate(AtomicBool);

impl LaunchGate {
    pub fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    /// True the first time only.
    fn take(&self) -> bool {
        !self.0.swap(true, Ordering::SeqCst)
    }
}

impl Default for LaunchGate {
    fn default() -> Self {
        Self::new()
    }
}

fn set_flag(settings_path: &Path, on: bool) -> Result<(), String> {
    let mut current = settings::load(settings_path);
    current.remember_on_device = on;
    settings::save(settings_path, &current)
}

/// Store the open vault's derived key and turn the setting on. Nothing changes on failure.
pub fn enable(vault: &Vault, store: &dyn KeyStore, settings_path: &Path) -> Result<(), String> {
    if !store.is_available() {
        return Err("The system keychain is not available.".into());
    }
    let key = vault.derived_key().map_err(|err| err.to_string())?;
    store.set(&key).map_err(|err| err.to_string())?;
    if let Err(err) = set_flag(settings_path, true) {
        let _ = store.delete(); // never leave a key stored while the setting says off
        return Err(err);
    }
    Ok(())
}

/// Turn the setting off and delete the entry (used by the toggle and by Forget); idempotent.
pub fn forget(store: &dyn KeyStore, settings_path: &Path) -> Result<(), String> {
    set_flag(settings_path, false)?;
    store.delete().map_err(|err| err.to_string())
}

/// Launch only. True when the vault is now open. Every other outcome (setting off, no keychain,
/// no entry, a key that no longer decrypts, a second call in the same run) is a silent false, and
/// the caller shows the master key screen. A key that fails to decrypt is deleted.
pub fn unlock_remembered(vault: &mut Vault, store: &dyn KeyStore, settings_path: &Path, gate: &LaunchGate) -> bool {
    if !gate.take() || !settings::load(settings_path).remember_on_device || !store.is_available() {
        return false;
    }
    let Ok(Some(key)) = store.get() else { return false };
    match vault.unlock_with_key(&key) {
        Ok(()) => true,
        Err(VaultError::Decrypt) => {
            let _ = store.delete();
            false
        }
        Err(_) => false,
    }
}

/// Master-key unlock (throttled), then, with the setting on, make the keychain hold the current
/// derived key: the Argon2 upgrade writes a new salt, which changes it.
pub fn unlock_with_master(
    vault: &mut Vault,
    throttle: &mut UnlockThrottle,
    clock: &dyn Clock,
    master_key: &str,
    store: &dyn KeyStore,
    settings_path: &Path,
) -> Result<(), VaultError> {
    unlock_guarded(vault, throttle, clock, master_key)?;
    refresh(vault, store, settings_path);
    Ok(())
}

/// Best effort and silent: the unlock already succeeded.
fn refresh(vault: &Vault, store: &dyn KeyStore, settings_path: &Path) {
    if !settings::load(settings_path).remember_on_device || !store.is_available() {
        return;
    }
    let Ok(key) = vault.derived_key() else { return };
    if matches!(store.get(), Ok(Some(stored)) if *stored == *key) {
        return;
    }
    let _ = store.set(&key);
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::path::PathBuf;

    use super::*;
    use crate::key_store::memory::MemoryKeyStore;
    use crate::key_store::KeyStore;
    use crate::settings::{self, AppSettings};
    use crate::unlock_throttle::{Clock, UnlockThrottle};
    use crate::vault::{KdfParams, Vault, VaultError};

    const CHEAP: KdfParams = KdfParams { m_cost: 8, t_cost: 1, p_cost: 1 };
    const STRONGER: KdfParams = KdfParams { m_cost: 16, t_cost: 2, p_cost: 1 };

    struct Clk(Cell<u64>);
    impl Clock for Clk {
        fn now_ms(&self) -> u64 {
            self.0.get()
        }
    }

    struct Env {
        dir: tempfile::TempDir,
    }

    impl Env {
        fn new() -> Self {
            Self { dir: tempfile::tempdir().unwrap() }
        }
        fn vault_path(&self) -> PathBuf {
            self.dir.path().join("vault.json")
        }
        fn settings_path(&self) -> PathBuf {
            self.dir.path().join("settings.json")
        }
        fn vault(&self, target: KdfParams) -> Vault {
            Vault::with_target(self.vault_path(), target)
        }
        /// A created, unlocked vault with the setting enabled.
        fn enabled(&self, store: &MemoryKeyStore) -> Vault {
            let mut vault = self.vault(CHEAP);
            vault.create("correct horse").unwrap();
            enable(&vault, store, &self.settings_path()).unwrap();
            vault
        }
        fn flag(&self) -> bool {
            settings::load(&self.settings_path()).remember_on_device
        }
    }

    #[test]
    fn enabling_stores_the_derived_key_and_turns_the_setting_on() {
        let env = Env::new();
        let store = MemoryKeyStore::new();
        let vault = env.enabled(&store);
        assert_eq!(store.peek().unwrap(), *vault.derived_key().unwrap());
        assert!(env.flag());
        assert_eq!(status(&store, &env.settings_path()), RememberStatus { available: true, enabled: true });
    }

    #[test]
    fn enabling_a_locked_vault_stores_nothing() {
        let env = Env::new();
        let store = MemoryKeyStore::new();
        let mut vault = env.vault(CHEAP);
        vault.create("m").unwrap();
        vault.lock();
        assert!(enable(&vault, &store, &env.settings_path()).is_err());
        assert!(store.peek().is_none());
        assert!(!env.flag());
    }

    #[test]
    fn an_unavailable_keychain_disables_the_option_without_errors() {
        let env = Env::new();
        let store = MemoryKeyStore::unavailable();
        settings::save(&env.settings_path(), &AppSettings { auto_lock_minutes: 15, remember_on_device: true, ..AppSettings::default() }).unwrap();
        assert_eq!(status(&store, &env.settings_path()), RememberStatus { available: false, enabled: false });
        let mut vault = env.vault(CHEAP);
        vault.create("m").unwrap();
        vault.lock();
        assert!(!unlock_remembered(&mut vault, &store, &env.settings_path(), &LaunchGate::new()));
        assert!(!vault.is_unlocked());
        assert!(enable(&vault, &store, &env.settings_path()).is_err());
    }

    #[test]
    fn launch_unlock_with_the_remembered_key_opens_the_vault() {
        let env = Env::new();
        let store = MemoryKeyStore::new();
        let mut vault = env.enabled(&store);
        vault.lock();
        let mut fresh = env.vault(CHEAP); // a new process: nothing in memory
        assert!(unlock_remembered(&mut fresh, &store, &env.settings_path(), &LaunchGate::new()));
        assert!(fresh.is_unlocked());
        assert!(store.peek().is_some());
    }

    #[test]
    fn a_wrong_key_is_deleted_silently_and_the_master_key_screen_follows() {
        let env = Env::new();
        let store = MemoryKeyStore::new();
        env.enabled(&store).lock();
        store.put([9u8; 32]);
        let mut fresh = env.vault(CHEAP);
        assert!(!unlock_remembered(&mut fresh, &store, &env.settings_path(), &LaunchGate::new()));
        assert!(!fresh.is_unlocked());
        assert!(store.peek().is_none());
        assert!(env.flag(), "the setting stays on so the next master-key unlock stores a fresh key");
    }

    #[test]
    fn a_tampered_vault_deletes_the_entry_and_falls_back() {
        let env = Env::new();
        let store = MemoryKeyStore::new();
        env.enabled(&store).lock();
        let mut bytes = std::fs::read(env.vault_path()).unwrap();
        let at = bytes.len() / 2;
        bytes[at] = if bytes[at] == b'A' { b'B' } else { b'A' };
        std::fs::write(env.vault_path(), bytes).unwrap();
        let mut fresh = env.vault(CHEAP);
        assert!(!unlock_remembered(&mut fresh, &store, &env.settings_path(), &LaunchGate::new()));
        assert!(store.peek().is_none());
    }

    #[test]
    fn a_missing_vault_file_is_a_plain_fallback() {
        let env = Env::new();
        let store = MemoryKeyStore::new();
        store.put([1u8; 32]);
        settings::save(&env.settings_path(), &AppSettings { auto_lock_minutes: 15, remember_on_device: true, ..AppSettings::default() }).unwrap();
        let mut vault = env.vault(CHEAP);
        assert!(!unlock_remembered(&mut vault, &store, &env.settings_path(), &LaunchGate::new()));
    }

    #[test]
    fn after_a_lock_from_the_button_or_the_idle_timer_the_master_key_is_required() {
        // Both locks end in `Vault::lock` (the idle callback is the Lock button's path).
        let env = Env::new();
        let store = MemoryKeyStore::new();
        env.enabled(&store).lock();
        let gate = LaunchGate::new();
        let mut vault = env.vault(CHEAP);
        assert!(unlock_remembered(&mut vault, &store, &env.settings_path(), &gate)); // the launch
        vault.lock();
        assert!(!unlock_remembered(&mut vault, &store, &env.settings_path(), &gate));
        assert!(!vault.is_unlocked());
        assert!(store.peek().is_some(), "locking keeps the entry for the next launch");
        vault.unlock("correct horse").unwrap();
    }

    #[test]
    fn the_remembered_key_is_tried_once_per_run_even_when_the_first_try_found_nothing() {
        let env = Env::new();
        let store = MemoryKeyStore::new();
        env.enabled(&store).lock();
        let gate = LaunchGate::new();
        let saved = store.peek().unwrap();
        store.delete().unwrap();
        let mut vault = env.vault(CHEAP);
        assert!(!unlock_remembered(&mut vault, &store, &env.settings_path(), &gate));
        store.put(saved);
        assert!(!unlock_remembered(&mut vault, &store, &env.settings_path(), &gate));
    }

    #[test]
    fn with_the_setting_off_the_stored_key_is_not_used() {
        let env = Env::new();
        let store = MemoryKeyStore::new();
        env.enabled(&store).lock();
        settings::save(&env.settings_path(), &AppSettings { auto_lock_minutes: 15, remember_on_device: false, ..AppSettings::default() }).unwrap();
        let mut vault = env.vault(CHEAP);
        assert!(!unlock_remembered(&mut vault, &store, &env.settings_path(), &LaunchGate::new()));
        assert!(!vault.is_unlocked());
    }

    #[test]
    fn forgetting_deletes_the_entry_turns_the_setting_off_and_is_idempotent() {
        let env = Env::new();
        let store = MemoryKeyStore::new();
        env.enabled(&store);
        forget(&store, &env.settings_path()).unwrap();
        assert!(store.peek().is_none());
        assert!(!env.flag());
        forget(&store, &env.settings_path()).unwrap();
        assert_eq!(status(&store, &env.settings_path()).enabled, false);
    }

    #[test]
    fn a_master_key_unlock_with_the_setting_off_stores_nothing() {
        let env = Env::new();
        let store = MemoryKeyStore::new();
        let mut vault = env.vault(CHEAP);
        vault.create("m").unwrap();
        vault.lock();
        let mut throttle = UnlockThrottle::load(env.dir.path().join("t.json"));
        unlock_with_master(&mut vault, &mut throttle, &Clk(Cell::new(0)), "m", &store, &env.settings_path()).unwrap();
        assert!(store.peek().is_none());
    }

    #[test]
    fn a_master_key_unlock_with_the_setting_on_restores_a_missing_entry() {
        let env = Env::new();
        let store = MemoryKeyStore::new();
        env.enabled(&store).lock();
        store.delete().unwrap();
        let mut vault = env.vault(CHEAP);
        let mut throttle = UnlockThrottle::load(env.dir.path().join("t.json"));
        unlock_with_master(&mut vault, &mut throttle, &Clk(Cell::new(0)), "correct horse", &store, &env.settings_path()).unwrap();
        assert_eq!(store.peek().unwrap(), *vault.derived_key().unwrap());
    }

    #[test]
    fn the_argon2_upgrade_changes_the_key_and_the_entry_is_refreshed_after_that_unlock() {
        let env = Env::new();
        let store = MemoryKeyStore::new();
        env.enabled(&store).lock();
        let old_key = store.peek().unwrap();
        let mut upgrading = env.vault(STRONGER); // target above the file: the unlock re-keys
        let mut throttle = UnlockThrottle::load(env.dir.path().join("t.json"));
        unlock_with_master(&mut upgrading, &mut throttle, &Clk(Cell::new(0)), "correct horse", &store, &env.settings_path()).unwrap();
        let new_key = store.peek().unwrap();
        assert_ne!(new_key, old_key, "a new salt gives a new derived key");
        assert_eq!(new_key, *upgrading.derived_key().unwrap());
        upgrading.lock();
        let mut fresh = env.vault(STRONGER);
        assert!(unlock_remembered(&mut fresh, &store, &env.settings_path(), &LaunchGate::new()));
    }

    #[test]
    fn the_old_key_after_an_upgrade_is_stale_and_removed() {
        let env = Env::new();
        let store = MemoryKeyStore::new();
        env.enabled(&store).lock();
        let old_key = store.peek().unwrap();
        let mut upgrading = env.vault(STRONGER);
        upgrading.unlock("correct horse").unwrap(); // upgraded, entry not refreshed on this path
        upgrading.lock();
        store.put(old_key);
        let mut fresh = env.vault(STRONGER);
        assert!(!unlock_remembered(&mut fresh, &store, &env.settings_path(), &LaunchGate::new()));
        assert!(store.peek().is_none());
    }

    #[test]
    fn remembered_unlocks_do_not_touch_the_throttle_and_master_key_attempts_are_still_throttled() {
        let env = Env::new();
        let store = MemoryKeyStore::new();
        env.enabled(&store).lock();
        let clock = Clk(Cell::new(1_000));
        let mut throttle = UnlockThrottle::load(env.dir.path().join("t.json"));
        throttle.record_failure(&clock);
        let wait = throttle.remaining_ms(&clock);
        assert!(wait > 0);
        let mut vault = env.vault(CHEAP);
        assert!(unlock_remembered(&mut vault, &store, &env.settings_path(), &LaunchGate::new()));
        assert_eq!(throttle.remaining_ms(&clock), wait);
        vault.lock();
        let err = unlock_with_master(&mut vault, &mut throttle, &clock, "correct horse", &store, &env.settings_path()).unwrap_err();
        assert!(matches!(err, VaultError::Throttled(_)));
    }

    #[test]
    fn errors_and_status_never_contain_the_key_or_the_master_key() {
        let env = Env::new();
        let store = MemoryKeyStore::failing_set();
        let mut vault = env.vault(CHEAP);
        vault.create("correct horse").unwrap();
        let key = vault.derived_key().unwrap();
        let message = enable(&vault, &store, &env.settings_path()).unwrap_err();
        for secret in [hex(&key[..]), b64(&key[..]), "correct horse".to_string()] {
            assert!(!message.contains(&secret));
        }
        assert!(!env.flag(), "a failed store leaves the setting off");
        let json = serde_json::to_string(&status(&store, &env.settings_path())).unwrap();
        assert_eq!(json, r#"{"available":true,"enabled":false}"#);
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn b64(bytes: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }
}
