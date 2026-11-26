# Architecture

Design from the project owner; the vault below is implemented, the dual-pane UI and S3 calls are not yet.

- **Shell**: Tauri desktop app (Rust backend + web frontend).
- **UI**: Total Commander-style dual pane. Two independent panels, each listing a directory/prefix with columns Name, Ext, Size, Date; a function-key bar at the bottom (F3 View, F4 Edit, F5 Copy, F6 Move, F7 New Folder, F8 Delete, Alt+F4 Exit); keyboard-driven navigation. Copy/Move between the two panels is the core workflow.
- **Scope**: manage directories (S3 prefixes) and files (objects) on a MinIO server (S3-compatible API, not AWS S3 itself). MinIO usually needs path-style addressing; for local testing, run a MinIO container from the shared `lab-infra` stack if it has one, otherwise ask before adding one.
- **Profiles**: multiple profiles, each holding a custom endpoint URL (no AWS-only assumptions: no fixed region/endpoint resolution, path-style addressing may be needed) and its secrets.
- **Security**: profile secrets are encrypted via a keychain; a master key is required to log in (unlock) the app.

## Vault (implemented)

- `src-tauri/src/vault.rs` is plain Rust (no Tauri dependency, unit-tested). `lib.rs` holds a `Mutex<Vault>` in Tauri managed state and exposes thin commands: `vault_status`, `vault_create`, `vault_unlock`, `vault_lock`, `profile_list`, `profile_save`, `profile_delete`.
- File `vault.json` in the Tauri app data dir: JSON `{version, salt, nonce, ciphertext}` (base64). Master key -> Argon2id (random 16-byte salt) -> 32-byte key -> XChaCha20-Poly1305 over the whole profile list; fresh random 24-byte nonce on every save, file replaced atomically (tmp + rename).
- No stored master-key hash: a wrong key fails on the AEAD auth tag, as does a tampered file. Vault states: no file = create, file = unlock.
- The derived key lives only in the managed state (zeroized on lock/drop) and is never sent to the frontend. `profile_list` returns profiles without `secret_key`; `profile_save` with an empty secret on an existing profile keeps the stored secret. `Vault::get_profile` (with secret) is internal, for the later S3 step.
- Profile = id, name, endpoint URL, access key, secret key, region (default `us-east-1`).
