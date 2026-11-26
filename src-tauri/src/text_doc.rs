//! Reading and saving text files for the in-app viewer and editor (LOCAL files). UTF-8 only: the
//! BOM is split off and handed back separately, every other byte of the text (line endings,
//! trailing newline) is kept as is, so an untouched file saves byte-identical. No Tauri dependency.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::app_error::AppError;
use crate::local::describe_io_error;

/// Largest file the app opens in the viewer and editor.
pub const MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;
const BOM: &[u8] = b"\xEF\xBB\xBF";

/// Decoded content: the text without its BOM, and whether a BOM was there.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TextDoc {
    pub text: String,
    pub bom: bool,
}

/// What a save did. `Changed` means the file or object differs from what the user opened, and
/// nothing was written (the UI offers Overwrite, Save as copy or Cancel).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SaveOutcome {
    Saved { stamp: String },
    Changed,
}

/// The size-cap message, shared by LOCAL and SERVER opens.
pub fn too_large(size: u64) -> AppError {
    AppError::Invalid(format!(
        "This file is {} MiB; the viewer opens files up to {} MiB. Download it to a Local panel to open it elsewhere.",
        size.div_ceil(1024 * 1024),
        MAX_TEXT_BYTES / (1024 * 1024)
    ))
}

/// UTF-8 text with an optional BOM; rejects NUL bytes and invalid UTF-8 with a readable message
/// (the message never repeats file content).
pub fn decode_text(bytes: &[u8]) -> Result<TextDoc, AppError> {
    let (body, bom) = match bytes.strip_prefix(BOM) {
        Some(rest) => (rest, true),
        None => (bytes, false),
    };
    if body.contains(&0) {
        return Err(AppError::Invalid("This is not a text file (it contains binary data).".into()));
    }
    match std::str::from_utf8(body) {
        Ok(text) => Ok(TextDoc { text: text.to_string(), bom }),
        Err(_) => Err(AppError::Invalid("This file is not valid UTF-8 text; only UTF-8 files open in the app.".into())),
    }
}

/// The bytes to store: the BOM (when there was one) followed by the text.
pub fn encode_text(text: &str, bom: bool) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() + 3);
    if bom {
        bytes.extend_from_slice(BOM);
    }
    bytes.extend_from_slice(text.as_bytes());
    bytes
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LocalTextOpen {
    pub text: String,
    pub bom: bool,
    pub size: u64,
    /// Opaque "size:modified-nanos" of the file when read; handed back on save to detect a change.
    pub stamp: String,
}

fn stamp_of(metadata: &fs::Metadata) -> String {
    let nanos = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0, |after| after.as_nanos());
    format!("{}:{nanos}", metadata.len())
}

fn absolute(path: &str) -> Result<&Path, AppError> {
    let target = Path::new(path.trim());
    if path.trim().is_empty() || !target.is_absolute() {
        return Err(AppError::Local("choose a file".into()));
    }
    Ok(target)
}

/// Reads a local file for the viewer: size cap first, then UTF-8 and NUL checks.
pub fn local_open(path: &str) -> Result<LocalTextOpen, AppError> {
    let target = absolute(path)?;
    let metadata = fs::metadata(target).map_err(|err| describe_io_error(&err, target))?;
    if metadata.is_dir() {
        return Err(AppError::Invalid("This is a folder, not a file.".into()));
    }
    if metadata.len() > MAX_TEXT_BYTES {
        return Err(too_large(metadata.len()));
    }
    let bytes = fs::read(target).map_err(|err| describe_io_error(&err, target))?;
    let doc = decode_text(&bytes)?;
    // Stamp from the metadata read before the content: a change after it is then detected on save.
    Ok(LocalTextOpen { text: doc.text, bom: doc.bom, size: bytes.len() as u64, stamp: stamp_of(&metadata) })
}

