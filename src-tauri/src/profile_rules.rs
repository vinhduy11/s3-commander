//! The one place that decides whether a profile input is acceptable (Rust is authoritative; the
//! frontend mirrors these rules in `src/profile/validate_profile.ts`, checked against the shared
//! table `src/profile/validation_cases.json`). Messages never contain the values checked, so the
//! secret key can never leak through an error.

use serde::Serialize;

use crate::transfer_settings::validate_transfer;
use crate::vault::{DEFAULT_REGION, ProfileInput};

/// One problem, tied to the form field it belongs to (`name`, `endpoint`, `access_key`,
/// `secret_key`, `region`, and the four transfer settings).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FieldError {
    pub field: &'static str,
    pub message: String,
}

const NAME_MAX: usize = 64;
const REGION_MAX: usize = 32;

fn err(field: &'static str, message: &str) -> FieldError {
    FieldError { field, message: message.to_string() }
}

/// Validate and normalize `input`. `others` are the names of the other profiles (without the
/// one being edited). `is_new` = no stored profile has this id; only then is the secret required.
/// On success the returned input is trimmed (secret untouched, empty = keep stored on edit).
/// At most one error per field.
pub fn validate_profile_input(
    input: &ProfileInput,
    others: &[&str],
    is_new: bool,
) -> Result<ProfileInput, Vec<FieldError>> {
    let mut errors = Vec::new();
    let mut clean = input.clone();

    clean.name = input.name.trim().to_string();
    if clean.name.is_empty() {
        errors.push(err("name", "Name is required."));
    } else if clean.name.chars().count() > NAME_MAX {
        errors.push(err("name", "Name must be 64 characters or fewer."));
    } else if others.iter().any(|other| other.trim().to_lowercase() == clean.name.to_lowercase()) {
        errors.push(err("name", "A profile with this name already exists."));
    }

    match normalize_endpoint(input.endpoint.trim()) {
        Ok(endpoint) => clean.endpoint = endpoint,
        Err(message) => {
            clean.endpoint = input.endpoint.trim().to_string();
            errors.push(err("endpoint", message));
        }
    }

    clean.access_key = input.access_key.trim().to_string();
    if clean.access_key.is_empty() {
        errors.push(err("access_key", "Access key is required."));
    } else if clean.access_key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        errors.push(err("access_key", "Access key must not contain spaces or control characters."));
    }

    if input.secret_key.is_empty() {
        if is_new {
            errors.push(err("secret_key", "Secret key is required."));
        }
    } else if input.secret_key.chars().any(char::is_control) {
        errors.push(err("secret_key", "Secret key must not contain control characters or line breaks."));
    }

    clean.region = match input.region.trim() {
        "" => DEFAULT_REGION.to_string(),
        region => region.to_string(),
    };
    let region_ok = clean.region.len() <= REGION_MAX
        && clean.region.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !region_ok {
        errors.push(err("region", "Region must be 1 to 32 characters: lowercase letters, digits and hyphens."));
    }

    match validate_transfer(&input.transfer) {
        Ok(transfer) => clean.transfer = transfer,
        Err(found) => errors.extend(found),
    }

    if errors.is_empty() { Ok(clean) } else { Err(errors) }
}

const BAD_URL: &str = "Enter a valid URL, for example http://localhost:9000.";
const BAD_PORT: &str = "Port must be between 1 and 65535.";

