//! Reading and saving text objects for the in-app viewer and editor (SERVER files). Mocked in
//! tests; no Tauri dependency.

use std::collections::HashMap;

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use aws_smithy_types::error::metadata::ProvideErrorMetadata;
use serde::Serialize;

use crate::app_error::AppError;
use crate::s3::map_sdk_error;
use crate::text_doc::{decode_text, encode_text, too_large, SaveOutcome, MAX_TEXT_BYTES};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct S3TextOpen {
    pub text: String,
    pub bom: bool,
    pub size: u64,
    /// Handed back on save: the object must still carry this ETag.
    pub etag: String,
    pub content_type: Option<String>,
    pub metadata: HashMap<String, String>,
}

/// What a save writes besides the text: the Content-Type and user metadata read at open time.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ObjectMeta {
    pub content_type: Option<String>,
    pub metadata: HashMap<String, String>,
}

pub fn normalize_etag(etag: &str) -> &str {
    etag.trim().trim_matches('"')
}

pub async fn s3_open(client: &Client, bucket: &str, key: &str) -> Result<S3TextOpen, AppError> {
    let object = client.get_object().bucket(bucket).key(key).send().await.map_err(map_sdk_error)?;
    if let Some(length) = object.content_length().and_then(|length| u64::try_from(length).ok()).filter(|length| *length > MAX_TEXT_BYTES) {
        return Err(too_large(length));
    }
    let etag = object.e_tag().unwrap_or_default().to_string();
    let content_type = object.content_type().map(str::to_string);
    let metadata = object.metadata().cloned().unwrap_or_default();
    let bytes = object.body.collect().await.map_err(|err| AppError::S3(err.to_string()))?.into_bytes();
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err(too_large(bytes.len() as u64));
    }
    let doc = decode_text(&bytes)?;
    Ok(S3TextOpen { text: doc.text, bom: doc.bom, size: bytes.len() as u64, etag, content_type, metadata })
}

/// `expected_etag` set: save only if the object still has it (`Changed` otherwise). `create_only`:
/// refuse when the key already exists (Save as copy). Both unset: overwrite.
///
/// With an ETag the object is compared with HEAD first (works on any server) and the PUT also
/// carries `If-Match`, so a change between the two is caught where the server supports it; a server
/// that rejects the header as unsupported gets the same PUT without it.
// ponytail: HEAD then PUT leaves a small window on a server without If-Match; accepted.
#[allow(clippy::too_many_arguments)]
pub async fn s3_save(
    client: &Client,
    bucket: &str,
    key: &str,
    text: &str,
    bom: bool,
    meta: &ObjectMeta,
    expected_etag: Option<&str>,
    create_only: bool,
) -> Result<SaveOutcome, AppError> {
    let head = if expected_etag.is_some() || create_only { Some(head_etag(client, bucket, key).await?) } else { None };
    if create_only && head.as_ref().is_some_and(Option::is_some) {
        return Err(AppError::Invalid("An object with that name already exists.".into()));
    }
    if let Some(expected) = expected_etag {
        let current = head.flatten();
        if current.as_deref().map(normalize_etag) != Some(normalize_etag(expected)) {
            return Ok(SaveOutcome::Changed);
        }
    }
    let bytes = encode_text(text, bom);
    let mut condition = expected_etag;
    loop {
        let request = client
            .put_object()
            .bucket(bucket)
            .key(key)
            .body(ByteStream::from(bytes.clone()))
            .set_if_match(condition.map(str::to_string))
            .set_content_type(meta.content_type.clone())
            .set_metadata((!meta.metadata.is_empty()).then(|| meta.metadata.clone()));
        match request.send().await {
            Ok(output) => return Ok(SaveOutcome::Saved { stamp: output.e_tag().unwrap_or_default().to_string() }),
            Err(err) => match (err.code(), condition) {
                (Some("PreconditionFailed"), Some(_)) => return Ok(SaveOutcome::Changed),
                (Some("NotImplemented" | "XNotImplemented"), Some(_)) => condition = None,
                _ => return Err(map_sdk_error(err)),
            },
        }
    }
}

