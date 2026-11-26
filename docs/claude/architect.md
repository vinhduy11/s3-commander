# Architecture

Intended design (from the project owner; no code exists yet — replace with the real layout after scaffolding).

- **Shell**: Tauri desktop app (Rust backend + web frontend).
- **UI**: Total Commander-style dual pane. Two independent panels, each listing a directory/prefix with columns Name, Ext, Size, Date; a function-key bar at the bottom (F3 View, F4 Edit, F5 Copy, F6 Move, F7 New Folder, F8 Delete, Alt+F4 Exit); keyboard-driven navigation. Copy/Move between the two panels is the core workflow.
- **Scope**: manage directories (S3 prefixes) and files (objects) on a MinIO server (S3-compatible API, not AWS S3 itself). MinIO usually needs path-style addressing; for local testing, run a MinIO container from the shared `lab-infra` stack if it has one, otherwise ask before adding one.
- **Profiles**: multiple profiles, each holding a custom endpoint URL (no AWS-only assumptions: no fixed region/endpoint resolution, path-style addressing may be needed) and its secrets.
- **Security**: profile secrets are encrypted via a keychain; a master key is required to log in (unlock) the app.
