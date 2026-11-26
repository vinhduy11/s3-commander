//! Pure transfer planning: no Tauri, no SDK, no file system. Callers gather what exists
//! (`Found` entries under the selected items, and which destinations already exist); this module
//! maps names and keys, validates, detects conflicts, applies the conflict policy and summarises.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::app_error::AppError;

/// How many keys one DeleteObjects call may carry.
pub const DELETE_BATCH_SIZE: usize = 1000;

/// A directory: an absolute local path, or a bucket key prefix ("" or "a/b/").
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Location {
    Local { path: String },
    Bucket { bucket: String, prefix: String },
}

/// One concrete file, directory or object.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ItemRef {
    Local(PathBuf),
    Object { bucket: String, key: String },
}

impl ItemRef {
    /// Text for messages: the path, or `bucket/key`.
    pub fn label(&self) -> String {
        match self {
            ItemRef::Local(path) => path.to_string_lossy().into_owned(),
            ItemRef::Object { bucket, key } => format!("{bucket}/{key}"),
        }
    }

    fn file_name(&self) -> String {
        match self {
            ItemRef::Local(path) => path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
            ItemRef::Object { key, .. } => key.trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_string(),
        }
    }

    fn with_file_name(&self, new_name: &str) -> ItemRef {
        match self {
            ItemRef::Local(path) => ItemRef::Local(path.with_file_name(new_name)),
            ItemRef::Object { bucket, key } => {
                let cut = key.rfind('/').map_or(0, |at| at + 1);
                ItemRef::Object { bucket: bucket.clone(), key: format!("{}{new_name}", &key[..cut]) }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Copy,
    Move,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    Overwrite,
    Skip,
    KeepBoth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Upload,
    Download,
    ServerCopy,
    LocalCopy,
}

/// A selected entry of the source directory. `dest_name` renames it at the destination.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopItem {
    pub name: String,
    pub is_dir: bool,
    #[serde(default)]
    pub dest_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferRequest {
    pub source: Location,
    pub dest: Location,
    pub items: Vec<TopItem>,
    pub mode: Mode,
}

/// Something found under a selected item. `rel` is relative to the source directory and starts
/// with the selected item's name, "/"-separated, without a trailing slash. A directory entry means
/// an empty directory (or a server folder marker) that must exist at the destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub rel: String,
    pub size: u64,
    pub is_dir: bool,
    /// Seconds since the Unix epoch, when known (shown in the conflict dialog).
    pub modified: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanItem {
    pub src: ItemRef,
    pub dst: ItemRef,
    pub size: u64,
    pub is_dir: bool,
    pub modified: Option<i64>,
    pub skip: bool,
}

/// An item that could not be processed, with a readable reason. Never swallowed: shown to the user.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ItemFailure {
    pub name: String,
    pub message: String,
}

/// What is already at a destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExistingInfo {
    pub size: u64,
    pub modified: Option<i64>,
}

/// One conflict as the dialog shows it. `dest` is the key the resolution map uses.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ConflictInfo {
    pub dest: String,
    pub incoming_size: u64,
    pub incoming_modified: Option<i64>,
    pub existing_size: Option<u64>,
    pub existing_modified: Option<i64>,
}

/// Decisions for the conflicts of one operation: a choice per destination (`ItemRef::label`), and
/// an optional default for the rest (the "all" buttons are just this default).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resolutions {
    #[serde(default)]
    pub per_item: HashMap<String, ConflictPolicy>,
    #[serde(default)]
    pub default: Option<ConflictPolicy>,
}

impl Resolutions {
    pub fn all(policy: ConflictPolicy) -> Self {
        Resolutions { per_item: HashMap::new(), default: Some(policy) }
    }
}

#[derive(Debug, Serialize, PartialEq)]
pub struct PlanSummary {
    pub direction: Direction,
    pub files: usize,
    pub dirs: usize,
    pub total_bytes: u64,
    pub conflict_count: usize,
    /// Every conflict, in plan order, with both sides' size and date for the per-item dialog.
    pub conflicts: Vec<ConflictInfo>,
}

