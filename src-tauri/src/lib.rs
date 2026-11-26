pub mod app_error;
pub mod local;
pub mod s3;
pub mod vault;

use std::sync::{Mutex, MutexGuard, PoisonError};

use app_error::AppError;
use aws_sdk_s3::Client;
use tauri::{Manager, State};
use vault::{ProfileInput, ProfileSummary, Vault};

const VAULT_FILE_NAME: &str = "vault.json";

type VaultState<'a> = State<'a, Mutex<Vault>>;
type ClientState<'a> = State<'a, ClientCache>;

/// The S3 client of the one active profile. Dropped on lock, on profile change/delete and
/// replaced when another profile is used, so a stale client never outlives its profile.
#[derive(Default)]
struct ClientCache(Mutex<Option<ActiveClient>>);

struct ActiveClient {
    profile_id: String,
    client: Client,
}

impl ClientCache {
    fn slot(&self) -> MutexGuard<'_, Option<ActiveClient>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn clear(&self) {
        *self.slot() = None;
    }
}

fn lock_vault<'a>(state: &'a VaultState) -> MutexGuard<'a, Vault> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Client for `profile_id`: cached, or built from the vault (fails when the vault is locked).
fn client_for(vault: &VaultState, cache: &ClientCache, profile_id: &str) -> Result<Client, AppError> {
    let mut slot = cache.slot();
    if let Some(active) = slot.as_ref().filter(|active| active.profile_id == profile_id) {
        return Ok(active.client.clone());
    }
    let profile = lock_vault(vault).get_profile(profile_id)?;
    let client = s3::build_client(&profile);
    *slot = Some(ActiveClient { profile_id: profile_id.to_string(), client: client.clone() });
    Ok(client)
}

#[derive(serde::Serialize)]
struct VaultStatus {
    exists: bool,
    unlocked: bool,
}

fn with_vault<T>(
    state: &VaultState,
    action: impl FnOnce(&mut Vault) -> Result<T, vault::VaultError>,
) -> Result<T, String> {
    let mut vault = state.lock().map_err(|_| "vault state poisoned".to_string())?;
    action(&mut vault).map_err(|err| err.to_string())
}

#[tauri::command]
fn vault_status(state: VaultState) -> Result<VaultStatus, String> {
    with_vault(&state, |vault| {
        Ok(VaultStatus { exists: vault.exists(), unlocked: vault.is_unlocked() })
    })
}

#[tauri::command]
fn vault_create(state: VaultState, master: String) -> Result<(), String> {
    with_vault(&state, |vault| vault.create(&master))
}

#[tauri::command]
fn vault_unlock(state: VaultState, master: String) -> Result<(), String> {
    with_vault(&state, |vault| vault.unlock(&master))
}

#[tauri::command]
fn vault_lock(state: VaultState, clients: ClientState) -> Result<(), String> {
    clients.clear();
    with_vault(&state, |vault| {
        vault.lock();
        Ok(())
    })
}

#[tauri::command]
fn profile_list(state: VaultState) -> Result<Vec<ProfileSummary>, String> {
    with_vault(&state, |vault| vault.list_profiles())
}

#[tauri::command]
fn profile_save(state: VaultState, clients: ClientState, profile: ProfileInput) -> Result<ProfileSummary, String> {
    clients.clear();
    with_vault(&state, |vault| vault.save_profile(profile))
}

#[tauri::command]
fn profile_delete(state: VaultState, clients: ClientState, profile_id: String) -> Result<(), String> {
    clients.clear();
    with_vault(&state, |vault| vault.delete_profile(&profile_id))
}

#[tauri::command]
fn profile_duplicate(state: VaultState, profile_id: String) -> Result<ProfileSummary, String> {
    with_vault(&state, |vault| vault.duplicate_profile(&profile_id))
}

/// Connects with a fresh client (never the cached one) and returns the number of buckets.
#[tauri::command]
async fn profile_test(state: VaultState<'_>, profile_id: String) -> Result<usize, AppError> {
    let profile = lock_vault(&state).get_profile(&profile_id)?;
    s3::check_connection(&s3::build_client(&profile)).await
}

#[tauri::command]
async fn s3_list_buckets(
    state: VaultState<'_>,
    clients: ClientState<'_>,
    profile_id: String,
) -> Result<Vec<String>, AppError> {
    let client = client_for(&state, &clients, &profile_id)?;
    s3::list_buckets(&client).await
}

#[tauri::command]
async fn s3_list_dir(
    state: VaultState<'_>,
    clients: ClientState<'_>,
    profile_id: String,
    bucket: String,
    prefix: String,
    token: Option<String>,
) -> Result<s3::DirPage, AppError> {
    let client = client_for(&state, &clients, &profile_id)?;
    s3::list_dir(&client, &bucket, &prefix, token).await
}

#[tauri::command]
async fn local_list_dir(path: String) -> Result<local::LocalListing, AppError> {
    local::list_dir(&local::start_dir(&path))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let vault_path = app.path().app_data_dir()?.join(VAULT_FILE_NAME);
            app.manage(Mutex::new(Vault::new(vault_path)));
            app.manage(ClientCache::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            vault_create,
            vault_unlock,
            vault_lock,
            profile_list,
            profile_save,
            profile_delete,
            profile_duplicate,
            profile_test,
            s3_list_buckets,
            s3_list_dir,
            local_list_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