/// `raw` is already trimmed. Returns `scheme://host[:port]` (lowercase host, default port
/// dropped, no trailing slash) or the message for the first rule it breaks.
fn normalize_endpoint(raw: &str) -> Result<String, &'static str> {
    if raw.is_empty() {
        return Err("Endpoint URL is required.");
    }
    if raw.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Endpoint must not contain spaces.");
    }
    let lower = raw.to_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("Endpoint must start with http:// or https://.");
    }
    if raw.contains(['?', '#']) {
        return Err("Endpoint must not contain a query string or fragment.");
    }
    let authority = raw[raw.find("//").unwrap_or(0) + 2..].split('/').next().unwrap_or("");
    if authority.contains('@') {
        return Err("Endpoint must not contain a user name or password.");
    }
    let url = url::Url::parse(raw).map_err(|e| match e {
        url::ParseError::InvalidPort => BAD_PORT,
        _ => BAD_URL,
    })?;
    if url.host_str().is_none_or(str::is_empty) {
        return Err(BAD_URL);
    }
    if url.port() == Some(0) {
        return Err(BAD_PORT);
    }
    if url.path() != "/" {
        return Err("Endpoint must be the server address only, without a path.");
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[derive(serde::Deserialize)]
    struct Table {
        cases: Vec<Case>,
    }
    #[derive(serde::Deserialize)]
    struct Case {
        label: String,
        #[serde(rename = "isNew")]
        is_new: bool,
        others: Vec<String>,
        input: Raw,
        errors: Vec<String>,
        normalized: Option<serde_json::Value>,
    }
    #[derive(serde::Deserialize, Clone)]
    struct Raw {
        name: String,
        endpoint: String,
        access_key: String,
        secret_key: String,
        region: String,
        #[serde(flatten)]
        transfer: crate::transfer_settings::TransferFields,
    }

    fn input_of(raw: Raw) -> ProfileInput {
        ProfileInput {
            id: String::new(),
            name: raw.name,
            endpoint: raw.endpoint,
            access_key: raw.access_key,
            secret_key: raw.secret_key,
            region: raw.region,
            transfer: raw.transfer,
        }
    }

    fn table() -> Table {
        serde_json::from_str(include_str!("../../src/profile/validation_cases.json")).unwrap()
    }

    #[test]
    fn shared_cases_give_the_expected_fields() {
        for case in table().cases {
            let others: Vec<&str> = case.others.iter().map(String::as_str).collect();
            let result = validate_profile_input(&input_of(case.input), &others, case.is_new);
            let got: BTreeSet<String> = match &result {
                Ok(_) => BTreeSet::new(),
                Err(errors) => errors.iter().map(|e| e.field.to_string()).collect(),
            };
            let want: BTreeSet<String> = case.errors.iter().cloned().collect();
            assert_eq!(got, want, "case: {}", case.label);
            if let (Ok(clean), Some(normalized)) = (&result, &case.normalized) {
                let actual = serde_json::json!({
                    "name": clean.name, "endpoint": clean.endpoint,
                    "access_key": clean.access_key, "region": clean.region,
                    "multipart_threshold": clean.transfer.multipart_threshold,
                    "multipart_chunksize": clean.transfer.multipart_chunksize,
                    "max_concurrent_requests": clean.transfer.max_concurrent_requests,
                    "addressing_style": clean.transfer.addressing_style,
                });
                for (key, value) in normalized.as_object().unwrap() {
                    assert_eq!(&actual[key], value, "case: {} field {key}", case.label);
                }
            }
        }
    }

    #[test]
    fn errors_have_messages_and_never_contain_the_secret() {
        let secret = "s3cr3t-VALUE\nx";
        let mut bad = input_of(table().cases[0].input.clone());
        bad.secret_key = secret.into();
        bad.endpoint = format!("http://user:{secret}@host");
        bad.name = String::new();
        let errors = validate_profile_input(&bad, &[], true).unwrap_err();
        assert!(errors.len() >= 3);
        let text = format!("{errors:?}{}", serde_json::to_string(&errors).unwrap());
        assert!(!text.contains("s3cr3t"), "secret leaked: {text}");
        assert!(errors.iter().all(|e| !e.message.is_empty()));
    }

    #[test]
    fn default_region_constant_is_used() {
        let clean = validate_profile_input(&input_of(table().cases[0].input.clone()), &[], true).unwrap();
        assert_eq!(clean.region, DEFAULT_REGION);
    }
}
