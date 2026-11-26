# Deployment

Everything here is generic (no real identities, values or hosts). Nothing in this file was run on a release machine for step 6b: items marked **unverified** have not been tried on this Mac or any Linux machine.

## macOS DMG

- Build: `npm install` then `npm run tauri build` from the repo root. Tauri builds the frontend (`npm run build`), compiles Rust in release mode (LTO, `panic = "abort"`, stripped, see `src-tauri/Cargo.toml`) and bundles.
- Bundle targets are set by `bundle.targets` in `src-tauri/tauri.conf.json` (default `"all"` for the host OS: on macOS the `.app` and the `.dmg`). To build only the DMG: `npm run tauri build -- --bundles dmg`. **unverified** for this project.
- Where it lands: `src-tauri/target/release/bundle/dmg/<productName>_<version>_<arch>.dmg` and `src-tauri/target/release/bundle/macos/<productName>.app`. A build runs on the host architecture; for a universal binary add `--target universal-apple-darwin` (needs both Rust targets installed). **unverified**

## Code signing and notarization (unverified, steps from the Tauri 2 docs)

1. Enroll in the Apple Developer Program and create a "Developer ID Application" certificate; export it as a `.p12` with a password.
2. Tauri reads these environment variables at build time (set them in the shell or the CI secret store, never in a tracked file):
   - `APPLE_CERTIFICATE` (base64 of the `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (or set `bundle.macOS.signingIdentity` in the config).
   - Notarization with an Apple ID: `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), `APPLE_TEAM_ID`.
   - Or with an App Store Connect API key: `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`.
3. Run `npm run tauri build`; Tauri signs the app, submits it to Apple's notary service and staples the ticket when the variables are present.
4. Check: `codesign --verify --deep --strict --verbose=2 <app>` and `spctl --assess --type execute --verbose <app>`.

A signed, stable app identity also makes the macOS Keychain prompt for "Remember on this device" appear less often (see `safety.md`).

## Unsigned builds on other Macs

An unsigned (or not notarized) build downloaded from the internet is quarantined and Gatekeeper warns that the app is damaged or from an unidentified developer. Workarounds for trusted recipients: right-click the app, Open, confirm; or remove the quarantine attribute: `xattr -dr com.apple.quarantine /Applications/<productName>.app`. Not a fix for distribution; sign and notarize for that.

## Linux

- Build prerequisites for Tauri 2 (Debian/Ubuntu names, **to verify on a Linux machine, not tested here**): `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`; plus Node.js and a Rust toolchain. Other distributions have equivalent packages (WebKitGTK 4.1, GTK 3, librsvg, OpenSSL headers).
- Bundles: `npm run tauri build -- --bundles deb` (Debian package), `--bundles appimage` (AppImage, needs `fuse`/`libfuse2` to run on many systems), `--bundles rpm`. Output in `src-tauri/target/release/bundle/<kind>/`. **unverified**
- Secret Service: "Remember on this device" needs a running Secret Service provider (GNOME Keyring, KeePassXC, KWallet with its Secret Service bridge) on the session D-Bus. The `keyring` crate used here talks to it over zbus (pure Rust), so no `libdbus-1-dev` is needed at build time. On a minimal setup without a provider the option shows "Not available on this system" and is disabled; the master key always works. **unverified on Linux**

## CI

`.github/workflows/ci.yml` runs on every push to `main` and on pull requests: a `versions` job (the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` must be equal) and a `test` job on `macos-latest` and `ubuntu-22.04` (fail-fast off): Linux system packages (Linux only), `npm ci`, `npm test`, `npm run build`, then `cargo test` and `cargo check` in `src-tauri`. It uses no secrets, and the tests use fakes and tempdirs and never touch a keychain, network or S3. **Not run on GitHub yet** (written and YAML-checked locally only).

## Release (GitHub Actions, automatic DMG and updater files)

1. Bump the version in all three places: `package.json`, `src-tauri/Cargo.toml` (then `cargo check` to refresh `Cargo.lock`) and `src-tauri/tauri.conf.json`. CI fails when they differ.
2. Move the `[Unreleased]` entries of `CHANGELOG.md` under the new version heading and commit.
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`. The identifier `dev.local.s3commander` never changes (it names the keychain item and the app data folder).
4. `.github/workflows/release.yml` (tags `v*` and manual runs) first checks that the tag equals the `tauri.conf.json` version, then builds with `tauri-apps/tauri-action@v0` on macOS Apple Silicon (`macos-latest`), macOS Intel (`macos-15-intel`, target `x86_64-apple-darwin`) and Linux (`ubuntu-22.04`, `deb` and `appimage`; **Linux is not verified**). It creates a **draft** GitHub Release holding the DMGs, the updater archives with their `.sig` signatures and `latest.json`. The builds are NOT code signed or notarized (Apple variables are commented out in the workflow; see the section above).
5. Open the draft, check the files, and **publish** it. `latest.json` only becomes reachable at `releases/latest/download/latest.json` (the updater endpoint) once the release is published and is the latest one. Until then installed apps see no update.

Repository secrets to create (Settings, Secrets and variables, Actions): `TAURI_SIGNING_PRIVATE_KEY` = the content of the private key file. The key was generated without a password, so leave `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` unset (the workflow passes it as empty). `GITHUB_TOKEN` is provided by GitHub; the release job asks for `contents: write`, everything else for `contents: read`.

Key custody: the private key signs every update. Keep it only in the maintainer's key store and in the repository secret, make an offline backup, and never commit it, paste it into an issue or print it in a log. If it is lost, installed apps can no longer verify a new update: users would have to install a new build by hand, signed with a new key whose public key replaces `plugins.updater.pubkey`. The public key in `tauri.conf.json` is not secret.

Local signed build (for trying the updater files): `TAURI_SIGNING_PRIVATE_KEY=<path to the key file> npm run tauri build`. Tauri accepts the key content or a path; do not echo it.

The first installed version must be one that already contains the updater (1.0.0 does not): older installs have no update check and must be replaced by hand once.

Data sent: the update check requests the endpoint URL (`latest.json` on GitHub) and nothing else, then downloads the release archive only after you press Download and install. The archive is installed only if its signature matches the public key built into the app.
