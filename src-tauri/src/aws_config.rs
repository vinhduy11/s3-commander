//! Read-only import of non-secret settings from an AWS CLI config file (`~/.aws/config`, or the
//! path in `AWS_CONFIG_FILE`). The parsers take text or a path so tests never touch the real
//! home directory. Only the keys in `AwsProfileSettings` are ever returned; the credentials file
//! is never read and every other key (including access keys and tokens) is ignored.

use std::path::{Path, PathBuf};

use serde::Serialize;

const NOT_FOUND: &str = "AWS config file not found.";

/// The only values that leave this module. All optional, raw text (validated by the form).
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct AwsProfileSettings {
    pub multipart_threshold: Option<String>,
    pub multipart_chunksize: Option<String>,
    pub max_concurrent_requests: Option<String>,
    pub addressing_style: Option<String>,
    pub region: Option<String>,
    pub endpoint_url: Option<String>,
}

struct Section {
    name: String,
    top: Vec<(String, String)>,
    s3: Vec<(String, String)>,
}

fn section_name(header: &str) -> Option<String> {
    let inner = header.strip_prefix('[')?.strip_suffix(']')?.trim();
    if inner == "default" {
        return Some("default".into());
    }
    let name = inner.strip_prefix("profile").filter(|rest| rest.starts_with(char::is_whitespace))?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn parse(text: &str) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    let mut current: Option<usize> = None; // index into `sections`, None while in an ignored section
    let mut in_s3 = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') {
            in_s3 = false;
            current = section_name(line).map(|name| {
                sections.push(Section { name, top: Vec::new(), s3: Vec::new() });
                sections.len() - 1
            });
            continue;
        }
        let Some(idx) = current else { continue };
        let Some((key, value)) = line.split_once('=') else { continue };
        let (key, value) = (key.trim().to_string(), value.trim().to_string());
        if raw.starts_with(char::is_whitespace) && in_s3 {
            sections[idx].s3.push((key, value));
        } else {
            in_s3 = key == "s3" && value.is_empty();
            if !in_s3 {
                sections[idx].top.push((key, value));
            }
        }
    }
    sections
}

fn find(entries: &[(String, String)], key: &str) -> Option<String> {
    entries.iter().rev().find(|(k, v)| k == key && !v.is_empty()).map(|(_, v)| v.clone())
}

pub fn list_profiles_in(text: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for section in parse(text) {
        if !names.contains(&section.name) {
            names.push(section.name);
        }
    }
    names
}

pub fn read_profile_in(text: &str, name: &str) -> Result<AwsProfileSettings, String> {
    let sections = parse(text);
    let matching: Vec<&Section> = sections.iter().filter(|s| s.name == name).collect();
    if matching.is_empty() {
        return Err(format!("Profile \"{name}\" was not found in the AWS config file."));
    }
    let top: Vec<(String, String)> = matching.iter().flat_map(|s| s.top.clone()).collect();
    let s3: Vec<(String, String)> = matching.iter().flat_map(|s| s.s3.clone()).collect();
    Ok(AwsProfileSettings {
        multipart_threshold: find(&s3, "multipart_threshold"),
        multipart_chunksize: find(&s3, "multipart_chunksize"),
        max_concurrent_requests: find(&s3, "max_concurrent_requests"),
        addressing_style: find(&s3, "addressing_style"),
        region: find(&top, "region"),
        endpoint_url: find(&s3, "endpoint_url").or_else(|| find(&top, "endpoint_url")),
    })
}

fn read_file(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => NOT_FOUND.to_string(),
        _ => "Could not read the AWS config file.".to_string(),
    })
}

pub fn list_profiles_at(path: &Path) -> Result<Vec<String>, String> {
    read_file(path).map(|text| list_profiles_in(&text))
}

pub fn read_profile_at(path: &Path, name: &str) -> Result<AwsProfileSettings, String> {
    read_profile_in(&read_file(path)?, name)
}

