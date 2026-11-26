# S3 Commander — implementation plan (steps 2 to 6)

Step 1 (profiles + master-key vault) is done. Backend SDK: `aws-sdk-s3`. Target: MinIO, macOS and Linux. Each step is its own branch cut from `main`, TDD (red, green, refactor), then user review before a squash merge. Offline demo: `docs/artifact/2026-11-26-s3-commander-demo.html`.

Common client setup (step 2 owns it): one `aws_sdk_s3::Client` per unlocked profile, built from `endpoint_url`, `force_path_style(true)`, the profile region, static credentials from `Vault::get_profile`, and request checksums sent only when required (older MinIO rejects the default). The client is dropped on lock or profile switch. Buckets are passed per request, so one client serves every bucket of a profile.

## Step 2 — Browse (client, buckets, listing, dual-pane UI)

- Each panel has a source: a bucket of the selected profile (SERVER) or the local file system (LOCAL). Local listing is a Rust `local` module over `std::fs` behind `local_list_dir(path)`; the frontend never touches the file system directly, so no Tauri fs-plugin scope is needed. Hidden files and permission errors are shown, not skipped silently.
- Rust `s3` module (no Tauri dependency): build client from a profile, `list_buckets`, `list_dir(bucket, prefix, continuation)` using `delimiter="/"` so prefixes become directories; map SDK errors to one app error type the UI can show.
- Tauri commands: `s3_list_buckets(profile_id)`, `s3_list_dir(profile_id, bucket, prefix, token)`; profile commands already fail when locked.
- Frontend: replace the profile screen as the main view with the dual-pane layout from the demo (two panels, bucket selector per panel, columns Name/Ext/Size/Date, keyboard navigation, function-key bar disabled for not-yet-built actions). Virtualise long lists.
- Panel state (source, bucket, path, cursor, marked items, active panel, scroll position) lives in a small Zustand store, outside the React tree, so it survives switching between views (profile list, browser, dialogs) and remounting. One slice per panel, components subscribe with selectors so a change in one panel does not re-render the other. Only the S3 side resets when the active profile changes or the app locks; the Local panel keeps its state. Never store secrets in this store (the secret key stays in Rust).
- Profile management: add, edit, delete exist from step 1. Step 2 adds a profile switcher in the top bar (as in the demo), `profile_test(profile_id)` (calls `list_buckets` and reports success or the mapped error) and `profile_duplicate`. Switching rebuilds the S3 client and resets only the S3 panels (see state above); the profile list never shows secrets.
- One profile is active at a time: a panel is either LOCAL or a bucket of that active profile.
- Tests: client config unit tests (path style, endpoint, checksum setting); listing and pagination logic against mocked SDK responses (no network). MinIO integration test only after the user confirms the target.
- Done when: both panels browse buckets and prefixes of the selected profile, pagination works past 1000 keys, switching profile rebuilds the client.

## Step 3 — Transfers, drag and drop, context menu, Copy, Move, Delete, Rename, New folder

- One transfer planner covers every direction: local to server (upload), server to local (download), server to server within the active profile (copy), local to local (copy). It builds the list of keys or files first (a folder expands to every entry under it), then runs it; the UI names the action by direction (Upload, Download, Copy, Move).
- Drag and drop inside the app (HTML5 drag between the two panels): plain drop copies, Shift moves, dropping on a folder row goes inside that folder, dropping on a folder of the same panel moves. Dropping a folder onto itself or its own child is refused.
- Drop from the OS file manager onto a server panel (Finder, Files): uses Tauri's window drag-drop event, which gives real paths, so files and folders upload with their structure. Dragging a server item out to the OS file manager is not supported by the webview; use Download to a Local panel or the context menu instead.
- Right-click context menu on a row: Open, View, Edit, Copy/Upload/Download to other panel, Move to other panel, Rename, Delete, Copy presigned URL (server items, step 3d), New folder (on empty space only New folder). Right-click on an unmarked row selects just that row; on a marked row it acts on all marked rows. Same actions have keys (Enter, F3 to F8, F2 for Rename).
- Rename: server = copy then delete of the key, for a folder every key under the prefix, with a conflict check; local = `std::fs::rename`.
- Local delete goes to the OS trash (not permanent) by default; server delete is permanent after the confirm dialog.

