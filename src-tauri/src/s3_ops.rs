//! S3 object operations used by transfers: full listing, head, empty put, copy (multipart above the
//! single-copy limit), batched delete. File upload and download live in `multipart_upload` and
//! `ranged_download`. No Tauri dependency; tested with mocked SDK responses.

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart, Delete, ObjectIdentifier};
use aws_sdk_s3::Client;

use crate::app_error::AppError;
use crate::s3::{describe_error_code, map_sdk_error};
use crate::transfer_plan::delete_batches;

/// CopyObject handles objects up to 5 GiB; larger ones use multipart UploadPartCopy.
pub const MAX_SINGLE_COPY_BYTES: u64 = 5 * 1024 * 1024 * 1024;
/// Part size for UploadPartCopy (512 MiB keeps even a 5 TiB object under 10 000 parts).
pub const COPY_PART_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct ListedKey {
    pub key: String,
    pub size: u64,
    pub modified: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct KeyFailure {
    pub key: String,
    pub message: String,
}

/// Every key under `prefix`, following continuation tokens, with no delimiter.
pub async fn list_all(client: &Client, bucket: &str, prefix: &str) -> Result<Vec<ListedKey>, AppError> {
    let mut keys = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = client
            .list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .set_continuation_token(token)
            .send()
            .await
            .map_err(map_sdk_error)?;
        keys.extend(page.contents().iter().filter_map(|object| {
            Some(ListedKey {
                key: object.key()?.to_string(),
                size: object.size().and_then(|size| u64::try_from(size).ok()).unwrap_or(0),
                modified: object.last_modified().map(|modified| modified.secs()),
            })
        }));
        token = page.next_continuation_token().map(str::to_string);
        if token.is_none() {
            return Ok(keys);
        }
    }
}

/// Size and modification time of the object, or `None` when it does not exist.
pub async fn object_info(client: &Client, bucket: &str, key: &str) -> Result<Option<(u64, Option<i64>)>, AppError> {
    match client.head_object().bucket(bucket).key(key).send().await {
        Ok(head) => Ok(Some((
            head.content_length().and_then(|size| u64::try_from(size).ok()).unwrap_or(0),
            head.last_modified().map(|modified| modified.secs()),
        ))),
        Err(err) if err.as_service_error().is_some_and(|service| service.is_not_found()) => Ok(None),
        Err(err) => Err(map_sdk_error(err)),
    }
}

/// Size of the object, or `None` when it does not exist.
pub async fn object_size(client: &Client, bucket: &str, key: &str) -> Result<Option<u64>, AppError> {
    Ok(object_info(client, bucket, key).await?.map(|(size, _)| size))
}

/// Zero-byte object, used for "New folder" (key ends with "/").
pub async fn put_empty(client: &Client, bucket: &str, key: &str) -> Result<(), AppError> {
    client
        .put_object()
        .bucket(bucket)
        .key(key)
        .content_length(0)
        .body(ByteStream::from_static(b""))
        .send()
        .await
        .map(|_| ())
        .map_err(map_sdk_error)
}

/// `bucket/key` percent-encoded the way the `x-amz-copy-source` header needs it.
pub fn encode_copy_source(bucket: &str, key: &str) -> String {
    let mut encoded = String::with_capacity(bucket.len() + key.len() + 1);
    for byte in format!("{bucket}/{key}").bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Inclusive byte ranges of the UploadPartCopy parts covering `size` bytes.
pub fn copy_part_ranges(size: u64) -> Vec<(u64, u64)> {
    (0..size.div_ceil(COPY_PART_BYTES))
        .map(|part| (part * COPY_PART_BYTES, ((part + 1) * COPY_PART_BYTES).min(size) - 1))
        .collect()
}

/// Server-side copy. Above the single-copy limit the copy is multipart and aborted on failure.
pub async fn copy_object(
    client: &Client,
    source_bucket: &str,
    source_key: &str,
    dest_bucket: &str,
    dest_key: &str,
    size: u64,
) -> Result<(), AppError> {
    let copy_source = encode_copy_source(source_bucket, source_key);
    if size <= MAX_SINGLE_COPY_BYTES {
        return client
            .copy_object()
            .bucket(dest_bucket)
            .key(dest_key)
            .copy_source(copy_source)
            .send()
            .await
            .map(|_| ())
            .map_err(map_sdk_error);
    }
    let upload = client.create_multipart_upload().bucket(dest_bucket).key(dest_key).send().await.map_err(map_sdk_error)?;
    let upload_id = upload.upload_id().ok_or_else(|| AppError::S3("server returned no upload id".into()))?.to_string();
    match copy_parts(client, &copy_source, dest_bucket, dest_key, &upload_id, size).await {
        Ok(()) => Ok(()),
        Err(err) => {
            // Best effort: an abort failure must not hide the original error.
            let _ = client.abort_multipart_upload().bucket(dest_bucket).key(dest_key).upload_id(&upload_id).send().await;
            Err(err)
        }
    }
}

async fn copy_parts(
    client: &Client,
    copy_source: &str,
    dest_bucket: &str,
    dest_key: &str,
    upload_id: &str,
    size: u64,
) -> Result<(), AppError> {
    let mut parts = Vec::new();
    for (index, (first, last)) in copy_part_ranges(size).into_iter().enumerate() {
        let part_number = i32::try_from(index + 1).map_err(|_| AppError::S3("too many parts".into()))?;
        let copied = client
            .upload_part_copy()
            .bucket(dest_bucket)
            .key(dest_key)
            .upload_id(upload_id)
            .part_number(part_number)
            .copy_source(copy_source)
            .copy_source_range(format!("bytes={first}-{last}"))
            .send()
            .await
            .map_err(map_sdk_error)?;
        let e_tag = copied.copy_part_result().and_then(|result| result.e_tag()).map(str::to_string);
        parts.push(CompletedPart::builder().set_e_tag(e_tag).part_number(part_number).build());
    }
    client
        .complete_multipart_upload()
        .bucket(dest_bucket)
        .key(dest_key)
        .upload_id(upload_id)
        .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(parts)).build())
        .send()
        .await
        .map(|_| ())
        .map_err(map_sdk_error)
}

