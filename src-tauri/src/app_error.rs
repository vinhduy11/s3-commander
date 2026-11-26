//! One error type for everything the UI can see. Its serialized form is the readable message.

use serde::{Serialize, Serializer};

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
}
