# Remote Skills Manifest Design

**Date:** 2026-03-14

## Goal

On application startup, check a remote manifest at `https://r2.tolearn.cc/manifest.json`. If the remote `skills.version` is newer than the current local skills catalog version, download the remote `skills.json`, save it locally, and use it as the active skill catalog. If the check fails, continue using local cached or bundled data.

## Chosen approach

Implement the update flow in the Tauri backend.

- Backend owns network fetch, version comparison, file persistence, and fallback handling.
- Frontend asks backend for the active skill catalog payload and active skills version.
- Bundled `skills.json` remains the last-resort fallback.
- `VERSION.json` remains the bundled baseline source for `skillsCatalogVersion`.

## Data flow

1. App startup triggers backend `ensure_remote_skill_catalog_fresh`.
2. Backend fetches remote manifest.
3. Backend compares `manifest.skills.version` with the current active local version.
4. If remote is newer, backend downloads `manifest.skills.url` and writes it into app local data storage.
5. Backend stores metadata for the cached skills version.
6. Frontend skill catalog loads the active payload through backend commands.

## Storage

Use app local data directory under a dedicated folder, e.g. `remote-skills/`.

- `remote-skills/skills.json` — cached remote skill catalog
- `remote-skills/metadata.json` — cached version metadata and source URL

## Fallbacks

- Remote manifest fetch fails → keep cached local file if present, otherwise bundled file
- Remote skills download fails → keep cached local file if present, otherwise bundled file
- Invalid JSON or missing fields → treat as remote failure and keep local fallback

## Scope

This implementation only handles the `skills` section from the remote manifest. The `notifications` and `desktop` sections are parsed only if needed later, but not wired into UI or update flows in this change.