/// `AWS_CONFIG_FILE` when set and not empty, else `~/.aws/config`.
pub fn config_path() -> Option<PathBuf> {
    match std::env::var_os("AWS_CONFIG_FILE").filter(|value| !value.is_empty()) {
        Some(path) => Some(PathBuf::from(path)),
        None => std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".aws").join("config")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# top comment
; another comment
[default]
region = eu-test-1
aws_access_key_id = AKIAFAKEFAKEFAKE
aws_secret_access_key = fake-secret-value
aws_session_token = fake-token-value
endpoint_url = http://flat.example:9000
s3 =
    multipart_threshold = 64MB
    multipart_chunksize = 16MB
    max_concurrent_requests = 20
    addressing_style = virtual
    # nested comment
    endpoint_url = http://nested.example:9000
    signature_version = s3v4

[profile lab]
region = us-test-2
endpoint_url = http://lab.example:9000
output = json

[profile  spaced ]
s3 =
  max_concurrent_requests = 4
[sso-session ignored]
sso_start_url = https://x.example
";

    #[test]
    fn lists_default_and_named_profiles_only() {
        assert_eq!(list_profiles_in(SAMPLE), vec!["default", "lab", "spaced"]);
    }

    #[test]
    fn empty_file_has_no_profiles() {
        assert!(list_profiles_in("").is_empty());
        assert!(list_profiles_in("# only a comment\n").is_empty());
    }

    #[test]
    fn default_profile_with_nested_s3_block() {
        let got = read_profile_in(SAMPLE, "default").unwrap();
        assert_eq!(got.multipart_threshold.as_deref(), Some("64MB"));
        assert_eq!(got.multipart_chunksize.as_deref(), Some("16MB"));
        assert_eq!(got.max_concurrent_requests.as_deref(), Some("20"));
        assert_eq!(got.addressing_style.as_deref(), Some("virtual"));
        assert_eq!(got.region.as_deref(), Some("eu-test-1"));
        // the s3-specific endpoint wins over the flat one
        assert_eq!(got.endpoint_url.as_deref(), Some("http://nested.example:9000"));
    }

    #[test]
    fn named_profile_with_flat_endpoint_and_no_s3_block() {
        let got = read_profile_in(SAMPLE, "lab").unwrap();
        assert_eq!(got.endpoint_url.as_deref(), Some("http://lab.example:9000"));
        assert_eq!(got.region.as_deref(), Some("us-test-2"));
        assert_eq!(got.multipart_threshold, None);
        assert_eq!(got.max_concurrent_requests, None);
    }

    #[test]
    fn section_name_whitespace_and_block_end() {
        let got = read_profile_in(SAMPLE, "spaced").unwrap();
        assert_eq!(got.max_concurrent_requests.as_deref(), Some("4"));
        assert_eq!(got.region, None);
    }

    #[test]
    fn missing_profile_is_a_clear_error() {
        let err = read_profile_in(SAMPLE, "nope").unwrap_err();
        assert!(err.contains("nope"), "{err}");
        assert!(read_profile_in("", "default").is_err());
    }

    #[test]
    fn secrets_and_other_keys_never_come_back() {
        let got = read_profile_in(SAMPLE, "default").unwrap();
        let text = serde_json::to_string(&got).unwrap();
        for leaked in ["AKIAFAKE", "fake-secret", "fake-token", "aws_access_key_id", "signature_version", "s3v4", "json"] {
            assert!(!text.contains(leaked), "{leaked} in {text}");
        }
        let mut keys: Vec<String> = serde_json::to_value(&got).unwrap().as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            ["addressing_style", "endpoint_url", "max_concurrent_requests", "multipart_chunksize", "multipart_threshold", "region"]
        );
    }

    #[test]
    fn crlf_and_top_level_keys_after_the_nested_block() {
        let text = "[default]\r\ns3 =\r\n    multipart_chunksize = 9MB\r\nregion = r-1\r\n";
        let got = read_profile_in(text, "default").unwrap();
        assert_eq!(got.multipart_chunksize.as_deref(), Some("9MB"));
        assert_eq!(got.region.as_deref(), Some("r-1"));
    }

    #[test]
    fn file_functions_read_a_path_and_report_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        assert!(list_profiles_at(&path).unwrap_err().contains("not found"));
        std::fs::write(&path, SAMPLE).unwrap();
        assert_eq!(list_profiles_at(&path).unwrap().len(), 3);
        assert_eq!(read_profile_at(&path, "lab").unwrap().region.as_deref(), Some("us-test-2"));
        assert!(read_profile_at(&dir.path().join("absent"), "lab").is_err());
    }
}
