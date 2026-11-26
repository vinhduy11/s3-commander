# Commands

Tauri 2 + React + TypeScript + Vite (npm). Run from the repo root unless noted.

- `npm install` — install frontend deps.
- `npm run tauri dev` — run the desktop app with hot reload.
- `npm run tauri build` — production bundle.
- `npm run build` — `tsc` + `vite build` (frontend only, also the type-check).
- `cd src-tauri && cargo check` — check the Rust side.
- `cd src-tauri && cargo test` / `cargo test <name>` — Rust tests, all or a single one.

No frontend test runner or lint is configured yet.
