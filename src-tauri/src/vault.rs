//! Encrypted profile vault. No Tauri dependency so it is unit-testable.
//!
//! File = JSON { version, kdf, salt, nonce, ciphertext } (base64). The master key is stretched with
//! Argon2id (random salt, parameters from the `kdf` header) into a 32-byte key; the whole profile
//! list is one XChaCha20-Poly1305 blob with a fresh random nonce per save. A wrong master key
//! fails on the auth tag. Version 1 files have no `kdf` header and mean the old default parameters.
//! A correct unlock of a vault with weaker parameters than the target rewrites it in place.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{aead::{Aead, KeyInit, OsRng}, XChaCha20Poly1305, XNonce};
use rand::RngCore;
use zeroize::Zeroizing;

use crate::profile_rules::{validate_profile_input, FieldError};
use crate::transfer_settings::TransferFields;

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
    #[error("Too many failed attempts. Try again in {0} s.")]
    Throttled(u64),
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
    /// Optional transfer settings; absent in vaults written before they existed (defaults apply).
    #[serde(flatten)]
    pub transfer: TransferFields,
}

/// What the frontend receives: no secret key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProfileSummary {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub access_key: String,
    pub region: String,
    #[serde(flatten)]
    pub transfer: TransferFields,
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
    #[serde(flatten)]
    pub transfer: TransferFields,
}

/// Version written by this code. Version 1 (no `kdf` header) is still read.
const FILE_VERSION: u32 = 2;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;

/// Argon2id cost parameters, stored in the vault file header.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    /// Memory in KiB.
    pub m_cost: u32,
    /// Passes.
    pub t_cost: u32,
    /// Lanes.
    pub p_cost: u32,
}

impl KdfParams {
    /// What every vault written before the header existed used (the argon2 crate defaults).
    pub const LEGACY: KdfParams = KdfParams { m_cost: 19_456, t_cost: 2, p_cost: 1 };
    /// What new vaults use and old ones are upgraded to: 256 MiB, 4 passes, 1 lane (see safety.md).
    pub const TARGET: KdfParams = KdfParams { m_cost: 262_144, t_cost: 4, p_cost: 1 };
    /// Upper bounds accepted from a file header, so a tampered header cannot ask for gigabytes.
    const MAX_M_COST: u32 = 1_048_576;
    const MAX_T_COST: u32 = 16;
    const MAX_P_COST: u32 = 8;

    fn is_within_bounds(&self) -> bool {
        self.m_cost <= Self::MAX_M_COST && self.t_cost <= Self::MAX_T_COST && self.p_cost <= Self::MAX_P_COST
    }

    fn is_weaker_than(&self, target: &KdfParams) -> bool {
        self.m_cost < target.m_cost || self.t_cost < target.t_cost || self.p_cost < target.p_cost
    }

    /// Never lowers a dimension that is already stronger than the target.
    fn raised_to(&self, target: &KdfParams) -> KdfParams {
        KdfParams {
            m_cost: self.m_cost.max(target.m_cost),
            t_cost: self.t_cost.max(target.t_cost),
            p_cost: self.p_cost.max(target.p_cost),
        }
    }
}

fn legacy_kdf() -> KdfParams {
    KdfParams::LEGACY
}

#[derive(Serialize, Deserialize)]
struct VaultFile {
    version: u32,
    #[serde(default = "legacy_kdf")]
    kdf: KdfParams,
    salt: String,
    nonce: String,
    ciphertext: String,
}

/// Key material that lives only in memory; zeroized on drop.
struct Unlocked {
    key: Zeroizing<[u8; KEY_LEN]>,
    salt: [u8; SALT_LEN],
    kdf: KdfParams,
    profiles: Vec<Profile>,
}

pub struct Vault {
    path: PathBuf,
    /// Parameters for new vaults and the level an unlock upgrades weaker vaults to.
    target: KdfParams,
    unlocked: Option<Unlocked>,
}

fn io_err(err: std::io::Error) -> VaultError {
    VaultError::Io(err.to_string())
}

