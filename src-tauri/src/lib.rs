pub mod vault;

use std::sync::Mutex;

use tauri::{Manager, State};
use vault::{ProfileInput, ProfileSummary, Vault};

const VAULT_FILE_NAME: &str = "vault.json";

type VaultState<'a> = State<'a, Mutex<Vault>>;

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
fn vault_lock(state: VaultState) -> Result<(), String> {
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
fn profile_save(state: VaultState, profile: ProfileInput) -> Result<ProfileSummary, String> {
    with_vault(&state, |vault| vault.save_profile(profile))
}

#[tauri::command]
fn profile_delete(state: VaultState, profile_id: String) -> Result<(), String> {
    with_vault(&state, |vault| vault.delete_profile(&profile_id))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let vault_path = app.path().app_data_dir()?.join(VAULT_FILE_NAME);
            app.manage(Mutex::new(Vault::new(vault_path)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            vault_create,
            vault_unlock,
            vault_lock,
            profile_list,
            profile_save,
            profile_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
