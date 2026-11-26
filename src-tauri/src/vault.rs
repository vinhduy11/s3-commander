//! Encrypted profile vault. No Tauri dependency so it is unit-testable.
//!
//! File = JSON { version, salt, nonce, ciphertext } (base64). The master key is stretched with
//! Argon2id (random salt) into a 32-byte key; the whole profile list is one XChaCha20-Poly1305
//! blob with a fresh random nonce per save. A wrong master key fails on the auth tag.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{aead::{Aead, KeyInit, OsRng}, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use zeroize::Zeroizing;

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("vault is locked")]
    Locked,
    #[error("vault already exists")]
    AlreadyExists,
    #[error("vault not found")]
    NotFound,
    #[error("wrong master key or corrupted vault")]
    Decrypt,
    #[error("invalid profile: {0}")]
    InvalidProfile(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("crypto error: {0}")]
    Crypto(String),
}

pub const DEFAULT_REGION: &str = "us-east-1";

/// Full profile, including the secret. Never serialized to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub access_key: String,
    pub secret_key: String,
    pub region: String,
}

/// What the frontend receives: no secret key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProfileSummary {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub access_key: String,
    pub region: String,
}

/// What the frontend sends. Empty `id` = new profile. Empty `secret_key` on an existing
/// profile keeps the stored secret; empty `region` becomes the default.
#[derive(Debug, Clone, Deserialize)]
pub struct ProfileInput {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub access_key: String,
    pub secret_key: String,
    pub region: String,
}

const FILE_VERSION: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;

#[derive(Serialize, Deserialize)]
struct VaultFile {
    version: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
}

/// Key material that lives only in memory; zeroized on drop.
struct Unlocked {
    key: Zeroizing<[u8; KEY_LEN]>,
    salt: [u8; SALT_LEN],
    profiles: Vec<Profile>,
}

pub struct Vault {
    path: PathBuf,
    unlocked: Option<Unlocked>,
}

fn io_err(err: std::io::Error) -> VaultError {
    VaultError::Io(err.to_string())
}