/// DeleteObjects in batches of 1000; keys the server refused come back as failures.
pub async fn delete_keys(client: &Client, bucket: &str, keys: &[String]) -> Result<Vec<KeyFailure>, AppError> {
    let mut failures = Vec::new();
    for batch in delete_batches(keys) {
        let identifiers = batch
            .iter()
            .map(|key| ObjectIdentifier::builder().key(key).build().map_err(|err| AppError::S3(err.to_string())))
            .collect::<Result<Vec<_>, _>>()?;
        let delete = Delete::builder().set_objects(Some(identifiers)).quiet(true).build().map_err(|err| AppError::S3(err.to_string()))?;
        let output = client.delete_objects().bucket(bucket).delete(delete).send().await.map_err(map_sdk_error)?;
        failures.extend(output.errors().iter().map(|entry| KeyFailure {
            key: entry.key().unwrap_or_default().to_string(),
            message: describe_error_code(entry.code(), entry.message()),
        }));
    }
    Ok(failures)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use aws_sdk_s3::operation::complete_multipart_upload::CompleteMultipartUploadOutput;
    use aws_sdk_s3::operation::copy_object::{CopyObjectError, CopyObjectOutput};
    use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
    use aws_sdk_s3::operation::delete_objects::DeleteObjectsOutput;
    use aws_sdk_s3::operation::head_object::{HeadObjectError, HeadObjectOutput};
    use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;
    use aws_sdk_s3::operation::put_object::PutObjectOutput;
    use aws_sdk_s3::operation::upload_part_copy::UploadPartCopyOutput;
    use aws_sdk_s3::types::{error::NotFound, CopyPartResult, Error as S3ErrorEntry, Object};
    use aws_smithy_mocks::{mock, mock_client, RuleMode};

    fn listed(key: &str, size: i64) -> Object {
        Object::builder().key(key).size(size).build()
    }

    #[tokio::test]
    async fn list_all_follows_tokens_without_a_delimiter() {
        let first = mock!(Client::list_objects_v2)
            .match_requests(|req| req.continuation_token().is_none() && req.delimiter().is_none() && req.prefix() == Some("d/"))
            .then_output(|| {
                ListObjectsV2Output::builder().contents(listed("d/", 0)).contents(listed("d/a", 5)).is_truncated(true).next_continuation_token("t2").build()
            });
        let second = mock!(Client::list_objects_v2)
            .match_requests(|req| req.continuation_token() == Some("t2"))
            .then_output(|| ListObjectsV2Output::builder().contents(listed("d/sub/b", 7)).build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&first, &second]);
        let keys = list_all(&client, "bkt", "d/").await.unwrap();
        let summary: Vec<_> = keys.iter().map(|entry| (entry.key.as_str(), entry.size)).collect();
        assert_eq!(summary, [("d/", 0), ("d/a", 5), ("d/sub/b", 7)]);
    }

    #[tokio::test]
    async fn object_size_is_none_when_missing() {
        let found = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().content_length(42).build());
        let client = mock_client!(aws_sdk_s3, RuleMode::Sequential, &[&found]);
        assert_eq!(object_size(&client, "bkt", "k").await.unwrap(), Some(42));
        let missing = mock!(Client::head_object).then_error(|| HeadObjectError::NotFound(NotFound::builder().build()));
        let client = mock_client!(aws_sdk_s3, RuleMode::Sequential, &[&missing]);
        assert_eq!(object_size(&client, "bkt", "k").await.unwrap(), None);
    }

    #[test]
    fn copy_source_is_percent_encoded_but_keeps_slashes() {
        assert_eq!(encode_copy_source("bkt", "a b/\u{fc}+.txt"), "bkt/a%20b/%C3%BC%2B.txt");
        assert_eq!(encode_copy_source("bkt", "plain-name_1.~x"), "bkt/plain-name_1.~x");
    }

    #[test]
    fn copy_part_ranges_cover_the_object_exactly() {
        let size = COPY_PART_BYTES * 2 + 10;
        let ranges = copy_part_ranges(size);
        assert_eq!(ranges, vec![(0, COPY_PART_BYTES - 1), (COPY_PART_BYTES, COPY_PART_BYTES * 2 - 1), (COPY_PART_BYTES * 2, size - 1)]);
        assert_eq!(copy_part_ranges(1), vec![(0, 0)]);
    }

    #[tokio::test]
    async fn small_object_uses_copy_object_and_never_multipart() {
        let single = mock!(Client::copy_object)
            .match_requests(|req| {
                req.bucket() == Some("dst") && req.key() == Some("to/k.txt") && req.copy_source() == Some("src/from/k%20x.txt")
            })
            .then_output(|| CopyObjectOutput::builder().build());
        let create = mock!(Client::create_multipart_upload).then_output(|| CreateMultipartUploadOutput::builder().upload_id("u").build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&single, &create]);
        copy_object(&client, "src", "from/k x.txt", "dst", "to/k.txt", MAX_SINGLE_COPY_BYTES).await.unwrap();
        assert_eq!((single.num_calls(), create.num_calls()), (1, 0));
    }

    #[tokio::test]
    async fn object_above_the_copy_limit_uses_upload_part_copy() {
        let size = MAX_SINGLE_COPY_BYTES + 1;
        let expected_parts = copy_part_ranges(size).len();
        let single = mock!(Client::copy_object).then_output(|| CopyObjectOutput::builder().build());
        let create = mock!(Client::create_multipart_upload)
            .match_requests(|req| req.bucket() == Some("dst") && req.key() == Some("big"))
            .then_output(|| CreateMultipartUploadOutput::builder().upload_id("u1").build());
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let seen = ranges.clone();
        let part = mock!(Client::upload_part_copy)
            .match_requests(|req| req.upload_id() == Some("u1"))
            .then_compute_output(move |req| {
                seen.lock().unwrap().push(req.copy_source_range().unwrap_or_default().to_string());
                UploadPartCopyOutput::builder()
                    .copy_part_result(CopyPartResult::builder().e_tag(format!("e{}", req.part_number().unwrap_or(0))).build())
                    .build()
            });
        let complete = mock!(Client::complete_multipart_upload)
            .match_requests(move |req| req.multipart_upload().map(|upload| upload.parts().len()) == Some(expected_parts))
            .then_output(|| CompleteMultipartUploadOutput::builder().build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&single, &create, &part, &complete]);
        copy_object(&client, "src", "big", "dst", "big", size).await.unwrap();
        assert_eq!(single.num_calls(), 0);
        assert_eq!(part.num_calls(), expected_parts);
        assert_eq!(complete.num_calls(), 1);
        let seen = ranges.lock().unwrap();
        assert_eq!(seen[0], format!("bytes=0-{}", COPY_PART_BYTES - 1));
        assert_eq!(seen.last().unwrap(), &format!("bytes={}-{}", COPY_PART_BYTES * 10, size - 1));
    }

    #[tokio::test]
    async fn failed_copy_is_a_readable_error() {
        let failing = mock!(Client::copy_object).then_error(|| CopyObjectError::unhandled("boom"));
        let client = mock_client!(aws_sdk_s3, RuleMode::Sequential, &[&failing]);
        let err = copy_object(&client, "s", "k", "d", "k", 1).await.unwrap_err();
        assert!(matches!(err, AppError::S3(_)), "{err}");
    }

    #[tokio::test]
    async fn delete_keys_sends_batches_of_1000_and_reports_refused_keys() {
        let sizes = Arc::new(Mutex::new(Vec::new()));
        let seen = sizes.clone();
        let rule = mock!(Client::delete_objects).then_compute_output(move |req| {
            let batch = req.delete().map(|delete| delete.objects().len()).unwrap_or(0);
            let first = req.delete().and_then(|delete| delete.objects().first().map(|object| object.key().to_string()));
            seen.lock().unwrap().push(batch);
            let mut output = DeleteObjectsOutput::builder();
            if first.as_deref() == Some("k2000") {
                output = output.errors(S3ErrorEntry::builder().key("k2000").code("AccessDenied").message("no").build());
            }
            output.build()
        });
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&rule]);
        let keys: Vec<String> = (0..2500).map(|index| format!("k{index}")).collect();
        let failures = delete_keys(&client, "bkt", &keys).await.unwrap();
        assert_eq!(*sizes.lock().unwrap(), [1000, 1000, 500]);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].key, "k2000");
        assert!(failures[0].message.contains("access denied"), "{}", failures[0].message);
    }

    #[tokio::test]
    async fn put_empty_writes_a_zero_byte_object_with_the_given_key() {
        let rule = mock!(Client::put_object)
            .match_requests(|req| req.key() == Some("p/new/") && req.content_length().unwrap_or(0) == 0)
            .then_output(|| PutObjectOutput::builder().build());
        let client = mock_client!(aws_sdk_s3, RuleMode::Sequential, &[&rule]);
        put_empty(&client, "bkt", "p/new/").await.unwrap();
        assert_eq!(rule.num_calls(), 1);
    }
}
