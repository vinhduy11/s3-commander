//! The operation engine: gathers what exists (local walk, server listing), builds the plan with
//! `transfer_plan`, applies the conflict policy and runs it item by item. Move = copy, verify,
//! then delete the source; an item whose copy or verify fails keeps its source and is reported.
//! No Tauri dependency.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use aws_sdk_s3::Client;
use serde::Serialize;

use crate::app_error::AppError;
use crate::local::describe_io_error;
use crate::local_ops::{self, TrashBin};
use crate::{multipart_upload, ranged_download, s3_ops};
use crate::transfer_control::{EngineError, TransferEnv};
use crate::transfer_plan::{
    apply_resolutions, build_plan, check_destination, summarize, ConflictPolicy, ExistingInfo, Found,
    ItemFailure, ItemRef, Location, Mode, PlanItem, PlanSummary, Resolutions, TopItem, TransferRequest,
};

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct RunReport {
    /// Files and folders created at the destination.
    pub transferred: usize,
    pub skipped: usize,
    pub bytes: u64,
    /// Sources deleted by a move.
    pub sources_removed: usize,
    pub failed: Vec<ItemFailure>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct DeleteReport {
    pub deleted: usize,
    pub failed: Vec<ItemFailure>,
}

const MAX_KEEP_BOTH_ROUNDS: usize = 100;

/// Why one item failed: the readable message, whether it was a cancel, and whether an
/// incomplete upload may be left on the server (a cancel whose abort failed).
#[derive(Debug)]
pub struct CopyFailure {
    pub message: String,
    pub cancelled: bool,
    pub leftover_upload: bool,
}

impl From<AppError> for CopyFailure {
    fn from(err: AppError) -> Self {
        Self { message: err.to_string(), cancelled: false, leftover_upload: false }
    }
}

impl From<EngineError> for CopyFailure {
    fn from(err: EngineError) -> Self {
        let (cancelled, leftover_upload) = (err.is_cancelled(), err.leftover_upload_id().is_some());
        Self { message: AppError::from(err).to_string(), cancelled, leftover_upload }
    }
}

/// What a finished item leaves to clean up when the operation is a move.
pub enum Removal {
    Nothing,
    SourceRemoved,
    ServerKey { bucket: String, key: String },
}

fn needs_server(location: &Location) -> bool {
    matches!(location, Location::Bucket { .. })
}

fn require_client<'a>(client: Option<&'a Client>) -> Result<&'a Client, AppError> {
    client.ok_or_else(|| AppError::S3("no active server profile selected".into()))
}

fn local_path(location: &Location) -> Option<&Path> {
    match location {
        Location::Local { path } => Some(Path::new(path)),
        Location::Bucket { .. } => None,
    }
}

/// Every file and empty folder under the selected items.
async fn expand(client: Option<&Client>, request: &TransferRequest) -> Result<Vec<Found>, AppError> {
    let mut found = Vec::new();
    for item in &request.items {
        match &request.source {
            Location::Local { path } => found.extend(local_ops::walk_item(Path::new(path), item)?),
            Location::Bucket { bucket, prefix } => {
                let client = require_client(client)?;
                if item.is_dir {
                    for listed in s3_ops::list_all(client, bucket, &format!("{prefix}{}/", item.name)).await? {
                        let is_dir = listed.key.ends_with('/');
                        let rel = listed.key.strip_prefix(prefix.as_str()).unwrap_or(&listed.key).trim_end_matches('/').to_string();
                        found.push(Found { rel, size: if is_dir { 0 } else { listed.size }, is_dir, modified: listed.modified });
                    }
                } else {
                    let key = format!("{prefix}{}", item.name);
                    let (size, modified) = s3_ops::object_info(client, bucket, &key)
                        .await?
                        .ok_or_else(|| AppError::S3(format!("not found: {bucket}/{key}")))?;
                    found.push(Found { rel: item.name.clone(), size, is_dir: false, modified });
                }
            }
        }
    }
    Ok(found)
}

/// Existence of one destination.
async fn probe_ref(client: Option<&Client>, target: &ItemRef) -> Result<Option<ExistingInfo>, AppError> {
    match target {
        ItemRef::Local(path) => Ok(std::fs::symlink_metadata(path)
            .ok()
            .map(|metadata| ExistingInfo { size: metadata.len(), modified: local_ops::modified_seconds(&metadata) })),
        ItemRef::Object { bucket, key } => Ok(s3_ops::object_info(require_client(client)?, bucket, key)
            .await?
            .map(|(size, modified)| ExistingInfo { size, modified })),
    }
}

/// Which destinations of the plan's files already exist. A selected folder at a server destination
/// is probed with one listing instead of one HEAD per file.
async fn probe_plan(
    client: Option<&Client>,
    request: &TransferRequest,
    plan: &[PlanItem],
) -> Result<HashMap<ItemRef, ExistingInfo>, AppError> {
    let mut listed: HashMap<String, ExistingInfo> = HashMap::new();
    let mut listed_prefixes: Vec<String> = Vec::new();
    if let Location::Bucket { bucket, prefix } = &request.dest {
        for item in request.items.iter().filter(|item| item.is_dir) {
            let dir_prefix = format!("{prefix}{}/", item.dest_name.as_deref().unwrap_or(&item.name));
            for entry in s3_ops::list_all(require_client(client)?, bucket, &dir_prefix).await? {
                listed.insert(entry.key, ExistingInfo { size: entry.size, modified: entry.modified });
            }
            listed_prefixes.push(dir_prefix);
        }
    }
    let mut existing = HashMap::new();
    for item in plan.iter().filter(|item| !item.is_dir) {
        let covered_key = match &item.dst {
            ItemRef::Object { key, .. } if listed_prefixes.iter().any(|dir_prefix| key.starts_with(dir_prefix)) => Some(key),
            _ => None,
        };
        let found = match covered_key {
            Some(key) => listed.get(key).copied(),
            None => probe_ref(client, &item.dst).await?,
        };
        if let Some(info) = found {
            existing.insert(item.dst.clone(), info);
        }
    }
    Ok(existing)
}

fn ensure_client(client: Option<&Client>, request: &TransferRequest) -> Result<(), AppError> {
    if needs_server(&request.source) || needs_server(&request.dest) {
        require_client(client)?;
    }
    Ok(())
}

