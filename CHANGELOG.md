# Changelog

## [Unreleased]

### Fixed
- Panel stuck on "Loading...": a Local listing no longer depends on the profile, so `setProfile` after `profile_list` (fresh launch) no longer drops the first Local response; a bucket source without a profile no longer sets `loading` before returning; a dropped stale response clears `loading` when no newer request owns the panel.

### Changed
- UI redesign, "Modern" direction (visual and layout only, no behavior change): design tokens with light and dark themes (`prefers-color-scheme`), system font stack (offline, no web fonts), inline SVG icons for folders and file types, restyled master-key screen, profiles list/form, top bar, dual-pane header/columns/footer with clear cursor, marked and active-panel states, loading spinner, disabled F-key bar. `App.css` replaced by `tokens.css` + `styles.css`.

### Added
- Browse (roadmap step 2): dual-pane UI with a Local panel and a bucket panel per side (Name/Ext/Size/Date, virtualised list, Tab/arrows/Enter/Backspace/Space), profile switcher and Lock in the top bar, disabled function-key bar.
- Rust `s3` module (aws-sdk-s3 with endpoint, path-style, static credentials, checksums only when required; paginated `list_dir`; readable error mapping), `local` module, `AppError`.
- Tauri commands `s3_list_buckets`, `s3_list_dir`, `local_list_dir`, `profile_test`, `profile_duplicate`; the S3 client is cached per active profile and dropped on lock and profile change.
- Zustand panel store and vitest (`npm test`).
- Implementation roadmap (`docs/implement/`) and an interactive dual-pane UI demo (`docs/artifact/`), including local-to-server drag and drop and a right-click action menu.
- Multi-profile support: master-key protected encrypted vault (Argon2id + XChaCha20-Poly1305) in the app data dir, Tauri commands `vault_status/create/unlock/lock` and `profile_list/save/delete`, minimal React screens.
- Tauri 2 project scaffold (React + TypeScript + Vite).
