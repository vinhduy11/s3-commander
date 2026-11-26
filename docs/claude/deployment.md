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

No CI file exists because the repository has no remote yet. A job on macOS and Linux runners would run, from the repo root (Linux runners first install the packages above):

```
cd src-tauri && cargo test
cd src-tauri && cargo check
npm ci
npm test
npm run build
```

The tests use fakes and tempdirs and never touch a keychain, network or S3. Signing and notarization secrets belong to a separate release job, not to the test job.
