//! One error type for everything the UI can see. Its serialized form is the readable message.

use serde::{Serialize, Serializer};

use crate::profile_rules::FieldError;
use crate::vault::VaultError;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error(transparent)]
    Vault(#[from] VaultError),
    #[error("{0}")]
    S3(String),
    #[error("{0}")]
    Local(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

/// What `profile_save` returns on failure: the readable message plus per-field errors (empty
/// unless the input failed validation), so the form can show them next to the right input.
#[derive(Debug, Serialize)]
pub struct ProfileSaveError {
    pub message: String,
    pub fields: Vec<FieldError>,
}

impl From<VaultError> for ProfileSaveError {
    fn from(err: VaultError) -> Self {
        let message = err.to_string();
        match err {
            VaultError::Validation(fields) => Self { message, fields },
            _ => Self { message, fields: Vec::new() },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_readable_message() {
        let json = serde_json::to_string(&AppError::S3("bucket not found".into())).unwrap();
        assert_eq!(json, "\"bucket not found\"");
    }

    #[test]
    fn vault_error_keeps_its_message() {
        let json = serde_json::to_string(&AppError::from(VaultError::Locked)).unwrap();
        assert_eq!(json, "\"vault is locked\"");
    }

    #[test]
    fn profile_save_error_carries_the_per_field_errors() {
        let err = ProfileSaveError::from(VaultError::Validation(vec![FieldError {
            field: "name",
            message: "Name is required.".into(),
        }]));
        let json: serde_json::Value = serde_json::to_value(&err).unwrap();
        assert_eq!(json["fields"][0]["field"], "name");
        assert_eq!(json["fields"][0]["message"], "Name is required.");
        assert!(json["message"].as_str().unwrap().contains("Name is required."));
    }

    #[test]
    fn profile_save_error_for_other_failures_has_no_fields() {
        let json: serde_json::Value = serde_json::to_value(ProfileSaveError::from(VaultError::Locked)).unwrap();
        assert_eq!(json["message"], "vault is locked");
        assert_eq!(json["fields"], serde_json::json!([]));
    }
}