pub fn direction(source: &Location, dest: &Location) -> Direction {
    match (source, dest) {
        (Location::Local { .. }, Location::Bucket { .. }) => Direction::Upload,
        (Location::Bucket { .. }, Location::Local { .. }) => Direction::Download,
        (Location::Bucket { .. }, Location::Bucket { .. }) => Direction::ServerCopy,
        (Location::Local { .. }, Location::Local { .. }) => Direction::LocalCopy,
    }
}

/// The item `rel` under `location`; a bucket directory gets the trailing "/" of a folder marker.
pub fn location_ref(location: &Location, rel: &str, is_dir: bool) -> ItemRef {
    match location {
        Location::Local { path } => ItemRef::Local(PathBuf::from(path).join(rel)),
        Location::Bucket { bucket, prefix } => ItemRef::Object {
            bucket: bucket.clone(),
            key: format!("{prefix}{rel}{}", if is_dir { "/" } else { "" }),
        },
    }
}

pub fn format_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    let amount = bytes as f64;
    if amount < KIB {
        format!("{bytes} B")
    } else if amount < KIB * KIB {
        format!("{:.1} KiB", amount / KIB)
    } else if amount < KIB * KIB * KIB {
        format!("{:.1} MiB", amount / (KIB * KIB))
    } else {
        format!("{:.2} GiB", amount / (KIB * KIB * KIB))
    }
}

/// Refuse a copy or move onto itself or into its own subtree. A rename (a `dest_name` that differs
/// from the name) in the same directory is allowed.
pub fn check_destination(request: &TransferRequest) -> Result<(), AppError> {
    if request.items.is_empty() {
        return Err(AppError::Local("nothing selected".into()));
    }
    for item in &request.items {
        let target_name = item.dest_name.as_deref().unwrap_or(&item.name);
        if request.source == request.dest && target_name == item.name {
            return Err(AppError::Local(format!("source and destination are the same: {}", item.name)));
        }
        if item.is_dir && is_inside(&request.source, &item.name, &request.dest) {
            return Err(AppError::Local(format!("cannot put a folder into itself: {}", item.name)));
        }
    }
    Ok(())
}

/// Is `dest` the directory `source/name` or below it (same bucket for server locations)?
fn is_inside(source: &Location, name: &str, dest: &Location) -> bool {
    match (source, dest) {
        (Location::Local { path: source_path }, Location::Local { path: dest_path }) => {
            PathBuf::from(dest_path).starts_with(PathBuf::from(source_path).join(name))
        }
        (Location::Bucket { bucket: source_bucket, prefix: source_prefix }, Location::Bucket { bucket, prefix }) => {
            source_bucket == bucket && prefix.starts_with(&format!("{source_prefix}{name}/"))
        }
        _ => false,
    }
}

fn destination_rel(rel: &str, items: &[TopItem]) -> String {
    let (top, rest) = rel.split_once('/').map_or((rel, None), |(top, rest)| (top, Some(rest)));
    let renamed = items.iter().find(|item| item.name == top).and_then(|item| item.dest_name.as_deref()).unwrap_or(top);
    match rest {
        Some(rest) => format!("{renamed}/{rest}"),
        None => renamed.to_string(),
    }
}

pub fn build_plan(request: &TransferRequest, found: &[Found]) -> Vec<PlanItem> {
    found
        .iter()
        .map(|entry| PlanItem {
            src: location_ref(&request.source, &entry.rel, entry.is_dir),
            dst: location_ref(&request.dest, &destination_rel(&entry.rel, &request.items), entry.is_dir),
            size: entry.size,
            is_dir: entry.is_dir,
            modified: entry.modified,
            skip: false,
        })
        .collect()
}

/// Indices of file items whose destination already exists. Directories merge and never conflict.
pub fn find_conflicts(plan: &[PlanItem], existing: &HashSet<ItemRef>) -> Vec<usize> {
    plan.iter()
        .enumerate()
        .filter(|(_, item)| !item.is_dir && existing.contains(&item.dst))
        .map(|(index, _)| index)
        .collect()
}

