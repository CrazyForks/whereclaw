# WhereClaw

WhereClaw is a Tauri desktop application with a React frontend and a bundled `whereclaw-engine` runtime.

## Supported CI build targets

GitHub Actions validates native builds for these targets on every `push` and `pull_request`:

- macOS Apple Silicon
- macOS Intel
- Windows x64
- Linux x64

Only version tags matching `v*` publish release assets.

## Local development

Install dependencies:

```bash
npm install
```

Run the app in development mode:

```bash
npm run tauri dev
```

Prepare the bundled engine runtime manually when needed:

```bash
npm run prepare:openclaw-engine
```

On Windows PowerShell:

```powershell
npm run prepare:openclaw-engine:windows
```

## CI release flow

- `push` / `pull_request`: builds all supported platforms and uploads workflow artifacts for inspection
- `push` of a tag like `v1.0.0`: builds all supported platforms and publishes release bundles to GitHub Releases

## Notes

- macOS distribution still requires Apple signing and notarization secrets before external release.
- Linux runners install WebKit/AppImage packaging dependencies before running `tauri build`.
- The bundled engine runtime is platform-specific and prepared inside CI before packaging.

## macOS signing secrets

To avoid Gatekeeper treating downloaded macOS builds as broken or untrusted, configure these GitHub Actions secrets before shipping releases:

- `APPLE_SIGNING_IDENTITY`
- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_P8`
- `APPLE_API_ISSUER`

Alternatively, notarization can use Apple ID credentials:

- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`
- `APPLE_PROVIDER_SHORT_NAME` (only when needed)
