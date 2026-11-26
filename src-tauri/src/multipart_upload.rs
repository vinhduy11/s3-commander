//! Upload of one local file: a streamed PutObject below the profile's multipart threshold,
//! otherwise a multipart upload with parts read from the file at their offset, uploaded in parallel
//! (bounded), retried per part, completed in part order and aborted on failure or cancel. A
//! partly uploaded multipart can be resumed from the server's ListParts. No Tauri dependency.
//!
//! Memory: a part is read into memory only while it is being sent, so the engine holds at most
//! `parts in flight x part size` bytes, and `TransferEnv::upload_concurrency` keeps that product
//! under `MAX_INFLIGHT_BYTES` (1 GiB). With the AWS CLI defaults that is 10 x 8 MiB = 80 MiB.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use aws_sdk_s3::Client;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::app_error::AppError;
use crate::local::describe_io_error;
use crate::part_plan::{plan_parts, PartSpec, MAX_SINGLE_PUT_BYTES};
use crate::s3::map_sdk_error;
use crate::transfer_control::{classify_sdk_error, run_bounded, with_retry, AttemptError, EngineError, ProgressTracker, RetryPolicy, TransferEnv};

/// Upload `path` to `bucket/key` (PutObject or multipart, see the module docs).
pub async fn upload_file(client: &Client, env: &TransferEnv, bucket: &str, key: &str, path: &Path) -> Result<(), EngineError> {
    let size = local_size(path).await?;
    let parts = plan_parts(size, env.settings.multipart_chunksize).map_err(EngineError::failed)?; // also enforces 5 TiB
    if env.cancel.is_cancelled() {
        return Err(EngineError::cancelled());
    }
    if size == 0 || size < env.settings.multipart_threshold.min(MAX_SINGLE_PUT_BYTES) {
        return put_whole(client, env, bucket, key, path, size).await;
    }
    let created = client.create_multipart_upload().bucket(bucket).key(key).send().await.map_err(|err| EngineError::failed(map_sdk_error(err)))?;
    let upload_id = created.upload_id().ok_or_else(|| EngineError::failed(AppError::S3("server returned no upload id".into())))?.to_string();
    env.sink.upload_created(&upload_id);
    finish(Target { client, env, bucket, key, path, upload_id: &upload_id }, size, parts, Vec::new()).await
}

/// Continue the multipart upload `upload_id` of `bucket/key`: parts the server already holds with
/// the planned number and size are kept, the rest are uploaded, then the upload is completed.
/// Like a fresh upload it is aborted when it fails for good or is cancelled.
pub async fn resume_upload(
    client: &Client,
    env: &TransferEnv,
    bucket: &str,
    key: &str,
    path: &Path,
    upload_id: &str,
) -> Result<(), EngineError> {
    let size = local_size(path).await?;
    let parts = plan_parts(size, env.settings.multipart_chunksize).map_err(EngineError::failed)?;
    if parts.is_empty() {
        return Err(EngineError::failed(AppError::Invalid("an empty file has no multipart upload to resume".into())));
    }
    if env.cancel.is_cancelled() {
        return Err(EngineError::cancelled());
    }
    // A failed listing leaves the upload as it was, so it is reported instead of aborted.
    let held = list_uploaded_parts(client, env, bucket, key, upload_id).await.map_err(|err| err.with_leftover(upload_id.to_string()))?;
    let kept = parts
        .iter()
        .filter_map(|part| held.get(&part.number).filter(|(held_size, _)| *held_size == part.length).map(|(_, tag)| (*part, tag.clone())))
        .collect();
    finish(Target { client, env, bucket, key, path, upload_id }, size, parts, kept).await
}

async fn local_size(path: &Path) -> Result<u64, EngineError> {
    tokio::fs::metadata(path).await.map(|meta| meta.len()).map_err(|err| EngineError::failed(describe_io_error(&err, path)))
}

