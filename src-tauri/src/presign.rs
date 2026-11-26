//! Presigned GET URLs. A local computation over the profile's static credentials (SigV4 query
//! signing): no request is sent. No Tauri dependency.
//!
//! A presigned URL is a credential: it is returned to the caller and never logged. Errors built
//! here never contain a URL, a secret key or any session material.

use std::time::{Duration, SystemTime};

use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::Client;
use serde::{Deserialize, Serialize};

use crate::app_error::AppError;
use crate::s3::map_sdk_error;
use crate::s3_ops::list_all;

const MAX_FILENAME_CHARS: usize = 255;

/// SigV4 allows at most 7 days.
pub const MAX_EXPIRES_SECS: u64 = 604_800;
/// A selection that expands to more objects than this is cut and flagged as capped.
pub const MAX_URLS: usize = 1000;

/// One selected item: the full key (a folder prefix for a directory).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PresignTarget {
    pub key: String,
    pub is_dir: bool,
}

/// A key to presign and the name shown for it (relative to the selected item's parent folder).
#[derive(Debug, Clone, PartialEq)]
pub struct ExpandedKey {
    pub key: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PresignOutcome {
    pub key: String,
    pub name: String,
    pub url: Option<String>,
    /// Seconds since the Unix epoch.
    pub expires_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct PresignReport {
    pub items: Vec<PresignOutcome>,
    /// Objects found under the selection, before the cap.
    pub total: usize,
    pub capped: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct PresignPreview {
    pub object_count: usize,
    pub cap: usize,
    pub capped: bool,
}

#[derive(Debug, PartialEq)]
pub struct Expansion {
    pub keys: Vec<ExpandedKey>,
    pub total: usize,
    pub capped: bool,
}

/// 1 second to 7 days.
pub fn expiry_duration(expires_secs: u64) -> Result<Duration, AppError> {
    match expires_secs {
        0 => Err(AppError::Invalid("expiry must be at least 1 second".into())),
        1..=MAX_EXPIRES_SECS => Ok(Duration::from_secs(expires_secs)),
        _ => Err(AppError::Invalid("expiry cannot be more than 7 days".into())),
    }
}

/// `response-content-disposition` value that makes a browser save the object under `filename`.
pub fn content_disposition(filename: &str) -> Result<String, AppError> {
    if filename.trim().is_empty() {
        return Err(AppError::Invalid("download file name is empty".into()));
    }
    if filename.chars().any(char::is_control) {
        return Err(AppError::Invalid("download file name has a control character".into()));
    }
    if filename.chars().count() > MAX_FILENAME_CHARS {
        return Err(AppError::Invalid(format!("download file name is longer than {MAX_FILENAME_CHARS} characters")));
    }
    // Plain `filename` for old clients (quoted, ASCII only), `filename*` (RFC 5987) carries the real name.
    let fallback: String = filename
        .chars()
        .map(|ch| if ch.is_ascii() && !matches!(ch, '"' | '\\' | '%' | ';') { ch } else { '_' })
        .collect();
    let mut encoded = String::new();
    for byte in filename.bytes() {
        if byte.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    Ok(format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"))
}

/// One presigned GET URL for `key`, valid for `expires_secs` from `start`.
pub async fn presign_get(
    client: &Client,
    bucket: &str,
    key: &str,
    expires_secs: u64,
    disposition: Option<&str>,
    start: SystemTime,
) -> Result<String, AppError> {
    let expires = expiry_duration(expires_secs)?;
    if bucket.is_empty() || key.is_empty() {
        return Err(AppError::Invalid("bucket and key are required".into()));
    }
    let config = PresigningConfig::builder()
        .start_time(start)
        .expires_in(expires)
        .build()
        .map_err(|_| AppError::Invalid("could not build the signing options".into()))?;
    let request = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .set_response_content_disposition(disposition.map(str::to_string))
        .presigned(config)
        .await
        .map_err(map_sdk_error)?;
    Ok(request.uri().to_string())
}

/// Every key behind the selection: files as they are, folders listed (zero-byte "dir/" markers
/// skipped). More than `cap` objects are cut and flagged.
pub async fn expand_targets(client: &Client, bucket: &str, targets: &[PresignTarget], cap: usize) -> Result<Expansion, AppError> {
    // ponytail: the whole folder listing is held in memory before the cap applies; stream and stop at the cap if folders reach millions.
    let mut keys = Vec::new();
    let mut total = 0;
    for target in targets {
        if !target.is_dir {
            total += 1;
            keys.push(ExpandedKey { key: target.key.clone(), name: target.key.rsplit('/').next().unwrap_or(&target.key).to_string() });
            continue;
        }
        let prefix = if target.key.ends_with('/') { target.key.clone() } else { format!("{}/", target.key) };
        let parent_len = prefix.trim_end_matches('/').rfind('/').map_or(0, |slash| slash + 1);
        for listed in list_all(client, bucket, &prefix).await? {
            // The zero-byte "dir/" object is the folder itself, not a file to share.
            if listed.key.ends_with('/') && listed.size == 0 {
                continue;
            }
            total += 1;
            let name = listed.key[parent_len..].to_string();
            keys.push(ExpandedKey { key: listed.key, name });
        }
    }
    keys.truncate(cap);
    Ok(Expansion { keys, total, capped: total > cap })
}

/// Presign every key in order; one failing key does not stop the others.
pub async fn presign_keys(
    client: &Client,
    bucket: &str,
    keys: &[ExpandedKey],
    expires_secs: u64,
    disposition: Option<&str>,
    start: SystemTime,
) -> Result<Vec<PresignOutcome>, AppError> {
    expiry_duration(expires_secs)?;
    let expires_at = start
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .and_then(|since| i64::try_from(since.as_secs() + expires_secs).ok());
    let mut outcomes = Vec::with_capacity(keys.len());
    for entry in keys {
        let outcome = match presign_get(client, bucket, &entry.key, expires_secs, disposition, start).await {
            Ok(url) => PresignOutcome { key: entry.key.clone(), name: entry.name.clone(), url: Some(url), expires_at, error: None },
            Err(err) => PresignOutcome { key: entry.key.clone(), name: entry.name.clone(), url: None, expires_at: None, error: Some(err.to_string()) },
        };
        outcomes.push(outcome);
    }
    Ok(outcomes)
}

/// The command body: expand the selection, then presign it.
pub async fn presign_selection(
    client: &Client,
    bucket: &str,
    targets: &[PresignTarget],
    expires_secs: u64,
    download_filename: Option<&str>,
    start: SystemTime,
) -> Result<PresignReport, AppError> {
    if targets.is_empty() {
        return Err(AppError::Invalid("nothing selected".into()));
    }
    expiry_duration(expires_secs)?;
    let disposition = download_filename.map(content_disposition).transpose()?;
    let expansion = expand_targets(client, bucket, targets, MAX_URLS).await?;
    if expansion.total == 0 {
        return Err(AppError::Invalid("no objects under the selection".into()));
    }
    if disposition.is_some() && expansion.total != 1 {
        return Err(AppError::Invalid("a download file name only applies to a single file".into()));
    }
    let items = presign_keys(client, bucket, &expansion.keys, expires_secs, disposition.as_deref(), start).await?;
    Ok(PresignReport { items, total: expansion.total, capped: expansion.capped })
}

/// Object count behind the selection, so the UI can ask before presigning a big folder.
pub async fn preview_selection(client: &Client, bucket: &str, targets: &[PresignTarget]) -> Result<PresignPreview, AppError> {
    let expansion = expand_targets(client, bucket, targets, MAX_URLS).await?;
    Ok(PresignPreview { object_count: expansion.total, cap: MAX_URLS, capped: expansion.capped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::s3::build_client;
    use crate::vault::Profile;
    use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;
    use aws_sdk_s3::types::Object;
    use aws_smithy_mocks::{mock, mock_client, RuleMode};
    use std::time::UNIX_EPOCH;

    const FAKE_ACCESS_KEY: &str = "FAKEACCESSKEY123";
    const FAKE_SECRET_KEY: &str = "fakeSecretKeyNeverInAnyUrl0123456789";
    /// 2026-01-02T03:04:05Z
    const START_SECS: u64 = 1_767_323_045;

    fn start() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(START_SECS)
    }

    fn fake_client() -> Client {
        build_client(&Profile {
            id: "p1".into(),
            name: "fake".into(),
            endpoint: "https://s3.example.test:9000".into(),
            access_key: FAKE_ACCESS_KEY.into(),
            secret_key: FAKE_SECRET_KEY.into(),
            region: "eu-test-1".into(),
            transfer: Default::default(),
        })
    }

    fn key(name: &str) -> ExpandedKey {
        ExpandedKey { key: name.into(), name: name.into() }
    }

    fn query(url: &str) -> std::collections::HashMap<String, String> {
        url::Url::parse(url).unwrap().query_pairs().map(|(name, value)| (name.into_owned(), value.into_owned())).collect()
    }

    fn object(key: &str, size: i64) -> Object {
        Object::builder().key(key).size(size).build()
    }

    #[tokio::test]
    async fn url_has_path_style_host_and_the_sigv4_query_parameters() {
        let url = presign_get(&fake_client(), "bkt", "dir/a.txt", 3600, None, start()).await.unwrap();
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.scheme(), "https");
        assert_eq!(parsed.host_str(), Some("s3.example.test"));
        assert_eq!(parsed.port(), Some(9000));
        assert_eq!(parsed.path(), "/bkt/dir/a.txt");
        let params = query(&url);
        assert_eq!(params["X-Amz-Algorithm"], "AWS4-HMAC-SHA256");
        assert_eq!(params["X-Amz-Credential"], format!("{FAKE_ACCESS_KEY}/20260102/eu-test-1/s3/aws4_request"));
        assert_eq!(params["X-Amz-Date"], "20260102T030405Z");
        assert_eq!(params["X-Amz-Expires"], "3600");
        assert_eq!(params["X-Amz-SignedHeaders"], "host");
        assert_eq!(params["X-Amz-Signature"].len(), 64);
        assert!(!params.contains_key("X-Amz-Security-Token"));
    }

    #[tokio::test]
    async fn same_inputs_give_the_same_url() {
        let first = presign_get(&fake_client(), "bkt", "k", 60, None, start()).await.unwrap();
        let second = presign_get(&fake_client(), "bkt", "k", 60, None, start()).await.unwrap();
        assert_eq!(first, second);
        let other_key = presign_get(&fake_client(), "bkt", "k2", 60, None, start()).await.unwrap();
        assert_ne!(query(&first)["X-Amz-Signature"], query(&other_key)["X-Amz-Signature"]);
    }

    #[tokio::test]
    async fn keys_with_spaces_unicode_plus_and_slashes_are_encoded_in_the_path() {
        let client = fake_client();
        let url = presign_get(&client, "bkt", "my dir/é+x.txt", 60, None, start()).await.unwrap();
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.path(), "/bkt/my%20dir/%C3%A9%2Bx.txt");
        assert!(!url.contains(' '));
    }

    #[tokio::test]
    async fn expiry_bounds_are_one_second_to_seven_days() {
        let client = fake_client();
        for rejected in [0, 604_801, u64::MAX] {
            let err = presign_get(&client, "bkt", "k", rejected, None, start()).await.unwrap_err();
            assert!(matches!(err, AppError::Invalid(_)), "{rejected}: {err}");
        }
        for accepted in [1, 604_800] {
            let url = presign_get(&client, "bkt", "k", accepted, None, start()).await.unwrap();
            assert_eq!(query(&url)["X-Amz-Expires"], accepted.to_string());
        }
        assert_eq!(expiry_duration(1).unwrap(), Duration::from_secs(1));
        assert!(expiry_duration(0).unwrap_err().to_string().contains("at least 1 second"));
        assert!(expiry_duration(604_801).unwrap_err().to_string().contains("7 days"));
    }

    #[test]
    fn content_disposition_is_an_attachment_with_a_safe_ascii_fallback_and_utf8_name() {
        assert_eq!(content_disposition("report.pdf").unwrap(), "attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf");
        let value = content_disposition("my \"é\";x%.txt").unwrap();
        assert_eq!(value, "attachment; filename=\"my ____x_.txt\"; filename*=UTF-8''my%20%22%C3%A9%22%3Bx%25.txt");
    }

    #[test]
    fn content_disposition_rejects_control_characters_and_empty_names() {
        for bad in ["a\nb", "a\rb", "a\0b", "a\tb", "a\u{7f}b", "", "   "] {
            assert!(matches!(content_disposition(bad), Err(AppError::Invalid(_))), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn disposition_is_signed_into_the_url_as_response_content_disposition() {
        let disposition = content_disposition("my file.txt").unwrap();
        let url = presign_get(&fake_client(), "bkt", "k", 60, Some(&disposition), start()).await.unwrap();
        assert_eq!(query(&url)["response-content-disposition"], disposition);
        assert!(!url.contains(' '));
    }

    #[tokio::test]
    async fn batch_keeps_order_and_reports_a_failing_key_without_stopping() {
        let keys = [key("b.txt"), key("a.txt"), key("c.txt")];
        let items = presign_keys(&fake_client(), "bkt", &keys, 60, None, start()).await.unwrap();
        let order: Vec<_> = items.iter().map(|item| item.key.as_str()).collect();
        assert_eq!(order, ["b.txt", "a.txt", "c.txt"]);
        assert!(items.iter().all(|item| item.url.is_some() && item.error.is_none()));
        assert!(items.iter().all(|item| item.expires_at == Some(START_SECS as i64 + 60)));

        // An empty bucket name cannot be signed: that item fails, and so does each of its neighbours with it.
        let items = presign_keys(&fake_client(), "", &keys[..2], 60, None, start()).await.unwrap();
        assert!(items.iter().all(|item| item.url.is_none() && item.expires_at.is_none() && item.error.is_some()));
    }

    #[tokio::test]
    async fn an_empty_key_fails_only_its_own_item() {
        let keys = [key("a.txt"), key(""), key("c.txt")];
        let items = presign_keys(&fake_client(), "bkt", &keys, 60, None, start()).await.unwrap();
        assert!(items[0].url.is_some() && items[2].url.is_some());
        assert!(items[1].url.is_none() && items[1].error.is_some());
    }

    #[tokio::test]
    async fn batch_with_a_bad_expiry_fails_as_a_whole() {
        let err = presign_keys(&fake_client(), "bkt", &[key("a")], 0, None, start()).await.unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
    }

    #[tokio::test]
    async fn the_secret_key_is_never_in_a_url_or_an_error() {
        let client = fake_client();
        let disposition = content_disposition("x.txt").unwrap();
        let url = presign_get(&client, "bkt", "k", 60, Some(&disposition), start()).await.unwrap();
        assert!(!url.contains(FAKE_SECRET_KEY));
        let mut texts = vec![url];
        for expires in [0, 604_801] {
            texts.push(presign_get(&client, "bkt", "k", expires, None, start()).await.unwrap_err().to_string());
        }
        texts.push(presign_get(&client, "", "k", 60, None, start()).await.unwrap_err().to_string());
        texts.push(content_disposition("a\nb").unwrap_err().to_string());
        for text in texts {
            assert!(!text.contains(FAKE_SECRET_KEY), "{text}");
        }
    }

    fn list_mock(pages: Vec<Vec<Object>>) -> Client {
        let rule = mock!(Client::list_objects_v2).then_output(move || ListObjectsV2Output::builder().set_contents(Some(pages[0].clone())).build());
        mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&rule])
    }

    #[tokio::test]
    async fn folders_expand_to_their_keys_and_skip_the_zero_byte_marker() {
        let client = list_mock(vec![vec![object("in/d/", 0), object("in/d/a.txt", 5), object("in/d/sub/", 0), object("in/d/sub/b.txt", 0)]]);
        let targets = [PresignTarget { key: "in/one.txt".into(), is_dir: false }, PresignTarget { key: "in/d/".into(), is_dir: true }];
        let expansion = expand_targets(&client, "bkt", &targets, 1000).await.unwrap();
        let keys: Vec<_> = expansion.keys.iter().map(|entry| (entry.key.as_str(), entry.name.as_str())).collect();
        // A zero-byte FILE (sub/b.txt) is a real object and stays; only "dir/" markers go.
        assert_eq!(keys, [("in/one.txt", "one.txt"), ("in/d/a.txt", "d/a.txt"), ("in/d/sub/b.txt", "d/sub/b.txt")]);
        assert_eq!((expansion.total, expansion.capped), (3, false));
    }

    #[tokio::test]
    async fn a_folder_target_without_a_trailing_slash_still_lists_its_prefix() {
        let rule = mock!(Client::list_objects_v2).match_requests(|req| req.prefix() == Some("in/d/")).then_output(|| ListObjectsV2Output::builder().contents(object("in/d/a", 1)).build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&rule]);
        let expansion = expand_targets(&client, "bkt", &[PresignTarget { key: "in/d".into(), is_dir: true }], 1000).await.unwrap();
        assert_eq!(expansion.keys.len(), 1);
    }

    #[tokio::test]
    async fn expansion_over_the_cap_is_cut_and_flagged_with_the_full_count() {
        let objects: Vec<_> = (0..7).map(|index| object(&format!("d/f{index}"), 1)).collect();
        let client = list_mock(vec![objects]);
        let expansion = expand_targets(&client, "bkt", &[PresignTarget { key: "d/".into(), is_dir: true }], 5).await.unwrap();
        assert_eq!((expansion.keys.len(), expansion.total, expansion.capped), (5, 7, true));
        assert_eq!(expansion.keys[4].key, "d/f4");
    }

    #[tokio::test]
    async fn preview_counts_objects_and_flags_a_selection_over_the_cap() {
        let objects: Vec<_> = (0..MAX_URLS + 2).map(|index| object(&format!("d/f{index}"), 1)).collect();
        let client = list_mock(vec![objects]);
        let preview = preview_selection(&client, "bkt", &[PresignTarget { key: "d/".into(), is_dir: true }]).await.unwrap();
        assert_eq!(preview, PresignPreview { object_count: MAX_URLS + 2, cap: MAX_URLS, capped: true });
    }

    #[tokio::test]
    async fn selection_presigns_the_expansion_and_reports_the_cap() {
        let client_for_list = list_mock(vec![vec![object("d/", 0), object("d/a", 1), object("d/b", 1)]]);
        let targets = [PresignTarget { key: "d/".into(), is_dir: true }];
        let expansion = expand_targets(&client_for_list, "bkt", &targets, 1000).await.unwrap();
        let items = presign_keys(&fake_client(), "bkt", &expansion.keys, 60, None, start()).await.unwrap();
        assert_eq!(items.iter().map(|item| item.name.as_str()).collect::<Vec<_>>(), ["d/a", "d/b"]);
    }

    #[tokio::test]
    async fn a_download_filename_is_refused_for_more_than_one_object() {
        let targets = [PresignTarget { key: "a".into(), is_dir: false }, PresignTarget { key: "b".into(), is_dir: false }];
        let err = presign_selection(&fake_client(), "bkt", &targets, 60, Some("x.txt"), start()).await.unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)), "{err}");
        let single = presign_selection(&fake_client(), "bkt", &targets[..1], 60, Some("x.txt"), start()).await.unwrap();
        assert!(single.items[0].url.as_deref().unwrap().contains("response-content-disposition"));
        assert_eq!((single.total, single.capped), (1, false));
    }

    #[tokio::test]
    async fn an_empty_selection_is_refused() {
        let err = presign_selection(&fake_client(), "bkt", &[], 60, None, start()).await.unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
    }
}
