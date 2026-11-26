//! Per-profile transfer settings modelled on the AWS CLI `s3` configuration. One place that
//! parses sizes, validates the four fields and resolves the effective values (AWS CLI defaults);
//! the frontend mirrors the rules in `src/profile/validate_profile.ts`. Only settings live here:
//! the multipart upload/download that consumes them is a later step.
//!
//! Storage: the four fields are strings as the user typed them in a normalized form (`100MB`,
//! `8388608`, `20`, `virtual`); empty = not set (the default applies). Strings keep a bad
//! imported value visible so it can be flagged instead of silently dropped.

use serde::{Deserialize, Serialize};

use crate::profile_rules::FieldError;

pub const DEFAULT_MULTIPART_THRESHOLD: u64 = 8 << 20;
pub const DEFAULT_MULTIPART_CHUNKSIZE: u64 = 8 << 20;
pub const DEFAULT_MAX_CONCURRENT_REQUESTS: usize = 10;
/// S3 minimum part size (all parts but the last).
pub const MIN_CHUNKSIZE: u64 = 5 << 20;
const MAX_CONCURRENT_REQUESTS: usize = 256;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TransferFields {
    pub multipart_threshold: String,
    pub multipart_chunksize: String,
    pub max_concurrent_requests: String,
    pub addressing_style: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressingStyle {
    Path,
    Virtual,
    Auto,
}

impl AddressingStyle {
    fn parse(text: &str) -> Option<Self> {
        match text.to_ascii_lowercase().as_str() {
            "path" => Some(Self::Path),
            "virtual" => Some(Self::Virtual),
            "auto" => Some(Self::Auto),
            _ => None,
        }
    }
}

/// Resolved values with defaults applied. Step 4 (multipart transfers) consumes this.
#[derive(Debug, Clone, PartialEq)]
pub struct EffectiveTransferSettings {
    pub multipart_threshold: u64,
    pub multipart_chunksize: u64,
    pub max_concurrent_requests: usize,
    pub addressing_style: AddressingStyle,
}

const SUFFIXES: [(&str, u32); 4] = [("KB", 10), ("MB", 20), ("GB", 30), ("TB", 40)];

/// Number and upper-case suffix of an AWS-CLI-style size: digits, then optionally one space and
/// KB/MB/GB/TB (case-insensitive). No decimals (the AWS CLI rejects them too). `None` = invalid.
fn size_parts(text: &str) -> Option<(u64, Option<&'static str>)> {
    let text = text.trim();
    let digits_end = text.find(|c: char| !c.is_ascii_digit()).unwrap_or(text.len());
    let number: u64 = text[..digits_end].parse().ok()?;
    let rest = text[digits_end..].strip_prefix(' ').unwrap_or(&text[digits_end..]);
    if rest.is_empty() && digits_end == text.len() {
        return Some((number, None));
    }
    let (name, _) = SUFFIXES.iter().find(|(name, _)| name.eq_ignore_ascii_case(rest))?;
    Some((number, Some(name)))
}

/// Bytes of an AWS-CLI-style size string (1024-based); `None` when invalid or too large.
pub fn parse_size(text: &str) -> Option<u64> {
    let (number, suffix) = size_parts(text)?;
    match suffix {
        None => Some(number),
        Some(name) => number.checked_mul(1u64 << SUFFIXES.iter().find(|(n, _)| *n == name)?.1),
    }
}

fn normalize_size(text: &str) -> Option<String> {
    parse_size(text)?;
    let (number, suffix) = size_parts(text)?;
    Some(format!("{number}{}", suffix.unwrap_or("")))
}

fn err(field: &'static str, message: &str) -> FieldError {
    FieldError { field, message: message.to_string() }
}

const BAD_SIZE: &str = "Enter a size such as 8MB, 100MB or 1GB, or a number of bytes.";

fn parse_concurrency(text: &str) -> Option<usize> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok().filter(|n| (1..=MAX_CONCURRENT_REQUESTS).contains(n))
}

