//! Writes a text file the user chose in the save dialog (the presigned URL list).
//! No Tauri dependency. The contents are live signed URLs: never logged.

use std::path::Path;

use crate::app_error::AppError;
use crate::local::describe_io_error;

/// Creates or truncates exactly the file at `path` (absolute) and writes `contents` to it.
pub fn write_text_file(path: &str, contents: &str) -> Result<(), AppError> {
    let target = Path::new(path.trim());
    if path.trim().is_empty() || !target.is_absolute() {
        return Err(AppError::Local("choose a file to save to".into()));
    }
    std::fs::write(target, contents).map_err(|err| describe_io_error(&err, target))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_truncates_the_chosen_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("urls.txt");
        std::fs::write(&path, "old old old old old").unwrap();
        write_text_file(path.to_str().unwrap(), "a\nb\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a\nb\n");
        write_text_file(path.to_str().unwrap(), "c").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "c");
    }

    #[test]
    fn rejects_empty_and_relative_paths_without_writing() {
        assert!(matches!(write_text_file("", "x"), Err(AppError::Local(_))));
        assert!(matches!(write_text_file("   ", "x"), Err(AppError::Local(_))));
        assert!(matches!(write_text_file("urls.txt", "x"), Err(AppError::Local(_))));
        assert!(!Path::new("urls.txt").exists());
    }

    #[test]
    fn a_missing_folder_is_a_readable_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no_such_dir").join("urls.txt");
        let err = write_text_file(path.to_str().unwrap(), "x").unwrap_err();
        assert!(matches!(err, AppError::Local(_)), "{err}");
    }
}