/// The one-request path: below the threshold (or empty), streamed from the file.
async fn put_whole(client: &Client, env: &TransferEnv, bucket: &str, key: &str, path: &Path, size: u64) -> Result<(), EngineError> {
    let tracker = ProgressTracker::new(env.sink.clone(), size);
    with_retry(&env.retry, &env.cancel, || async {
        let body = ByteStream::from_path(path).await.map_err(|err| AttemptError::permanent(AppError::Local(format!("{err}: {}", path.display()))))?;
        client
            .put_object()
            .bucket(bucket)
            .key(key)
            .content_length(i64::try_from(size).unwrap_or(i64::MAX))
            .body(body)
            .send()
            .await
            .map(|_| ())
            .map_err(classify_sdk_error)
    })
    .await?;
    tracker.add(size);
    Ok(())
}

/// What one multipart call works on.
struct Target<'a> {
    client: &'a Client,
    env: &'a TransferEnv,
    bucket: &'a str,
    key: &'a str,
    path: &'a Path,
    upload_id: &'a str,
}

/// Upload the missing parts and complete; on any error abort the upload (best effort).
async fn finish(target: Target<'_>, size: u64, parts: Vec<PartSpec>, kept: Vec<(PartSpec, String)>) -> Result<(), EngineError> {
    match upload_and_complete(&target, size, parts, kept).await {
        Ok(()) => Ok(()),
        Err(err) => {
            let aborted = target.client.abort_multipart_upload().bucket(target.bucket).key(target.key).upload_id(target.upload_id).send().await;
            Err(if aborted.is_ok() { err } else { err.with_leftover(target.upload_id.to_string()) })
        }
    }
}

/// Everything a spawned part upload needs, owned so the task can outlive the caller's borrows.
struct PartJob {
    client: Client,
    bucket: String,
    key: String,
    path: PathBuf,
    upload_id: String,
    retry: RetryPolicy,
    cancel: crate::transfer_control::CancelToken,
    tracker: Arc<ProgressTracker>,
    total_parts: usize,
}

async fn upload_and_complete(target: &Target<'_>, size: u64, parts: Vec<PartSpec>, kept: Vec<(PartSpec, String)>) -> Result<(), EngineError> {
    let tracker = Arc::new(ProgressTracker::new(target.env.sink.clone(), size));
    let total_parts = parts.len();
    for (part, _) in &kept {
        tracker.add(part.length);
        tracker.sink().part_done(part.number, total_parts);
    }
    let part_size = parts.iter().map(|part| part.length).max().unwrap_or(0);
    let todo: Vec<PartSpec> = parts.iter().filter(|part| kept.iter().all(|(done, _)| done.number != part.number)).copied().collect();
    let job = Arc::new(PartJob {
        client: target.client.clone(),
        bucket: target.bucket.to_string(),
        key: target.key.to_string(),
        path: target.path.to_path_buf(),
        upload_id: target.upload_id.to_string(),
        retry: target.env.retry,
        cancel: target.env.cancel.clone(),
        tracker,
        total_parts,
    });
    let uploaded = run_bounded(todo, target.env.upload_concurrency(part_size), &target.env.cancel, |part| upload_part(job.clone(), part)).await?;
    let mut tags: Vec<(i32, String)> = kept.into_iter().map(|(part, tag)| (part.number, tag)).chain(uploaded).collect();
    tags.sort_by_key(|(number, _)| *number);
    let completed = tags.into_iter().map(|(number, tag)| CompletedPart::builder().part_number(number).e_tag(tag).build()).collect();
    target
        .client
        .complete_multipart_upload()
        .bucket(target.bucket)
        .key(target.key)
        .upload_id(target.upload_id)
        .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(completed)).build())
        .send()
        .await
        .map(|_| ())
        .map_err(|err| EngineError::failed(map_sdk_error(err)))
}

/// One part with retries; returns its number and ETag.
async fn upload_part(job: Arc<PartJob>, part: PartSpec) -> Result<(i32, String), EngineError> {
    let tag = with_retry(&job.retry, &job.cancel, || send_part(&job, part)).await?;
    job.tracker.add(part.length);
    job.tracker.sink().part_done(part.number, job.total_parts);
    Ok((part.number, tag))
}

