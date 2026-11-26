# Changelog

## [Unreleased]

### Added
- Right-click context menu on panel rows and empty panel space (also Shift+F10 / ContextMenu key): Open, Upload/Download/Copy to other panel, Move to other panel, Rename, Delete, New folder, with shortcut hints. Handlers call the same flows as the F-keys. Vitest no longer scans `.claude/` worktrees.
- Profile validation on add and edit. Rust (`profile_rules.rs`) is authoritative and returns per-field errors; the form mirrors the rules (`src/profile/validate_profile.ts`) for inline errors and a disabled Save while invalid. Rules: name required, max 64, unique case-insensitively; endpoint is an http(s) URL with a host, no user info, query, fragment or path, port 1..65535, normalized (trimmed, no trailing slash); access key without whitespace or control characters; secret required on create (blank on edit keeps the stored one), no control characters; region optional (default `us-east-1`), `[a-z0-9-]` up to 32.
- A non-blocking warning for `http://` endpoints (keys travel unencrypted) and a "Test connection" button after a successful save. Saving never checks connectivity.
- Shared test table `src/profile/validation_cases.json` used by both the Rust and the vitest tests.

### Changed
- `profile_save` now fails with `{ message, fields: [{ field, message }] }` instead of a plain string; `VaultError::Validation` replaces the old "x is required" check.

### Fixed
- Panel stuck on "Loading...": a Local listing no longer depends on the profile, so `setProfile` after `profile_list` (fresh launch) no longer drops the first Local response; a bucket source without a profile no longer sets `loading` before returning; a dropped stale response clears `loading` when no newer request owns the panel.

### Changed
- Endpoint errors now say why: an `SdkError::DispatchFailure` is classified (DNS failure, connection refused, connection timed out, TLS certificate not trusted or invalid, invalid endpoint URL) and shows a trimmed root-cause string from the error source chain; the old generic hint is kept only for an unclassified failure. No change to TLS trust behavior.
- UI redesign, "Modern" direction (visual and layout only, no behavior change): design tokens with light and dark themes (`prefers-color-scheme`), system font stack (offline, no web fonts), inline SVG icons for folders and file types, restyled master-key screen, profiles list/form, top bar, dual-pane header/columns/footer with clear cursor, marked and active-panel states, loading spinner, disabled F-key bar. `App.css` replaced by `tokens.css` + `styles.css`.

### Added
- Basic file operations (roadmap step 3a, no drag and drop or context menu yet): F5 Copy, F6 Move, F7 New folder, F8 Delete and F2 Rename on marked items or the cursor item, destination = the other panel. One transfer planner covers upload, download, server copy (also across buckets) and local copy; it plans first (counts, size, conflicts), move = copy, verify size, delete source (a failed item keeps its source), server copy uses CopyObject or multipart UploadPartCopy above 5 GiB, server delete uses DeleteObjects in batches of 1000 (folder marker included), local delete goes to the OS Trash.
- Conflicts are decided per item (Overwrite, Skip, Keep both, with Overwrite all, Skip all, Keep both all and Cancel before anything runs) from a resolution map plus an optional default; the dialog shows existing and incoming size and date.
- Commands `transfer_preview`, `transfer_execute`, `items_delete`, `folder_create`, `item_rename`; per-item failures are returned and listed in a result dialog.
- Known limit: upload and download are a single PutObject/GetObject streamed from/to disk; a file above 5 GiB fails with a clear error (multipart, progress, cancel and resume are step 4).
- Browse (roadmap step 2): dual-pane UI with a Local panel and a bucket panel per side (Name/Ext/Size/Date, virtualised list, Tab/arrows/Enter/Backspace/Space), profile switcher and Lock in the top bar, disabled function-key bar.
- Rust `s3` module (aws-sdk-s3 with endpoint, path-style, static credentials, checksums only when required; paginated `list_dir`; readable error mapping), `local` module, `AppError`.
- Tauri commands `s3_list_buckets`, `s3_list_dir`, `local_list_dir`, `profile_test`, `profile_duplicate`; the S3 client is cached per active profile and dropped on lock and profile change.
- Zustand panel store and vitest (`npm test`).
- Implementation roadmap (`docs/implement/`) and an interactive dual-pane UI demo (`docs/artifact/`), including local-to-server drag and drop and a right-click action menu.
- Multi-profile support: master-key protected encrypted vault (Argon2id + XChaCha20-Poly1305) in the app data dir, Tauri commands `vault_status/create/unlock/lock` and `profile_list/save/delete`, minimal React screens.
- Tauri 2 project scaffold (React + TypeScript + Vite).