async fn prepare(client: Option<&Client>, request: &TransferRequest) -> Result<(Vec<PlanItem>, HashMap<ItemRef, ExistingInfo>), AppError> {
    check_destination(request)?;
    ensure_client(client, request)?;
    let found = expand(client, request).await?;
    let plan = build_plan(request, &found);
    let details = probe_plan(client, request, &plan).await?;
    Ok((plan, details))
}

/// Dry run: what a transfer would do (counts, size, conflicts), without writing anything.
pub async fn plan_transfer(client: Option<&Client>, request: &TransferRequest) -> Result<PlanSummary, AppError> {
    let (plan, details) = prepare(client, request).await?;
    let existing: HashSet<ItemRef> = details.keys().cloned().collect();
    Ok(summarize(request, &plan, &existing, &details))
}

/// Apply the decisions; "keep both" names are probed too, so a "(1)" that already exists is skipped over.
async fn resolve(
    client: Option<&Client>,
    plan: &[PlanItem],
    mut existing: HashSet<ItemRef>,
    resolutions: &Resolutions,
) -> Result<Vec<PlanItem>, AppError> {
    for _ in 0..MAX_KEEP_BOTH_ROUNDS {
        let applied = apply_resolutions(plan.to_vec(), &existing, resolutions)?;
        let mut taken_names = Vec::new();
        for (original, resolved) in plan.iter().zip(&applied) {
            if original.dst != resolved.dst && probe_ref(client, &resolved.dst).await?.is_some() {
                taken_names.push(resolved.dst.clone());
            }
        }
        if taken_names.is_empty() {
            return Ok(applied);
        }
        existing.extend(taken_names);
    }
    Err(AppError::Local("could not find a free name for \"keep both\"".into()))
}

/// The plan after the conflict decisions: what a job will run, item by item.
pub async fn prepare_plan(client: Option<&Client>, request: &TransferRequest, resolutions: &Resolutions) -> Result<Vec<PlanItem>, AppError> {
    let (plan, details) = prepare(client, request).await?;
    let existing: HashSet<ItemRef> = details.keys().cloned().collect();
    resolve(client, &plan, existing, resolutions).await
}

/// After a move from a local folder: remove the source folders the move emptied.
pub fn remove_emptied_local_dirs(request: &TransferRequest) {
    if request.mode != Mode::Move {
        return;
    }
    if let Some(parent) = local_path(&request.source) {
        request.items.iter().filter(|item| item.is_dir).for_each(|item| local_ops::remove_empty_tree(&parent.join(&item.name)));
    }
}

/// One-shot run of a whole transfer (no queue): used by rename; the UI's copy and move go through
/// the job queue instead.
pub async fn run_transfer(
    client: Option<&Client>,
    request: &TransferRequest,
    resolutions: &Resolutions,
    env: &TransferEnv,
) -> Result<RunReport, AppError> {
    let plan = prepare_plan(client, request, resolutions).await?;
    let mut report = RunReport::default();
    let mut server_removals: HashMap<String, Vec<String>> = HashMap::new();
    for item in &plan {
        if item.skip {
            report.skipped += 1;
            continue;
        }
        match transfer_one(client, item, request.mode, env).await {
            Ok(removal) => {
                report.transferred += 1;
                report.bytes += item.size;
                match removal {
                    Removal::Nothing => {}
                    Removal::SourceRemoved => report.sources_removed += 1,
                    Removal::ServerKey { bucket, key } => server_removals.entry(bucket).or_default().push(key),
                }
            }
            Err(message) => report.failed.push(ItemFailure { name: item.src.label(), message }),
        }
    }
    for (bucket, keys) in server_removals {
        remove_server_sources(client, &bucket, &keys, &mut report).await;
    }
    remove_emptied_local_dirs(request);
    Ok(report)
}

/// Delete the verified sources of a move; a refused key is reported, never hidden.
async fn remove_server_sources(client: Option<&Client>, bucket: &str, keys: &[String], report: &mut RunReport) {
    let Some(client) = client else { return };
    match s3_ops::delete_keys(client, bucket, keys).await {
        Ok(refused) => {
            report.sources_removed += keys.len() - refused.len();
            report.failed.extend(refused.into_iter().map(|failure| ItemFailure {
                name: format!("{bucket}/{}", failure.key),
                message: format!("copied, but the source was not deleted: {}", failure.message),
            }));
        }
        Err(err) => report.failed.push(ItemFailure {
            name: bucket.to_string(),
            message: format!("copied, but the sources were not deleted: {err}"),
        }),
    }
}

async fn transfer_one(client: Option<&Client>, item: &PlanItem, mode: Mode, env: &TransferEnv) -> Result<Removal, String> {
    copy_item(client, item, mode, env, None).await.map_err(|failure| failure.message)
}

/// Copy one planned item (and verify it for a move). `resume_upload_id` continues a kept multipart
/// upload instead of starting a new one (an upload of a large file only).
pub async fn copy_item(
    client: Option<&Client>,
    item: &PlanItem,
    mode: Mode,
    env: &TransferEnv,
    resume_upload_id: Option<&str>,
) -> Result<Removal, CopyFailure> {
    if item.is_dir {
        match (&item.src, &item.dst) {
            (ItemRef::Object { bucket: from_bucket, key: from_key }, ItemRef::Object { bucket, key }) => {
                s3_ops::copy_object(require_client(client)?, from_bucket, from_key, bucket, key, 0).await?
            }
            (_, ItemRef::Object { bucket, key }) => s3_ops::put_empty(require_client(client)?, bucket, key).await?,
            (_, ItemRef::Local(path)) => local_ops::ensure_dir(path)?,
        }
        return Ok(match (&item.src, mode) {
            (ItemRef::Object { bucket, key }, Mode::Move) => Removal::ServerKey { bucket: bucket.clone(), key: key.clone() },
            _ => Removal::Nothing,
        });
    }
    match (&item.src, &item.dst) {
        (ItemRef::Local(from), ItemRef::Local(to)) => {
            if let Some(parent) = to.parent() {
                local_ops::ensure_dir(parent)?;
            }
            if mode == Mode::Move && std::fs::rename(from, to).is_ok() {
                return Ok(Removal::SourceRemoved);
            }
            tokio::fs::copy(from, to).await.map_err(|err| describe_io_error(&err, from))?;
        }
        (ItemRef::Local(from), ItemRef::Object { bucket, key }) => match resume_upload_id {
            Some(upload_id) => multipart_upload::resume_upload(require_client(client)?, env, bucket, key, from, upload_id).await?,
            None => multipart_upload::upload_file(require_client(client)?, env, bucket, key, from).await?,
        },
        (ItemRef::Object { bucket, key }, ItemRef::Local(to)) => ranged_download::download_file(require_client(client)?, env, bucket, key, to).await?,
        (ItemRef::Object { bucket: from_bucket, key: from_key }, ItemRef::Object { bucket, key }) => {
            s3_ops::copy_object(require_client(client)?, from_bucket, from_key, bucket, key, item.size).await?
        }
    }
    if mode == Mode::Copy {
        return Ok(Removal::Nothing);
    }
    verify_size(client, &item.dst, item.size).await?;
    match &item.src {
        ItemRef::Local(from) => {
            tokio::fs::remove_file(from).await.map_err(|err| describe_io_error(&err, from))?;
            Ok(Removal::SourceRemoved)
        }
        ItemRef::Object { bucket, key } => Ok(Removal::ServerKey { bucket: bucket.clone(), key: key.clone() }),
    }
}