- Copy within a profile: `CopyObject`; objects over the single-copy limit use multipart `UploadPartCopy`. Panels never span two profiles, so there is no cross-profile copy.
- Move = copy, verify, delete source. Folder operations list the prefix first, then act per key; delete uses `DeleteObjects` in batches of 1000.
- New folder = zero-byte object with a trailing `/` key (the convention MinIO's console uses).
- Conflict handling (3a, as built): decided per item with Overwrite, Skip, Keep both and the "all" variants plus Cancel (Total Commander style), from a resolution map plus an optional default; nothing runs before all conflicts are resolved.
- Tests: key-mapping and batching logic with mocks; direction matrix of the planner (4 directions, file and folder, conflict); drop-target rules (copy, move, into folder, into itself refused); a dry-run plan builder (what would be copied or deleted) unit-tested before any real call.

## Step 3e — Sorting in the panels

- Click a column header (Name, Ext, Size, Date) to sort the panel; click again to reverse; an arrow shows the active column and direction. Each panel keeps its own sort in the Zustand panel slice, so it survives switching views and source changes (reset to Name ascending only when the panel is first created; not persisted across app restarts for now).
- Rules: the ".." row is always first; folders stay above files in every sort (the Total Commander default), and a folder is sorted by name only (a folder has no size or date); Name and Ext compare case-insensitively with natural number order (`file2` before `file10`); ties fall back to Name ascending so the order is stable.
- One pure comparator module with tests (all four keys, both directions, natural numbers, mixed case, folders versus files, ties, empty ext, ".."), used by the panel list and applied after every listing change, mark or refresh without moving the cursor off its item (the cursor follows the item by name).
- Server listings are paginated: a sort by Size or Date, or the natural Name order, only covers the pages loaded so far and rows can move when the next page arrives. Show a small "sorted over loaded items" hint while more pages remain, with an action to load every remaining page (capped, with the count shown) so the sort becomes complete. Local listings are always complete.
- Keyboard: the sort has no function-key slot yet; a "Sort by" entry (Name, Ext, Size, Date, Reverse) goes into the empty-area context menu of step 3c once both exist.
- Tests: comparator as above; store keeps the sort per panel and across source switches; cursor stays on the same item after a re-sort; header click cycles ascending then descending.

## Step 3d — Presigned URLs (one file or many)

- Rust `presign` module over `aws-sdk-s3` `PresigningConfig` (a local computation with the profile's static credentials, no request is sent): `presign_get(bucket, key, expires_in)` for one object and a batch variant for many; command `presign_urls(profile_id, bucket, keys, expires_secs)`.
- Selection: one file, or the marked files of a SERVER panel. Folders are expanded to every key under the prefix after showing the object count and asking for confirmation (a large expansion is capped with a clear message). Local panels have nothing to presign.
- Expiry choice in the dialog: presets (15 minutes, 1 hour, 1 day, 7 days) plus a custom value; the maximum is 7 days (the SigV4 limit); default 1 hour. The URL uses the profile endpoint and addressing style, so it must be reachable from where it will be opened (say so in the dialog).
- Result dialog: the URL list with name and expiry time, "Copy" for one, "Copy all" (one URL per line) and "Save as text file" for many. A short warning that anyone holding a URL can read the object until it expires. URLs are shown and copied only: never logged, never stored in the vault or the store beyond the open dialog.
- Entry points: F-key bar (a free key or a modifier combination, decided with the UI), and "Copy presigned URL" in the right-click menu of step 3c.
- Optional field `download_filename`: sets `response-content-disposition` so the browser saves the object under a readable name.
- Tests: presigning against fixed credentials, time and region gives a stable URL shape (host, path style, `X-Amz-Expires`, `X-Amz-SignedHeaders`); expiry bounds (0 and over 7 days rejected); batch order and per-key errors; folder expansion cap; the secret key never appears in any URL or error. No network.
- Out of scope for now: presigned PUT (upload) URLs and POST policies.

## Step 4 — Large upload and download with progress

- Per-profile transfer settings, modelled on the AWS CLI `s3` configuration (`aws configure set s3.multipart_threshold 100MB --profile <name>`), stored in the vault profile (new optional fields with serde defaults so existing vaults still load) and edited in a "Transfer settings" section of the profile form:
  - `multipart_threshold`: objects at or above this size upload as multipart; below it, a single PutObject.
  - `multipart_chunksize`: part size; raised automatically when needed so the object fits in 10,000 parts; minimum 5 MiB (S3 rule).
  - `max_concurrent_requests`: parallel parts and parallel items.
  - `addressing_style`: `path` (default for MinIO), `virtual` or `auto`; today path style is forced.
  - Size values accept AWS-CLI-style strings (`100MB`, `8MB`, `1GB`; suffixes are 1024-based like the AWS CLI) or plain bytes; invalid values and `threshold < chunksize` combinations are rejected by the same validation as the other profile fields. AWS CLI defaults apply when unset (8MB, 8MB, 10).
  - Import from an existing AWS CLI profile (button "Import from AWS CLI" in the profile form), only on explicit user action:
    - Rust commands `aws_config_list_profiles` (names only) and `aws_config_read_profile(name)`; the file is `~/.aws/config`, or the path in `AWS_CONFIG_FILE` when set. The frontend never reads the file.
    - Parses the INI sections (`[default]`, `[profile <name>]`) including the nested form that `aws configure set s3.<key> <value> --profile <name>` writes (an `s3 =` line followed by indented `key = value` lines).
    - Imports only non-secret keys: the four transfer settings above, plus `region` and `endpoint_url` (also `services`-less `s3`-specific `endpoint_url` when present) as form prefill. It never reads `~/.aws/credentials` and ignores `aws_access_key_id`, `aws_secret_access_key`, `aws_session_token` and every other key, so no secret passes through this path.
    - The import fills the form as a preview the user can edit before saving; values go through the same validation, so a bad value is flagged instead of saved. Unknown keys are ignored; a missing file or profile gives a clear message.
    - Tests use tempdir config files with fake names only; no test reads the real home directory.
- Upload: multipart with parallel parts; the part size, threshold and concurrency come from the profile settings above (defaults to be measured and tuned). Progress per part through Tauri events, Cancel calls `AbortMultipartUpload`, failed part retries, resume by listing uploaded parts.
- Download: ranged `GetObject` streamed to disk through a temp file, then renamed.
- UI: a transfer queue with per-item progress, cancel and retry (the demo shows the single-operation dialog).
- Tests: part-splitting and resume logic as pure functions; failure injection with mocks.

## Step 5 — View and Edit (F3/F4)

- View: text files below a size cap shown in-app, other files downloaded to the app cache dir and opened with the system viewer.
- Edit: download, edit, upload to replace the object; detect that the object changed remotely (ETag) before overwriting.
- Temp files live in the app cache dir and are removed on lock.

## Step 6 — Hardening and multi-OS

- Auto-lock after idle, brute-force throttle on unlock, tune Argon2 parameters on the slowest target machine, avoid keeping the master key string longer than the call.
- Optional "remember on this device" through the OS keychain (`keyring` crate), off by default, with a silent fallback to the master-key prompt when no keychain exists (common on minimal Linux setups). This needs the vault to use a random data key wrapped by the master-key-derived key.
- Linux build needs the system WebKitGTK libraries; document the package list in `docs/claude/commands.md` when the first Linux build is made. macOS distribution needs signing and notarization.
- CI matrix for macOS and Linux (`cargo test`, `npm run build`).

## Open questions

- Local delete: OS trash (default) or permanent?

## Out of scope for now

- Copy between two different profiles or servers.
- Create and delete bucket from the app (later).