/// Validate and normalize the four fields (at most one error per field). Messages never contain
/// the typed value.
pub fn validate_transfer(input: &TransferFields) -> Result<TransferFields, Vec<FieldError>> {
    let mut errors = Vec::new();
    let mut clean = TransferFields::default();
    let mut sizes: [Option<u64>; 2] = [None, None]; // threshold, chunksize (when set and valid)
    let set = [input.multipart_threshold.trim(), input.multipart_chunksize.trim()];
    let names = ["multipart_threshold", "multipart_chunksize"];
    for i in 0..2 {
        if set[i].is_empty() {
            continue;
        }
        match normalize_size(set[i]).and_then(|text| parse_size(&text).map(|bytes| (text, bytes))) {
            Some((text, bytes)) if i == 1 && bytes < MIN_CHUNKSIZE => {
                clean.multipart_chunksize = text;
                errors.push(err(names[i], "Chunk size must be at least 5 MB (the S3 minimum part size)."));
            }
            Some((text, bytes)) => {
                sizes[i] = Some(bytes);
                if i == 0 { clean.multipart_threshold = text } else { clean.multipart_chunksize = text }
            }
            None => errors.push(err(names[i], BAD_SIZE)),
        }
    }
    if errors.is_empty() {
        let threshold = sizes[0].unwrap_or(DEFAULT_MULTIPART_THRESHOLD);
        let chunksize = sizes[1].unwrap_or(DEFAULT_MULTIPART_CHUNKSIZE);
        if threshold < chunksize {
            // flag the field the user filled in; the threshold when both are set
            if sizes[0].is_some() {
                errors.push(err("multipart_threshold", "Threshold must not be smaller than the chunk size."));
            } else {
                errors.push(err("multipart_chunksize", "Chunk size must not be larger than the threshold (default 8 MB)."));
            }
        }
    }

    let concurrency = input.max_concurrent_requests.trim();
    if !concurrency.is_empty() {
        match parse_concurrency(concurrency) {
            Some(n) => clean.max_concurrent_requests = n.to_string(),
            None => errors.push(err("max_concurrent_requests", "Max concurrent requests must be a whole number between 1 and 256.")),
        }
    }

    let style = input.addressing_style.trim();
    if !style.is_empty() {
        match AddressingStyle::parse(style) {
            Some(_) => clean.addressing_style = style.to_ascii_lowercase(),
            None => errors.push(err("addressing_style", "Addressing style must be path, virtual or auto.")),
        }
    }

    if errors.is_empty() { Ok(clean) } else { Err(errors) }
}

