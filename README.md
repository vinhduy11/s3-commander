# s3-commander

Tauri desktop app to manage files and directories on a MinIO server (S3-compatible API) with a Total Commander-style dual-pane UI. Multiple profiles, secrets encrypted via keychain, unlocked with a master key. See `CLAUDE.md` and `docs/claude/` for the design.

Status: multi-profile support with a master-key encrypted vault; no S3 features yet.

## Development

```bash
npm install
npm run tauri dev      # run the desktop app
npm run build          # type-check + build the frontend
cargo check            # run inside src-tauri/ to check the Rust side
cargo test             # run inside src-tauri/; vault unit tests (local, no network)
```

## Project structure

```
.
├── CLAUDE.md             # index for Claude Code, points into docs/claude/
├── docs/claude/          # topic reference files (architect, rule, safety, commands)
├── docs/changelog/       # dated implementation reports
├── index.html            # Vite entry
├── package.json          # frontend deps and npm scripts
├── vite.config.ts        # Vite config
├── src/                  # React + TypeScript frontend
│   ├── main.tsx          # React entry
│   └── App.tsx           # master-key screen + profile list/form (minimal UI)
└── src-tauri/            # Rust backend
    ├── Cargo.toml        # Rust deps
    ├── tauri.conf.json   # Tauri app config
    ├── capabilities/     # Tauri permission sets
    ├── icons/            # app icons
    └── src/
        ├── main.rs       # binary entry
        ├── lib.rs        # Tauri builder, vault state, thin vault/profile commands
        └── vault.rs      # encrypted profile vault (Argon2id + XChaCha20-Poly1305), no Tauri dependency
```
