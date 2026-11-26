//! Download of one object: ranged GetObject requests (at most the profile's chunk size each,
//! one stream per file) appended to `<name>.part` next to the destination, then an atomic rename.
//! A sidecar `<name>.part.meta` records the object's ETag and size; an existing `.part` is
//! continued from its length only when both still match, otherwise the download starts over.
//! Cancel removes the temp file and the sidecar; a failure keeps them for the next try and says
//! so in the error. No Tauri dependency.
//!
//! Memory: the body is streamed straight to the file, so only the SDK's current body chunk is held.

use std::io::SeekFrom;
use std::path::{Path, PathBuf};

use aws_sdk_s3::Client;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::app_error::AppError;
use crate::local::describe_io_error;
use crate::multipart_upload::single_attempt;
use crate::transfer_control::{classify_sdk_error, with_retry, AttemptError, EngineError, ProgressTracker, TransferEnv};

const PART_SUFFIX: &str = ".part";
const META_SUFFIX: &str = ".part.meta";

/// Download `bucket/key` to `dest` (parent folders are created).
pub async fn download_file(client: &Client, env: &TransferEnv, bucket: &str, key: &str, dest: &Path) -> Result<(), EngineError> {
    if env.cancel.is_cancelled() {
        return Err(EngineError::cancelled());
    }
    let head = with_retry(&env.retry, &env.cancel, || async {
        client.head_object().bucket(bucket).key(key).customize().config_override(single_attempt()).send().await.map_err(classify_sdk_error)
    })
    .await?;
    let size = head.content_length().and_then(|length| u64::try_from(length).ok()).unwrap_or(0);
    let etag = head.e_tag().unwrap_or_default().to_string();
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|err| EngineError::failed(describe_io_error(&err, parent)))?;
    }
    let files = TempFiles { partial: sibling(dest, PART_SUFFIX), meta: sibling(dest, META_SUFFIX) };
    let start = files.prepare(&etag, size).await.map_err(EngineError::failed)?;
    let source = Source { client, env, bucket, key, etag: &etag, size };
    match fetch_all(&source, &files, start).await {
        Ok(()) => files.finish(dest, size).await.map_err(EngineError::failed),
        Err(err) if err.is_cancelled() => {
            files.remove().await;
            Err(err)
        }
        Err(err) => Err(keep_for_resume(err, &files.partial)),
    }
}

/// `<name><suffix>` next to `dest`.
fn sibling(dest: &Path, suffix: &str) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    dest.with_file_name(name)
}

/// The temp file and its sidecar (first line the ETag, second the object size).
struct TempFiles {
    partial: PathBuf,
    meta: PathBuf,
}

impl TempFiles {
    /// Where to continue: the length of an existing `.part` whose sidecar matches the object,
    /// otherwise 0 after starting a fresh `.part` and sidecar.
    async fn prepare(&self, etag: &str, size: u64) -> Result<u64, AppError> {
        let kept = self.resumable_len(etag, size).await;
        if kept > 0 {
            return Ok(kept);
        }
        tokio::fs::write(&self.meta, format!("{etag}\n{size}")).await.map_err(|err| describe_io_error(&err, &self.meta))?;
        tokio::fs::File::create(&self.partial).await.map_err(|err| describe_io_error(&err, &self.partial))?;
        Ok(0)
    }

    async fn resumable_len(&self, etag: &str, size: u64) -> u64 {
        let Ok(text) = tokio::fs::read_to_string(&self.meta).await else { return 0 };
        let mut lines = text.lines();
        let matches = !etag.is_empty() && lines.next() == Some(etag) && lines.next().and_then(|line| line.parse::<u64>().ok()) == Some(size);
        let length = tokio::fs::metadata(&self.partial).await.map(|meta| meta.len()).unwrap_or(0);
        if matches && length <= size { length } else { 0 }
    }

