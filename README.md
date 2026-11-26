# s3-commander

Tauri desktop app to manage files and directories on a MinIO server (S3-compatible API) with a Total Commander-style dual-pane UI. Multiple profiles, secrets encrypted in an app vault, unlocked with a master key. See `CLAUDE.md` and `docs/claude/` for the design.

Status: multi-profile vault, browsing (dual-pane Local / bucket panels, profile switcher, profile test and duplicate) and basic file operations: F5 Copy, F6 Move, F7 New folder, F8 Delete, F2 Rename between Local and server panels, with a per-item conflict dialog (step 3a). Drag and drop and the context menu (3b, 3c), large transfers with progress (step 4) and view/edit (step 5) are later steps. Known limit: upload and download are one PutObject/GetObject, so a single file above 5 GiB fails with a clear error until step 4 (`docs/implement/s3-commander-roadmap.md`).

## Development

```bash
npm install
npm run tauri dev      # run the desktop app
npm run build          # type-check + build the frontend
cargo check            # run inside src-tauri/ to check the Rust side
cargo test             # run inside src-tauri/; vault, s3, transfer planner and engine (mocked SDK, tempdirs, fake Trash); no network
npm test               # vitest: panel store, navigation helpers, operation targets and dialog flow (mocked backend, no network)
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
│   ├── tokens.css        # design tokens (colors, type, spacing, radius) with light and dark themes
│   ├── styles.css        # all component styles, built on tokens.css (imported by App.tsx)
│   ├── icons.tsx         # inline SVG icons: folder, parent, file types, lock, key, server, disk
│   ├── screens/
│   │   ├── master_key_screen.tsx  # create / unlock the vault
│   │   ├── profiles_screen.tsx    # add, edit, delete, test, duplicate profiles; shows Rust's per-field save errors
│   │   ├── profile_form.tsx       # profile form: inline per-field errors, Save disabled while invalid, http warning, collapsible Transfer settings, Import from AWS CLI
│   │   └── browser_screen.tsx     # top bar (profile switcher, Lock), two panels, F-key bar (F2, F5-F8), operation dialogs
│   ├── profile/
│   │   ├── validate_profile.ts    # profile rules (mirror of profile_rules.rs) for instant feedback
│   │   ├── aws_import_api.ts      # typed wrappers over aws_config_list_profiles / aws_config_read_profile
│   │   └── validation_cases.json  # shared test table, read by both the vitest and the Rust tests
│   └── browse/
│       ├── browse_store.ts        # Zustand store: one slice per panel, S3 reset on profile switch / lock
│       ├── navigation.ts          # pure path, row and formatting helpers
│       ├── sort.ts                # pure comparator (name, ext, size, date; folders first; natural order) and header-click cycle
│       ├── browse_api.ts          # typed wrappers over the Tauri commands
│       ├── panel_loader.ts        # loads listings into the store, drops stale responses; loadAll (capped) for server panels
│       ├── file_panel.tsx         # one panel: source selector, sortable column headers, virtualised list, keyboard, footer hint
│       ├── context_menu.ts        # right-click menu: state, data-driven item list, selection rules, position clamp
│       ├── context_menu_view.tsx  # menu surface (role=menu), keyboard, close rules
│       ├── drag_drop_logic.ts     # pure drag rules: threshold, drag set, hit test, drop target, refusals, auto-scroll step
│       ├── drop_locations.ts      # pure location helpers (child folder, same place, inside itself)
│       ├── drag_drop.ts           # pointer-event drag controller + ghost/hover store (no HTML5 DnD)
│       ├── drag_drop_view.tsx     # drag ghost and refusal toast
│       ├── os_drop.ts             # OS file manager drop: Tauri webview drag-drop event, position mapping, upload through the F5 flow
│       └── *.test.ts(x)           # vitest tests
│   └── ops/                       # file operations (step 3a)
│       ├── ops_api.ts             # typed wrappers over the operation commands and their DTO types
│       ├── ops_targets.ts         # pure: marked-or-cursor targets, panel location, destination = other panel
│       ├── ops_store.ts           # Zustand store for the single open dialog (kept apart from panel state)
│       ├── ops_flow.ts            # flows: preview, per-item conflicts, execute, delete, new folder, rename, refresh
│       ├── ops_dialogs.tsx        # modal dialogs (delete, name, plan, conflicts, busy, result), Esc / Enter
│       └── *.test.ts(x)           # vitest tests (backend mocked)
└── src-tauri/            # Rust backend
    ├── Cargo.toml        # Rust deps
    ├── tauri.conf.json   # Tauri app config
    ├── capabilities/     # Tauri permission sets
    ├── icons/            # app icons
    └── src/
        ├── main.rs       # binary entry
        ├── lib.rs        # Tauri builder, vault + client-cache state, thin commands (incl. transfer_preview, transfer_execute, items_delete, folder_create, item_rename)
        ├── app_error.rs  # AppError: the one error type the UI sees (serialized as a message); ProfileSaveError with per-field errors
        ├── profile_rules.rs # the one place that validates and normalizes a profile input (per-field errors); no Tauri dependency
        ├── transfer_settings.rs # per-profile transfer settings: size parser, validation, effective_transfer_settings (AWS CLI defaults)
        ├── aws_config.rs # read-only parser of ~/.aws/config (or AWS_CONFIG_FILE): profile names and non-secret settings only; no Tauri dependency
        ├── s3.rs         # aws-sdk-s3 client from a profile, list_buckets, list_dir, error mapping; no Tauri dependency
        ├── local.rs      # local_list_dir over std::fs; no Tauri dependency
        │                     # (also local_stat_paths: folder/file, parent and name of OS-dropped paths)
        ├── transfer_plan.rs  # pure transfer planner: key mapping, validation, conflicts, resolutions, summary, delete batches
        ├── transfer_run.rs   # operation engine: expand, probe, resolve, run, move = copy + verify + delete; delete, new folder, rename
        ├── s3_ops.rs     # object ops: list all, head, put, get, CopyObject / UploadPartCopy, DeleteObjects in batches
        ├── local_ops.rs  # local walk, copy tree, rename, New folder, Trash behind the TrashBin trait
        └── vault.rs      # encrypted profile vault (Argon2id + XChaCha20-Poly1305), no Tauri dependency
```
