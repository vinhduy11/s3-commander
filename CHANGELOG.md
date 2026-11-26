# Changelog

## [Unreleased]

### Added
- Browse (roadmap step 2): dual-pane UI with a Local panel and a bucket panel per side (Name/Ext/Size/Date, virtualised list, Tab/arrows/Enter/Backspace/Space), profile switcher and Lock in the top bar, disabled function-key bar.
- Rust `s3` module (aws-sdk-s3 with endpoint, path-style, static credentials, checksums only when required; paginated `list_dir`; readable error mapping), `local` module, `AppError`.
- Tauri commands `s3_list_buckets`, `s3_list_dir`, `local_list_dir`, `profile_test`, `profile_duplicate`; the S3 client is cached per active profile and dropped on lock and profile change.
- Zustand panel store and vitest (`npm test`).
- Implementation roadmap (`docs/implement/`) and an interactive dual-pane UI demo (`docs/artifact/`), including local-to-server drag and drop and a right-click action menu.
- Multi-profile support: master-key protected encrypted vault (Argon2id + XChaCha20-Poly1305) in the app data dir, Tauri commands `vault_status/create/unlock/lock` and `profile_list/save/delete`, minimal React screens.
- Tauri 2 project scaffold (React + TypeScript + Vite).
