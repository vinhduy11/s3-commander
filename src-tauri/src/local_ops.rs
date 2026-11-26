//! Local file operations for transfers: walking a selection, copy, rename, New folder and delete
//! to the OS Trash (behind a trait so tests never touch the real Trash). No Tauri dependency.

use std::fs;
use std::path::Path;

use crate::app_error::AppError;
use crate::local::describe_io_error;
use crate::transfer_plan::{Found, ItemFailure, TopItem};

/// Moves a path to the OS Trash. The real one wraps the `trash` crate; tests inject a fake.
pub trait TrashBin: Send + Sync {
    fn move_to_trash(&self, path: &Path) -> Result<(), String>;
}

pub struct SystemTrash;

impl TrashBin for SystemTrash {
    fn move_to_trash(&self, path: &Path) -> Result<(), String> {
        trash::delete(path).map_err(|err| err.to_string())
    }
}

/// A name for a new file or folder: not empty, not "." or "..", no "/" and no NUL.
pub fn validate_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return Err(AppError::Local(format!("invalid name: {name:?}")));
    }
    Ok(())
}

/// Everything under the selected item: a file, every file below a folder, and the empty folders.
/// `Found.rel` starts with the item's name.
pub fn walk_item(parent: &Path, item: &TopItem) -> Result<Vec<Found>, AppError> {
    let path = parent.join(&item.name);
    let metadata = fs::metadata(&path).map_err(|err| describe_io_error(&err, &path))?;
    let mut found = Vec::new();
    if metadata.is_dir() {
        walk_dir(&path, &item.name, &mut found)?;
    } else {
        found.push(Found { rel: item.name.clone(), size: metadata.len(), is_dir: false, modified: modified_seconds(&metadata) });
    }
    Ok(found)
}

/// Modification time in epoch seconds, when the platform reports one.
pub fn modified_seconds(metadata: &fs::Metadata) -> Option<i64> {
    let after = metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(after.as_secs()).ok()
}

fn walk_dir(path: &Path, rel: &str, found: &mut Vec<Found>) -> Result<(), AppError> {
    let mut children = fs::read_dir(path).map_err(|err| describe_io_error(&err, path))?.peekable();
    if children.peek().is_none() {
        found.push(Found { rel: rel.to_string(), size: 0, is_dir: true, modified: None });
        return Ok(());
    }
    for child in children {
        let child = child.map_err(|err| describe_io_error(&err, path))?;
        let child_path = child.path();
        let child_rel = format!("{rel}/{}", child.file_name().to_string_lossy());
        let file_type = child.file_type().map_err(|err| describe_io_error(&err, &child_path))?;
        if file_type.is_dir() {
            walk_dir(&child_path, &child_rel, found)?;
        } else {
            // A symlink to a folder is refused rather than followed: a link loop would never end.
            let metadata = fs::metadata(&child_path).map_err(|err| describe_io_error(&err, &child_path))?;
            if metadata.is_dir() {
                return Err(AppError::Local(format!("symlinked folders are not supported: {}", child_path.display())));
            }
            found.push(Found { rel: child_rel, size: metadata.len(), is_dir: false, modified: modified_seconds(&metadata) });
        }
    }
    Ok(())
}

/// Create the directory `parent/name`; fails when it already exists.
pub fn make_dir(parent: &Path, name: &str) -> Result<(), AppError> {
    validate_name(name)?;
    let path = parent.join(name);
    fs::create_dir(&path).map_err(|err| match err.kind() {
        std::io::ErrorKind::AlreadyExists => AppError::Local(format!("already exists: {}", path.display())),
        _ => describe_io_error(&err, &path),
    })
}

/// Create `path` and its parents (used for destination directories of a transfer).
pub fn ensure_dir(path: &Path) -> Result<(), AppError> {
    fs::create_dir_all(path).map_err(|err| describe_io_error(&err, path))
}

