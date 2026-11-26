# s3-commander

Tauri desktop app to manage files and directories on a MinIO server (S3-compatible API) with a Total Commander-style dual-pane UI. Multiple profiles, secrets encrypted in an app vault, unlocked with a master key. See `CLAUDE.md` and `docs/claude/` for the design.

Status: multi-profile vault, browsing (dual-pane Local / bucket panels, profile switcher, profile test and duplicate) and basic file operations: F5 Copy, F6 Move, F7 New folder, F8 Delete, F2 Rename between Local and server panels, with a per-item conflict dialog (step 3a). Drag and drop and the context menu (3b, 3c) are in. Uploads and downloads of any size (up to the 5 TiB object limit) go through the multipart / ranged transfer engine (step 4a, Rust only): parts in parallel with retry, resume of a partly uploaded multipart, ranged downloads through a `.part` file. Copy, Move and drops run as background jobs in a transfer queue above the function keys (step 4b): progress, speed and ETA, Cancel, and Retry that resumes a kept multipart upload (an app crash or quit leaves such an upload on the server, see `docs/claude/architect.md`). View/edit (step 5) is a later step (`docs/implement/s3-commander-roadmap.md`).

## Development

```bash
npm install
npm run tauri dev      # run the desktop app
npm run build          # type-check + build the frontend
cargo check            # run inside src-tauri/ to check the Rust side
cargo test             # run inside src-tauri/; vault, s3, transfer planner and engine (mocked SDK, tempdirs, fake Trash); no network
npm test               # vitest: panel store, navigation helpers, operation targets, dialog flow and presigned URL flow (mocked backend, no network)
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
│   │   └── browser_screen.tsx     # top bar (profile switcher, Lock), two panels, F-key bar (F2, F5-F9), operation dialogs
│   ├── profile/
│   │   ├── validate_profile.ts    # profile rules (mirror of profile_rules.rs) for instant feedback
│   │   ├── aws_import_api.ts      # typed wrappers over aws_config_list_profiles / aws_config_read_profile
│   │   └── validation_cases.json  # shared test table, read by both the vitest and the Rust tests
│   └── browse/
│       ├── browse_store.ts        # Zustand store: one slice per panel, S3 reset on profile switch / lock
│       ├── navigation.ts          # pure path, row and formatting helpers
│       ├── sort.ts                # pure comparator (name, ext, size, date; folders first; natural order) and header-click cycle
│       ├── panel_split.ts         # pure split rules (clamp, keyboard step, pointer to ratio) and guarded localStorage load/save
│       ├── panel_splitter.tsx     # the draggable, keyboard-operable divider between the panels (role=separator)
│       ├── panel_columns.ts       # pure column-width rules (limits, clamp, step, reset, fit to panel width) and guarded localStorage load/save
│       ├── column_resizer.tsx     # the draggable, keyboard-operable border on the Ext/Size/Date header cells (role=separator)
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
│   ├── queue/                     # transfer queue (step 4b)
│   │   ├── queue_logic.ts         # pure: job types, event reducer, speed (moving window) and ETA, status line, buttons per state
│   │   ├── queue_store.ts         # Zustand store: jobs, expanded flag, per-job meta (where it was going)
│   │   ├── queue_api.ts           # typed wrappers over transfer_start / cancel / retry / dismiss / list
│   │   ├── queue_events.ts        # listens to transfer://state and transfer://progress, refreshes the panels when a job finishes
│   │   ├── queue_panel.tsx        # the panel docked above the F-key bar: collapsed status line, rows, Cancel / Retry / Dismiss, failures
│   │   ├── queue_fixtures.ts      # test fixture (job snapshot)
│   │   └── *.test.ts(x)           # vitest tests
│   └── ops/                       # file operations (step 3a)
│       ├── ops_api.ts             # typed wrappers over the operation commands and their DTO types
│       ├── ops_targets.ts         # pure: marked-or-cursor targets, panel location, destination = other panel
│       ├── ops_store.ts           # Zustand store for the single open dialog (kept apart from panel state)
│       ├── ops_flow.ts            # flows: preview, per-item conflicts, start a transfer job, delete, new folder, rename
│       ├── panel_refresh.ts       # refreshPanel: reload a panel with openPath, keep the cursor row
│       ├── ops_dialogs.tsx        # modal dialogs (delete, name, plan, conflicts, busy, result), Esc / Enter
│       ├── modal.tsx              # the shared modal shell: scrim, focus trap, Esc / Enter
│       ├── presign_flow.ts        # presigned URLs (step 3d): options, folder confirm, result, copy, save as text file
│       ├── presign_logic.ts       # pure: expiry presets, custom value and unit parsing (1 s to 7 days), URL list text
│       ├── presign_dialogs.tsx    # options, folder confirm and result dialogs
│       ├── clipboard.ts           # copyText: Clipboard API, then select + execCommand("copy")
│       ├── toast.tsx              # short status message (copy and save results)
│       └── *.test.ts(x)           # vitest tests (backend mocked)
└── src-tauri/            # Rust backend
    ├── Cargo.toml        # Rust deps
    ├── tauri.conf.json   # Tauri app config
    ├── capabilities/     # Tauri permission sets
    ├── icons/            # app icons
    └── src/
        ├── main.rs       # binary entry
        ├── lib.rs        # Tauri builder, vault + client-cache state, thin commands (incl. transfer_preview, transfer_start / transfer_cancel / transfer_retry / transfer_dismiss / transfer_list, items_delete, folder_create, item_rename, presign_preview, presign_urls, write_text_file)
        ├── app_error.rs  # AppError: the one error type the UI sees (serialized as a message); ProfileSaveError with per-field errors
        ├── profile_rules.rs # the one place that validates and normalizes a profile input (per-field errors); no Tauri dependency
        ├── transfer_settings.rs # per-profile transfer settings: size parser, validation, effective_transfer_settings (AWS CLI defaults)
        ├── aws_config.rs # read-only parser of ~/.aws/config (or AWS_CONFIG_FILE): profile names and non-secret settings only; no Tauri dependency
        ├── s3.rs         # aws-sdk-s3 client from a profile, list_buckets, list_dir, error mapping; no Tauri dependency
        ├── local.rs      # local_list_dir over std::fs; no Tauri dependency
        │                     # (also local_stat_paths: folder/file, parent and name of OS-dropped paths)
        ├── transfer_plan.rs  # pure transfer planner: key mapping, validation, conflicts, resolutions, summary, delete batches
        ├── transfer_run.rs   # operation engine: expand, probe, resolve (prepare_plan), copy_item (move = copy + verify), one-shot run_transfer (rename); delete, new folder, rename
        ├── transfer_job.rs   # pure job / item state machine (queued, running, done, failed, cancelling, cancelled), snapshots, progress events, job titles
        ├── transfer_queue.rs # background job runner: 3 jobs at once, sequential items, EventSink, throttled progress, kept uploads for Retry, Cancel / Dismiss / Lock abort them
        ├── s3_ops.rs     # object ops: list all, head, empty put, CopyObject / UploadPartCopy, DeleteObjects in batches
        ├── part_plan.rs  # pure plan_parts(size, chunksize): part size raised to 5 MiB / 10,000 parts, 5 GiB part and 5 TiB object limits
        ├── transfer_control.rs # ProgressSink (+ no-op), CancelToken, RetryPolicy, EngineError, run_bounded, TransferEnv (settings + sink + token + retry)
        ├── multipart_upload.rs # upload_file (PutObject below the threshold, else parallel multipart with retry; a failure keeps the upload, a cancel aborts it), resume_upload (ListParts), abort_upload
        ├── ranged_download.rs  # download_file: ranged GetObject into <name>.part (+ ETag/size sidecar, resume), then atomic rename
        ├── presign.rs    # presigned GET URLs (local SigV4 computation): expiry bounds, content-disposition, folder expansion, batch; no Tauri dependency
        ├── text_file.rs  # write_text_file for the URL list chosen in the save dialog; no Tauri dependency
        ├── local_ops.rs  # local walk, copy tree, rename, New folder, Trash behind the TrashBin trait
        └── vault.rs      # encrypted profile vault (Argon2id + XChaCha20-Poly1305), no Tauri dependency
```