/// A move deletes its source only after the destination reports the expected size.
async fn verify_size(client: Option<&Client>, target: &ItemRef, expected: u64) -> Result<(), AppError> {
    match probe_ref(client, target).await? {
        Some(info) if info.size == expected => Ok(()),
        Some(info) => Err(AppError::Local(format!("verify failed: {} has {} bytes, expected {expected}", target.label(), info.size))),
        None => Err(AppError::Local(format!("verify failed: {} is missing after the copy", target.label()))),
    }
}

/// Server: DeleteObjects in batches of 1000 (a folder is every key under the prefix, marker
/// included), permanent. Local: to the Trash through `trash`.
pub async fn delete_items(
    client: Option<&Client>,
    trash: &dyn TrashBin,
    location: &Location,
    items: &[TopItem],
) -> Result<DeleteReport, AppError> {
    match location {
        Location::Local { path } => {
            let failed = local_ops::trash_items(trash, Path::new(path), items);
            Ok(DeleteReport { deleted: items.len() - failed.len(), failed })
        }
        Location::Bucket { bucket, prefix } => {
            let client = require_client(client)?;
            let mut keys = Vec::new();
            for item in items {
                if item.is_dir {
                    let listed = s3_ops::list_all(client, bucket, &format!("{prefix}{}/", item.name)).await?;
                    keys.extend(listed.into_iter().map(|entry| entry.key));
                } else {
                    keys.push(format!("{prefix}{}", item.name));
                }
            }
            let refused = s3_ops::delete_keys(client, bucket, &keys).await?;
            Ok(DeleteReport {
                deleted: keys.len() - refused.len(),
                failed: refused.into_iter().map(|failure| ItemFailure { name: failure.key, message: failure.message }).collect(),
            })
        }
    }
}

/// Server: a zero-byte object with a trailing "/". Local: a directory.
pub async fn new_folder(client: Option<&Client>, location: &Location, name: &str) -> Result<(), AppError> {
    local_ops::validate_name(name)?;
    match location {
        Location::Local { path } => local_ops::make_dir(Path::new(path), name),
        Location::Bucket { bucket, prefix } => s3_ops::put_empty(require_client(client)?, bucket, &format!("{prefix}{name}/")).await,
    }
}

