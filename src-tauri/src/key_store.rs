//! The OS keychain behind a small trait, so tests never touch the real one. The one thing stored is
//! the vault's 32-byte derived key (never the master key text), as base64 under a fixed account.

use zeroize::Zeroizing;

pub const KEYCHAIN_SERVICE: &str = "dev.local.s3commander";
const KEYCHAIN_ACCOUNT: &str = "vault-derived-key";

/// A keychain failure. The message comes from the platform and never contains the key.
#[derive(Debug, Clone, PartialEq)]
pub struct KeyStoreError(pub String);

impl std::fmt::Display for KeyStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub trait KeyStore: Send + Sync {
    /// False on systems without a usable keychain (typical on minimal Linux setups); never an error.
    fn is_available(&self) -> bool;
    fn get(&self) -> Result<Option<Zeroizing<[u8; 32]>>, KeyStoreError>;
    fn set(&self, key: &[u8; 32]) -> Result<(), KeyStoreError>;
    /// Idempotent: deleting an entry that is not there succeeds.
    fn delete(&self) -> Result<(), KeyStoreError>;
}

/// Apple Keychain on macOS, Secret Service on Linux (via the `keyring` crate).
pub struct SystemKeyStore {
    account: &'static str,
}

impl SystemKeyStore {
    pub fn new() -> Self {
        Self::with_account(KEYCHAIN_ACCOUNT)
    }

    pub fn with_account(account: &'static str) -> Self {
        Self { account }
    }

    fn entry(&self) -> Result<keyring::Entry, KeyStoreError> {
        keyring::Entry::new(KEYCHAIN_SERVICE, self.account).map_err(platform_error)
    }
}

impl Default for SystemKeyStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Platform errors name the failure, not the value; keep only that.
fn platform_error(err: keyring::Error) -> KeyStoreError {
    KeyStoreError(format!("keychain error: {err}"))
}

impl KeyStore for SystemKeyStore {
    fn is_available(&self) -> bool {
        keyring::Entry::store_status().is_ok()
    }

    fn get(&self) -> Result<Option<Zeroizing<[u8; 32]>>, KeyStoreError> {
        use base64::Engine;
        let text = match self.entry()?.get_password() {
            Ok(text) => Zeroizing::new(text),
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(err) => return Err(platform_error(err)),
        };
        // A value of the wrong shape is treated as absent; the next remembered unlock overwrites it.
        let bytes = Zeroizing::new(base64::engine::general_purpose::STANDARD.decode(text.as_bytes()).unwrap_or_default());
        Ok(<[u8; 32]>::try_from(bytes.as_slice()).ok().map(Zeroizing::new))
    }

    fn set(&self, key: &[u8; 32]) -> Result<(), KeyStoreError> {
        use base64::Engine;
        let text = Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(key));
        self.entry()?.set_password(&text).map_err(platform_error)
    }

    fn delete(&self) -> Result<(), KeyStoreError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(platform_error(err)),
        }
    }
}

#[cfg(test)]
pub mod memory {
    use std::sync::Mutex;

    use zeroize::Zeroizing;

    use super::{KeyStore, KeyStoreError};

    /// In-memory stand-in: tests and CI never touch the real keychain.
    pub struct MemoryKeyStore {
        slot: Mutex<Option<[u8; 32]>>,
        available: bool,
        fail_set: bool,
    }

    impl MemoryKeyStore {
        pub fn new() -> Self {
            Self { slot: Mutex::new(None), available: true, fail_set: false }
        }
        pub fn unavailable() -> Self {
            Self { available: false, ..Self::new() }
        }
        pub fn failing_set() -> Self {
            Self { fail_set: true, ..Self::new() }
        }
        pub fn peek(&self) -> Option<[u8; 32]> {
            *self.slot.lock().unwrap()
        }
        pub fn put(&self, key: [u8; 32]) {
            *self.slot.lock().unwrap() = Some(key);
        }
    }

    impl KeyStore for MemoryKeyStore {
        fn is_available(&self) -> bool {
            self.available
        }
        fn get(&self) -> Result<Option<Zeroizing<[u8; 32]>>, KeyStoreError> {
            Ok(self.peek().map(Zeroizing::new))
        }
        fn set(&self, key: &[u8; 32]) -> Result<(), KeyStoreError> {
            if self.fail_set {
                return Err(KeyStoreError("the keychain refused the write".into()));
            }
            self.put(*key);
            Ok(())
        }
        fn delete(&self) -> Result<(), KeyStoreError> {
            *self.slot.lock().unwrap() = None;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::memory::MemoryKeyStore;
    use super::*;

    #[test]
    fn set_get_delete_and_delete_again() {
        let store = MemoryKeyStore::new();
        assert!(store.get().unwrap().is_none());
        store.set(&[5u8; 32]).unwrap();
        assert_eq!(*store.get().unwrap().unwrap(), [5u8; 32]);
        store.delete().unwrap();
        store.delete().unwrap();
        assert!(store.get().unwrap().is_none());
    }

    /// Manual check against the real keychain of the machine running it:
    /// `cargo test -- --ignored real_keychain` (macOS may ask for permission). Uses its own account.
    #[test]
    #[ignore]
    fn real_keychain_round_trip() {
        let store = SystemKeyStore::with_account("manual-test-account");
        assert!(store.is_available());
        store.set(&[7u8; 32]).unwrap();
        assert_eq!(*store.get().unwrap().unwrap(), [7u8; 32]);
        store.delete().unwrap();
        store.delete().unwrap();
        assert!(store.get().unwrap().is_none());
    }
}