    /// Check the size, rename into place and drop the sidecar.
    async fn finish(&self, dest: &Path, size: u64) -> Result<(), AppError> {
        let length = tokio::fs::metadata(&self.partial).await.map_err(|err| describe_io_error(&err, &self.partial))?.len();
        if length != size {
            self.remove().await;
            return Err(AppError::Local(format!("downloaded {length} bytes but the object has {size}; the temporary file was removed")));
        }
        tokio::fs::rename(&self.partial, dest).await.map_err(|err| describe_io_error(&err, dest))?;
        let _ = tokio::fs::remove_file(&self.meta).await;
        Ok(())
    }

    async fn remove(&self) {
        let _ = tokio::fs::remove_file(&self.partial).await;
        let _ = tokio::fs::remove_file(&self.meta).await;
    }
}

/// The failure stays an error of the same kind, with the fact that the temp file is kept.
fn keep_for_resume(err: EngineError, partial: &Path) -> EngineError {
    let note = format!("; the partial download was kept for resume ({})", partial.display());
    match err {
        EngineError::Failed { error: AppError::S3(message), leftover_upload_id } => {
            EngineError::Failed { error: AppError::S3(message + &note), leftover_upload_id }
        }
        EngineError::Failed { error: AppError::Local(message), leftover_upload_id } => {
            EngineError::Failed { error: AppError::Local(message + &note), leftover_upload_id }
        }
        other => other,
    }
}

struct Source<'a> {
    client: &'a Client,
    env: &'a TransferEnv,
    bucket: &'a str,
    key: &'a str,
    etag: &'a str,
    size: u64,
}

/// Request the object range by range from `start`, appending to the `.part` file.
async fn fetch_all(source: &Source<'_>, files: &TempFiles, start: u64) -> Result<(), EngineError> {
    let env = source.env;
    let chunk = env.settings.multipart_chunksize.max(1);
    let total_ranges = usize::try_from(source.size.div_ceil(chunk)).unwrap_or(usize::MAX);
    let tracker = ProgressTracker::new(env.sink.clone(), source.size);
    if start > 0 {
        tracker.add(start);
    }
    let mut offset = start;
    while offset < source.size {
        if env.cancel.is_cancelled() {
            return Err(EngineError::cancelled());
        }
        let last = (offset + chunk).min(source.size) - 1;
        let received = with_retry(&env.retry, &env.cancel, || fetch_range(source, &files.partial, offset, last)).await;
        match received {
            Ok(()) => {}
            Err(_) if env.cancel.is_cancelled() => return Err(EngineError::cancelled()),
            Err(err) => return Err(err),
        }
        tracker.add(last - offset + 1);
        tracker.sink().part_done(i32::try_from(offset / chunk + 1).unwrap_or(i32::MAX), total_ranges);
        offset = last + 1;
    }
    Ok(())
}