/// Rename inside one directory. Server: copy then delete of every key (a folder: every key under
/// the prefix); refused when the new name already exists. Local: `fs::rename`.
pub async fn rename_item(
    client: Option<&Client>,
    location: &Location,
    item: &TopItem,
    new_name: &str,
) -> Result<RunReport, AppError> {
    local_ops::validate_name(new_name)?;
    match location {
        Location::Local { path } => {
            let parent = Path::new(path);
            local_ops::rename_path(&parent.join(&item.name), &parent.join(new_name))?;
            Ok(RunReport { transferred: 1, ..RunReport::default() })
        }
        Location::Bucket { bucket, prefix } => {
            let client = require_client(client)?;
            let taken = if item.is_dir {
                !s3_ops::list_all(client, bucket, &format!("{prefix}{new_name}/")).await?.is_empty()
            } else {
                s3_ops::object_size(client, bucket, &format!("{prefix}{new_name}")).await?.is_some()
            };
            if taken {
                return Err(AppError::S3(format!("already exists: {new_name}")));
            }
            let renamed = TopItem { dest_name: Some(new_name.to_string()), ..item.clone() };
            let request = TransferRequest { source: location.clone(), dest: location.clone(), items: vec![renamed], mode: Mode::Move };
            run_transfer(Some(client), &request, &Resolutions::all(ConflictPolicy::Overwrite), &TransferEnv::default()).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::{Arc, Mutex};

    use aws_sdk_s3::operation::copy_object::{CopyObjectError, CopyObjectOutput};
    use aws_sdk_s3::operation::delete_objects::DeleteObjectsOutput;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::operation::head_object::{HeadObjectError, HeadObjectOutput};
    use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;
    use aws_sdk_s3::operation::put_object::PutObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;
    use aws_sdk_s3::types::{error::NotFound, Object};
    use aws_smithy_mocks::{mock, mock_client, MockResponse, Rule, RuleMode};


    /// The engine with the AWS CLI defaults, as a profile with no transfer settings gets.
    async fn run_transfer(client: Option<&Client>, request: &TransferRequest, resolutions: &Resolutions) -> Result<RunReport, AppError> {
        super::run_transfer(client, request, resolutions, &TransferEnv::default()).await
    }

    fn local(path: &std::path::Path) -> Location {
        Location::Local { path: path.to_string_lossy().into_owned() }
    }
    fn bucket(name: &str, prefix: &str) -> Location {
        Location::Bucket { bucket: name.into(), prefix: prefix.into() }
    }
    fn top(name: &str, is_dir: bool) -> TopItem {
        TopItem { name: name.into(), is_dir, dest_name: None }
    }
    fn request(source: Location, dest: Location, items: Vec<TopItem>, mode: Mode) -> TransferRequest {
        TransferRequest { source, dest, items, mode }
    }
    fn failure_text(report: &RunReport) -> String {
        report.failed.iter().map(|failure| format!("{}: {}", failure.name, failure.message)).collect::<Vec<_>>().join("; ")
    }

    /// HeadObject answering from a "bucket/key" -> size table; anything else is NotFound.
    fn head_table(sizes: &[(&str, i64)]) -> Rule {
        let table: Vec<(String, i64)> = sizes.iter().map(|(name, size)| (name.to_string(), *size)).collect();
        mock!(Client::head_object).then_compute_response(move |req| {
            let name = format!("{}/{}", req.bucket().unwrap_or_default(), req.key().unwrap_or_default());
            match table.iter().find(|(known, _)| *known == name) {
                Some((_, size)) => MockResponse::Output(HeadObjectOutput::builder().content_length(*size).build()),
                None => MockResponse::Error(HeadObjectError::NotFound(NotFound::builder().build())),
            }
        })
    }

    /// ListObjectsV2 answering from a "bucket/prefix" -> [(key, size)] table; anything else is empty.
    fn list_table(table: &[(&str, &[(&str, i64)])]) -> Rule {
        let table: Vec<(String, Vec<(String, i64)>)> = table
            .iter()
            .map(|(name, keys)| (name.to_string(), keys.iter().map(|(key, size)| (key.to_string(), *size)).collect()))
            .collect();
        mock!(Client::list_objects_v2).then_compute_output(move |req| {
            let name = format!("{}/{}", req.bucket().unwrap_or_default(), req.prefix().unwrap_or_default());
            let mut output = ListObjectsV2Output::builder();
            for (key, size) in table.iter().find(|(known, _)| *known == name).map(|(_, keys)| keys.clone()).unwrap_or_default() {
                output = output.contents(Object::builder().key(key).size(size).build());
            }
            output.build()
        })
    }

    fn copy_ok() -> Rule {
        mock!(Client::copy_object).then_output(|| CopyObjectOutput::builder().build())
    }

    type Deleted = Arc<Mutex<Vec<(String, Vec<String>)>>>;

    fn delete_recorder() -> (Rule, Deleted) {
        let seen: Deleted = Arc::default();
        let sink = seen.clone();
        let rule = mock!(Client::delete_objects).then_compute_output(move |req| {
            let keys = req.delete().map(|delete| delete.objects().iter().map(|object| object.key().to_string()).collect()).unwrap_or_default();
            sink.lock().unwrap().push((req.bucket().unwrap_or_default().to_string(), keys));
            DeleteObjectsOutput::builder().build()
        });
        (rule, seen)
    }

    #[derive(Default)]
    struct FakeTrash(Mutex<Vec<std::path::PathBuf>>);
    impl TrashBin for FakeTrash {
        fn move_to_trash(&self, path: &std::path::Path) -> Result<(), String> {
            self.0.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }
    }

    // ---- local to local ----

    #[tokio::test]
    async fn local_copy_keeps_nested_files_and_empty_dirs() {
        let root = tempfile::tempdir().unwrap();
        let (src, dst) = (root.path().join("src"), root.path().join("dst"));
        fs::create_dir_all(src.join("d/sub")).unwrap();
        fs::create_dir(src.join("d/empty")).unwrap();
        fs::write(src.join("d/sub/f.txt"), "deep").unwrap();
        fs::write(src.join("top.txt"), "top").unwrap();
        fs::create_dir(&dst).unwrap();
        let req = request(local(&src), local(&dst), vec![top("d", true), top("top.txt", false)], Mode::Copy);
        let report = run_transfer(None, &req, &Resolutions::all(ConflictPolicy::Overwrite)).await.unwrap();
        assert!(report.failed.is_empty(), "{}", failure_text(&report));
        assert_eq!(fs::read_to_string(dst.join("d/sub/f.txt")).unwrap(), "deep");
        assert!(dst.join("d/empty").is_dir());
        assert_eq!(fs::read_to_string(dst.join("top.txt")).unwrap(), "top");
        assert!(src.join("d/sub/f.txt").exists(), "a copy keeps the source");
        assert_eq!(report.bytes, 7);
    }

    #[tokio::test]
    async fn local_move_removes_sources_and_emptied_folders() {
        let root = tempfile::tempdir().unwrap();
        let (src, dst) = (root.path().join("src"), root.path().join("dst"));
        fs::create_dir_all(src.join("d/sub")).unwrap();
        fs::write(src.join("d/sub/f.txt"), "deep").unwrap();
        fs::create_dir(&dst).unwrap();
        let req = request(local(&src), local(&dst), vec![top("d", true)], Mode::Move);
        let report = run_transfer(None, &req, &Resolutions::all(ConflictPolicy::Overwrite)).await.unwrap();
        assert!(report.failed.is_empty(), "{}", failure_text(&report));
        assert_eq!(fs::read_to_string(dst.join("d/sub/f.txt")).unwrap(), "deep");
        assert!(!src.join("d").exists());
    }

    #[tokio::test]
    async fn local_move_keeps_the_source_when_the_copy_fails() {
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("src");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("a.txt"), "keep me").unwrap();
        let blocker = root.path().join("blocker");
        fs::write(&blocker, "i am a file, not a directory").unwrap();
        let req = request(local(&src), local(&blocker), vec![top("a.txt", false)], Mode::Move);
        let report = run_transfer(None, &req, &Resolutions::all(ConflictPolicy::Overwrite)).await.unwrap();
        assert_eq!(report.failed.len(), 1, "{}", failure_text(&report));
        assert!(report.failed[0].name.ends_with("a.txt"), "{}", report.failed[0].name);
        assert_eq!(fs::read_to_string(src.join("a.txt")).unwrap(), "keep me");
        assert_eq!(report.sources_removed, 0);
    }

    #[tokio::test]
    async fn local_conflict_policies_overwrite_skip_and_keep_both() {
        for (policy, expect_dst, expect_copy) in [
            (ConflictPolicy::Overwrite, "new", None),
            (ConflictPolicy::Skip, "old", None),
            (ConflictPolicy::KeepBoth, "old", Some("new")),
        ] {
            let root = tempfile::tempdir().unwrap();
            let (src, dst) = (root.path().join("src"), root.path().join("dst"));
            fs::create_dir(&src).unwrap();
            fs::create_dir(&dst).unwrap();
            fs::write(src.join("a.txt"), "new").unwrap();
            fs::write(dst.join("a.txt"), "old").unwrap();
            fs::write(dst.join("a (1).txt"), "taken").unwrap();
            let req = request(local(&src), local(&dst), vec![top("a.txt", false)], Mode::Copy);
            let summary = plan_transfer(None, &req).await.unwrap();
            assert_eq!(summary.conflict_count, 1);
            let report = run_transfer(None, &req, &Resolutions::all(policy)).await.unwrap();
            assert!(report.failed.is_empty(), "{}", failure_text(&report));
            assert_eq!(fs::read_to_string(dst.join("a.txt")).unwrap(), expect_dst, "{policy:?}");
            assert_eq!(report.skipped, usize::from(policy == ConflictPolicy::Skip));
            if let Some(content) = expect_copy {
                assert_eq!(fs::read_to_string(dst.join("a (2).txt")).unwrap(), content, "skips the taken (1)");
                assert_eq!(fs::read_to_string(dst.join("a (1).txt")).unwrap(), "taken");
            }
        }
    }

    #[tokio::test]
    async fn per_item_resolutions_mix_and_a_skipped_move_item_keeps_its_source() {
        let root = tempfile::tempdir().unwrap();
        let (src, dst) = (root.path().join("src"), root.path().join("dst"));
        fs::create_dir(&src).unwrap();
        fs::create_dir(&dst).unwrap();
        for name in ["over.txt", "skip.txt", "both.txt", "fresh.txt"] {
            fs::write(src.join(name), "new").unwrap();
        }
        for name in ["over.txt", "skip.txt", "both.txt"] {
            fs::write(dst.join(name), "old").unwrap();
        }
        let items = ["over.txt", "skip.txt", "both.txt", "fresh.txt"].map(|name| top(name, false)).to_vec();
        let req = request(local(&src), local(&dst), items, Mode::Move);
        let summary = plan_transfer(None, &req).await.unwrap();
        assert_eq!(summary.conflicts.len(), 3);
        assert_eq!((summary.conflicts[0].incoming_size, summary.conflicts[0].existing_size), (3, Some(3)));
        let key = |name: &str| dst.join(name).to_string_lossy().into_owned();
        let resolutions = Resolutions {
            per_item: std::collections::HashMap::from([
                (key("over.txt"), ConflictPolicy::Overwrite),
                (key("skip.txt"), ConflictPolicy::Skip),
                (key("both.txt"), ConflictPolicy::KeepBoth),
            ]),
            default: None,
        };
        let report = run_transfer(None, &req, &resolutions).await.unwrap();
        assert!(report.failed.is_empty(), "{}", failure_text(&report));
        assert_eq!(fs::read_to_string(dst.join("over.txt")).unwrap(), "new");
        assert_eq!(fs::read_to_string(dst.join("skip.txt")).unwrap(), "old");
        assert_eq!(fs::read_to_string(dst.join("both.txt")).unwrap(), "old");
        assert_eq!(fs::read_to_string(dst.join("both (1).txt")).unwrap(), "new");
        assert!(src.join("skip.txt").exists(), "a skipped item is not deleted from the source");
        assert!(!src.join("over.txt").exists() && !src.join("both.txt").exists() && !src.join("fresh.txt").exists());
        assert_eq!((report.skipped, report.sources_removed), (1, 3));
    }

    #[tokio::test]
    async fn unresolved_conflicts_run_nothing() {
        let root = tempfile::tempdir().unwrap();
        let (src, dst) = (root.path().join("src"), root.path().join("dst"));
        fs::create_dir(&src).unwrap();
        fs::create_dir(&dst).unwrap();
        fs::write(src.join("a.txt"), "new").unwrap();
        fs::write(src.join("b.txt"), "new").unwrap();
        fs::write(dst.join("a.txt"), "old").unwrap();
        let req = request(local(&src), local(&dst), vec![top("a.txt", false), top("b.txt", false)], Mode::Move);
        let err = run_transfer(None, &req, &Resolutions::default()).await.unwrap_err();
        assert!(err.to_string().contains("not resolved"), "{err}");
        assert_eq!(fs::read_to_string(dst.join("a.txt")).unwrap(), "old");
        assert!(!dst.join("b.txt").exists() && src.join("a.txt").exists() && src.join("b.txt").exists());
    }

    #[tokio::test]
    async fn copying_a_folder_into_itself_is_refused_before_anything_runs() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("d/inner")).unwrap();
        let req = request(local(root.path()), local(&root.path().join("d/inner")), vec![top("d", true)], Mode::Copy);
        let err = run_transfer(None, &req, &Resolutions::all(ConflictPolicy::Overwrite)).await.unwrap_err();
        assert!(err.to_string().contains("into itself"), "{err}");
    }

    // ---- upload ----

    #[tokio::test]
    async fn upload_streams_the_file_to_the_mapped_key() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("up.txt"), "hello").unwrap();
        let head = head_table(&[]);
        let put = mock!(Client::put_object)
            .match_requests(|req| req.bucket() == Some("bkt") && req.key() == Some("in/up.txt") && req.content_length() == Some(5))
            .then_output(|| PutObjectOutput::builder().build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &put]);
        let req = request(local(root.path()), bucket("bkt", "in/"), vec![top("up.txt", false)], Mode::Copy);
        let report = run_transfer(Some(&client), &req, &Resolutions::all(ConflictPolicy::Overwrite)).await.unwrap();
        assert!(report.failed.is_empty(), "{}", failure_text(&report));
        assert_eq!((put.num_calls(), report.transferred, report.bytes), (1, 1, 5));
    }

    #[tokio::test]
    async fn upload_of_an_empty_local_folder_writes_a_folder_marker() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("hollow")).unwrap();
        let head = list_table(&[]);
        let put = mock!(Client::put_object)
            .match_requests(|req| req.key() == Some("hollow/") && req.content_length().unwrap_or(0) == 0)
            .then_output(|| PutObjectOutput::builder().build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &put]);
        let req = request(local(root.path()), bucket("bkt", ""), vec![top("hollow", true)], Mode::Copy);
        let report = run_transfer(Some(&client), &req, &Resolutions::all(ConflictPolicy::Overwrite)).await.unwrap();
        assert_eq!((put.num_calls(), report.failed.len()), (1, 0));
    }

    /// Engine settings with a small threshold and the S3 minimum part size, so a few MiB go multipart.
    fn small_multipart_env() -> TransferEnv {
        let mut env = TransferEnv::new(crate::transfer_settings::EffectiveTransferSettings {
            multipart_threshold: 5 << 20,
            multipart_chunksize: 5 << 20,
            max_concurrent_requests: 3,
            addressing_style: crate::transfer_settings::AddressingStyle::Path,
        });
        env.retry.base_delay = std::time::Duration::ZERO;
        env
    }

    #[tokio::test]
    async fn a_file_above_the_threshold_uploads_as_multipart_and_a_move_verifies_then_removes_the_source() {
        use aws_sdk_s3::operation::complete_multipart_upload::CompleteMultipartUploadOutput;
        use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
        use aws_sdk_s3::operation::upload_part::UploadPartOutput;
        let root = tempfile::tempdir().unwrap();
        fs::File::create(root.path().join("big.bin")).unwrap().set_len(11 << 20).unwrap(); // sparse
        let verify = mock!(Client::head_object)
            .match_requests(|req| req.key() == Some("big.bin"))
            .sequence()
            .error(|| HeadObjectError::NotFound(NotFound::builder().build())) // destination probe
            .output(|| HeadObjectOutput::builder().content_length(11 << 20).build()) // verify after the upload
            .build();
        let put = mock!(Client::put_object).then_output(|| PutObjectOutput::builder().build());
        let create = mock!(Client::create_multipart_upload).then_output(|| CreateMultipartUploadOutput::builder().upload_id("u1").build());
        let part = mock!(Client::upload_part).then_compute_output(|req| UploadPartOutput::builder().e_tag(format!("e{}", req.part_number().unwrap_or(0))).build());
        let complete = mock!(Client::complete_multipart_upload).then_output(|| CompleteMultipartUploadOutput::builder().build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&verify, &put, &create, &part, &complete]);
        let req = request(local(root.path()), bucket("bkt", ""), vec![top("big.bin", false)], Mode::Move);
        let report = super::run_transfer(Some(&client), &req, &Resolutions::all(ConflictPolicy::Overwrite), &small_multipart_env()).await.unwrap();
        assert!(report.failed.is_empty(), "{}", failure_text(&report));
        assert_eq!((put.num_calls(), create.num_calls(), part.num_calls(), complete.num_calls()), (0, 1, 3, 1));
        assert_eq!((report.transferred, report.bytes, report.sources_removed), (1, 11 << 20, 1));
        assert!(!root.path().join("big.bin").exists());
    }

    #[tokio::test]
    async fn a_file_above_5_gib_is_planned_without_any_limit_warning() {
        let root = tempfile::tempdir().unwrap();
        fs::File::create(root.path().join("huge.bin")).unwrap().set_len((5 << 30) + 1).unwrap(); // sparse
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head_table(&[])]);
        let req = request(local(root.path()), bucket("bkt", ""), vec![top("huge.bin", false)], Mode::Copy);
        let summary = plan_transfer(Some(&client), &req).await.unwrap();
        assert_eq!((summary.files, summary.total_bytes), (1, (5 << 30) + 1));
        let json = serde_json::to_value(&summary).unwrap();
        assert!(json.get("too_large_count").is_none(), "{json}");
    }

    #[tokio::test]
    async fn an_upload_above_5_tib_fails_that_item_with_a_clear_message_and_keeps_the_source() {
        let root = tempfile::tempdir().unwrap();
        fs::File::create(root.path().join("huge.bin")).unwrap().set_len((5 << 40) + 1).unwrap(); // sparse
        let head = head_table(&[]);
        let put = mock!(Client::put_object).then_output(|| PutObjectOutput::builder().build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &put]);
        let req = request(local(root.path()), bucket("bkt", ""), vec![top("huge.bin", false)], Mode::Move);
        let report = run_transfer(Some(&client), &req, &Resolutions::all(ConflictPolicy::Overwrite)).await.unwrap();
        assert_eq!(put.num_calls(), 0);
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].message.contains("5 TiB"), "{}", failure_text(&report));
        assert!(root.path().join("huge.bin").exists(), "failed item keeps its source");
    }

    #[tokio::test]
    async fn a_download_of_several_ranges_lands_complete_through_the_engine() {
        let root = tempfile::tempdir().unwrap();
        let size: usize = 12 << 20;
        let head = mock!(Client::head_object)
            .match_requests(|req| req.key() == Some("big.bin"))
            .then_output(move || HeadObjectOutput::builder().content_length(size as i64).e_tag("\"e\"").build());
        let list = list_table(&[]);
        let gets = Arc::new(Mutex::new(Vec::new()));
        let seen = gets.clone();
        let get = mock!(Client::get_object).then_compute_output(move |req| {
            let range = req.range().unwrap_or_default().to_string();
            let (first, last) = range.trim_start_matches("bytes=").split_once('-').map(|(a, b)| (a.parse::<usize>().unwrap(), b.parse::<usize>().unwrap())).unwrap();
            seen.lock().unwrap().push(range);
            GetObjectOutput::builder().body(ByteStream::from(vec![7u8; last - first + 1])).build()
        });
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &list, &get]);
        let req = request(bucket("bkt", ""), local(root.path()), vec![top("big.bin", false)], Mode::Copy);
        let report = super::run_transfer(Some(&client), &req, &Resolutions::all(ConflictPolicy::Overwrite), &small_multipart_env()).await.unwrap();
        assert!(report.failed.is_empty(), "{}", failure_text(&report));
        assert_eq!(fs::metadata(root.path().join("big.bin")).unwrap().len(), size as u64);
        assert_eq!(gets.lock().unwrap().len(), 3, "12 MiB in 5 MiB ranges");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1, "no .part or sidecar left");
    }

    #[tokio::test]
    async fn upload_move_keeps_the_local_source_when_the_put_fails() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "data").unwrap();
        let head = head_table(&[]);
        let put = mock!(Client::put_object).then_error(|| aws_sdk_s3::operation::put_object::PutObjectError::unhandled("denied"));
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &put]);
        let req = request(local(root.path()), bucket("bkt", ""), vec![top("a.txt", false)], Mode::Move);
        let report = run_transfer(Some(&client), &req, &Resolutions::all(ConflictPolicy::Overwrite)).await.unwrap();
        assert_eq!(report.failed.len(), 1);
        assert!(root.path().join("a.txt").exists());
    }

    #[tokio::test]
    async fn upload_move_removes_the_source_only_after_the_size_is_verified() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("ok.txt"), "12345").unwrap();
        fs::write(root.path().join("bad.txt"), "12345").unwrap();
        // dest probe sees nothing; afterwards ok.txt verifies with 5 bytes, bad.txt reports 1 byte
        let verify = mock!(Client::head_object).then_compute_response(|req| {
            match (req.key().unwrap_or_default(), req.bucket().unwrap_or_default()) {
                ("ok.txt", "bkt") => MockResponse::Output(HeadObjectOutput::builder().content_length(5).build()),
                ("bad.txt", "bkt") => MockResponse::Output(HeadObjectOutput::builder().content_length(1).build()),
                _ => MockResponse::Error(HeadObjectError::NotFound(NotFound::builder().build())),
            }
        });
        let put = mock!(Client::put_object).then_output(|| PutObjectOutput::builder().build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&verify, &put]);
        let req = request(local(root.path()), bucket("bkt", ""), vec![top("ok.txt", false), top("bad.txt", false)], Mode::Move);
        // ok.txt and bad.txt "exist" per the table, so overwrite them: the point is the verify step
        let report = run_transfer(Some(&client), &req, &Resolutions::all(ConflictPolicy::Overwrite)).await.unwrap();
        assert!(!root.path().join("ok.txt").exists(), "verified item is removed");
        assert!(root.path().join("bad.txt").exists(), "unverified item is kept");
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].message.contains("verify"), "{}", failure_text(&report));
        assert_eq!(report.sources_removed, 1);
    }

    // ---- download ----

    #[tokio::test]
    async fn download_expands_a_folder_with_its_marker_and_nested_keys() {
        let root = tempfile::tempdir().unwrap();
        let list = list_table(&[("bkt/logs/d/", &[("logs/d/", 0), ("logs/d/a.txt", 5), ("logs/d/sub/b.txt", 5)])]);
        let head = head_table(&[("bkt/logs/d/a.txt", 5), ("bkt/logs/d/sub/b.txt", 5)]);
        let get = mock!(Client::get_object).then_compute_output(|_| GetObjectOutput::builder().body(ByteStream::from_static(b"hello")).build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&list, &head, &get]);
        let req = request(bucket("bkt", "logs/"), local(root.path()), vec![top("d", true)], Mode::Copy);
        let summary = plan_transfer(Some(&client), &req).await.unwrap();
        assert_eq!((summary.files, summary.dirs, summary.total_bytes), (2, 1, 10));
        let report = run_transfer(Some(&client), &req, &Resolutions::all(ConflictPolicy::Overwrite)).await.unwrap();
        assert!(report.failed.is_empty(), "{}", failure_text(&report));
        assert_eq!(fs::read_to_string(root.path().join("d/sub/b.txt")).unwrap(), "hello");
        assert_eq!(fs::read_to_string(root.path().join("d/a.txt")).unwrap(), "hello");
    }

    // ---- server to server ----

    #[tokio::test]
    async fn server_move_of_a_folder_copies_every_key_then_deletes_them_in_one_batch() {
        let list = list_table(&[("b/dir/", &[("dir/", 0), ("dir/a", 3), ("dir/n/c", 4)])]);
        let head = head_table(&[("c/dir/a", 3), ("c/dir/n/c", 4)]);
        let copy = copy_ok();
        let (delete, deleted) = delete_recorder();
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&list, &head, &copy, &delete]);
        // the head table also answers the destination probe, so the plan must be probed as empty first:
        // use Overwrite, conflicts are irrelevant here
        let req = request(bucket("b", ""), bucket("c", ""), vec![top("dir", true)], Mode::Move);
        let report = run_transfer(Some(&client), &req, &Resolutions::all(ConflictPolicy::Overwrite)).await.unwrap();
        assert!(report.failed.is_empty(), "{}", failure_text(&report));
        assert_eq!(copy.num_calls(), 3, "files and the folder marker are copied server side");
        let deleted = deleted.lock().unwrap();
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].0, "b");
        let mut keys = deleted[0].1.clone();
        keys.sort();
        assert_eq!(keys, ["dir/", "dir/a", "dir/n/c"], "marker included");
        assert_eq!(report.sources_removed, 3);
    }

    #[tokio::test]
    async fn server_move_keeps_the_source_when_the_copy_fails() {
        let head = head_table(&[("b/f.txt", 3)]);
        let copy = mock!(Client::copy_object).then_error(|| CopyObjectError::unhandled("boom"));
        let (delete, deleted) = delete_recorder();
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &copy, &delete]);
        let req = request(bucket("b", ""), bucket("c", ""), vec![top("f.txt", false)], Mode::Move);
        let report = run_transfer(Some(&client), &req, &Resolutions::all(ConflictPolicy::Overwrite)).await.unwrap();
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].name, "b/f.txt");
        assert_eq!((delete.num_calls(), deleted.lock().unwrap().len(), report.sources_removed), (0, 0, 0));
    }

    #[tokio::test]
    async fn server_move_keeps_the_source_when_the_destination_size_differs() {
        let head = head_table(&[("b/f.txt", 3), ("c/f.txt", 99)]);
        let copy = copy_ok();
        let (delete, _) = delete_recorder();
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &copy, &delete]);
        let req = request(bucket("b", ""), bucket("c", ""), vec![top("f.txt", false)], Mode::Move);
        let report = run_transfer(Some(&client), &req, &Resolutions::all(ConflictPolicy::Overwrite)).await.unwrap();
        assert_eq!((copy.num_calls(), delete.num_calls()), (1, 0));
        assert!(report.failed[0].message.contains("verify"), "{}", failure_text(&report));
    }

    #[tokio::test]
    async fn server_copy_skip_and_keep_both_probe_the_destination() {
        let head = head_table(&[("b/f.txt", 3), ("c/f.txt", 3), ("c/f (1).txt", 3)]);
        let copied_to = Arc::new(Mutex::new(Vec::new()));
        let sink = copied_to.clone();
        let copy = mock!(Client::copy_object).then_compute_output(move |req| {
            sink.lock().unwrap().push(req.key().unwrap_or_default().to_string());
            CopyObjectOutput::builder().build()
        });
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &copy]);
        let req = request(bucket("b", ""), bucket("c", ""), vec![top("f.txt", false)], Mode::Copy);
        assert_eq!(plan_transfer(Some(&client), &req).await.unwrap().conflicts[0].dest, "c/f.txt");
        let skipped = run_transfer(Some(&client), &req, &Resolutions::all(ConflictPolicy::Skip)).await.unwrap();
        assert_eq!((skipped.skipped, copy.num_calls()), (1, 0));
        run_transfer(Some(&client), &req, &Resolutions::all(ConflictPolicy::KeepBoth)).await.unwrap();
        assert_eq!(*copied_to.lock().unwrap(), ["f (2).txt"], "the existing (1) is probed and avoided");
    }

    // ---- delete, new folder, rename ----

    #[tokio::test]
    async fn server_delete_of_a_folder_includes_the_marker_and_is_batched() {
        let many: Vec<(String, i64)> = (0..1500).map(|index| (format!("x/k{index}"), 1)).collect();
        let mut keys: Vec<(&str, i64)> = vec![("x/", 0)];
        keys.extend(many.iter().map(|(key, size)| (key.as_str(), *size)));
        let list = list_table(&[("b/x/", &keys)]);
        let (delete, deleted) = delete_recorder();
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&list, &delete]);
        let report = delete_items(Some(&client), &FakeTrash::default(), &bucket("b", ""), &[top("x", true), top("single.txt", false)]).await.unwrap();
        assert!(report.failed.is_empty());
        assert_eq!(report.deleted, 1502);
        let deleted = deleted.lock().unwrap();
        assert_eq!(deleted.iter().map(|(_, keys)| keys.len()).collect::<Vec<_>>(), [1000, 502]);
        assert!(deleted.iter().any(|(_, keys)| keys.contains(&"x/".to_string())));
        assert!(deleted.iter().any(|(_, keys)| keys.contains(&"single.txt".to_string())));
    }

    #[tokio::test]
    async fn local_delete_goes_through_the_injected_trash() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "1").unwrap();
        let trash = FakeTrash::default();
        let report = delete_items(None, &trash, &local(root.path()), &[top("a.txt", false)]).await.unwrap();
        assert_eq!(report.deleted, 1);
        assert_eq!(trash.0.lock().unwrap().len(), 1);
        assert!(root.path().join("a.txt").exists(), "the fake trash does not delete");
    }

    #[tokio::test]
    async fn new_folder_writes_a_zero_byte_object_with_a_trailing_slash() {
        let put = mock!(Client::put_object)
            .match_requests(|req| req.bucket() == Some("b") && req.key() == Some("p/new/") && req.content_length().unwrap_or(0) == 0)
            .then_output(|| PutObjectOutput::builder().build());
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&put]);
        new_folder(Some(&client), &bucket("b", "p/"), "new").await.unwrap();
        assert_eq!(put.num_calls(), 1);
        assert!(new_folder(Some(&client), &bucket("b", "p/"), "a/b").await.is_err());
        let root = tempfile::tempdir().unwrap();
        new_folder(None, &local(root.path()), "made").await.unwrap();
        assert!(root.path().join("made").is_dir());
    }

    #[tokio::test]
    async fn server_folder_rename_copies_every_key_then_deletes_the_old_ones() {
        let list = list_table(&[("b/p/old/", &[("p/old/", 0), ("p/old/a", 2), ("p/old/n/b", 3)])]);
        let head = head_table(&[("b/p/old/a", 2), ("b/p/old/n/b", 3), ("b/p/new/a", 2), ("b/p/new/n/b", 3)]);
        let copied = Arc::new(Mutex::new(Vec::new()));
        let sink = copied.clone();
        let copy = mock!(Client::copy_object).then_compute_output(move |req| {
            sink.lock().unwrap().push((req.copy_source().unwrap_or_default().to_string(), req.key().unwrap_or_default().to_string()));
            CopyObjectOutput::builder().build()
        });
        let (delete, deleted) = delete_recorder();
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&list, &head, &copy, &delete]);
        let report = rename_item(Some(&client), &bucket("b", "p/"), &top("old", true), "new").await.unwrap();
        assert!(report.failed.is_empty(), "{}", failure_text(&report));
        let mut pairs = copied.lock().unwrap().clone();
        pairs.sort();
        assert_eq!(
            pairs,
            [
                ("b/p/old/".to_string(), "p/new/".to_string()),
                ("b/p/old/a".to_string(), "p/new/a".to_string()),
                ("b/p/old/n/b".to_string(), "p/new/n/b".to_string()),
            ]
        );
        let mut old_keys = deleted.lock().unwrap()[0].1.clone();
        old_keys.sort();
        assert_eq!(old_keys, ["p/old/", "p/old/a", "p/old/n/b"]);
    }

    #[tokio::test]
    async fn server_rename_refuses_an_existing_destination() {
        let list = list_table(&[("b/p/new/", &[("p/new/z", 1)])]);
        let copy = copy_ok();
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&list, &copy]);
        let err = rename_item(Some(&client), &bucket("b", "p/"), &top("old", true), "new").await.unwrap_err();
        assert!(err.to_string().contains("already exists"), "{err}");
        assert_eq!(copy.num_calls(), 0);
        let head = head_table(&[("b/p/taken.txt", 1)]);
        let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, &[&head, &copy]);
        assert!(rename_item(Some(&client), &bucket("b", "p/"), &top("a.txt", false), "taken.txt").await.is_err());
    }

    #[tokio::test]
    async fn local_rename_renames_and_refuses_an_existing_name() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "a").unwrap();
        fs::write(root.path().join("b.txt"), "b").unwrap();
        let report = rename_item(None, &local(root.path()), &top("a.txt", false), "c.txt").await.unwrap();
        assert!(report.failed.is_empty());
        assert!(root.path().join("c.txt").exists() && !root.path().join("a.txt").exists());
        assert!(rename_item(None, &local(root.path()), &top("c.txt", false), "b.txt").await.is_err());
        assert!(rename_item(None, &local(root.path()), &top("c.txt", false), "bad/name").await.is_err());
    }

    #[tokio::test]
    async fn a_server_location_without_a_client_is_a_readable_error() {
        let req = request(bucket("b", ""), local(std::path::Path::new("/tmp")), vec![top("f", false)], Mode::Copy);
        let err = plan_transfer(None, &req).await.unwrap_err();
        assert!(err.to_string().contains("profile"), "{err}");
    }
}