/// Read the part from the file at its offset and send it (one attempt).
async fn send_part(job: &PartJob, part: PartSpec) -> Result<String, AttemptError> {
    let local = |err: std::io::Error| AttemptError::permanent(describe_io_error(&err, &job.path));
    let mut file = tokio::fs::File::open(&job.path).await.map_err(local)?;
    file.seek(SeekFrom::Start(part.offset)).await.map_err(local)?;
    let mut content = vec![0u8; usize::try_from(part.length).map_err(|_| AttemptError::permanent(AppError::Local("part too large for this platform".into())))?];
    file.read_exact(&mut content).await.map_err(local)?;
    let sent = job
        .client
        .upload_part()
        .bucket(&job.bucket)
        .key(&job.key)
        .upload_id(&job.upload_id)
        .part_number(part.number)
        .content_length(i64::try_from(part.length).unwrap_or(i64::MAX))
        .body(ByteStream::from(content))
        .customize()
        .config_override(single_attempt())
        .send()
        .await
        .map_err(classify_sdk_error)?;
    sent.e_tag().map(str::to_string).ok_or_else(|| AttemptError::permanent(AppError::S3(format!("server returned no ETag for part {}", part.number))))
}

/// The engine owns the retry policy, so the SDK's own retry is switched off for the requests it
/// retries (otherwise a 5xx would be tried 3 x 3 times).
pub(crate) fn single_attempt() -> aws_sdk_s3::config::Builder {
    aws_sdk_s3::Config::builder().retry_config(aws_sdk_s3::config::retry::RetryConfig::disabled())
}