/// One attempt at bytes `offset..=last`: the file is cut back to `offset` first, so a retry never
/// leaves duplicated or partial data behind.
async fn fetch_range(source: &Source<'_>, partial: &Path, offset: u64, last: u64) -> Result<(), AttemptError> {
    let local = |err: std::io::Error| AttemptError::permanent(describe_io_error(&err, partial));
    let mut file = tokio::fs::OpenOptions::new().write(true).open(partial).await.map_err(local)?;
    file.set_len(offset).await.map_err(local)?;
    file.seek(SeekFrom::Start(offset)).await.map_err(local)?;
    let mut request = source.client.get_object().bucket(source.bucket).key(source.key).range(format!("bytes={offset}-{last}"));
    if !source.etag.is_empty() {
        request = request.if_match(source.etag);
    }
    let output = request.customize().config_override(single_attempt()).send().await.map_err(classify_sdk_error)?;
    let expected = last - offset + 1;
    let mut body = output.body;
    let mut received = 0u64;
    while let Some(piece) = body.try_next().await.map_err(|err| AttemptError { error: AppError::S3(format!("download interrupted: {err}")), is_transient: true })? {
        received += piece.len() as u64;
        if received > expected {
            return Err(AttemptError::permanent(AppError::S3("the server sent more data than the requested range; the size does not match".into())));
        }
        if source.env.cancel.is_cancelled() {
            return Err(AttemptError::permanent(AppError::Local("cancelled".into())));
        }
        file.write_all(&piece).await.map_err(local)?;
    }
    file.flush().await.map_err(local)?;
    if received != expected {
        return Err(AttemptError { error: AppError::S3(format!("download interrupted: received {received} of {expected} bytes")), is_transient: true });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::operation::head_object::{HeadObjectError, HeadObjectOutput};
    use aws_sdk_s3::primitives::ByteStream;
    use aws_sdk_s3::types::error::NotFound;
    use aws_smithy_mocks::{mock, mock_client, Rule, RuleMode};
    use aws_smithy_runtime_api::client::orchestrator::HttpResponse;
    use aws_smithy_runtime_api::http::StatusCode;
    use aws_smithy_types::body::SdkBody;

    use crate::app_error::AppError;
    use crate::transfer_control::{CancelToken, ProgressSink, RetryPolicy};
    use crate::transfer_settings::{AddressingStyle, EffectiveTransferSettings};

    const ETAG: &str = "\"etag-1\"";

    fn env(chunksize: u64) -> TransferEnv {
        let mut env = TransferEnv::new(EffectiveTransferSettings {
            multipart_threshold: 8 << 20,
            multipart_chunksize: chunksize,
            max_concurrent_requests: 4,
            addressing_style: AddressingStyle::Path,
        });
        env.retry = RetryPolicy { max_attempts: 3, base_delay: std::time::Duration::ZERO };
        env
    }

    /// 25 bytes "0123456789" repeated and cut: easy to tell which range ended up where.
    fn content() -> Vec<u8> {
        (0..25u8).map(|index| b'a' + index).collect()
    }

    fn head_rule(body: &[u8], etag: &'static str) -> Rule {
        let size = body.len() as i64;
        mock!(aws_sdk_s3::Client::head_object)
            .match_requests(|req| req.bucket() == Some("bkt") && req.key() == Some("dir/obj.bin"))
            .then_output(move || HeadObjectOutput::builder().content_length(size).e_tag(etag).build())
    }

    /// `bytes=a-b` of the request, inclusive.
    fn range_of(header: Option<&str>) -> (usize, usize) {
        let text = header.unwrap_or("").trim_start_matches("bytes=");
        let (first, last) = text.split_once('-').unwrap_or(("0", "0"));
        (first.parse().unwrap_or(0), last.parse().unwrap_or(0))
    }

    /// GetObject serving `body` by range and logging every request's range and If-Match.
    fn get_rule(body: Vec<u8>, log: &Arc<Mutex<Vec<String>>>) -> Rule {
        let log = log.clone();
        mock!(aws_sdk_s3::Client::get_object).then_compute_output(move |req| {
            let (first, last) = range_of(req.range());
            log.lock().unwrap().push(format!("{} if-match={}", req.range().unwrap_or(""), req.if_match().unwrap_or("")));
            let end = (last + 1).min(body.len());
            GetObjectOutput::builder().body(ByteStream::from(body[first..end].to_vec())).build()
        })
    }

    fn status(code: u16) -> HttpResponse {
        HttpResponse::new(StatusCode::try_from(code).unwrap(), SdkBody::empty())
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut found: Vec<String> = std::fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        found.sort();
        found
    }

    #[derive(Default)]
    struct Recorder {
        totals: Mutex<Vec<u64>>,
        done: Mutex<Vec<u64>>,
        parts: Mutex<Vec<(i32, usize)>>,
        cancel_after_first_part: Option<CancelToken>,
    }
    impl ProgressSink for Recorder {
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
    async fn downloads_in_ranges_through_a_part_file_and_renames_it_into_place() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("sub").join("obj.bin");
        let part_dir = dest.parent().unwrap().to_path_buf();
        let during = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let (seen_during, listing_dir) = (during.clone(), part_dir.clone());
        let body = content();
        let served = body.clone();
        let get = mock!(aws_sdk_s3::Client::get_object).then_compute_output(move |req| {
            seen_during.lock().unwrap().push(names(&listing_dir));
            let (first, last) = range_of(req.range());
            GetObjectOutput::builder().body(ByteStream::from(served[first..(last + 1).min(served.len())].to_vec())).build()
        });
        let head = head_rule(&body, ETAG);
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &get]);
        let recorder = Arc::new(Recorder::default());
        let mut env = env(10);
        env.sink = recorder.clone();
        download_file(&client, &env, "bkt", "dir/obj.bin", &dest).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert_eq!(names(&part_dir), ["obj.bin"], "no .part or sidecar left behind");
        assert_eq!(get.num_calls(), 3);
        let during = during.lock().unwrap();
        assert_eq!(during[0], ["obj.bin.part", "obj.bin.part.meta"]);
        assert_eq!(*recorder.totals.lock().unwrap(), [25]);
        assert_eq!(*recorder.done.lock().unwrap(), [10, 20, 25]);
        assert_eq!(*recorder.parts.lock().unwrap(), [(1, 3), (2, 3), (3, 3)]);
    }

    #[tokio::test]
    async fn every_range_request_carries_the_range_and_if_match_with_the_etag() {
        let dir = tempfile::tempdir().unwrap();
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let body = content();
        let (head, get) = (head_rule(&body, ETAG), get_rule(body, &log));
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &get]);
        download_file(&client, &env(10), "bkt", "dir/obj.bin", &dir.path().join("obj.bin")).await.unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            ["bytes=0-9 if-match=\"etag-1\"", "bytes=10-19 if-match=\"etag-1\"", "bytes=20-24 if-match=\"etag-1\""]
        );
    }

    #[tokio::test]
    async fn an_empty_object_makes_an_empty_file_without_a_get() {
        let dir = tempfile::tempdir().unwrap();
        let head = head_rule(b"", ETAG);
        let get = mock!(aws_sdk_s3::Client::get_object).then_output(|| GetObjectOutput::builder().build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &get]);
        download_file(&client, &env(10), "bkt", "dir/obj.bin", &dir.path().join("obj.bin")).await.unwrap();
        assert_eq!((std::fs::metadata(dir.path().join("obj.bin")).unwrap().len(), get.num_calls()), (0, 0));
        assert_eq!(names(dir.path()), ["obj.bin"]);
    }

    #[tokio::test]
    async fn an_existing_part_file_with_the_same_etag_and_size_is_continued_from_its_length() {
        let dir = tempfile::tempdir().unwrap();
        let body = content();
        std::fs::write(dir.path().join("obj.bin.part"), &body[..10]).unwrap();
        std::fs::write(dir.path().join("obj.bin.part.meta"), format!("{ETAG}\n25")).unwrap();
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let (head, get) = (head_rule(&body, ETAG), get_rule(body.clone(), &log));
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &get]);
        let recorder = Arc::new(Recorder::default());
        let mut env = env(10);
        env.sink = recorder.clone();
        download_file(&client, &env, "bkt", "dir/obj.bin", &dir.path().join("obj.bin")).await.unwrap();
        assert_eq!(log.lock().unwrap()[0], "bytes=10-19 if-match=\"etag-1\"");
        assert_eq!(std::fs::read(dir.path().join("obj.bin")).unwrap(), body);
        assert_eq!(*recorder.done.lock().unwrap(), [10, 20, 25], "progress starts from what was already on disk");
    }

    #[tokio::test]
    async fn a_changed_etag_or_size_or_missing_sidecar_restarts_the_download_from_zero() {
        let body = content();
        let cases: [(&str, Option<String>); 3] = [
            ("another etag", Some("\"other\"\n25".to_string())),
            ("another size", Some(format!("{ETAG}\n99"))),
            ("no sidecar", None),
        ];
        for (label, sidecar) in cases {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("obj.bin.part"), b"JUNKJUNKJU").unwrap();
            if let Some(text) = sidecar {
                std::fs::write(dir.path().join("obj.bin.part.meta"), text).unwrap();
            }
            let log = Arc::new(Mutex::new(Vec::<String>::new()));
            let (head, get) = (head_rule(&body, ETAG), get_rule(body.clone(), &log));
            let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &get]);
            download_file(&client, &env(10), "bkt", "dir/obj.bin", &dir.path().join("obj.bin")).await.unwrap();
            assert!(log.lock().unwrap()[0].starts_with("bytes=0-9"), "{label}: {:?}", log.lock().unwrap());
            assert_eq!(std::fs::read(dir.path().join("obj.bin")).unwrap(), body, "{label}");
        }
    }

    #[tokio::test]
    async fn a_part_file_longer_than_the_object_is_not_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let body = content();
        std::fs::write(dir.path().join("obj.bin.part"), vec![b'x'; 40]).unwrap();
        std::fs::write(dir.path().join("obj.bin.part.meta"), format!("{ETAG}\n25")).unwrap();
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let (head, get) = (head_rule(&body, ETAG), get_rule(body.clone(), &log));
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &get]);
        download_file(&client, &env(10), "bkt", "dir/obj.bin", &dir.path().join("obj.bin")).await.unwrap();
        assert!(log.lock().unwrap()[0].starts_with("bytes=0-9"));
        assert_eq!(std::fs::read(dir.path().join("obj.bin")).unwrap(), body);
    }

    #[tokio::test]
    async fn cancel_removes_the_part_file_and_the_sidecar_and_requests_nothing_more() {
        let dir = tempfile::tempdir().unwrap();
        let body = content();
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let (head, get) = (head_rule(&body, ETAG), get_rule(body, &log));
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &get]);
        let token = CancelToken::default();
        let mut env = env(10);
        env.sink = Arc::new(Recorder { cancel_after_first_part: Some(token.clone()), ..Default::default() });
        env.cancel = token;
        let err = download_file(&client, &env, "bkt", "dir/obj.bin", &dir.path().join("obj.bin")).await.unwrap_err();
        assert!(err.is_cancelled(), "{err:?}");
        assert_eq!(get.num_calls(), 1);
        assert!(names(dir.path()).is_empty(), "{:?}", names(dir.path()));
    }

    #[tokio::test]
    async fn a_failure_keeps_the_part_file_for_resume_says_so_and_the_next_run_continues() {
        let dir = tempfile::tempdir().unwrap();
        let body = content();
        let dest = dir.path().join("obj.bin");
        let first_ok = get_rule_for_range(body.clone(), 0);
        let broken = mock!(aws_sdk_s3::Client::get_object)
            .match_requests(|req| req.range() != Some("bytes=0-9"))
            .then_http_response(|| status(503));
        let head = head_rule(&body, ETAG);
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &first_ok, &broken]);
        let err = download_file(&client, &env(10), "bkt", "dir/obj.bin", &dest).await.unwrap_err();
        assert_eq!(broken.num_calls(), 3, "three attempts on the failing range");
        let text = AppError::from(err).to_string();
        assert!(text.contains("kept for resume"), "{text}");
        assert!(!dest.exists());
        assert_eq!(std::fs::read(dir.path().join("obj.bin.part")).unwrap(), body[..10]);
        assert!(dir.path().join("obj.bin.part.meta").exists());

        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let (head, get) = (head_rule(&body, ETAG), get_rule(body.clone(), &log));
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &get]);
        download_file(&client, &env(10), "bkt", "dir/obj.bin", &dest).await.unwrap();
        assert!(log.lock().unwrap()[0].starts_with("bytes=10-19"));
        assert_eq!(std::fs::read(&dest).unwrap(), body);
    }

    fn get_rule_for_range(body: Vec<u8>, first: usize) -> Rule {
        mock!(aws_sdk_s3::Client::get_object)
            .match_requests(move |req| range_of(req.range()).0 == first && req.range() == Some("bytes=0-9"))
            .then_compute_output(move |req| {
                let (from, to) = range_of(req.range());
                GetObjectOutput::builder().body(ByteStream::from(body[from..=to].to_vec())).build()
            })
    }

    #[tokio::test]
    async fn a_range_that_fails_once_or_arrives_short_is_retried_without_duplicating_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let body = content();
        let served = body.clone();
        let attempts = Arc::new(Mutex::new(0u32));
        let counter = attempts.clone();
        let get = mock!(aws_sdk_s3::Client::get_object).then_compute_response(move |req| {
            let (first, last) = range_of(req.range());
            if first == 10 {
                let mut tries = counter.lock().unwrap();
                *tries += 1;
                match *tries {
                    1 => return aws_smithy_mocks::MockResponse::Http(status(500)),
                    2 => return aws_smithy_mocks::MockResponse::Output(GetObjectOutput::builder().body(ByteStream::from(served[10..13].to_vec())).build()),
                    _ => {}
                }
            }
            aws_smithy_mocks::MockResponse::Output(GetObjectOutput::builder().body(ByteStream::from(served[first..(last + 1).min(served.len())].to_vec())).build())
        });
        let head = head_rule(&body, ETAG);
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &get]);
        let dest = dir.path().join("obj.bin");
        download_file(&client, &env(10), "bkt", "dir/obj.bin", &dest).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert_eq!(*attempts.lock().unwrap(), 3);
    }

    #[tokio::test]
    async fn a_4xx_is_not_retried() {
        let dir = tempfile::tempdir().unwrap();
        let body = content();
        let get = mock!(aws_sdk_s3::Client::get_object).then_http_response(|| status(412));
        let head = head_rule(&body, ETAG);
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &get]);
        download_file(&client, &env(10), "bkt", "dir/obj.bin", &dir.path().join("obj.bin")).await.unwrap_err();
        assert_eq!(get.num_calls(), 1);
    }

    #[tokio::test]
    async fn a_server_that_ignores_the_range_and_sends_too_many_bytes_is_rejected_and_never_renamed() {
        let dir = tempfile::tempdir().unwrap();
        let body = content();
        let whole = body.clone();
        let get = mock!(aws_sdk_s3::Client::get_object).then_compute_output(move |_| GetObjectOutput::builder().body(ByteStream::from(whole.clone())).build());
        let head = head_rule(&body, ETAG);
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &get]);
        let dest = dir.path().join("obj.bin");
        let err = download_file(&client, &env(10), "bkt", "dir/obj.bin", &dest).await.unwrap_err();
        assert!(!dest.exists());
        let text = AppError::from(err).to_string();
        assert!(text.contains("more") || text.contains("size"), "{text}");
        assert_eq!(get.num_calls(), 1, "a wrong-sized answer is not retried");
    }

    #[tokio::test]
    async fn a_missing_object_is_an_error_and_creates_no_files() {
        let dir = tempfile::tempdir().unwrap();
        let head = mock!(aws_sdk_s3::Client::head_object).then_error(|| HeadObjectError::NotFound(NotFound::builder().build()));
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head]);
        let err = download_file(&client, &env(10), "bkt", "dir/obj.bin", &dir.path().join("obj.bin")).await.unwrap_err();
        assert!(matches!(AppError::from(err), AppError::S3(_)));
        assert!(names(dir.path()).is_empty());
    }
}