/// The object's ETag, or `None` when it does not exist.
async fn head_etag(client: &Client, bucket: &str, key: &str) -> Result<Option<String>, AppError> {
    match client.head_object().bucket(bucket).key(key).send().await {
        Ok(head) => Ok(Some(head.e_tag().unwrap_or_default().to_string())),
        Err(err) if err.as_service_error().is_some_and(|service| service.is_not_found()) => Ok(None),
        Err(err) => Err(map_sdk_error(err)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::operation::head_object::HeadObjectOutput;
    use aws_sdk_s3::operation::put_object::{PutObjectError, PutObjectOutput};
    use aws_smithy_mocks::{mock, mock_client, RuleMode};
    use aws_smithy_types::error::metadata::ErrorMetadata;

    fn get(body: &'static [u8], etag: &str) -> GetObjectOutput {
        GetObjectOutput::builder()
            .body(ByteStream::from_static(body))
            .content_length(body.len() as i64)
            .e_tag(etag)
            .content_type("text/csv")
            .metadata("owner", "team-a")
            .build()
    }

    fn precondition_failed() -> PutObjectError {
        PutObjectError::generic(ErrorMetadata::builder().code("PreconditionFailed").message("At least one of the pre-conditions you specified did not hold").build())
    }

    fn meta() -> ObjectMeta {
        ObjectMeta { content_type: Some("text/csv".into()), metadata: HashMap::from([("owner".to_string(), "team-a".to_string())]) }
    }

    #[tokio::test]
    async fn open_returns_text_etag_content_type_and_metadata() {
        let rule = mock!(Client::get_object)
            .match_requests(|req| req.bucket() == Some("bkt") && req.key() == Some("d/a.csv"))
            .then_output(|| get(b"\xEF\xBB\xBFa,b\r\n1,2\r\n", "\"abc\""));
        let client = mock_client!(aws_sdk_s3, RuleMode::Sequential, &[&rule]);
        let opened = s3_open(&client, "bkt", "d/a.csv").await.unwrap();
        assert_eq!(opened.text, "a,b\r\n1,2\r\n");
        assert!(opened.bom);
        assert_eq!(opened.etag, "\"abc\"");
        assert_eq!(opened.content_type.as_deref(), Some("text/csv"));
        assert_eq!(opened.metadata.get("owner").map(String::as_str), Some("team-a"));
        assert_eq!(opened.size, 13);
    }

    #[tokio::test]
    async fn open_refuses_an_object_above_the_cap_before_reading_it() {
        let rule = mock!(Client::get_object).then_output(|| {
            GetObjectOutput::builder().body(ByteStream::from_static(b"x")).content_length(MAX_TEXT_BYTES as i64 + 1).e_tag("e").build()
        });
        let client = mock_client!(aws_sdk_s3, RuleMode::Sequential, &[&rule]);
        let err = s3_open(&client, "bkt", "big").await.unwrap_err();
        assert!(err.to_string().contains("up to 5 MiB"), "{err}");
    }

    #[tokio::test]
    async fn open_refuses_binary_content() {
        let rule = mock!(Client::get_object).then_output(|| get(b"PK\x03\x04\0\0", "\"z\""));
        let client = mock_client!(aws_sdk_s3, RuleMode::Sequential, &[&rule]);
        assert!(s3_open(&client, "bkt", "a.zip").await.unwrap_err().to_string().contains("not a text file"));
    }

    #[tokio::test]
    async fn save_carries_content_type_metadata_bom_and_if_match() {
        let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().e_tag("\"abc\"").build());
        let seen = Arc::new(Mutex::new(None));
        let sink = seen.clone();
        let put = mock!(Client::put_object)
            .match_requests(|req| req.bucket() == Some("bkt") && req.key() == Some("d/a.csv"))
            .then_compute_output(move |req| {
                *sink.lock().unwrap() = Some((
                    req.if_match().map(str::to_string),
                    req.content_type().map(str::to_string),
                    req.metadata().cloned().unwrap_or_default(),
                ));
                PutObjectOutput::builder().e_tag("\"new\"").build()
            });
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &put]);
        let outcome = s3_save(&client, "bkt", "d/a.csv", "a,b\n", true, &meta(), Some("\"abc\""), false).await.unwrap();
        assert_eq!(outcome, SaveOutcome::Saved { stamp: "\"new\"".into() });
        let (if_match, content_type, metadata) = seen.lock().unwrap().clone().unwrap();
        assert_eq!(if_match.as_deref(), Some("\"abc\""));
        assert_eq!(content_type.as_deref(), Some("text/csv"));
        assert_eq!(metadata.get("owner").map(String::as_str), Some("team-a"));
    }

    #[tokio::test]
    async fn save_body_is_bom_plus_text() {
        let body = Arc::new(Mutex::new(Vec::new()));
        let sink = body.clone();
        let put = mock!(Client::put_object).then_compute_output(move |req| {
            let bytes = req.body().bytes().map(<[u8]>::to_vec).unwrap_or_default();
            *sink.lock().unwrap() = bytes;
            PutObjectOutput::builder().e_tag("\"n\"").build()
        });
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&put]);
        s3_save(&client, "bkt", "k", "x\r\n", true, &ObjectMeta::default(), None, false).await.unwrap();
        assert_eq!(*body.lock().unwrap(), b"\xEF\xBB\xBFx\r\n");
    }

    #[tokio::test]
    async fn a_changed_etag_is_reported_and_nothing_is_put() {
        let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().e_tag("\"other\"").build());
        let put = mock!(Client::put_object).then_output(|| PutObjectOutput::builder().build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &put]);
        let outcome = s3_save(&client, "bkt", "k", "x", false, &meta(), Some("\"abc\""), false).await.unwrap();
        assert_eq!(outcome, SaveOutcome::Changed);
        assert_eq!(put.num_calls(), 0);
    }

    #[tokio::test]
    async fn a_precondition_failure_from_the_server_is_changed_too() {
        let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().e_tag("\"abc\"").build());
        let put = mock!(Client::put_object).then_error(precondition_failed);
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &put]);
        assert_eq!(s3_save(&client, "bkt", "k", "x", false, &meta(), Some("\"abc\""), false).await.unwrap(), SaveOutcome::Changed);
    }

    #[tokio::test]
    async fn a_server_without_if_match_support_falls_back_to_the_head_check() {
        let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().e_tag("\"abc\"").build());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let sink = calls.clone();
        let put = mock!(Client::put_object).then_compute_output(move |req| {
            sink.lock().unwrap().push(req.if_match().is_some());
            PutObjectOutput::builder().e_tag("\"n\"").build()
        });
        let unsupported = mock!(Client::put_object)
            .match_requests(|req| req.if_match().is_some())
            .then_error(|| PutObjectError::generic(ErrorMetadata::builder().code("NotImplemented").build()));
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &unsupported, &put]);
        let outcome = s3_save(&client, "bkt", "k", "x", false, &meta(), Some("\"abc\""), false).await.unwrap();
        assert!(matches!(outcome, SaveOutcome::Saved { .. }));
        assert_eq!(*calls.lock().unwrap(), [false]);
    }

    #[tokio::test]
    async fn overwrite_sends_no_precondition_and_no_head() {
        let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
        let put = mock!(Client::put_object)
            .match_requests(|req| req.if_match().is_none())
            .then_output(|| PutObjectOutput::builder().e_tag("\"n\"").build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &put]);
        s3_save(&client, "bkt", "k", "x", false, &meta(), None, false).await.unwrap();
        assert_eq!((head.num_calls(), put.num_calls()), (0, 1));
    }

    #[tokio::test]
    async fn save_as_copy_refuses_an_existing_key() {
        let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().e_tag("\"x\"").build());
        let put = mock!(Client::put_object).then_output(|| PutObjectOutput::builder().build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &put]);
        let err = s3_save(&client, "bkt", "k copy", "x", false, &meta(), None, true).await.unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)), "{err}");
        assert_eq!(put.num_calls(), 0);
    }

    #[tokio::test]
    async fn other_save_failures_are_readable_and_carry_no_secret() {
        let put = mock!(Client::put_object).then_error(|| PutObjectError::generic(ErrorMetadata::builder().code("AccessDenied").build()));
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&put]);
        let err = s3_save(&client, "bkt", "k", "x", false, &meta(), None, false).await.unwrap_err();
        assert!(matches!(err, AppError::S3(_)));
        assert_eq!(err.to_string(), "access denied");
    }
}
