# s3-commander

Tauri desktop app to manage files and directories on a MinIO server (S3-compatible API) with a Total Commander-style dual-pane UI. Multiple profiles, secrets encrypted in an app vault, unlocked with a master key. See `CLAUDE.md` and `docs/claude/` for the design.

Status: multi-profile vault, browsing (dual-pane Local / bucket panels, profile switcher, profile test and duplicate) and basic file operations: F5 Copy, F6 Move, F7 New folder, F8 Delete, F2 Rename between Local and server panels, with a per-item conflict dialog (step 3a). Drag and drop and the context menu (3b, 3c) are in. Uploads and downloads of any size (up to the 5 TiB object limit) go through the multipart / ranged transfer engine (step 4a, Rust only): parts in parallel with retry, resume of a partly uploaded multipart, ranged downloads through a `.part` file. Copy, Move and drops run as background jobs in a transfer queue above the function keys (step 4b): progress, speed and ETA, Cancel, and Retry that resumes a kept multipart upload (an app crash or quit leaves such an upload on the server, see `docs/claude/architect.md`). View/edit (step 5) is in. Vault hardening (step 6a): auto-lock after idle (Settings popover), a persisted delay after failed unlocks, and stronger Argon2 parameters for new vaults with an in-place upgrade of old ones. Step 6b: an opt-in "Remember on this device" (Settings popover) keeps the vault's derived key in the OS keychain and opens the vault with it only at app launch; macOS and Linux build and release notes are in `docs/claude/deployment.md` (the Linux build and the real keychain are untested here).

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
├── docs/claude/          # topic reference files (architect, rule, safety, commands, deployment)
├── docs/changelog/       # dated implementation reports
├── docs/implement/       # implementation plans (roadmap for the S3 steps)
├── docs/artifact/        # offline copy of published artifacts (UI demo, app icon options)
├── .github/workflows/    # ci.yml (tests on push and pull request), release.yml (tag v*: draft release with DMG and updater files)
├── index.html            # Vite entry
├── package.json          # frontend deps and npm scripts
├── vite.config.ts        # Vite config
├── src/                  # React + TypeScript frontend
│   ├── main.tsx          # React entry
│   ├── App.tsx           # vault status, view switch (browser / profiles), lock
│   ├── tokens.css        # design tokens (colors, type, spacing, radius) with light and dark themes
│   ├── styles.css        # all component styles, built on tokens.css (imported by App.tsx)
│   ├── icons.tsx         # inline SVG icons: folder, parent, file types, lock, key, server, disk
│   ├── security/                  # auto-lock (6a): idle_timer (pure), use_auto_lock, settings_store, settings_popover (incl. Remember on this device); launch_unlock (6b: remembered-key unlock at launch)
│   ├── update/                    # in-app updates: update_logic (pure), update_api (plugin wrappers), update_store, update_dialog, use_launch_check
│   ├── screens/
│   │   ├── master_key_screen.tsx  # create / unlock the vault; shows the unlock wait after failed attempts and disables Unlock
│   │   ├── profiles_screen.tsx    # add, edit, delete, test, duplicate profiles; shows Rust's per-field save errors
│   │   ├── profile_form.tsx       # profile form: inline per-field errors, Save disabled while invalid, http warning, collapsible Transfer settings, Import from AWS CLI
│   │   └── browser_screen.tsx     # top bar (profile switcher, Settings, Lock), two panels, F-key bar (F2 to F9), operation dialogs and the viewer
│   ├── profile/
│   │   ├── validate_profile.ts    # profile rules (mirror of profile_rules.rs) for instant feedback
│   │   ├── aws_import_api.ts      # typed wrappers over aws_config_list_profiles / aws_config_read_profile
│   │   └── validation_cases.json  # shared test table, read by both the vitest and the Rust tests
│   └── browse/
│       ├── browse_store.ts        # Zustand store: one slice per panel, S3 reset on profile switch / lock
│       ├── selection.ts           # pure selection rules: range from the anchor, toggle, all, invert, glob matcher, rubber-band hit-test
│       ├── selection_flow.ts      # opens the "Select by pattern" dialog (keys + and -, context menu)
│       ├── rubber_band.ts         # hook: rubber-band selection from empty list space (pointer capture, auto-scroll, Esc cancels)
│       ├── navigation.ts          # pure path, row and formatting helpers
│       ├── sort.ts                # pure comparator (name, ext, size, date; folders first; natural order) and header-click cycle
│       ├── panel_split.ts         # pure split rules (clamp, keyboard step, pointer to ratio) and guarded localStorage load/save
│       ├── panel_splitter.tsx     # the draggable, keyboard-operable divider between the panels (role=separator)
│       ├── panel_columns.ts       # pure column-width rules (limits, clamp, step, reset, fit to panel width) and guarded localStorage load/save
│       ├── column_resizer.tsx     # the draggable, keyboard-operable border on the Ext/Size/Date header cells (role=separator)
│       ├── browse_api.ts          # typed wrappers over the Tauri commands
│       ├── panel_loader.ts        # loads listings into the store, drops stale responses; reloadPanel (keeps context); loadAll (capped) for server panels
│       ├── reload_state.ts        # pure rule for a reload: cursor by name, marks and anchor pruned to names that still exist
│       ├── reload_triggers.ts     # Cmd/Ctrl+R (active panel) and the silent reload of Local panels when the window regains focus
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
│   ├── viewer/                    # View (F3) and Edit (F4) for text, JSON and CSV (step 5)
│   │   ├── viewer_api.ts          # typed wrappers over the text commands (local and server open and save)
│   │   ├── viewer_store.ts        # Zustand store: the one open viewer session (text, saved text, source, guard)
│   │   ├── viewer_flow.ts         # open (F3, F4, Enter, menu), dirty guard, saves with changed-on-disk / changed-remotely handling, Save as copy
│   │   ├── viewer_host.tsx        # mounts the viewer and loads its chunk lazily (React.lazy)
│   │   ├── viewer_modal.tsx       # the large in-window modal: toolbar, JSON tools, CSV toggle, the nested dialogs (lazy chunk)
│   │   ├── code_editor.tsx        # CodeMirror 6 wrapper, theme from the CSS tokens (lazy chunk)
│   │   ├── csv_table.tsx          # virtualised CSV grid with in-place cell edit (lazy chunk)
│   │   ├── csv.ts                 # pure: RFC 4180 parse and serialize that keeps untouched cells byte-identical, delimiter detection, row and column edits
│   │   ├── json_tools.ts          # pure: validate with line and column, Format and Minify on the token text
│   │   ├── text_kind.ts           # pure: file kind by extension, line ending detection, copy name, size cap
│   │   └── *.test.ts(x)           # vitest tests (backend mocked, CodeMirror stubbed in the modal tests)
│   └── ops/                       # file operations (step 3a)
│       ├── ops_api.ts             # typed wrappers over the operation commands and their DTO types
│       ├── ops_targets.ts         # pure: marked-or-cursor targets, panel location, destination = other panel
│       ├── ops_store.ts           # Zustand store for the single open dialog (kept apart from panel state)
│       ├── ops_flow.ts            # flows: preview, per-item conflicts, start a transfer job, delete, new folder, rename
│       ├── panel_refresh.ts       # refreshPanel: reload a panel with openPath, keep the cursor row
│       ├── ops_dialogs.tsx        # modal dialogs (delete, name, plan, conflicts, busy, result), Esc / Enter
│       ├── modal.tsx              # the shared modal shell: scrim, focus trap, Esc / Enter
│       ├── pattern_dialog.tsx     # "Select by pattern" / "Deselect by pattern" modal with the live match count
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
    ├── icon-source/      # app-icon.svg: the vector source of the app icon (bucket with transfer arrows)
    ├── icons/            # app icons generated from icon-source/app-icon.svg with `npx tauri icon src-tauri/icon-source/app-icon.svg` (desktop files only; mobile folders removed)
    └── src/
        ├── main.rs       # binary entry
        ├── key_store.rs  # KeyStore trait (get, set, delete, is_available), SystemKeyStore (keyring crate: Apple Keychain, Secret Service), test-only MemoryKeyStore; no Tauri dependency
        ├── remember.rs   # remember on this device: enable, forget, launch-only unlock with the stored key, refresh after a master-key unlock, LaunchGate; no Tauri dependency
        ├── settings.rs   # app settings file (settings.json: auto-lock minutes): defaults, validation, atomic save; no Tauri dependency
        ├── unlock_throttle.rs # failed-unlock counter with exponential delay (1 s .. 5 min), persisted, injectable clock; unlock_guarded; no Tauri dependency
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
        ├── text_doc.rs   # viewer text commands, local: UTF-8 / BOM / NUL detection, 5 MiB cap, atomic save keeping permissions, changed-on-disk stamp; no Tauri dependency
        ├── text_s3.rs    # viewer text commands, server: open (ETag, Content-Type, metadata), save with If-Match plus HEAD check, create-only for Save as copy
        ├── s3_ops.rs     # object ops: list all, head, empty put, CopyObject / UploadPartCopy, DeleteObjects in batches
        ├── part_plan.rs  # pure plan_parts(size, chunksize): part size raised to 5 MiB / 10,000 parts, 5 GiB part and 5 TiB object limits
        ├── transfer_control.rs # ProgressSink (+ no-op), CancelToken, RetryPolicy, EngineError, run_bounded, TransferEnv (settings + sink + token + retry)
        ├── multipart_upload.rs # upload_file (PutObject below the threshold, else parallel multipart with retry; a failure keeps the upload, a cancel aborts it), resume_upload (ListParts), abort_upload
        ├── ranged_download.rs  # download_file: ranged GetObject into <name>.part (+ ETag/size sidecar, resume), then atomic rename
        ├── presign.rs    # presigned GET URLs (local SigV4 computation): expiry bounds, content-disposition, folder expansion, batch; no Tauri dependency
        ├── text_file.rs  # write_text_file for the URL list chosen in the save dialog; no Tauri dependency
        ├── local_ops.rs  # local walk, copy tree, rename, New folder, Trash behind the TrashBin trait
        └── vault.rs      # encrypted profile vault (Argon2id + XChaCha20-Poly1305), Argon2 parameters in the file header, in-place upgrade on unlock; no Tauri dependency
```
