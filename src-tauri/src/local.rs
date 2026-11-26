//! Local file system listing for the LOCAL panel. Plain `std::fs`, no Tauri dependency.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::app_error::AppError;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LocalEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub modified: Option<i64>,
    pub hidden: bool,
}

#[derive(Debug, Serialize)]
pub struct LocalListing {
    /// Absolute, resolved path that was listed.
    pub path: String,
    pub entries: Vec<LocalEntry>,
}

/// An empty path means the user's home directory (falls back to `/`).
pub fn start_dir(path: &str) -> std::path::PathBuf {
    if path.is_empty() {
        return std::env::var_os("HOME").map(Into::into).unwrap_or_else(|| "/".into());
    }
    path.into()
}

pub fn list_dir(path: &Path) -> Result<LocalListing, AppError> {
    let resolved = path.canonicalize().map_err(|err| describe_io_error(&err, path))?;
    let mut entries = Vec::new();
    for dir_entry in fs::read_dir(&resolved).map_err(|err| describe_io_error(&err, &resolved))? {
        let dir_entry = dir_entry.map_err(|err| describe_io_error(&err, &resolved))?;
        let entry_path = dir_entry.path();
        // Follow symlinks for type/size; a broken link falls back to the link itself.
        let metadata = fs::metadata(&entry_path)
            .or_else(|_| dir_entry.metadata())
            .map_err(|err| describe_io_error(&err, &entry_path))?;
        let name = dir_entry.file_name().to_string_lossy().into_owned();
        entries.push(LocalEntry {
            hidden: name.starts_with('.'),
            is_dir: metadata.is_dir(),
            size: if metadata.is_dir() { 0 } else { metadata.len() },
            modified: metadata.modified().ok().and_then(epoch_seconds),
            name,
        });
    }
    entries.sort_by_cached_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(LocalListing { path: resolved.to_string_lossy().into_owned(), entries })
}

fn epoch_seconds(time: std::time::SystemTime) -> Option<i64> {
    match time.duration_since(UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_secs()).ok(),
        Err(before) => i64::try_from(before.duration().as_secs()).ok().map(|secs| -secs),
    }
}

fn describe_io_error(err: &std::io::Error, path: &Path) -> AppError {
    let shown = path.display();
    AppError::Local(match err.kind() {
        std::io::ErrorKind::PermissionDenied => format!("permission denied: {shown}"),
        std::io::ErrorKind::NotFound => format!("not found: {shown}"),
        std::io::ErrorKind::NotADirectory => format!("not a directory: {shown}"),
        _ => format!("{err}: {shown}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(listing: &LocalListing) -> Vec<&str> {
        listing.entries.iter().map(|entry| entry.name.as_str()).collect()
    }

    #[test]
    fn start_dir_keeps_explicit_path_and_defaults_to_an_existing_dir() {
        assert_eq!(start_dir("/some/where"), std::path::PathBuf::from("/some/where"));
        assert!(start_dir("").is_dir());
    }

    #[test]
    fn dirs_come_first_then_files_sorted_by_name() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("b.txt"), "bb").unwrap();
        fs::write(dir.path().join("A.txt"), "a").unwrap();
        fs::create_dir(dir.path().join("zdir")).unwrap();
        fs::create_dir(dir.path().join("adir")).unwrap();
        let listing = list_dir(dir.path()).unwrap();
        assert_eq!(names(&listing), ["adir", "zdir", "A.txt", "b.txt"]);
    }

    #[test]
    fn reports_size_dir_flag_and_modified() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f.bin"), [0u8; 5]).unwrap();
        fs::create_dir(dir.path().join("d")).unwrap();
        let listing = list_dir(dir.path()).unwrap();
        let sub = &listing.entries[0];
        let file = &listing.entries[1];
        assert!(sub.is_dir && !file.is_dir);
        assert_eq!(file.size, 5);
        assert!(file.modified.unwrap() > 0);
    }

    #[test]
    fn hidden_files_are_listed_and_flagged() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".secret"), "x").unwrap();
        fs::write(dir.path().join("plain"), "x").unwrap();
        let listing = list_dir(dir.path()).unwrap();
        let hidden: Vec<_> = listing.entries.iter().filter(|entry| entry.hidden).map(|entry| entry.name.as_str()).collect();
        assert_eq!(hidden, [".secret"]);
        assert_eq!(listing.entries.len(), 2);
    }

    #[test]
    fn listing_path_is_resolved() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        let listing = list_dir(&dir.path().join("sub").join("..")).unwrap();
        assert_eq!(listing.path, dir.path().canonicalize().unwrap().to_string_lossy());
    }

    #[test]
    fn missing_dir_is_a_readable_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = list_dir(&dir.path().join("nope")).unwrap_err();
        assert!(err.to_string().starts_with("not found:"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn permission_error_is_returned_not_swallowed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let outcome = list_dir(&locked);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        let err = outcome.unwrap_err();
        assert!(err.to_string().starts_with("permission denied:"), "{err}");
    }
}