/// Saves atomically: a temporary file in the same folder, then a rename over the target, keeping
/// the target's permissions. With `expected_stamp` the file must still look as it did when opened,
/// otherwise nothing is written and `Changed` is returned. Without it the file is overwritten
/// (Overwrite, or Save as copy to a path the user chose).
// ponytail: check-then-rename is not one atomic step; a change between the stamp check and the
// rename is lost. A file lock would close it; accepted for a desktop editor.
pub fn local_save(path: &str, text: &str, bom: bool, expected_stamp: Option<&str>) -> Result<SaveOutcome, AppError> {
    let requested = absolute(path)?;
    // A symlink is written through, so the link itself survives.
    let target: PathBuf = fs::canonicalize(requested).unwrap_or_else(|_| requested.to_path_buf());
    let existing = fs::metadata(&target).ok();
    if let Some(expected) = expected_stamp {
        match &existing {
            Some(metadata) if stamp_of(metadata) == expected => {}
            _ => return Ok(SaveOutcome::Changed),
        }
    }
    let bytes = encode_text(text, bom);
    let temp = temp_path(&target);
    let written = write_temp(&temp, &bytes, existing.as_ref()).and_then(|()| fs::rename(&temp, &target));
    if let Err(err) = written {
        let _ = fs::remove_file(&temp);
        return Err(describe_io_error(&err, &target));
    }
    let saved = fs::metadata(&target).map_err(|err| describe_io_error(&err, &target))?;
    Ok(SaveOutcome::Saved { stamp: stamp_of(&saved) })
}

fn temp_path(target: &Path) -> PathBuf {
    let name = target.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let nanos = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |after| after.as_nanos());
    target.with_file_name(format!(".{name}.{}.{nanos}.tmp", std::process::id()))
}