/// "name.ext" becomes "name (1).ext", then "name (2).ext", until `is_taken` says the name is free.
/// A leading dot is not an extension (".env" becomes ".env (1)").
pub fn auto_rename(name: &str, is_taken: &dyn Fn(&str) -> bool) -> String {
    let (base, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    (1..)
        .map(|counter| format!("{base} ({counter}){extension}"))
        .find(|candidate| !is_taken(candidate))
        .expect("an unbounded counter always finds a free name")
}

/// Apply the decisions to the conflicting items: overwrite keeps the plan, skip marks them
/// skipped, keep-both gives their destinations a free "name (n).ext". A conflict with neither a
/// per-item decision nor a default is an error, so nothing runs before every conflict is resolved.
pub fn apply_resolutions(
    mut plan: Vec<PlanItem>,
    existing: &HashSet<ItemRef>,
    resolutions: &Resolutions,
) -> Result<Vec<PlanItem>, AppError> {
    let conflicts = find_conflicts(&plan, existing);
    let mut chosen = Vec::with_capacity(conflicts.len());
    for &index in &conflicts {
        let label = plan[index].dst.label();
        let policy = resolutions.per_item.get(&label).copied().or(resolutions.default);
        chosen.push(policy.ok_or_else(|| AppError::Local(format!("conflict not resolved: {label}")))?);
    }
    let mut taken: HashSet<ItemRef> = existing.clone();
    taken.extend(plan.iter().map(|item| item.dst.clone()));
    for (&index, policy) in conflicts.iter().zip(chosen) {
        match policy {
            ConflictPolicy::Overwrite => {}
            ConflictPolicy::Skip => plan[index].skip = true,
            ConflictPolicy::KeepBoth => {
                let current = plan[index].dst.clone();
                let renamed_name = auto_rename(&current.file_name(), &|candidate| taken.contains(&current.with_file_name(candidate)));
                let renamed = current.with_file_name(&renamed_name);
                taken.insert(renamed.clone());
                plan[index].dst = renamed;
            }
        }
    }
    Ok(plan)
}

/// One decision for every conflict.
pub fn apply_policy(plan: Vec<PlanItem>, existing: &HashSet<ItemRef>, policy: ConflictPolicy) -> Vec<PlanItem> {
    apply_resolutions(plan, existing, &Resolutions::all(policy)).expect("a default resolves every conflict")
}

pub fn summarize(
    request: &TransferRequest,
    plan: &[PlanItem],
    existing: &HashSet<ItemRef>,
    details: &HashMap<ItemRef, ExistingInfo>,
) -> PlanSummary {
    let way = direction(&request.source, &request.dest);
    let conflicts = find_conflicts(plan, existing);
    PlanSummary {
        direction: way,
        files: plan.iter().filter(|item| !item.is_dir).count(),
        dirs: plan.iter().filter(|item| item.is_dir).count(),
        total_bytes: plan.iter().map(|item| item.size).sum(),
        conflict_count: conflicts.len(),
        conflicts: conflicts
            .iter()
            .map(|&index| {
                let item = &plan[index];
                let found = details.get(&item.dst);
                ConflictInfo {
                    dest: item.dst.label(),
                    incoming_size: item.size,
                    incoming_modified: item.modified,
                    existing_size: found.map(|info| info.size),
                    existing_modified: found.and_then(|info| info.modified),
                }
            })
            .collect(),
    }
}

/// Split keys into DeleteObjects batches of at most `DELETE_BATCH_SIZE`.
pub fn delete_batches(keys: &[String]) -> Vec<&[String]> {
    keys.chunks(DELETE_BATCH_SIZE).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(path: &str) -> Location {
        Location::Local { path: path.into() }
    }
    fn bucket(name: &str, prefix: &str) -> Location {
        Location::Bucket { bucket: name.into(), prefix: prefix.into() }
    }
    fn top(name: &str, is_dir: bool) -> TopItem {
        TopItem { name: name.into(), is_dir, dest_name: None }
    }
    fn request(source: Location, dest: Location, items: Vec<TopItem>) -> TransferRequest {
        TransferRequest { source, dest, items, mode: Mode::Copy }
    }
    fn file(rel: &str, size: u64) -> Found {
        Found { rel: rel.into(), size, is_dir: false, modified: Some(100) }
    }
    fn folder(rel: &str) -> Found {
        Found { rel: rel.into(), size: 0, is_dir: true, modified: None }
    }
    fn object(bucket_name: &str, key: &str) -> ItemRef {
        ItemRef::Object { bucket: bucket_name.into(), key: key.into() }
    }

    #[test]
    fn direction_matrix_covers_all_four_pairs() {
        assert_eq!(direction(&local("/a"), &bucket("b", "")), Direction::Upload);
        assert_eq!(direction(&bucket("b", ""), &local("/a")), Direction::Download);
        assert_eq!(direction(&bucket("b", "x/"), &bucket("c", "")), Direction::ServerCopy);
        assert_eq!(direction(&local("/a"), &local("/b")), Direction::LocalCopy);
    }

    #[test]
    fn plan_upload_maps_files_and_nested_folders_to_keys() {
        let req = request(local("/src"), bucket("bkt", "in/"), vec![top("a.txt", false), top("photos", true)]);
        let found = [file("a.txt", 3), file("photos/1.jpg", 10), file("photos/sub/2.jpg", 20), folder("photos/empty")];
        let plan = build_plan(&req, &found);
        let dsts: Vec<_> = plan.iter().map(|item| item.dst.clone()).collect();
        assert_eq!(
            dsts,
            vec![
                object("bkt", "in/a.txt"),
                object("bkt", "in/photos/1.jpg"),
                object("bkt", "in/photos/sub/2.jpg"),
                object("bkt", "in/photos/empty/"),
            ]
        );
        assert_eq!(plan[1].src, ItemRef::Local("/src/photos/1.jpg".into()));
        assert!(plan[3].is_dir);
    }

    #[test]
    fn plan_download_maps_keys_to_local_paths() {
        let req = request(bucket("bkt", "logs/"), local("/dl"), vec![top("2026", true)]);
        let plan = build_plan(&req, &[file("2026/jan/a.log", 5), folder("2026")]);
        assert_eq!(plan[0].src, object("bkt", "logs/2026/jan/a.log"));
        assert_eq!(plan[0].dst, ItemRef::Local("/dl/2026/jan/a.log".into()));
        // the folder marker "logs/2026/" becomes the directory itself
        assert_eq!(plan[1].src, object("bkt", "logs/2026/"));
        assert_eq!(plan[1].dst, ItemRef::Local("/dl/2026".into()));
    }

    #[test]
    fn plan_server_copy_across_buckets_and_local_copy() {
        let across = request(bucket("one", "a/"), bucket("two", ""), vec![top("f.bin", false)]);
        let plan = build_plan(&across, &[file("f.bin", 7)]);
        assert_eq!((plan[0].src.clone(), plan[0].dst.clone()), (object("one", "a/f.bin"), object("two", "f.bin")));
        let copy = request(local("/x"), local("/y"), vec![top("d", true)]);
        let plan = build_plan(&copy, &[file("d/f", 1), folder("d/empty")]);
        assert_eq!(plan[0].dst, ItemRef::Local("/y/d/f".into()));
        assert_eq!(plan[1].dst, ItemRef::Local("/y/d/empty".into()));
    }

    #[test]
    fn empty_folder_alone_is_one_directory_item() {
        let req = request(local("/x"), bucket("b", "p/"), vec![top("hollow", true)]);
        let plan = build_plan(&req, &[folder("hollow")]);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].dst, object("b", "p/hollow/"));
    }

    #[test]
    fn dest_name_renames_the_top_level_only() {
        let mut item = top("old", true);
        item.dest_name = Some("new".into());
        let req = request(bucket("b", "p/"), bucket("b", "p/"), vec![item]);
        let plan = build_plan(&req, &[file("old/a/old.txt", 1), folder("old")]);
        assert_eq!(plan[0].dst, object("b", "p/new/a/old.txt"));
        assert_eq!(plan[1].dst, object("b", "p/new/"));
    }

    #[test]
    fn same_directory_copy_and_folder_into_itself_are_refused() {
        let same = request(local("/a"), local("/a"), vec![top("f", false)]);
        assert!(check_destination(&same).unwrap_err().to_string().contains("same"));
        let into_child = request(local("/a"), local("/a/dir/sub"), vec![top("dir", true)]);
        assert!(check_destination(&into_child).unwrap_err().to_string().contains("into itself"));
        let server_child = request(bucket("b", "x/"), bucket("b", "x/dir/deep/"), vec![top("dir", true)]);
        assert!(check_destination(&server_child).is_err());
        let sibling = request(local("/a"), local("/a/dir2"), vec![top("dir", true)]);
        assert!(check_destination(&sibling).is_ok());
        let other_bucket = request(bucket("b", ""), bucket("c", "dir/"), vec![top("dir", true)]);
        assert!(check_destination(&other_bucket).is_ok());
        let mut renamed = top("f", false);
        renamed.dest_name = Some("g".into());
        assert!(check_destination(&request(local("/a"), local("/a"), vec![renamed])).is_ok());
        assert!(check_destination(&request(local("/a"), local("/b"), vec![])).is_err());
    }

    fn two_file_plan() -> (Vec<PlanItem>, HashSet<ItemRef>) {
        let req = request(local("/s"), bucket("b", ""), vec![top("a.txt", false), top("b.txt", false)]);
        let plan = build_plan(&req, &[file("a.txt", 1), file("b.txt", 2)]);
        let existing = HashSet::from([object("b", "a.txt")]);
        (plan, existing)
    }

    #[test]
    fn conflicts_are_detected_before_running_and_dirs_never_conflict() {
        let (plan, existing) = two_file_plan();
        assert_eq!(find_conflicts(&plan, &existing), vec![0]);
        let dir_plan = build_plan(&request(local("/s"), bucket("b", ""), vec![top("d", true)]), &[folder("d")]);
        assert!(find_conflicts(&dir_plan, &HashSet::from([object("b", "d/")])).is_empty());
    }

    #[test]
    fn policy_overwrite_keeps_everything() {
        let (plan, existing) = two_file_plan();
        let applied = apply_policy(plan.clone(), &existing, ConflictPolicy::Overwrite);
        assert_eq!(applied, plan);
    }

    #[test]
    fn policy_skip_marks_only_conflicting_items() {
        let (plan, existing) = two_file_plan();
        let applied = apply_policy(plan, &existing, ConflictPolicy::Skip);
        assert_eq!(applied.iter().map(|item| item.skip).collect::<Vec<_>>(), [true, false]);
    }

    #[test]
    fn policy_keep_both_renames_to_a_free_name() {
        let (plan, mut existing) = two_file_plan();
        existing.insert(object("b", "a (1).txt"));
        let applied = apply_policy(plan, &existing, ConflictPolicy::KeepBoth);
        assert_eq!(applied[0].dst, object("b", "a (2).txt"));
        assert_eq!(applied[1].dst, object("b", "b.txt"));
        assert!(!applied[0].skip);
    }

    #[test]
    fn keep_both_inside_a_folder_and_for_local_paths() {
        let req = request(bucket("b", ""), local("/dl"), vec![top("d", true)]);
        let plan = build_plan(&req, &[file("d/x.tar.gz", 1)]);
        let existing = HashSet::from([ItemRef::Local("/dl/d/x.tar.gz".into())]);
        let applied = apply_policy(plan, &existing, ConflictPolicy::KeepBoth);
        assert_eq!(applied[0].dst, ItemRef::Local("/dl/d/x.tar (1).gz".into()));
    }

    fn three_conflicts() -> (Vec<PlanItem>, HashSet<ItemRef>) {
        let req = request(local("/s"), bucket("b", ""), vec![top("a", false), top("b", false), top("c", false)]);
        let plan = build_plan(&req, &[file("a", 1), file("b", 1), file("c", 1)]);
        (plan, HashSet::from([object("b", "a"), object("b", "b"), object("b", "c")]))
    }

    #[test]
    fn per_item_resolutions_can_mix_overwrite_skip_and_keep_both() {
        let (plan, existing) = three_conflicts();
        let resolutions = Resolutions {
            per_item: HashMap::from([
                ("b/a".to_string(), ConflictPolicy::Overwrite),
                ("b/b".to_string(), ConflictPolicy::Skip),
                ("b/c".to_string(), ConflictPolicy::KeepBoth),
            ]),
            default: None,
        };
        let applied = apply_resolutions(plan, &existing, &resolutions).unwrap();
        assert_eq!((applied[0].skip, applied[0].dst.clone()), (false, object("b", "a")));
        assert!(applied[1].skip);
        assert_eq!((applied[2].skip, applied[2].dst.clone()), (false, object("b", "c (1)")));
    }

    #[test]
    fn each_all_variant_is_just_the_default_for_unresolved_items() {
        for policy in [ConflictPolicy::Overwrite, ConflictPolicy::Skip, ConflictPolicy::KeepBoth] {
            let (plan, existing) = three_conflicts();
            // the first conflict was decided by hand (overwrite), the remaining two use the "all" default
            let resolutions = Resolutions {
                per_item: HashMap::from([("b/a".to_string(), ConflictPolicy::Overwrite)]),
                default: Some(policy),
            };
            let applied = apply_resolutions(plan, &existing, &resolutions).unwrap();
            assert!(!applied[0].skip && applied[0].dst == object("b", "a"));
            assert_eq!(applied[1].skip, policy == ConflictPolicy::Skip, "{policy:?}");
            assert_eq!(applied[2].dst != object("b", "c"), policy == ConflictPolicy::KeepBoth, "{policy:?}");
        }
    }

    #[test]
    fn an_unresolved_conflict_is_an_error_so_nothing_runs() {
        let (plan, existing) = three_conflicts();
        let partial = Resolutions { per_item: HashMap::from([("b/a".to_string(), ConflictPolicy::Skip)]), default: None };
        let err = apply_resolutions(plan.clone(), &existing, &partial).unwrap_err();
        assert!(err.to_string().contains("not resolved"), "{err}");
        assert!(apply_resolutions(plan, &HashSet::new(), &Resolutions::default()).is_ok(), "no conflicts needs no decision");
    }

    #[test]
    fn auto_rename_handles_extensions_dotfiles_and_no_extension() {
        let free = |_: &str| false;
        assert_eq!(auto_rename("name.ext", &free), "name (1).ext");
        assert_eq!(auto_rename(".env", &free), ".env (1)");
        assert_eq!(auto_rename("README", &free), "README (1)");
        let taken = |candidate: &str| candidate == "n (1).e" || candidate == "n (2).e";
        assert_eq!(auto_rename("n.e", &taken), "n (3).e");
    }

    #[test]
    fn summary_counts_size_and_conflicts_with_no_size_limit() {
        const OVER_FIVE_GIB: u64 = (5 << 30) + 1;
        let req = request(local("/s"), bucket("b", ""), vec![top("a.txt", false), top("huge", false), top("d", true)]);
        let plan = build_plan(&req, &[file("a.txt", 10), file("huge", OVER_FIVE_GIB), folder("d")]);
        let summary = summarize(&req, &plan, &HashSet::from([object("b", "a.txt")]), &HashMap::from([(object("b", "a.txt"), ExistingInfo { size: 4, modified: Some(50) })]));
        assert_eq!((summary.files, summary.dirs), (2, 1));
        assert_eq!(summary.total_bytes, 10 + OVER_FIVE_GIB);
        assert_eq!(summary.conflict_count, 1);
        assert_eq!(
            summary.conflicts,
            vec![ConflictInfo { dest: "b/a.txt".into(), incoming_size: 10, incoming_modified: Some(100), existing_size: Some(4), existing_modified: Some(50) }]
        );
    }

    #[test]
    fn delete_batches_hold_at_most_1000_keys() {
        let keys: Vec<String> = (0..2500).map(|index| format!("k{index}")).collect();
        let sizes: Vec<_> = delete_batches(&keys).iter().map(|batch| batch.len()).collect();
        assert_eq!(sizes, [1000, 1000, 500]);
        assert!(delete_batches(&[]).is_empty());
    }
}
