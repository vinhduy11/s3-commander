# Commands

Tauri 2 + React + TypeScript + Vite (npm). Run from the repo root unless noted.

- `npm install` — install frontend deps.
- `npm run tauri dev` — run the desktop app with hot reload.
- `npm run tauri build` — production bundle.
- `npm run build` — `tsc` + `vite build` (frontend only, also the type-check).
- `cd src-tauri && cargo check` — check the Rust side.
- `cd src-tauri && cargo test` / `cargo test <name>` — Rust tests, all or a single one.

- `npm test` — vitest (`vitest run`): panel store, navigation, operation targets and dialog flow tests, jsdom, backend mocked, no network.

Tauri commands added by step 3a (called from `src/ops/ops_api.ts`): `transfer_preview(profileId, request)`, `transfer_execute(profileId, request, resolutions)`, `items_delete(profileId, location, items)`, `folder_create(profileId, location, name)`, `item_rename(profileId, location, item, newName)`.

No lint is configured yet. Tests are fully mocked or local (tempdirs); none connects to a real S3 endpoint, and local delete tests use a fake Trash, never the real one.
