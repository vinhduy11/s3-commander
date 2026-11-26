//! Small app settings file (`settings.json` in the app data dir). Not secret; no Tauri dependency.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Auto-lock choices in minutes; 0 = never.
pub const AUTO_LOCK_CHOICES: [u32; 6] = [1, 5, 15, 30, 60, 0];
pub const DEFAULT_AUTO_LOCK_MINUTES: u32 = 15;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default = "default_auto_lock")]
    pub auto_lock_minutes: u32,
}

fn default_auto_lock() -> u32 {
    DEFAULT_AUTO_LOCK_MINUTES
}

impl Default for AppSettings {
    fn default() -> Self {
        Self { auto_lock_minutes: DEFAULT_AUTO_LOCK_MINUTES }
    }
}

impl AppSettings {
    /// Rejects values outside the presets.
    pub fn validate(&self) -> Result<(), String> {
        if AUTO_LOCK_CHOICES.contains(&self.auto_lock_minutes) {
            Ok(())
        } else {
            Err("Auto-lock must be 1, 5, 15, 30 or 60 minutes, or Never.".into())
        }
    }
}

/// Missing, unreadable or invalid file: defaults (a bad value must never lock the user out of the app).
pub fn load(path: &Path) -> AppSettings {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<AppSettings>(&bytes).ok())
        .filter(|settings| settings.validate().is_ok())
        .unwrap_or_default()
}

/// Validates, then writes through a temp file and a rename.
pub fn save(path: &Path, settings: &AppSettings) -> Result<(), String> {
    settings.validate()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(settings).map_err(|err| err.to_string())?)
        .map_err(|err| err.to_string())?;
    std::fs::rename(&tmp, path).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(dir: &tempfile::TempDir) -> std::path::PathBuf {
        dir.path().join("settings.json")
    }

    #[test]
    fn missing_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(&path(&dir)).auto_lock_minutes, 15);
    }

    #[test]
    fn save_then_load_round_trips_every_choice() {
        let dir = tempfile::tempdir().unwrap();
        for minutes in AUTO_LOCK_CHOICES {
            save(&path(&dir), &AppSettings { auto_lock_minutes: minutes }).unwrap();
            assert_eq!(load(&path(&dir)).auto_lock_minutes, minutes);
        }
    }

    #[test]
    fn invalid_value_is_refused_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let err = save(&path(&dir), &AppSettings { auto_lock_minutes: 7 }).unwrap_err();
        assert!(err.contains("Auto-lock"));
        assert!(!path(&dir).exists());
    }

    #[test]
    fn corrupt_or_out_of_range_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path(&dir), b"{not json").unwrap();
        assert_eq!(load(&path(&dir)), AppSettings::default());
        std::fs::write(path(&dir), br#"{"auto_lock_minutes": 3}"#).unwrap();
        assert_eq!(load(&path(&dir)), AppSettings::default());
    }

    #[test]
    fn missing_field_gets_the_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path(&dir), b"{}").unwrap();
        assert_eq!(load(&path(&dir)).auto_lock_minutes, 15);
    }

    #[test]
    fn save_is_atomic_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        save(&path(&dir), &AppSettings::default()).unwrap();
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("settings.json")]);
    }
}
