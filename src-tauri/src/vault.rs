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

use crate::profile_rules::{validate_profile_input, FieldError};

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
    #[error("invalid profile: {}", join_errors(.0))]
    Validation(Vec<FieldError>),
    #[error("io error: {0}")]
    Io(String),
    #[error("crypto error: {0}")]
    Crypto(String),
}

fn join_errors(errors: &[FieldError]) -> String {
    errors.iter().map(|e| e.message.as_str()).collect::<Vec<_>>().join(" ")
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
        let state = self.state()?;
        let existing = state.profiles.iter().position(|profile| profile.id == input.id);
        let others: Vec<&str> = state
            .profiles
            .iter()
            .enumerate()
            .filter(|(idx, _)| Some(*idx) != existing)
            .map(|(_, profile)| profile.name.as_str())
            .collect();
        let clean = validate_profile_input(&input, &others, existing.is_none()).map_err(VaultError::Validation)?;
        let secret_key = match existing {
            Some(idx) if clean.secret_key.is_empty() => state.profiles[idx].secret_key.clone(),
            _ => clean.secret_key,
        };
        let profile = Profile {
            id: if existing.is_some() { clean.id } else { new_profile_id() },
            name: clean.name,
            endpoint: clean.endpoint,
            access_key: clean.access_key,
            secret_key,
            region: clean.region,
        };
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

    /// Copy a profile under a new id and name "<name> (copy)". The secret is copied inside the
    /// vault and never returned.
    pub fn duplicate_profile(&mut self, profile_id: &str) -> Result<ProfileSummary, VaultError> {
        let mut copy = self.get_profile(profile_id)?;
        copy.id = new_profile_id();
        copy.name = format!("{} (copy)", copy.name);
        let summary = copy.summary();
        let state = self.state_mut()?;
        state.profiles.push(copy);
        if let Err(err) = self.persist() {
            self.state_mut()?.profiles.pop();
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

    fn fields_of(err: VaultError) -> Vec<&'static str> {
        match err {
            VaultError::Validation(errors) => errors.iter().map(|e| e.field).collect(),
            other => panic!("expected a validation error, got {other}"),
        }
    }

    fn unlocked_vault(dir: &tempfile::TempDir) -> Vault {
        let mut vault = new_vault(dir);
        vault.create("m").unwrap();
        vault
    }

    #[test]
    fn invalid_profile_is_rejected_with_per_field_errors() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = unlocked_vault(&dir);
        assert_eq!(fields_of(vault.save_profile(sample_input("")).unwrap_err()), vec!["name"]);
        let mut bad = sample_input("n");
        bad.secret_key = String::new(); // new profile needs a secret
        assert_eq!(fields_of(vault.save_profile(bad).unwrap_err()), vec!["secret_key"]);
        assert!(vault.list_profiles().unwrap().is_empty(), "nothing is stored on a rejected save");
    }

    #[test]
    fn save_stores_the_normalized_values() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = unlocked_vault(&dir);
        let mut input = sample_input("  Dev  ");
        input.endpoint = " HTTP://Localhost:9000/ ".into();
        let saved = vault.save_profile(input).unwrap();
        assert_eq!((saved.name.as_str(), saved.endpoint.as_str()), ("Dev", "http://localhost:9000"));
        assert_eq!(vault.get_profile(&saved.id).unwrap().secret_key, "test-secret-value");
    }

    #[test]
    fn name_must_be_unique_case_insensitively() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = unlocked_vault(&dir);
        vault.save_profile(sample_input("Prod")).unwrap();
        assert_eq!(fields_of(vault.save_profile(sample_input("pROD")).unwrap_err()), vec!["name"]);
        assert_eq!(vault.list_profiles().unwrap().len(), 1);
    }

    #[test]
    fn editing_may_keep_its_own_name_but_not_take_another() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = unlocked_vault(&dir);
        let prod = vault.save_profile(sample_input("Prod")).unwrap();
        vault.save_profile(sample_input("Dev")).unwrap();
        let mut keep = sample_input("prod"); // same name, other case, same profile
        keep.id = prod.id.clone();
        keep.secret_key = String::new();
        assert_eq!(vault.save_profile(keep).unwrap().name, "prod");
        let mut steal = sample_input("DEV");
        steal.id = prod.id;
        steal.secret_key = String::new();
        assert_eq!(fields_of(vault.save_profile(steal).unwrap_err()), vec!["name"]);
    }

    #[test]
    fn empty_secret_on_create_is_rejected_and_on_edit_keeps_the_stored_one() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = unlocked_vault(&dir);
        let mut create = sample_input("one");
        create.secret_key = String::new();
        assert_eq!(fields_of(vault.save_profile(create).unwrap_err()), vec!["secret_key"]);
        let saved = vault.save_profile(sample_input("one")).unwrap();
        let mut edit = sample_input("one");
        edit.id = saved.id.clone();
        edit.secret_key = String::new();
        vault.save_profile(edit).unwrap();
        assert_eq!(vault.get_profile(&saved.id).unwrap().secret_key, "test-secret-value");
    }

    #[test]
    fn validation_error_text_never_contains_the_secret() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = unlocked_vault(&dir);
        let mut bad = sample_input("");
        bad.secret_key = "s3cr3t-VALUE\nx".into();
        bad.endpoint = "http://user:s3cr3t-VALUE@host".into();
        let err = vault.save_profile(bad).unwrap_err();
        assert!(!format!("{err} {err:?}").contains("s3cr3t"));
    }

    #[test]
    fn duplicate_copies_secret_inside_vault_with_new_id_and_name() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        vault.create("m").unwrap();
        let original = vault.save_profile(sample_input("dev")).unwrap();
        let copy = vault.duplicate_profile(&original.id).unwrap();
        assert_ne!(copy.id, original.id);
        assert_eq!(copy.name, "dev (copy)");
        assert_eq!(copy.endpoint, original.endpoint);
        assert_eq!(vault.get_profile(&copy.id).unwrap().secret_key, "test-secret-value");
        assert_eq!(vault.list_profiles().unwrap().len(), 2);
        // the summary type has no secret field, and the copy survives a lock/unlock round trip
        vault.lock();
        vault.unlock("m").unwrap();
        assert_eq!(vault.get_profile(&copy.id).unwrap().secret_key, "test-secret-value");
    }

    #[test]
    fn duplicate_of_unknown_profile_fails() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        vault.create("m").unwrap();
        assert!(matches!(vault.duplicate_profile("nope"), Err(VaultError::InvalidProfile(_))));
    }
}
