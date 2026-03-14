# WhereClaw

WhereClaw is a Tauri desktop application with a React frontend and a bundled `whereclaw-engine` runtime.

## Supported local build targets

Use the local packaging scripts for these targets:

- macOS Apple Silicon
- macOS Intel
- Windows x64
- Linux x64

GitHub Actions auto build is disabled. Use the local packaging scripts in `scripts/`.

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

- Run the platform-specific script on each target machine to build local release artifacts.
- Built artifacts are written to `release-artifacts/<platform>/`.

## Notes

- macOS packaging scripts perform ad-hoc re-signing so the app bundle is structurally valid, but they do not notarize the app.
- Windows packaging currently produces a portable `.zip` bundle instead of an installer.
- Linux packaging assumes the required WebKit/AppImage dependencies are already installed on that machine.
- The bundled engine runtime is platform-specific and prepared locally before packaging.

## Local packaging scripts

Run these on the matching local machine:

- macOS Apple Silicon: `./scripts/package-macos-arm64.sh`
- macOS Intel: `./scripts/package-macos-x64.sh`
- Windows x64 (PowerShell): `./scripts/package-windows-x64.ps1`
- Linux x64: `./scripts/package-linux-x64.sh`

Artifacts are copied into `release-artifacts/` under a per-platform folder.