/// Number -> (size, ETag) of the parts the server holds for the upload (ListParts, all pages).
async fn list_uploaded_parts(
    client: &Client,
    env: &TransferEnv,
    bucket: &str,
    key: &str,
    upload_id: &str,
) -> Result<HashMap<i32, (u64, String)>, EngineError> {
    let mut held = HashMap::new();
    let mut marker: Option<String> = None;
    loop {
        let page = with_retry(&env.retry, &env.cancel, || async {
            client
                .list_parts()
                .bucket(bucket)
                .key(key)
                .upload_id(upload_id)
                .set_part_number_marker(marker.clone())
                .customize()
                .config_override(single_attempt())
                .send()
                .await
                .map_err(classify_sdk_error)
        })
        .await?;
        for part in page.parts() {
            if let (Some(number), Some(size), Some(tag)) = (part.part_number(), part.size(), part.e_tag()) {
                held.insert(number, (u64::try_from(size).unwrap_or(0), tag.to_string()));
            }
        }
        match (page.is_truncated(), page.next_part_number_marker()) {
            (Some(true), Some(next)) => marker = Some(next.to_string()),
            _ => return Ok(held),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::sync::{Arc, Mutex};

    use aws_sdk_s3::operation::abort_multipart_upload::{AbortMultipartUploadError, AbortMultipartUploadOutput};
    use aws_sdk_s3::operation::complete_multipart_upload::CompleteMultipartUploadOutput;
    use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
    use aws_sdk_s3::operation::list_parts::{ListPartsError, ListPartsOutput};
    use aws_sdk_s3::operation::put_object::PutObjectOutput;
    use aws_sdk_s3::operation::upload_part::UploadPartOutput;
    use aws_sdk_s3::types::{error::NoSuchUpload, Part};
    use aws_smithy_mocks::{mock, mock_client, Rule, RuleMode};
    use aws_smithy_runtime_api::client::orchestrator::HttpResponse;
    use aws_smithy_runtime_api::http::StatusCode;
    use aws_smithy_types::body::SdkBody;

    use crate::app_error::AppError;
    use crate::transfer_control::{CancelToken, ProgressSink, RetryPolicy};
    use crate::transfer_settings::{AddressingStyle, EffectiveTransferSettings};

    const MIB: u64 = 1 << 20;

    fn env(threshold: u64, chunksize: u64, concurrency: usize) -> TransferEnv {
        let mut env = TransferEnv::new(EffectiveTransferSettings {
            multipart_threshold: threshold,
            multipart_chunksize: chunksize,
            max_concurrent_requests: concurrency,
            addressing_style: AddressingStyle::Path,
        });
        env.retry = RetryPolicy { max_attempts: 3, base_delay: std::time::Duration::ZERO };
        env
    }

    /// A file of `len` bytes that takes no disk space (reads back as zeros).
    fn sparse_file(dir: &Path, len: u64) -> std::path::PathBuf {
        let path = dir.join("big.bin");
        File::create(&path).unwrap().set_len(len).unwrap();
        path
    }

    fn status(code: u16) -> HttpResponse {
        HttpResponse::new(StatusCode::try_from(code).unwrap(), SdkBody::empty())
    }

    fn create_rule() -> Rule {
        mock!(aws_sdk_s3::Client::create_multipart_upload)
            .match_requests(|req| req.bucket() == Some("bkt") && req.key() == Some("big.bin"))
            .then_output(|| CreateMultipartUploadOutput::builder().upload_id("u1").build())
    }

    fn part_ok_rule() -> Rule {
        mock!(aws_sdk_s3::Client::upload_part)
            .then_compute_output(|req| UploadPartOutput::builder().e_tag(format!("e{}", req.part_number().unwrap_or(0))).build())
    }

    fn abort_rule() -> Rule {
        mock!(aws_sdk_s3::Client::abort_multipart_upload)
            .match_requests(|req| req.upload_id() == Some("u1") && req.key() == Some("big.bin"))
            .then_output(|| AbortMultipartUploadOutput::builder().build())
    }

    /// CompleteMultipartUpload that records the (number, etag) list it was sent.
    fn complete_rule(sent: &Arc<Mutex<Vec<(i32, String)>>>) -> Rule {
        let sent = sent.clone();
        mock!(aws_sdk_s3::Client::complete_multipart_upload)
            .match_requests(|req| req.upload_id() == Some("u1"))
            .then_compute_output(move |req| {
                let parts = req.multipart_upload().map(|upload| upload.parts()).unwrap_or_default();
                *sent.lock().unwrap() = parts.iter().map(|part| (part.part_number().unwrap_or(0), part.e_tag().unwrap_or("").to_string())).collect();
                CompleteMultipartUploadOutput::builder().build()
            })
    }

    fn client_with(rules: &[&Rule]) -> Client {
        mock_client!(aws_sdk_s3, RuleMode::MatchAny, rules)
    }

    #[derive(Default)]
    struct Recorder {
        created: Mutex<Vec<String>>,
        totals: Mutex<Vec<u64>>,
        done: Mutex<Vec<u64>>,
        parts: Mutex<Vec<(i32, usize)>>,
        cancel_after_first_part: Option<CancelToken>,
    }
    impl ProgressSink for Recorder {
        fn upload_created(&self, upload_id: &str) {
            self.created.lock().unwrap().push(upload_id.into());
        }
        fn bytes_total(&self, total: u64) {
            self.totals.lock().unwrap().push(total);
        }
        fn bytes_done(&self, done: u64) {
            self.done.lock().unwrap().push(done);
        }
        fn part_done(&self, part_number: i32, total_parts: usize) {
            self.parts.lock().unwrap().push((part_number, total_parts));
            if let Some(token) = &self.cancel_after_first_part {
                token.cancel();
            }
        }
    }

    #[tokio::test]
    async fn a_file_below_the_threshold_is_one_streamed_put_object() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        std::fs::write(&path, b"hello").unwrap();
        let put = mock!(aws_sdk_s3::Client::put_object)
            .match_requests(|req| req.key() == Some("big.bin") && req.content_length() == Some(5))
            .then_output(|| PutObjectOutput::builder().build());
        let create = create_rule();
        let client = client_with(&[&put, &create]);
        let recorder = Arc::new(Recorder::default());
        let mut env = env(6, 5 * MIB, 4);
        env.sink = recorder.clone();
        upload_file(&client, &env, "bkt", "big.bin", &path).await.unwrap();
        assert_eq!((put.num_calls(), create.num_calls()), (1, 0));
        assert_eq!(*recorder.totals.lock().unwrap(), [5]);
        assert_eq!(*recorder.done.lock().unwrap(), [5]);
    }

    #[tokio::test]
    async fn exactly_the_threshold_is_multipart_and_one_byte_less_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let path = sparse_file(dir.path(), 5 * MIB);
        let put = mock!(aws_sdk_s3::Client::put_object).then_output(|| PutObjectOutput::builder().build());
        let (create, part, complete) = (create_rule(), part_ok_rule(), complete_rule(&Default::default()));
        let client = client_with(&[&put, &create, &part, &complete]);
        upload_file(&client, &env(5 * MIB, 5 * MIB, 4), "bkt", "big.bin", &path).await.unwrap();
        assert_eq!((put.num_calls(), create.num_calls(), part.num_calls(), complete.num_calls()), (0, 1, 1, 1));
        upload_file(&client, &env(5 * MIB + 1, 5 * MIB, 4), "bkt", "big.bin", &path).await.unwrap();
        assert_eq!((put.num_calls(), create.num_calls()), (1, 1));
    }

    #[tokio::test]
    async fn small_multipart_sends_create_parts_in_order_then_complete_with_sorted_parts() {
        let dir = tempfile::tempdir().unwrap();
        let path = sparse_file(dir.path(), 11 * MIB);
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let (create_log, part_log, complete_log) = (log.clone(), log.clone(), log.clone());
        let create = mock!(aws_sdk_s3::Client::create_multipart_upload).then_compute_output(move |req| {
            create_log.lock().unwrap().push(format!("create {}/{}", req.bucket().unwrap_or(""), req.key().unwrap_or("")));
            CreateMultipartUploadOutput::builder().upload_id("u1").build()
        });
        let part = mock!(aws_sdk_s3::Client::upload_part).then_compute_output(move |req| {
            part_log.lock().unwrap().push(format!("part {} len {} id {}", req.part_number().unwrap_or(0), req.content_length().unwrap_or(0), req.upload_id().unwrap_or("")));
            UploadPartOutput::builder().e_tag(format!("e{}", req.part_number().unwrap_or(0))).build()
        });
        let complete = mock!(aws_sdk_s3::Client::complete_multipart_upload).then_compute_output(move |req| {
            let numbers: Vec<_> = req.multipart_upload().unwrap().parts().iter().map(|part| (part.part_number().unwrap_or(0), part.e_tag().unwrap_or("").to_string())).collect();
            complete_log.lock().unwrap().push(format!("complete {} {:?}", req.upload_id().unwrap_or(""), numbers));
            CompleteMultipartUploadOutput::builder().build()
        });
        let client = client_with(&[&create, &part, &complete]);
        let recorder = Arc::new(Recorder::default());
        let mut env = env(5 * MIB, 5 * MIB, 1);
        env.sink = recorder.clone();
        upload_file(&client, &env, "bkt", "big.bin", &path).await.unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            [
                "create bkt/big.bin".to_string(),
                format!("part 1 len {} id u1", 5 * MIB),
                format!("part 2 len {} id u1", 5 * MIB),
                format!("part 3 len {} id u1", MIB),
                "complete u1 [(1, \"e1\"), (2, \"e2\"), (3, \"e3\")]".to_string(),
            ]
        );
        assert_eq!(*recorder.created.lock().unwrap(), ["u1"]);
        assert_eq!(*recorder.totals.lock().unwrap(), [11 * MIB]);
        assert_eq!(*recorder.done.lock().unwrap(), [5 * MIB, 10 * MIB, 11 * MIB]);
        assert_eq!(*recorder.parts.lock().unwrap(), [(1, 3), (2, 3), (3, 3)]);
    }

    #[tokio::test]
    async fn parts_finishing_out_of_order_are_still_completed_in_part_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = sparse_file(dir.path(), 26 * MIB); // 6 parts
        let sent = Arc::new(Mutex::new(Vec::new()));
        let (create, part, complete) = (create_rule(), part_ok_rule(), complete_rule(&sent));
        let client = client_with(&[&create, &part, &complete]);
        upload_file(&client, &env(5 * MIB, 5 * MIB, 6), "bkt", "big.bin", &path).await.unwrap();
        let numbers: Vec<i32> = sent.lock().unwrap().iter().map(|(number, _)| *number).collect();
        assert_eq!(numbers, [1, 2, 3, 4, 5, 6]);
    }

    #[tokio::test]
    async fn a_part_failing_twice_with_5xx_then_succeeding_is_retried_and_the_upload_completes() {
        let dir = tempfile::tempdir().unwrap();
        let path = sparse_file(dir.path(), 11 * MIB);
        let flaky = mock!(aws_sdk_s3::Client::upload_part)
            .match_requests(|req| req.part_number() == Some(2))
            .sequence()
            .http_status(500, None)
            .times(2)
            .output(|| UploadPartOutput::builder().e_tag("e2").build())
            .build();
        let steady = mock!(aws_sdk_s3::Client::upload_part)
            .match_requests(|req| req.part_number() != Some(2))
            .then_compute_output(|req| UploadPartOutput::builder().e_tag(format!("e{}", req.part_number().unwrap_or(0))).build());
        let sent = Arc::new(Mutex::new(Vec::new()));
        let (create, complete, abort) = (create_rule(), complete_rule(&sent), abort_rule());
        let client = client_with(&[&create, &flaky, &steady, &complete, &abort]);
        upload_file(&client, &env(5 * MIB, 5 * MIB, 2), "bkt", "big.bin", &path).await.unwrap();
        assert_eq!((flaky.num_calls(), steady.num_calls(), abort.num_calls()), (3, 2, 0));
        assert_eq!(sent.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn a_part_that_keeps_failing_gets_three_attempts_then_the_upload_is_aborted() {
        let dir = tempfile::tempdir().unwrap();
        let path = sparse_file(dir.path(), 11 * MIB);
        let broken = mock!(aws_sdk_s3::Client::upload_part)
            .match_requests(|req| req.part_number() == Some(2))
            .then_http_response(|| status(503));
        let steady = mock!(aws_sdk_s3::Client::upload_part)
            .match_requests(|req| req.part_number() != Some(2))
            .then_output(|| UploadPartOutput::builder().e_tag("e").build());
        let (create, complete, abort) = (create_rule(), complete_rule(&Default::default()), abort_rule());
        let client = client_with(&[&create, &broken, &steady, &complete, &abort]);
        let err = upload_file(&client, &env(5 * MIB, 5 * MIB, 1), "bkt", "big.bin", &path).await.unwrap_err();
        assert_eq!((broken.num_calls(), abort.num_calls(), complete.num_calls()), (3, 1, 0));
        assert!(!err.is_cancelled());
        assert_eq!(err.leftover_upload_id(), None, "abort worked, nothing is left behind");
    }

    #[tokio::test]
    async fn a_4xx_on_a_part_is_not_retried() {
        let dir = tempfile::tempdir().unwrap();
        let path = sparse_file(dir.path(), 11 * MIB);
        let denied = mock!(aws_sdk_s3::Client::upload_part).then_http_response(|| status(403));
        let (create, abort) = (create_rule(), abort_rule());
        let client = client_with(&[&create, &denied, &abort]);
        let err = upload_file(&client, &env(5 * MIB, 5 * MIB, 1), "bkt", "big.bin", &path).await.unwrap_err();
        assert_eq!((denied.num_calls(), abort.num_calls()), (1, 1));
        assert!(matches!(err, EngineError::Failed { .. }));
        let text = AppError::from(err).to_string().to_lowercase();
        assert!(!["secret", "authorization", "signature", "http"].iter().any(|leak| text.contains(leak)), "{text}");
    }

    #[tokio::test]
    async fn a_failed_abort_is_reported_with_the_upload_id_and_keeps_the_original_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = sparse_file(dir.path(), 11 * MIB);
        let denied = mock!(aws_sdk_s3::Client::upload_part).then_http_response(|| status(403));
        let abort = mock!(aws_sdk_s3::Client::abort_multipart_upload).then_error(|| AbortMultipartUploadError::unhandled("down"));
        let create = create_rule();
        let client = client_with(&[&create, &denied, &abort]);
        let err = upload_file(&client, &env(5 * MIB, 5 * MIB, 1), "bkt", "big.bin", &path).await.unwrap_err();
        assert_eq!(err.leftover_upload_id(), Some("u1"));
        let text = AppError::from(err).to_string();
        assert!(text.contains("u1"), "{text}");
    }

    #[tokio::test]
    async fn cancel_mid_upload_aborts_the_multipart_and_starts_no_more_parts() {
        let dir = tempfile::tempdir().unwrap();
        let path = sparse_file(dir.path(), 16 * MIB); // 4 parts
        let token = CancelToken::default();
        let recorder = Arc::new(Recorder { cancel_after_first_part: Some(token.clone()), ..Default::default() });
        let mut env = env(5 * MIB, 5 * MIB, 1);
        env.sink = recorder;
        env.cancel = token;
        let (create, part, complete, abort) = (create_rule(), part_ok_rule(), complete_rule(&Default::default()), abort_rule());
        let client = client_with(&[&create, &part, &complete, &abort]);
        let err = upload_file(&client, &env, "bkt", "big.bin", &path).await.unwrap_err();
        assert!(err.is_cancelled(), "{err:?}");
        assert_eq!((part.num_calls(), abort.num_calls(), complete.num_calls()), (1, 1, 0));
        assert_eq!(err.leftover_upload_id(), None);
    }

    #[tokio::test]
    async fn cancel_before_the_first_request_sends_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = sparse_file(dir.path(), 11 * MIB);
        let env = env(5 * MIB, 5 * MIB, 2);
        env.cancel.cancel();
        let (create, part) = (create_rule(), part_ok_rule());
        let client = client_with(&[&create, &part]);
        let err = upload_file(&client, &env, "bkt", "big.bin", &path).await.unwrap_err();
        assert!(err.is_cancelled());
        assert_eq!((create.num_calls(), part.num_calls()), (0, 0));
    }

    #[tokio::test]
    async fn resume_skips_parts_the_server_has_with_the_planned_size_and_uploads_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let path = sparse_file(dir.path(), 26 * MIB); // parts 1..5 of 5 MiB and a 1 MiB part 6
        let listed = |number: i32, size: u64| Part::builder().part_number(number).size(size as i64).e_tag(format!("old{number}")).build();
        let markers = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
        let seen = markers.clone();
        let list = mock!(aws_sdk_s3::Client::list_parts)
            .match_requests(|req| req.upload_id() == Some("u1") && req.key() == Some("big.bin"))
            .then_compute_output(move |req| {
                seen.lock().unwrap().push(req.part_number_marker().map(str::to_string));
                match req.part_number_marker() {
                    None => ListPartsOutput::builder().parts(listed(1, 5 * MIB)).parts(listed(2, 5 * MIB)).is_truncated(true).next_part_number_marker("2").build(),
                    Some(_) => ListPartsOutput::builder()
                        .parts(listed(3, 1)) // wrong size: must be uploaded again
                        .parts(listed(4, 5 * MIB))
                        .parts(listed(9, 5 * MIB)) // not in the plan: ignored
                        .is_truncated(false)
                        .build(),
                }
            });
        let uploaded = Arc::new(Mutex::new(Vec::<i32>::new()));
        let log = uploaded.clone();
        let part = mock!(aws_sdk_s3::Client::upload_part).then_compute_output(move |req| {
            log.lock().unwrap().push(req.part_number().unwrap_or(0));
            UploadPartOutput::builder().e_tag(format!("new{}", req.part_number().unwrap_or(0))).build()
        });
        let sent = Arc::new(Mutex::new(Vec::new()));
        let (create, complete) = (create_rule(), complete_rule(&sent));
        let client = client_with(&[&list, &part, &create, &complete]);
        let recorder = Arc::new(Recorder::default());
        let mut env = env(5 * MIB, 5 * MIB, 1);
        env.sink = recorder.clone();
        resume_upload(&client, &env, "bkt", "big.bin", &path, "u1").await.unwrap();
        assert_eq!(*markers.lock().unwrap(), [None, Some("2".to_string())]);
        assert_eq!(*uploaded.lock().unwrap(), [3, 5, 6]);
        assert_eq!(create.num_calls(), 0);
        let expected: Vec<(i32, String)> = [(1, "old1"), (2, "old2"), (3, "new3"), (4, "old4"), (5, "new5"), (6, "new6")]
            .iter()
            .map(|(number, tag)| (*number, tag.to_string()))
            .collect();
        assert_eq!(*sent.lock().unwrap(), expected);
        let done = recorder.done.lock().unwrap().clone();
        assert!(done.windows(2).all(|pair| pair[0] <= pair[1]), "{done:?}");
        assert_eq!(*done.last().unwrap(), 26 * MIB);
        assert_eq!(*recorder.totals.lock().unwrap(), [26 * MIB]);
    }

    #[tokio::test]
    async fn resume_that_cannot_list_the_parts_reports_the_upload_id_and_does_not_abort() {
        let dir = tempfile::tempdir().unwrap();
        let path = sparse_file(dir.path(), 11 * MIB);
        let list = mock!(aws_sdk_s3::Client::list_parts).then_error(|| ListPartsError::unhandled(NoSuchUpload::builder().build()));
        let abort = abort_rule();
        let client = client_with(&[&list, &abort]);
        let err = resume_upload(&client, &env(5 * MIB, 5 * MIB, 1), "bkt", "big.bin", &path, "u1").await.unwrap_err();
        assert_eq!((abort.num_calls(), err.leftover_upload_id()), (0, Some("u1")));
    }

    #[tokio::test]
    async fn a_failed_resume_aborts_like_a_fresh_upload() {
        let dir = tempfile::tempdir().unwrap();
        let path = sparse_file(dir.path(), 11 * MIB);
        let list = mock!(aws_sdk_s3::Client::list_parts).then_output(|| ListPartsOutput::builder().is_truncated(false).build());
        let denied = mock!(aws_sdk_s3::Client::upload_part).then_http_response(|| status(403));
        let abort = abort_rule();
        let client = client_with(&[&list, &denied, &abort]);
        let err = resume_upload(&client, &env(5 * MIB, 5 * MIB, 1), "bkt", "big.bin", &path, "u1").await.unwrap_err();
        assert_eq!((denied.num_calls(), abort.num_calls()), (1, 1));
        assert!(!err.is_cancelled());
    }

    #[tokio::test]
    async fn above_5_tib_is_refused_before_any_request() {
        let dir = tempfile::tempdir().unwrap();
        let path = sparse_file(dir.path(), (5 << 40) + 1);
        let create = create_rule();
        let client = client_with(&[&create]);
        let err = upload_file(&client, &env(8 * MIB, 8 * MIB, 4), "bkt", "big.bin", &path).await.unwrap_err();
        let text = AppError::from(err).to_string();
        assert!(text.contains("5 TiB"), "{text}");
        assert_eq!(create.num_calls(), 0);
    }

    #[tokio::test]
    async fn a_missing_source_file_is_a_local_error_and_sends_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let create = create_rule();
        let client = client_with(&[&create]);
        let err = upload_file(&client, &env(1, 5 * MIB, 4), "bkt", "big.bin", &dir.path().join("nope")).await.unwrap_err();
        assert!(matches!(AppError::from(err), AppError::Local(_)));
        assert_eq!(create.num_calls(), 0);
    }
}
