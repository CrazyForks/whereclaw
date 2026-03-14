# Version Manifest Design

**Date:** 2026-03-14

## Goal

Introduce a single repository-level version manifest that carries:
- `appVersion`
- `skillsCatalogVersion`

The release workflow remains `npm version x.y.z`, while automation keeps the app metadata, skills catalog metadata, and build configuration synchronized.

## Constraints

- The desktop app UI currently gets the app version from Tauri via `getVersion()`.
- Tauri cannot directly use an arbitrary JSON manifest as its app version source; it expects an explicit version value in config or a `package.json`-style source.
- Cargo also requires a static `version` field in `src-tauri/Cargo.toml`.
- `skills.json` is a checked-in catalog payload that should expose its own top-level version metadata and that version should be visible in the app.
- The user wants to continue using `npm version x.y.z` as the standard release command.

## Chosen Design

### Single manifest

Add `VERSION.json` at the repository root:

```json
{
  "appVersion": "1.0.0",
  "skillsCatalogVersion": "1.0.0"
}
```

This file becomes the canonical repository manifest for version metadata.

### Sync model

Because `npm version` updates `package.json` directly, the implementation uses two flows:

1. **Normal sync**
   - `npm run sync:versions`
   - Reads `VERSION.json`
   - Updates:
     - `package.json`
     - `package-lock.json`
     - `src-tauri/tauri.conf.json`
     - `src-tauri/Cargo.toml`
     - `skills.json`

2. **Release sync during `npm version`**
   - `npm version x.y.z`
   - NPM updates `package.json`
   - The `version` lifecycle script copies the new `package.json.version` into `VERSION.json.appVersion`
   - The same lifecycle also updates `VERSION.json.skillsCatalogVersion` to the same release number
   - Then it syncs all derived files from `VERSION.json`
   - Finally it stages the generated files so the `npm version` commit captures them

This preserves the user’s preferred command while keeping the repository aligned to one manifest file after the command completes.

## UI behavior

- The app version display continues to use `getVersion()` from Tauri.
- `skills.json` gains a top-level `version` field sourced from `VERSION.json.skillsCatalogVersion`.
- The skill catalog screen reads that top-level `version` from the fetched catalog payload and displays it in the UI.

## Verification

Add automated checks that:
- `VERSION.json` exists and has both required fields
- the synchronized files match the manifest
- `skills.json` exposes a top-level `version`
- the app source reads the catalog version metadata