fn derive_key(master_key: &str, salt: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>, VaultError> {
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    Argon2::default()
        .hash_password_into(master_key.as_bytes(), salt, key.as_mut())
        .map_err(|err| VaultError::Crypto(err.to_string()))?;
    Ok(key)
}

fn decode(field: &str) -> Result<Vec<u8>, VaultError> {
    B64.decode(field).map_err(|_| VaultError::Decrypt)
}

impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self { path, unlocked: None }
    }

    pub fn exists(&self) -> bool {
        self.path.is_file()
    }

    pub fn is_unlocked(&self) -> bool {
        self.unlocked.is_some()
    }

    pub fn create(&mut self, master_key: &str) -> Result<(), VaultError> {
        if self.exists() {
            return Err(VaultError::AlreadyExists);
        }
        if master_key.is_empty() {
            return Err(VaultError::InvalidProfile("master key must not be empty".into()));
        }
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        let key = derive_key(master_key, &salt)?;
        self.unlocked = Some(Unlocked { key, salt, profiles: Vec::new() });
        if let Err(err) = self.persist() {
            self.unlocked = None;
            return Err(err);
        }
        Ok(())
    }

    pub fn unlock(&mut self, master_key: &str) -> Result<(), VaultError> {
        if !self.exists() {
            return Err(VaultError::NotFound);
        }
        let file: VaultFile = serde_json::from_slice(&std::fs::read(&self.path).map_err(io_err)?)
            .map_err(|_| VaultError::Decrypt)?;
        if file.version != FILE_VERSION {
            return Err(VaultError::Decrypt);
        }
        let salt: [u8; SALT_LEN] = decode(&file.salt)?.try_into().map_err(|_| VaultError::Decrypt)?;
        let nonce = decode(&file.nonce)?;
        if nonce.len() != NONCE_LEN {
            return Err(VaultError::Decrypt);
        }
        let key = derive_key(master_key, &salt)?;
        let plaintext = Zeroizing::new(
            XChaCha20Poly1305::new(key.as_ref().into())
                .decrypt(XNonce::from_slice(&nonce), decode(&file.ciphertext)?.as_slice())
                .map_err(|_| VaultError::Decrypt)?,
        );
        let profiles = serde_json::from_slice(&plaintext).map_err(|_| VaultError::Decrypt)?;
        self.unlocked = Some(Unlocked { key, salt, profiles });
        Ok(())
    }

    pub fn lock(&mut self) {
        self.unlocked = None; // Zeroizing wipes the key on drop
    }

    pub fn list_profiles(&self) -> Result<Vec<ProfileSummary>, VaultError> {
        Ok(self.state()?.profiles.iter().map(Profile::summary).collect())
    }

    /// Internal use by later S3 steps; never exposed as a command.
    pub fn get_profile(&self, profile_id: &str) -> Result<Profile, VaultError> {
        self.state()?
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .cloned()
            .ok_or_else(|| VaultError::InvalidProfile("profile not found".into()))
    }

    pub fn save_profile(&mut self, input: ProfileInput) -> Result<ProfileSummary, VaultError> {
        let existing = self.state()?.profiles.iter().position(|profile| profile.id == input.id);
        let secret_key = match existing {
            Some(idx) if input.secret_key.is_empty() => self.state()?.profiles[idx].secret_key.clone(),
            _ => input.secret_key,
        };
        let profile = Profile {
            id: if existing.is_some() { input.id } else { new_profile_id() },
            name: input.name.trim().to_string(),
            endpoint: input.endpoint.trim().to_string(),
            access_key: input.access_key.trim().to_string(),
            secret_key,
            region: match input.region.trim() {
                "" => DEFAULT_REGION.to_string(),
                region => region.to_string(),
            },
        };
        profile.validate()?;
        let summary = profile.summary();
        let state = self.state_mut()?;
        let previous = state.profiles.clone();
        match existing {
            Some(idx) => state.profiles[idx] = profile,
            None => state.profiles.push(profile),
        }
        if let Err(err) = self.persist() {
            self.state_mut()?.profiles = previous;
            return Err(err);
        }
        Ok(summary)
    }

    pub fn delete_profile(&mut self, profile_id: &str) -> Result<(), VaultError> {
        let previous = self.state()?.profiles.clone();
        self.state_mut()?.profiles.retain(|profile| profile.id != profile_id);
        if let Err(err) = self.persist() {
            self.state_mut()?.profiles = previous;
            return Err(err);
        }
        Ok(())
    }

    fn state(&self) -> Result<&Unlocked, VaultError> {
        self.unlocked.as_ref().ok_or(VaultError::Locked)
    }

    fn state_mut(&mut self) -> Result<&mut Unlocked, VaultError> {
        self.unlocked.as_mut().ok_or(VaultError::Locked)
    }

    /// Encrypt the whole profile list with a fresh nonce and replace the file atomically.
    fn persist(&self) -> Result<(), VaultError> {
        let state = self.state()?;
        let plaintext = Zeroizing::new(
            serde_json::to_vec(&state.profiles).map_err(|err| VaultError::Crypto(err.to_string()))?,
        );
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        let ciphertext = XChaCha20Poly1305::new(state.key.as_ref().into())
            .encrypt(XNonce::from_slice(&nonce), plaintext.as_slice())
            .map_err(|err| VaultError::Crypto(err.to_string()))?;
        let file = VaultFile {
            version: FILE_VERSION,
            salt: B64.encode(state.salt),
            nonce: B64.encode(nonce),
            ciphertext: B64.encode(ciphertext),
        };
        write_atomic(&self.path, &serde_json::to_vec(&file).map_err(|err| VaultError::Crypto(err.to_string()))?)
    }
}

impl Profile {
    fn summary(&self) -> ProfileSummary {
        ProfileSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            endpoint: self.endpoint.clone(),
            access_key: self.access_key.clone(),
            region: self.region.clone(),
        }
    }

    fn validate(&self) -> Result<(), VaultError> {
        let required = [
            ("name", &self.name),
            ("endpoint", &self.endpoint),
            ("access key", &self.access_key),
            ("secret key", &self.secret_key),
        ];
        match required.iter().find(|(_, value)| value.is_empty()) {
            Some((field, _)) => Err(VaultError::InvalidProfile(format!("{field} is required"))),
            None => Ok(()),
        }
    }
}

