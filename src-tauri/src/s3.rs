//! S3 client and listing for MinIO. No Tauri dependency; SDK calls are tested with mocked responses.

use std::time::Duration;

use aws_credential_types::Credentials;
use aws_sdk_s3::config::{
    BehaviorVersion, Region, RequestChecksumCalculation, ResponseChecksumValidation,
    timeout::TimeoutConfig,
};
use aws_sdk_s3::error::{DisplayErrorContext, ProvideErrorMetadata, SdkError};
use aws_sdk_s3::Client;
use serde::Serialize;

use crate::app_error::AppError;
use crate::vault::Profile;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30);
const CREDENTIALS_PROVIDER_NAME: &str = "s3-commander-profile";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct S3Entry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// Seconds since the Unix epoch.
    pub modified: Option<i64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct DirPage {
    pub entries: Vec<S3Entry>,
    /// Pass back as `continuation` to get the next page; `None` when the listing is complete.
    pub next_token: Option<String>,
}

/// Client settings for a MinIO profile: custom endpoint, path-style addressing, static
/// credentials, checksums only when an operation requires them (older MinIO rejects the default).
pub fn client_config_builder(profile: &Profile) -> aws_sdk_s3::config::Builder {
    aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .endpoint_url(&profile.endpoint)
        .force_path_style(true)
        .region(Region::new(profile.region.clone()))
        .credentials_provider(Credentials::new(
            &profile.access_key,
            &profile.secret_key,
            None,
            None,
            CREDENTIALS_PROVIDER_NAME,
        ))
        .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
        .timeout_config(
            TimeoutConfig::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .operation_attempt_timeout(ATTEMPT_TIMEOUT)
                .build(),
        )
}

pub fn build_client(profile: &Profile) -> Client {
    Client::from_conf(client_config_builder(profile).build())
}

// ponytail: ListBuckets is not paginated here; add continuation if a server has thousands of buckets.
pub async fn list_buckets(client: &Client) -> Result<Vec<String>, AppError> {
    let output = client.list_buckets().send().await.map_err(map_sdk_error)?;
    Ok(output.buckets().iter().filter_map(|bucket| bucket.name().map(str::to_string)).collect())
}

/// One page (up to 1000 keys) of the directory `prefix` in `bucket`. Prefixes become directories,
/// keys become files; pass the returned `next_token` back to get the next page.
pub async fn list_dir(
    client: &Client,
    bucket: &str,
    prefix: &str,
    continuation: Option<String>,
) -> Result<DirPage, AppError> {
    let output = client
        .list_objects_v2()
        .bucket(bucket)
        .prefix(prefix)
        .delimiter("/")
        .set_continuation_token(continuation)
        .send()
        .await
        .map_err(|err| {
            if err.as_service_error().is_some_and(|service| service.is_no_such_bucket()) {
                AppError::S3(describe_error_code(Some("NoSuchBucket"), None))
            } else {
                map_sdk_error(err)
            }
        })?;
    let dirs = output.common_prefixes().iter().filter_map(|common| common.prefix()).filter_map(|full| {
        let name = relative_name(full, prefix);
        (!name.is_empty()).then(|| S3Entry { name, is_dir: true, size: 0, modified: None })
    });
    // A key equal to the prefix is the "folder marker" object; it is the directory itself, not a child.
    let files = output.contents().iter().filter_map(|object| {
        let name = relative_name(object.key()?, prefix);
        (!name.is_empty()).then(|| S3Entry {
            name,
            is_dir: false,
            size: object.size().and_then(|size| u64::try_from(size).ok()).unwrap_or(0),
            modified: object.last_modified().map(|modified| modified.secs()),
        })
    });
    Ok(DirPage {
        entries: dirs.chain(files).collect(),
        next_token: output.next_continuation_token().map(str::to_string),
    })
}

fn relative_name(full_key: &str, prefix: &str) -> String {
    full_key.strip_prefix(prefix).unwrap_or(full_key).trim_end_matches('/').to_string()
}

/// Test a profile: list its buckets and return how many there are.
pub async fn check_connection(client: &Client) -> Result<usize, AppError> {
    Ok(list_buckets(client).await?.len())
}