fn write_temp(temp: &Path, bytes: &[u8], existing: Option<&fs::Metadata>) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(temp)?;
    if let Some(metadata) = existing {
        fs::set_permissions(temp, metadata.permissions())?;
    }
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> String {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn decodes_plain_utf8_and_the_empty_file() {
        assert_eq!(decode_text("h\u{e9}llo\n".as_bytes()).unwrap(), TextDoc { text: "h\u{e9}llo\n".into(), bom: false });
        assert_eq!(decode_text(b"").unwrap(), TextDoc { text: String::new(), bom: false });
    }

    #[test]
    fn a_bom_is_split_off_and_reported() {
        let doc = decode_text(b"\xEF\xBB\xBFa,b\n").unwrap();
        assert_eq!(doc, TextDoc { text: "a,b\n".into(), bom: true });
        assert_eq!(encode_text(&doc.text, doc.bom), b"\xEF\xBB\xBFa,b\n");
    }

    #[test]
    fn nul_bytes_and_invalid_utf8_are_refused_without_echoing_content() {
        let nul = decode_text(b"abc\0def").unwrap_err();
        assert!(matches!(nul, AppError::Invalid(_)));
        assert!(nul.to_string().contains("not a text file"), "{nul}");
        let bad = decode_text(b"secret-token \xFF\xFE").unwrap_err();
        assert!(bad.to_string().contains("not valid UTF-8"), "{bad}");
        assert!(!bad.to_string().contains("secret-token"));
    }

    #[test]
    fn untouched_content_round_trips_byte_identical() {
        let samples: [&[u8]; 6] = [b"a\r\nb\r\n", b"a\nb", b"a\r\nb\nc\r", b"\xEF\xBB\xBFx\r\n", b"", b"\n\n"];
        for sample in samples {
            let doc = decode_text(sample).unwrap();
            assert_eq!(encode_text(&doc.text, doc.bom), sample);
        }
    }

    #[test]
    fn local_save_of_an_untouched_file_is_byte_identical() {
        let dir = tempfile::tempdir().unwrap();
        let original: &[u8] = b"\xEF\xBB\xBFone\r\ntwo\r\nlast";
        let path = write(dir.path(), "a.txt", original);
        let opened = local_open(&path).unwrap();
        assert!(opened.bom);
        assert_eq!(local_save(&path, &opened.text, opened.bom, Some(&opened.stamp)).unwrap(), SaveOutcome::Saved { stamp: stamp_of(&fs::metadata(&path).unwrap()) });
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn local_open_refuses_binary_invalid_folder_and_too_large() {
        let dir = tempfile::tempdir().unwrap();
        let bin = write(dir.path(), "b.bin", b"\x00\x01\x02");
        assert!(local_open(&bin).unwrap_err().to_string().contains("not a text file"));
        let bad = write(dir.path(), "bad.txt", b"\xC3\x28");
        assert!(local_open(&bad).unwrap_err().to_string().contains("UTF-8"));
        assert!(matches!(local_open(dir.path().to_str().unwrap()), Err(AppError::Invalid(_))));
        let big = dir.path().join("big.txt");
        fs::File::create(&big).unwrap().set_len(MAX_TEXT_BYTES + 1).unwrap();
        let err = local_open(big.to_str().unwrap()).unwrap_err();
        assert!(err.to_string().contains("up to 5 MiB"), "{err}");
        let exact = dir.path().join("exact.txt");
        fs::write(&exact, vec![b'a'; MAX_TEXT_BYTES as usize]).unwrap();
        assert!(local_open(exact.to_str().unwrap()).is_ok());
        assert!(matches!(local_open("relative.txt"), Err(AppError::Local(_))));
        assert!(matches!(local_open(dir.path().join("missing.txt").to_str().unwrap()), Err(AppError::Local(_))));
    }

    #[cfg(unix)]
    #[test]
    fn atomic_save_keeps_permissions_and_leaves_no_temp_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "conf.ini", b"a=1\n");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let opened = local_open(&path).unwrap();
        local_save(&path, "a=2\n", false, Some(&opened.stamp)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "a=2\n");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["conf.ini"]);
    }

    #[test]
    fn a_file_changed_on_disk_is_not_overwritten_unless_asked() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "n.txt", b"mine");
        let opened = local_open(&path).unwrap();
        // size changes
        fs::write(&path, b"theirs, longer").unwrap();
        assert_eq!(local_save(&path, "edited", false, Some(&opened.stamp)).unwrap(), SaveOutcome::Changed);
        assert_eq!(fs::read(&path).unwrap(), b"theirs, longer");
        // same size, new modified time
        fs::write(&path, b"mine").unwrap();
        let reopened = local_open(&path).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(60)).unwrap();
        assert_eq!(local_save(&path, "edited", false, Some(&reopened.stamp)).unwrap(), SaveOutcome::Changed);
        // deleted file
        fs::remove_file(&path).unwrap();
        assert_eq!(local_save(&path, "edited", false, Some(&reopened.stamp)).unwrap(), SaveOutcome::Changed);
        // Overwrite: no stamp, writes anyway
        assert!(matches!(local_save(&path, "edited", false, None).unwrap(), SaveOutcome::Saved { .. }));
        assert_eq!(fs::read(&path).unwrap(), b"edited");
    }

    #[test]
    fn save_as_copy_writes_a_new_file_and_leaves_the_original() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "o.txt", b"orig");
        let copy = dir.path().join("o (copy).txt");
        local_save(copy.to_str().unwrap(), "new", false, None).unwrap();
        assert_eq!(fs::read(&copy).unwrap(), b"new");
        assert_eq!(fs::read(&path).unwrap(), b"orig");
    }

    #[test]
    fn save_rejects_relative_paths_and_missing_folders() {
        assert!(matches!(local_save("x.txt", "a", false, None), Err(AppError::Local(_))));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no_dir").join("x.txt");
        assert!(matches!(local_save(path.to_str().unwrap(), "a", false, None), Err(AppError::Local(_))));
    }
}