#[cfg(test)]
thread_local! {
    static DERIVES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Key derivations run on this thread so far (tests only: proves a refusal never ran Argon2).
#[cfg(test)]
pub fn derive_count_for_tests() -> usize {
    DERIVES.with(|c| c.get())
}

fn derive_key(master_key: &str, salt: &[u8], kdf: KdfParams) -> Result<Zeroizing<[u8; KEY_LEN]>, VaultError> {
    #[cfg(test)]
    DERIVES.with(|c| c.set(c.get() + 1));
    let params = Params::new(kdf.m_cost, kdf.t_cost, kdf.p_cost, Some(KEY_LEN))
        .map_err(|err| VaultError::Crypto(err.to_string()))?;
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(master_key.as_bytes(), salt, key.as_mut())
        .map_err(|err| VaultError::Crypto(err.to_string()))?;
    Ok(key)
}

fn decode(field: &str) -> Result<Vec<u8>, VaultError> {
    B64.decode(field).map_err(|_| VaultError::Decrypt)
}

/// Decrypt a vault file. The one path used by unlock and by the upgrade read-back check.
fn open_file(master_key: &str, bytes: &[u8]) -> Result<Unlocked, VaultError> {
    let file: VaultFile = serde_json::from_slice(bytes).map_err(|_| VaultError::Decrypt)?;
    if file.version != 1 && file.version != FILE_VERSION {
        return Err(VaultError::Decrypt);
    }
    if !file.kdf.is_within_bounds() {
        return Err(VaultError::Decrypt);
    }
    let salt: [u8; SALT_LEN] = decode(&file.salt)?.try_into().map_err(|_| VaultError::Decrypt)?;
    let nonce = decode(&file.nonce)?;
    if nonce.len() != NONCE_LEN {
        return Err(VaultError::Decrypt);
    }
    let key = derive_key(master_key, &salt, file.kdf)?;
    let plaintext = Zeroizing::new(
        XChaCha20Poly1305::new(key.as_ref().into())
            .decrypt(XNonce::from_slice(&nonce), decode(&file.ciphertext)?.as_slice())
            .map_err(|_| VaultError::Decrypt)?,
    );
    let profiles = serde_json::from_slice(&plaintext).map_err(|_| VaultError::Decrypt)?;
    Ok(Unlocked { key, salt, kdf: file.kdf, profiles })
}

/// Encrypt the profile list with a fresh nonce into the file bytes.
fn seal_file(state: &Unlocked) -> Result<Vec<u8>, VaultError> {
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
        kdf: state.kdf,
        salt: B64.encode(state.salt),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
    };
    serde_json::to_vec(&file).map_err(|err| VaultError::Crypto(err.to_string()))
}

impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self::with_target(path, KdfParams::TARGET)
    }

    /// Vault whose new files and upgrades use `target` (tests pass cheap parameters).
    pub fn with_target(path: PathBuf, target: KdfParams) -> Self {
        Self { path, target, unlocked: None }
    }

    pub fn target(&self) -> KdfParams {
        self.target
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
        let key = derive_key(master_key, &salt, self.target)?;
        self.unlocked = Some(Unlocked { key, salt, kdf: self.target, profiles: Vec::new() });
        if let Err(err) = self.persist() {
            self.unlocked = None;
            return Err(err);
        }
        Ok(())
    }

    pub fn unlock(&mut self, master_key: &str) -> Result<(), VaultError> {
        self.unlock_with_hook(master_key, |_| Ok(()))
    }

    /// Unlock, then upgrade the file when its Argon2 parameters are weaker than the target.
    /// `before_rename` runs on the finished temp file just before it replaces the vault (a seam
    /// for tests); any failure of the upgrade is swallowed and leaves the old file untouched.
    fn unlock_with_hook(
        &mut self,
        master_key: &str,
        before_rename: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<(), VaultError> {
        if !self.exists() {
            return Err(VaultError::NotFound);
        }
        let opened = open_file(master_key, &std::fs::read(&self.path).map_err(io_err)?)?;
        self.unlocked = Some(match opened.kdf.is_weaker_than(&self.target) {
            true => self.upgrade(master_key, opened, before_rename),
            false => opened,
        });
        Ok(())
    }

    /// New salt, new key, temp file next to the vault, read back and compare, atomic rename.
    /// Returns the upgraded state, or the old one when anything fails (the old file stays valid).
    fn upgrade(
        &self,
        master_key: &str,
        old: Unlocked,
        before_rename: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Unlocked {
        let tmp = self.path.with_extension("json.upgrade");
        match self.write_upgrade(master_key, &old, &tmp, before_rename) {
            Ok(upgraded) => upgraded,
            Err(_) => {
                let _ = std::fs::remove_file(&tmp);
                old
            }
        }
    }

    fn write_upgrade(
        &self,
        master_key: &str,
        old: &Unlocked,
        tmp: &Path,
        before_rename: impl FnOnce(&Path) -> std::io::Result<()>,
    ) -> Result<Unlocked, VaultError> {
        let kdf = old.kdf.raised_to(&self.target);
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        let upgraded = Unlocked { key: derive_key(master_key, &salt, kdf)?, salt, kdf, profiles: old.profiles.clone() };
        std::fs::write(tmp, seal_file(&upgraded)?).map_err(io_err)?;
        before_rename(tmp).map_err(io_err)?;
        // Same code path as a real unlock: the file must open with the master key and hold the same profiles.
        let check = open_file(master_key, &std::fs::read(tmp).map_err(io_err)?)?;
        if check.profiles != old.profiles || check.kdf != kdf {
            return Err(VaultError::Crypto("upgrade check failed".into()));
        }
        std::fs::rename(tmp, &self.path).map_err(io_err)?;
        Ok(upgraded)
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
            transfer: clean.transfer,
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
        write_atomic(&self.path, &seal_file(self.state()?)?)
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
            transfer: self.transfer.clone(),
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
            transfer: TransferFields::default(),
        }
    }

    fn new_vault(dir: &tempfile::TempDir) -> Vault {
        Vault::with_target(dir.path().join("vault.json"), KdfParams::LEGACY)
    }

    /// Cheap but stronger than LEGACY, so an upgrade is visible in tests.
    const TEST_TARGET: KdfParams = KdfParams { m_cost: 32 * 1024, t_cost: 3, p_cost: 1 };

    /// A vault file exactly as the code before step 6a wrote it: version 1, no `kdf` header,
    /// Argon2id with the crate defaults (19 MiB, 2 passes, 1 lane).
    fn write_v1_fixture(dir: &tempfile::TempDir, master: &str, profiles: &[Profile]) -> Vec<u8> {
        let salt = [7u8; SALT_LEN];
        let mut key = [0u8; KEY_LEN];
        Argon2::default().hash_password_into(master.as_bytes(), &salt, &mut key).unwrap();
        let nonce = [9u8; NONCE_LEN];
        let cipher = XChaCha20Poly1305::new((&key).into())
            .encrypt(XNonce::from_slice(&nonce), serde_json::to_vec(profiles).unwrap().as_slice())
            .unwrap();
        let file = serde_json::json!({
            "version": 1, "salt": B64.encode(salt), "nonce": B64.encode(nonce), "ciphertext": B64.encode(cipher)
        });
        let bytes = serde_json::to_vec(&file).unwrap();
        fs::write(dir.path().join("vault.json"), &bytes).unwrap();
        bytes
    }

    fn fixture_profile() -> Profile {
        Profile {
            id: "p1".into(),
            name: "Old".into(),
            endpoint: "http://localhost:9000".into(),
            access_key: "ak".into(),
            secret_key: "fixture-secret".into(),
            region: "us-east-1".into(),
            transfer: TransferFields::default(),
        }
    }

    fn header(dir: &tempfile::TempDir) -> serde_json::Value {
        serde_json::from_slice(&fs::read(dir.path().join("vault.json")).unwrap()).unwrap()
    }

    fn bytes_of(dir: &tempfile::TempDir) -> Vec<u8> {
        fs::read(dir.path().join("vault.json")).unwrap()
    }

    #[test]
    fn a_vault_without_the_kdf_header_opens_with_the_old_parameters_and_stays_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let before = write_v1_fixture(&dir, "m", &[fixture_profile()]);
        let mut vault = new_vault(&dir); // target = LEGACY: nothing to upgrade
        vault.unlock("m").unwrap();
        assert_eq!(vault.get_profile("p1").unwrap().secret_key, "fixture-secret");
        assert_eq!(bytes_of(&dir), before);
    }

    #[test]
    fn a_new_vault_records_and_uses_the_target_parameters() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::with_target(dir.path().join("vault.json"), TEST_TARGET);
        vault.create("m").unwrap();
        let file = header(&dir);
        assert_eq!(file["version"], 2);
        assert_eq!(file["kdf"], serde_json::json!({"m_cost": 32768, "t_cost": 3, "p_cost": 1}));
        vault.lock();
        vault.unlock("m").unwrap();
        assert_eq!(Vault::new(dir.path().join("x.json")).target(), KdfParams::TARGET);
        assert!(KdfParams::TARGET.m_cost > KdfParams::LEGACY.m_cost && KdfParams::TARGET.t_cost >= KdfParams::LEGACY.t_cost);
    }

    #[test]
    fn unlock_upgrades_a_weaker_vault_in_place_and_keeps_the_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let before = write_v1_fixture(&dir, "m", &[fixture_profile()]);
        let old_salt = header(&dir)["salt"].clone();
        let mut vault = Vault::with_target(dir.path().join("vault.json"), TEST_TARGET);
        vault.unlock("m").unwrap();
        assert!(vault.is_unlocked());
        assert_ne!(bytes_of(&dir), before);
        let file = header(&dir);
        assert_eq!(file["version"], 2);
        assert_eq!(file["kdf"]["m_cost"], 32768);
        assert_ne!(file["salt"], old_salt, "a new salt");
        // a later save keeps using the new key, salt and parameters
        let mut input = sample_input("added");
        input.secret_key = "later-secret".into();
        vault.save_profile(input).unwrap();
        vault.lock();
        let mut again = Vault::with_target(dir.path().join("vault.json"), TEST_TARGET);
        again.unlock("m").unwrap();
        assert_eq!(again.list_profiles().unwrap().len(), 2);
        assert_eq!(again.get_profile("p1").unwrap().secret_key, "fixture-secret");
        assert_eq!(header(&dir)["kdf"]["m_cost"], 32768);
        assert!(!dir.path().join("vault.json.upgrade").exists());
    }

    #[test]
    fn a_wrong_master_key_never_triggers_an_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        let before = write_v1_fixture(&dir, "m", &[fixture_profile()]);
        let mut vault = Vault::with_target(dir.path().join("vault.json"), TEST_TARGET);
        let err = vault.unlock("not-the-key").unwrap_err();
        assert!(matches!(err, VaultError::Decrypt));
        assert!(!format!("{err} {err:?}").contains("not-the-key"));
        assert_eq!(bytes_of(&dir), before);
        assert!(!dir.path().join("vault.json.upgrade").exists());
    }

    #[test]
    fn an_already_strong_enough_vault_is_not_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::with_target(dir.path().join("vault.json"), TEST_TARGET);
        vault.create("m").unwrap();
        vault.lock();
        let before = bytes_of(&dir);
        vault.unlock("m").unwrap();
        assert_eq!(bytes_of(&dir), before);
    }

    #[test]
    fn a_failure_before_the_rename_leaves_the_old_vault_valid_and_unlock_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let before = write_v1_fixture(&dir, "m", &[fixture_profile()]);
        let mut vault = Vault::with_target(dir.path().join("vault.json"), TEST_TARGET);
        vault
            .unlock_with_hook("m", |_| Err(std::io::Error::other("disk full")))
            .unwrap();
        assert!(vault.is_unlocked());
        assert_eq!(bytes_of(&dir), before);
        assert!(!dir.path().join("vault.json.upgrade").exists(), "the temp file is cleaned up");
        // still saves with the old parameters, and the old vault still opens
        vault.save_profile(sample_input("kept")).unwrap();
        assert!(header(&dir).get("kdf").is_none() || header(&dir)["kdf"]["m_cost"] == 19456);
        vault.lock();
        new_vault(&dir).unlock("m").unwrap();
    }

    #[test]
    fn a_temp_file_that_does_not_read_back_the_same_is_never_renamed_into_place() {
        let dir = tempfile::tempdir().unwrap();
        let before = write_v1_fixture(&dir, "m", &[fixture_profile()]);
        let mut vault = Vault::with_target(dir.path().join("vault.json"), TEST_TARGET);
        vault
            .unlock_with_hook("m", |tmp| {
                let mut bytes = fs::read(tmp)?;
                let last = bytes.len() - 3;
                bytes[last] = if bytes[last] == b'A' { b'B' } else { b'A' };
                fs::write(tmp, bytes)
            })
            .unwrap();
        assert!(vault.is_unlocked());
        assert_eq!(bytes_of(&dir), before);
        assert!(!dir.path().join("vault.json.upgrade").exists());
    }

    #[test]
    fn absurd_header_parameters_are_refused_without_deriving() {
        let dir = tempfile::tempdir().unwrap();
        write_v1_fixture(&dir, "m", &[fixture_profile()]);
        let mut file = header(&dir);
        file["version"] = 2.into();
        file["kdf"] = serde_json::json!({"m_cost": 4_000_000_000u64, "t_cost": 1, "p_cost": 1});
        fs::write(dir.path().join("vault.json"), serde_json::to_vec(&file).unwrap()).unwrap();
        let before = derive_count_for_tests();
        assert!(matches!(new_vault(&dir).unlock("m"), Err(VaultError::Decrypt)));
        assert_eq!(derive_count_for_tests(), before);
    }

    #[test]
    fn errors_never_contain_the_master_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        vault.create("master-s3cr3t").unwrap();
        vault.lock();
        let wrong = vault.unlock("wrong-s3cr3t").unwrap_err();
        let empty = new_vault(&tempfile::tempdir().unwrap()).create("").unwrap_err();
        for err in [wrong, empty, VaultError::Throttled(3)] {
            let text = format!("{err} {err:?}");
            assert!(!text.contains("s3cr3t"), "{text}");
        }
    }

    /// Prints the time of one key derivation per parameter set; never asserts on it.
    /// Run: cargo test kdf_timing -- --ignored --nocapture
    #[test]
    #[ignore]
    fn kdf_timing() {
        let candidate = |m_mib: u32, t: u32| KdfParams { m_cost: m_mib * 1024, t_cost: t, p_cost: 1 };
        let sets = [
            ("legacy", KdfParams::LEGACY),
            ("64MiB/t3", candidate(64, 3)),
            ("128MiB/t3", candidate(128, 3)),
            ("256MiB/t2", candidate(256, 2)),
            ("256MiB/t3", candidate(256, 3)),
            ("512MiB/t3", candidate(512, 3)),
            ("target", KdfParams::TARGET),
        ];
        for (name, params) in sets {
            let mut times = Vec::new();
            for _ in 0..5 {
                let start = std::time::Instant::now();
                derive_key("benchmark-master-key", &[1u8; SALT_LEN], params).unwrap();
                times.push(start.elapsed().as_millis());
            }
            println!("kdf_timing {name} m={} KiB t={} p={}: runs_ms={times:?}", params.m_cost, params.t_cost, params.p_cost);
        }
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

    #[test]
    fn profiles_stored_before_transfer_settings_still_load_with_defaults() {
        let old = r#"[{"id":"a1","name":"Old","endpoint":"http://localhost:9000","access_key":"ak","secret_key":"sk","region":"us-east-1"}]"#;
        let profiles: Vec<Profile> = serde_json::from_str(old).unwrap();
        assert_eq!(profiles[0].transfer, TransferFields::default());
        let eff = crate::transfer_settings::effective_transfer_settings(&profiles[0].transfer);
        assert_eq!(eff.max_concurrent_requests, 10);
    }

    #[test]
    fn transfer_settings_are_saved_normalized_and_come_back_in_the_summary() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        vault.create("master").unwrap();
        let mut input = sample_input("Dev");
        input.transfer = TransferFields {
            multipart_threshold: " 64 mb".into(),
            multipart_chunksize: "16MB".into(),
            max_concurrent_requests: "20".into(),
            addressing_style: "Virtual".into(),
        };
        let summary = vault.save_profile(input).unwrap();
        assert_eq!(summary.transfer.multipart_threshold, "64MB");
        assert_eq!(summary.transfer.addressing_style, "virtual");
        vault.lock();
        vault.unlock("master").unwrap();
        assert_eq!(vault.get_profile(&summary.id).unwrap().transfer.max_concurrent_requests, "20");
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["multipart_chunksize"], "16MB");
        assert!(json.get("secret_key").is_none());
    }

    #[test]
    fn bad_transfer_settings_block_the_save_with_per_field_errors() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = new_vault(&dir);
        vault.create("master").unwrap();
        let mut input = sample_input("Dev");
        input.transfer.max_concurrent_requests = "0".into();
        match vault.save_profile(input).unwrap_err() {
            VaultError::Validation(errors) => assert_eq!(errors[0].field, "max_concurrent_requests"),
            other => panic!("{other:?}"),
        }
        assert!(vault.list_profiles().unwrap().is_empty());
    }
}
