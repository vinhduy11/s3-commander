# Changelog

## [Unreleased]

### Added
- Implementation roadmap (`docs/implement/`) and an interactive dual-pane UI demo (`docs/artifact/`), including local-to-server drag and drop and a right-click action menu.
- Multi-profile support: master-key protected encrypted vault (Argon2id + XChaCha20-Poly1305) in the app data dir, Tauri commands `vault_status/create/unlock/lock` and `profile_list/save/delete`, minimal React screens.
- Tauri 2 project scaffold (React + TypeScript + Vite).