/// Rename or move; never overwrites. Falls back to copy then delete when the plain rename fails
/// (for instance across file systems).
pub fn rename_path(from: &Path, to: &Path) -> Result<(), AppError> {
    if fs::symlink_metadata(to).is_ok() {
        return Err(AppError::Local(format!("already exists: {}", to.display())));
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_then_remove(from, to)
}

/// Copy a file or a whole folder tree, then remove the original (the cross-filesystem fallback).
pub fn copy_then_remove(from: &Path, to: &Path) -> Result<(), AppError> {
    copy_tree(from, to)?;
    let removed = if from.is_dir() { fs::remove_dir_all(from) } else { fs::remove_file(from) };
    removed.map_err(|err| describe_io_error(&err, from))
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), AppError> {
    if !from.is_dir() {
        return fs::copy(from, to).map(|_| ()).map_err(|err| describe_io_error(&err, from));
    }
    fs::create_dir_all(to).map_err(|err| describe_io_error(&err, to))?;
    for child in fs::read_dir(from).map_err(|err| describe_io_error(&err, from))? {
        let child = child.map_err(|err| describe_io_error(&err, from))?;
        copy_tree(&child.path(), &to.join(child.file_name()))?;
    }
    Ok(())
}

/// Remove directories under `path` that are empty after a move (bottom-up); non-empty ones stay.
pub fn remove_empty_tree(path: &Path) {
    let Ok(children) = fs::read_dir(path) else { return };
    for child in children.flatten() {
        if child.file_type().is_ok_and(|file_type| file_type.is_dir()) {
            remove_empty_tree(&child.path());
        }
    }
    // Fails (and is ignored on purpose) while the directory still holds something.
    let _ = fs::remove_dir(path);
}

/// Send each selected item to the Trash; one failure does not stop the others.
pub fn trash_items(trash: &dyn TrashBin, parent: &Path, items: &[TopItem]) -> Vec<ItemFailure> {
    items
        .iter()
        .filter_map(|item| {
            trash
                .move_to_trash(&parent.join(&item.name))
                .err()
                .map(|message| ItemFailure { name: item.name.clone(), message })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex;

    fn top(name: &str, is_dir: bool) -> TopItem {
        TopItem { name: name.into(), is_dir, dest_name: None }
    }

    #[derive(Default)]
    struct FakeTrash {
        trashed: Mutex<Vec<std::path::PathBuf>>,
        fail_on: Option<&'static str>,
    }

    impl TrashBin for FakeTrash {
        fn move_to_trash(&self, path: &Path) -> Result<(), String> {
            if self.fail_on.is_some_and(|name| path.ends_with(name)) {
                return Err("trash unavailable".into());
            }
            self.trashed.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }
    }

    #[test]
    fn names_are_validated() {
        assert!(validate_name("ok name.txt").is_ok());
        for bad in ["", ".", "..", "a/b", "nul\0"] {
            assert!(validate_name(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn walk_returns_files_nested_files_and_empty_dirs_with_relative_names() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("photos/sub")).unwrap();
        fs::create_dir(dir.path().join("photos/empty")).unwrap();
        fs::write(dir.path().join("photos/1.jpg"), "1234").unwrap();
        fs::write(dir.path().join("photos/sub/2.jpg"), "12").unwrap();
        fs::write(dir.path().join("single.txt"), "xyz").unwrap();
        let mut found = walk_item(dir.path(), &top("photos", true)).unwrap();
        found.sort_by(|first, second| first.rel.cmp(&second.rel));
        let shown: Vec<_> = found.iter().map(|entry| (entry.rel.as_str(), entry.size, entry.is_dir)).collect();
        assert_eq!(shown, [("photos/1.jpg", 4, false), ("photos/empty", 0, true), ("photos/sub/2.jpg", 2, false)]);
        let single = walk_item(dir.path(), &top("single.txt", false)).unwrap();
        assert_eq!((single[0].rel.as_str(), single[0].size, single[0].is_dir), ("single.txt", 3, false));
        assert!(single[0].modified.is_some_and(|seconds| seconds > 0));
    }

    #[test]
    fn walk_of_an_empty_folder_is_the_folder_itself() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("hollow")).unwrap();
        let found = walk_item(dir.path(), &top("hollow", true)).unwrap();
        assert_eq!(found, vec![Found { rel: "hollow".into(), size: 0, is_dir: true, modified: None }]);
    }

    #[test]
    fn walk_of_a_missing_item_is_a_readable_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = walk_item(dir.path(), &top("gone", false)).unwrap_err();
        assert!(err.to_string().starts_with("not found:"), "{err}");
    }

    #[test]
    fn make_dir_creates_and_refuses_an_existing_name() {
        let dir = tempfile::tempdir().unwrap();
        make_dir(dir.path(), "fresh").unwrap();
        assert!(dir.path().join("fresh").is_dir());
        let err = make_dir(dir.path(), "fresh").unwrap_err();
        assert!(err.to_string().contains("already exists"), "{err}");
        assert!(make_dir(dir.path(), "a/b").is_err());
    }

    #[test]
    fn rename_moves_files_and_folders_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "a").unwrap();
        fs::create_dir(dir.path().join("d")).unwrap();
        fs::write(dir.path().join("d/in.txt"), "in").unwrap();
        rename_path(&dir.path().join("a.txt"), &dir.path().join("b.txt")).unwrap();
        rename_path(&dir.path().join("d"), &dir.path().join("e")).unwrap();
        assert!(!dir.path().join("a.txt").exists() && dir.path().join("b.txt").exists());
        assert_eq!(fs::read_to_string(dir.path().join("e/in.txt")).unwrap(), "in");
        fs::write(dir.path().join("a.txt"), "again").unwrap();
        let err = rename_path(&dir.path().join("a.txt"), &dir.path().join("b.txt")).unwrap_err();
        assert!(err.to_string().contains("already exists"), "{err}");
        assert_eq!(fs::read_to_string(dir.path().join("b.txt")).unwrap(), "a");
    }

    #[test]
    fn copy_then_remove_moves_a_whole_tree() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("from/sub")).unwrap();
        fs::write(dir.path().join("from/sub/f.txt"), "deep").unwrap();
        fs::create_dir(dir.path().join("from/empty")).unwrap();
        copy_then_remove(&dir.path().join("from"), &dir.path().join("to")).unwrap();
        assert!(!dir.path().join("from").exists());
        assert_eq!(fs::read_to_string(dir.path().join("to/sub/f.txt")).unwrap(), "deep");
        assert!(dir.path().join("to/empty").is_dir());
    }

    #[test]
    fn remove_empty_tree_keeps_directories_that_still_hold_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("t/a/b")).unwrap();
        fs::create_dir_all(dir.path().join("t/keep")).unwrap();
        fs::write(dir.path().join("t/keep/f"), "x").unwrap();
        remove_empty_tree(&dir.path().join("t"));
        assert!(!dir.path().join("t/a").exists());
        assert!(dir.path().join("t/keep/f").exists());
        remove_empty_tree(&dir.path().join("missing"));
    }

    #[test]
    fn trash_items_uses_the_injected_bin_and_reports_each_failure() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a"), "1").unwrap();
        fs::write(dir.path().join("b"), "2").unwrap();
        fs::write(dir.path().join("c"), "3").unwrap();
        let trash = FakeTrash { fail_on: Some("b"), ..Default::default() };
        let failures = trash_items(&trash, dir.path(), &[top("a", false), top("b", false), top("c", false)]);
        assert_eq!(failures, vec![ItemFailure { name: "b".into(), message: "trash unavailable".into() }]);
        let trashed = trash.trashed.lock().unwrap();
        assert_eq!(trashed.len(), 2);
        assert!(trashed[0].ends_with("a") && trashed[1].ends_with("c"));
        // the fake never removed anything: nothing real was touched
        assert!(dir.path().join("a").exists());
    }
}
