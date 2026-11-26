# s3-commander

Tauri desktop app to manage files and directories on a MinIO server (S3-compatible API) with a Total Commander-style dual-pane UI. Multiple profiles, secrets encrypted in an app vault, unlocked with a master key. See `CLAUDE.md` and `docs/claude/` for the design.

Status: multi-profile vault plus read-only browsing (dual-pane Local / bucket panels, profile switcher, profile test and duplicate). Transfers, copy/move/delete and view/edit are later steps (`docs/implement/s3-commander-roadmap.md`).

## Development

```bash
npm install
npm run tauri dev      # run the desktop app
npm run build          # type-check + build the frontend
cargo check            # run inside src-tauri/ to check the Rust side
cargo test             # run inside src-tauri/; vault, s3 (mocked SDK), local fs tests; no network
npm test               # vitest: panel store and navigation helpers (no network)
```

## Project structure

```
.
├── CLAUDE.md             # index for Claude Code, points into docs/claude/
├── docs/claude/          # topic reference files (architect, rule, safety, commands)
├── docs/changelog/       # dated implementation reports
├── docs/implement/       # implementation plans (roadmap for the S3 steps)
├── docs/artifact/        # offline copy of published artifacts (UI demo)
├── index.html            # Vite entry
├── package.json          # frontend deps and npm scripts
├── vite.config.ts        # Vite config
├── src/                  # React + TypeScript frontend
│   ├── main.tsx          # React entry
│   ├── App.tsx           # vault status, view switch (browser / profiles), lock
│   ├── App.css           # styles, including the dual-pane browser
│   ├── screens/
│   │   ├── master_key_screen.tsx  # create / unlock the vault
│   │   ├── profiles_screen.tsx    # add, edit, delete, test, duplicate profiles
│   │   └── browser_screen.tsx     # top bar (profile switcher, Lock), two panels, disabled F-key bar
│   └── browse/
│       ├── browse_store.ts        # Zustand store: one slice per panel, S3 reset on profile switch / lock
│       ├── navigation.ts          # pure path, row and formatting helpers
│       ├── browse_api.ts          # typed wrappers over the Tauri commands
│       ├── panel_loader.ts        # loads listings into the store, drops stale responses
│       ├── file_panel.tsx         # one panel: source selector, virtualised list, keyboard
│       └── *.test.ts(x)           # vitest tests
└── src-tauri/            # Rust backend
    ├── Cargo.toml        # Rust deps
    ├── tauri.conf.json   # Tauri app config
    ├── capabilities/     # Tauri permission sets
    ├── icons/            # app icons
    └── src/
        ├── main.rs       # binary entry
        ├── lib.rs        # Tauri builder, vault + client-cache state, thin commands
        ├── app_error.rs  # AppError: the one error type the UI sees (serialized as a message)
        ├── s3.rs         # aws-sdk-s3 client from a profile, list_buckets, list_dir, error mapping; no Tauri dependency
        ├── local.rs      # local_list_dir over std::fs; no Tauri dependency
        └── vault.rs      # encrypted profile vault (Argon2id + XChaCha20-Poly1305), no Tauri dependency
```