/// Readable text for an S3 error code; falls back to the code and server message.
pub fn describe_error_code(code: Option<&str>, message: Option<&str>) -> String {
    match (code, message) {
        (Some("AccessDenied"), _) => "access denied".into(),
        (Some("InvalidAccessKeyId" | "SignatureDoesNotMatch"), _) => "invalid access key or secret key".into(),
        (Some("NoSuchBucket"), _) => "bucket does not exist".into(),
        (Some(code), Some(message)) => format!("{code}: {message}"),
        (Some(code), None) => code.to_string(),
        (None, Some(message)) => message.to_string(),
        (None, None) => "unknown S3 error".into(),
    }
}

fn map_sdk_error<E, R>(err: SdkError<E, R>) -> AppError
where
    E: ProvideErrorMetadata + std::error::Error + 'static,
    R: std::fmt::Debug,
{
    let message = match &err {
        SdkError::DispatchFailure(_) => "cannot reach the endpoint (check the URL and the network)".to_string(),
        SdkError::TimeoutError(_) => "the request timed out".to_string(),
        SdkError::ServiceError(_) => describe_error_code(err.code(), err.message()),
        _ => DisplayErrorContext(&err).to_string(),
    };
    AppError::S3(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_s3::config::RequestChecksumCalculation;
    use aws_sdk_s3::operation::list_buckets::ListBucketsOutput;
    use aws_sdk_s3::operation::list_objects_v2::{ListObjectsV2Error, ListObjectsV2Output};
    use aws_sdk_s3::primitives::DateTime;
    use aws_sdk_s3::types::{error::NoSuchBucket, Bucket, CommonPrefix, Object};
    use aws_smithy_mocks::{mock, mock_client, RuleMode};

    fn sample_profile() -> Profile {
        Profile {
            id: "p1".into(),
            name: "dev".into(),
            endpoint: "http://localhost:9000".into(),
            access_key: "test-access".into(),
            secret_key: "test-secret-value".into(),
            region: "eu-test-1".into(),
        }
    }

    /// Send one request through a capturing HTTP client and return what would hit the wire.
    async fn captured_request(
        builder: aws_sdk_s3::config::Builder,
        send: impl FnOnce(Client) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>,
    ) -> aws_smithy_runtime_api::client::orchestrator::HttpRequest {
        let (http_client, receiver) = aws_smithy_http_client::test_util::capture_request(None);
        let client = Client::from_conf(builder.http_client(http_client).build());
        send(client).await;
        receiver.expect_request()
    }

    fn put_object_request(client: Client) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()>>> {
        Box::pin(async move {
            let _ = client
                .put_object()
                .bucket("bkt")
                .key("k.txt")
                .body(aws_sdk_s3::primitives::ByteStream::from_static(b"hello"))
                .send()
                .await;
        })
    }

    #[tokio::test]
    async fn requests_use_endpoint_path_style_region_and_profile_credentials() {
        let request = captured_request(client_config_builder(&sample_profile()), put_object_request).await;
        assert!(request.uri().starts_with("http://localhost:9000/bkt/k.txt"), "{}", request.uri());
        let auth = request.headers().get("authorization").unwrap();
        assert!(auth.contains("Credential=test-access/"), "{auth}");
        assert!(auth.contains("/eu-test-1/s3/aws4_request"), "{auth}");
    }

    #[tokio::test]
    async fn checksums_are_sent_only_when_required() {
        let ours = captured_request(client_config_builder(&sample_profile()), put_object_request).await;
        assert!(ours.headers().get("x-amz-sdk-checksum-algorithm").is_none());
        assert!(ours.headers().get("x-amz-checksum-crc32").is_none());
        // Guard: with the SDK default the same request does carry a checksum, so the test can fail.
        let sdk_default = client_config_builder(&sample_profile())
            .request_checksum_calculation(RequestChecksumCalculation::WhenSupported);
        let default_request = captured_request(sdk_default, put_object_request).await;
        assert!(default_request.headers().get("x-amz-sdk-checksum-algorithm").is_some());
    }

    fn object(key: &str, size: i64, epoch: i64) -> Object {
        Object::builder().key(key).size(size).last_modified(DateTime::from_secs(epoch)).build()
    }

    #[tokio::test]
    async fn list_dir_maps_prefixes_to_dirs_and_keys_to_files() {
        let rule = mock!(Client::list_objects_v2)
            .match_requests(|req| {
                req.bucket() == Some("bkt") && req.prefix() == Some("a/") && req.delimiter() == Some("/")
            })
            .then_output(|| {
                ListObjectsV2Output::builder()
                    .common_prefixes(CommonPrefix::builder().prefix("a/sub/").build())
                    .contents(object("a/file.txt", 12, 1_700_000_000))
                    .build()
            });
        let client = mock_client!(aws_sdk_s3, RuleMode::Sequential, &[&rule]);
        let page = list_dir(&client, "bkt", "a/", None).await.unwrap();
        assert_eq!(
            page.entries,
            vec![
                S3Entry { name: "sub".into(), is_dir: true, size: 0, modified: None },
                S3Entry { name: "file.txt".into(), is_dir: false, size: 12, modified: Some(1_700_000_000) },
            ]
        );
        assert_eq!(page.next_token, None);
    }

    #[tokio::test]
    async fn list_dir_skips_the_folder_marker_object_of_the_prefix() {
        let rule = mock!(Client::list_objects_v2).then_output(|| {
            ListObjectsV2Output::builder()
                .contents(object("a/", 0, 1))
                .contents(object("a/real.txt", 3, 2))
                .build()
        });
        let client = mock_client!(aws_sdk_s3, RuleMode::Sequential, &[&rule]);
        let page = list_dir(&client, "bkt", "a/", None).await.unwrap();
        let names: Vec<_> = page.entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, ["real.txt"]);
    }

    #[tokio::test]
    async fn list_dir_follows_continuation_tokens() {
        let first = mock!(Client::list_objects_v2)
            .match_requests(|req| req.continuation_token().is_none())
            .then_output(|| {
                ListObjectsV2Output::builder()
                    .contents(object("one.txt", 1, 1))
                    .is_truncated(true)
                    .next_continuation_token("token-2")
                    .build()
            });
        let second = mock!(Client::list_objects_v2)
            .match_requests(|req| req.continuation_token() == Some("token-2"))
            .then_output(|| ListObjectsV2Output::builder().contents(object("two.txt", 2, 2)).is_truncated(false).build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&first, &second]);
        let page_one = list_dir(&client, "bkt", "", None).await.unwrap();
        assert_eq!(page_one.next_token.as_deref(), Some("token-2"));
        let page_two = list_dir(&client, "bkt", "", page_one.next_token).await.unwrap();
        assert_eq!(page_two.entries[0].name, "two.txt");
        assert_eq!(page_two.next_token, None);
    }

    #[tokio::test]
    async fn list_buckets_returns_names() {
        let rule = mock!(Client::list_buckets).then_output(|| {
            ListBucketsOutput::builder()
                .buckets(Bucket::builder().name("alpha").build())
                .buckets(Bucket::builder().name("beta").build())
                .build()
        });
        let client = mock_client!(aws_sdk_s3, RuleMode::Sequential, &[&rule]);
        assert_eq!(list_buckets(&client).await.unwrap(), ["alpha", "beta"]);
        let rule = mock!(Client::list_buckets)
            .then_output(|| ListBucketsOutput::builder().buckets(Bucket::builder().name("alpha").build()).build());
        let client = mock_client!(aws_sdk_s3, RuleMode::Sequential, &[&rule]);
        assert_eq!(check_connection(&client).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn service_error_becomes_readable_app_error() {
        let rule = mock!(Client::list_objects_v2)
            .then_error(|| ListObjectsV2Error::NoSuchBucket(NoSuchBucket::builder().build()));
        let client = mock_client!(aws_sdk_s3, RuleMode::Sequential, &[&rule]);
        let err = list_dir(&client, "gone", "", None).await.unwrap_err();
        assert!(matches!(err, AppError::S3(_)));
        assert_eq!(err.to_string(), "bucket does not exist");
    }

    #[test]
    fn error_codes_have_readable_messages() {
        assert_eq!(describe_error_code(Some("AccessDenied"), None), "access denied");
        assert_eq!(describe_error_code(Some("InvalidAccessKeyId"), None), "invalid access key or secret key");
        assert_eq!(describe_error_code(Some("SignatureDoesNotMatch"), None), "invalid access key or secret key");
        assert_eq!(describe_error_code(Some("NoSuchBucket"), None), "bucket does not exist");
        assert_eq!(describe_error_code(Some("Weird"), Some("because")), "Weird: because");
        assert_eq!(describe_error_code(None, None), "unknown S3 error");
    }
}
