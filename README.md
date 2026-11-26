# s3-commander

Tauri desktop app to manage files and directories on a MinIO server (S3-compatible API) with a Total Commander-style dual-pane UI. Multiple profiles, secrets encrypted via keychain, unlocked with a master key. See `CLAUDE.md` and `docs/claude/` for the design.

Status: scaffold only (Tauri 2 + React + TypeScript + Vite); no S3 features yet.

## Development

```bash
npm install
npm run tauri dev      # run the desktop app
npm run build          # type-check + build the frontend
cargo check            # run inside src-tauri/ to check the Rust side
```

## Project structure

```
.
├── CLAUDE.md             # index for Claude Code, points into docs/claude/
├── docs/claude/          # topic reference files (architect, rule, safety, commands)
├── index.html            # Vite entry
├── package.json          # frontend deps and npm scripts
├── vite.config.ts        # Vite config
├── src/                  # React + TypeScript frontend
│   ├── main.tsx          # React entry
│   └── App.tsx           # root component (template placeholder)
└── src-tauri/            # Rust backend
    ├── Cargo.toml        # Rust deps
    ├── tauri.conf.json   # Tauri app config
    ├── capabilities/     # Tauri permission sets
    ├── icons/            # app icons
    └── src/
        ├── main.rs       # binary entry
        └── lib.rs        # Tauri builder and commands
```