fn new_profile_id() -> String {
    let mut bytes = [0u8; 8];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), VaultError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(io_err)?;
    }
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, contents).map_err(io_err)?;
    std::fs::rename(&tmp_path, path).map_err(io_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn sample_input(name: &str) -> ProfileInput {
        ProfileInput {
            id: String::new(),
            name: name.into(),
            endpoint: "http://localhost:9000".into(),
            access_key: "test-access".into(),
            secret_key: "test-secret-value".into(),
            region: String::new(),
        }
    }

    fn new_vault(dir: &tempfile::TempDir) -> Vault {
        Vault::new(dir.path().join("vault.json"))
    }

    #[test]
    fn create_then_unlock_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        assert!(!vault.exists());
        vault.create("master-1").unwrap();
        assert!(vault.exists() && vault.is_unlocked());
        vault.lock();
        assert!(!vault.is_unlocked());
        vault.unlock("master-1").unwrap();
        assert!(vault.is_unlocked());
        assert!(matches!(vault.create("again"), Err(VaultError::AlreadyExists)));
    }

    #[test]
    fn wrong_master_key_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        vault.create("right").unwrap();
        vault.lock();
        assert!(matches!(vault.unlock("wrong"), Err(VaultError::Decrypt)));
        assert!(!vault.is_unlocked());
    }

    #[test]
    fn tampered_file_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        vault.create("right").unwrap();
        vault.save_profile(sample_input("a")).unwrap();
        vault.lock();
        let path = dir.path().join("vault.json");
        let mut file: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let cipher = file["ciphertext"].as_str().unwrap().to_string();
        // flip the first base64 char
        let flipped = if cipher.starts_with('A') { "B" } else { "A" };
        file["ciphertext"] = format!("{flipped}{}", &cipher[1..]).into();
        fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
        assert!(matches!(vault.unlock("right"), Err(VaultError::Decrypt)));
    }

    #[test]
    fn profiles_persist_across_lock_unlock() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        vault.create("m").unwrap();
        let saved = vault.save_profile(sample_input("one")).unwrap();
        vault.lock();
        let mut reopened = new_vault(&dir);
        reopened.unlock("m").unwrap();
        let listed = reopened.list_profiles().unwrap();
        assert_eq!(listed, vec![saved.clone()]);
        assert_eq!(listed[0].region, DEFAULT_REGION);
        assert_eq!(reopened.get_profile(&saved.id).unwrap().secret_key, "test-secret-value");
        reopened.delete_profile(&saved.id).unwrap();
        assert!(reopened.list_profiles().unwrap().is_empty());
    }

    #[test]
    fn edit_with_empty_secret_keeps_stored_secret() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        vault.create("m").unwrap();
        let saved = vault.save_profile(sample_input("one")).unwrap();
        let mut edit = sample_input("renamed");
        edit.id = saved.id.clone();
        edit.secret_key = String::new();
        vault.save_profile(edit).unwrap();
        let profile = vault.get_profile(&saved.id).unwrap();
        assert_eq!(profile.name, "renamed");
        assert_eq!(profile.secret_key, "test-secret-value");
    }

    #[test]
    fn list_output_never_contains_secret_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        vault.create("m").unwrap();
        vault.save_profile(sample_input("one")).unwrap();
        let json = serde_json::to_string(&vault.list_profiles().unwrap()).unwrap();
        assert!(!json.contains("test-secret-value"));
        assert!(!json.contains("secret_key"));
    }

    #[test]
    fn vault_file_does_not_contain_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        vault.create("m").unwrap();
        vault.save_profile(sample_input("one")).unwrap();
        let raw = fs::read_to_string(dir.path().join("vault.json")).unwrap();
        assert!(!raw.contains("test-secret-value") && !raw.contains("test-access"));
    }

    #[test]
    fn nonce_differs_between_saves() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        vault.create("m").unwrap();
        let path = dir.path().join("vault.json");
        let nonce_of = || {
            let file: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            file["nonce"].as_str().unwrap().to_string()
        };
        let first = nonce_of();
        vault.save_profile(sample_input("one")).unwrap();
        let second = nonce_of();
        vault.save_profile(sample_input("two")).unwrap();
        let third = nonce_of();
        assert!(first != second && second != third && first != third);
    }

    #[test]
    fn profile_operations_fail_when_locked() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        vault.create("m").unwrap();
        vault.lock();
        assert!(matches!(vault.list_profiles(), Err(VaultError::Locked)));
        assert!(matches!(vault.save_profile(sample_input("x")), Err(VaultError::Locked)));
        assert!(matches!(vault.delete_profile("x"), Err(VaultError::Locked)));
    }

    #[test]
    fn invalid_profile_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        vault.create("m").unwrap();
        let mut bad = sample_input("");
        assert!(matches!(vault.save_profile(bad.clone()), Err(VaultError::InvalidProfile(_))));
        bad = sample_input("n");
        bad.secret_key = String::new(); // new profile needs a secret
        assert!(matches!(vault.save_profile(bad), Err(VaultError::InvalidProfile(_))));
    }
}