/// The values to use for a profile: what is set, else the AWS CLI defaults (path-style addressing
/// for MinIO). A stored value that no longer parses falls back to its default.
pub fn effective_transfer_settings(fields: &TransferFields) -> EffectiveTransferSettings {
    EffectiveTransferSettings {
        multipart_threshold: parse_size(&fields.multipart_threshold).unwrap_or(DEFAULT_MULTIPART_THRESHOLD),
        multipart_chunksize: parse_size(&fields.multipart_chunksize).unwrap_or(DEFAULT_MULTIPART_CHUNKSIZE),
        max_concurrent_requests: parse_concurrency(&fields.max_concurrent_requests).unwrap_or(DEFAULT_MAX_CONCURRENT_REQUESTS),
        addressing_style: AddressingStyle::parse(&fields.addressing_style).unwrap_or(AddressingStyle::Path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_table() {
        let ok = [
            ("8388608", 8_388_608u64),
            ("0", 0),
            ("1KB", 1024),
            ("1kb", 1024),
            ("8MB", 8 << 20),
            ("8 mb", 8 << 20),
            ("100Mb", 100 << 20),
            ("1GB", 1 << 30),
            ("2tb", 2 << 40),
            ("  16MB ", 16 << 20),
            ("008MB", 8 << 20),
        ];
        for (text, bytes) in ok {
            assert_eq!(parse_size(text), Some(bytes), "{text}");
        }
        for bad in ["", "MB", "1.5MB", "8M", "8 MB MB", "-1MB", "1PB", "8MiB", "1  MB", "abc", "99999999999TB"] {
            assert_eq!(parse_size(bad), None, "{bad}");
        }
    }

    fn fields(threshold: &str, chunk: &str, conc: &str, style: &str) -> TransferFields {
        TransferFields {
            multipart_threshold: threshold.into(),
            multipart_chunksize: chunk.into(),
            max_concurrent_requests: conc.into(),
            addressing_style: style.into(),
        }
    }

    fn bad_fields(f: TransferFields) -> Vec<&'static str> {
        validate_transfer(&f).unwrap_err().iter().map(|e| e.field).collect()
    }

    #[test]
    fn empty_is_valid_and_normalized_forms_are_canonical() {
        assert_eq!(validate_transfer(&fields("", "", "", "")).unwrap(), fields("", "", "", ""));
        let clean = validate_transfer(&fields(" 100 mb ", "8MB", " 016 ", " Virtual ")).unwrap();
        assert_eq!(clean, fields("100MB", "8MB", "16", "virtual"));
    }

    #[test]
    fn chunksize_minimum_is_5_mib() {
        assert!(validate_transfer(&fields("", "5MB", "", "")).is_ok());
        assert!(validate_transfer(&fields("5MB", "5MB", "", "")).is_ok());
        assert_eq!(bad_fields(fields("", "5242879", "", "")), vec!["multipart_chunksize"]);
        assert_eq!(bad_fields(fields("", "1MB", "", "")), vec!["multipart_chunksize"]);
    }

    #[test]
    fn threshold_below_chunksize_is_rejected_on_the_field_the_user_set() {
        assert!(validate_transfer(&fields("16MB", "16MB", "", "")).is_ok());
        assert_eq!(bad_fields(fields("6MB", "7MB", "", "")), vec!["multipart_threshold"]);
        // threshold unset: the effective default (8 MiB) is compared, the chunksize field is flagged
        assert_eq!(bad_fields(fields("", "16MB", "", "")), vec!["multipart_chunksize"]);
        // chunksize unset: default 8 MiB vs a smaller threshold
        assert_eq!(bad_fields(fields("6MB", "", "", "")), vec!["multipart_threshold"]);
    }

    #[test]
    fn concurrency_bounds_and_text() {
        for ok in ["1", "10", "256"] {
            assert!(validate_transfer(&fields("", "", ok, "")).is_ok(), "{ok}");
        }
        for bad in ["0", "257", "-1", "1.5", "ten"] {
            assert_eq!(bad_fields(fields("", "", bad, "")), vec!["max_concurrent_requests"], "{bad}");
        }
    }

    #[test]
    fn addressing_style_values() {
        for ok in ["path", "virtual", "auto", "PATH"] {
            assert!(validate_transfer(&fields("", "", "", ok)).is_ok(), "{ok}");
        }
        assert_eq!(bad_fields(fields("", "", "", "bucket")), vec!["addressing_style"]);
    }

    #[test]
    fn errors_never_contain_the_typed_value() {
        let errors = validate_transfer(&fields("zz-secret-1", "zz-secret-2", "zz-secret-3", "zz-secret-4")).unwrap_err();
        assert_eq!(errors.len(), 4);
        assert!(errors.iter().all(|e| !e.message.contains("zz-secret")));
    }

    #[test]
    fn effective_defaults_are_the_aws_cli_defaults_with_path_style() {
        let eff = effective_transfer_settings(&fields("", "", "", ""));
        assert_eq!(eff.multipart_threshold, 8 << 20);
        assert_eq!(eff.multipart_chunksize, 8 << 20);
        assert_eq!(eff.max_concurrent_requests, 10);
        assert_eq!(eff.addressing_style, AddressingStyle::Path);
    }

    #[test]
    fn effective_uses_set_values() {
        let eff = effective_transfer_settings(&fields("100MB", "16 mb", "32", "virtual"));
        assert_eq!(eff.multipart_threshold, 100 << 20);
        assert_eq!(eff.multipart_chunksize, 16 << 20);
        assert_eq!(eff.max_concurrent_requests, 32);
        assert_eq!(eff.addressing_style, AddressingStyle::Virtual);
        assert_eq!(effective_transfer_settings(&fields("", "", "", "auto")).addressing_style, AddressingStyle::Auto);
    }
}
