# Remote Desktop Manifest Design

**Date:** 2026-04-15

## Goal

Restore startup-time remote manifest handling for the desktop app so that:

- Every app launch requests `https://r2.tolearn.cc/manifest.json`
- The top of the main content area shows remote notification lines for the active language
- The app compares `manifest.desktop.version` against the local app version
- When the remote desktop version is newer, the sidebar version label shows an update button that opens `https://whereclaw.com`

If the remote request fails or the manifest payload is invalid, the app shows no remote notifications and no update button for that launch.

## Requirements

- The request must happen on each startup
- No cache is used for notifications or version data
- Notification content comes from:
  - `notifications.cn` for `zh-CN`
  - `notifications.en` for `en`
- Version comparison uses semantic numeric segments like `1.1.0`
- Invalid or missing `desktop.version` is treated as "no update"
- Invalid or missing notification arrays are treated as empty

## Chosen Approach

Implement manifest fetching in the Tauri backend and expose a single frontend command that returns sanitized launch-time remote state.

### Why backend-owned fetch

- Keeps network, timeout, JSON validation, and version parsing in one place
- Avoids duplicating platform/network edge-case handling inside the React app
- Fits the existing pattern where desktop capabilities are mediated through Tauri commands

## Backend Design

Add a new command in `src-tauri/src/lib.rs`:

- `read_remote_manifest_state(language: String) -> Result<RemoteManifestState, String>`

Add supporting types:

- `RemoteManifestPayload`
- `RemoteManifestNotifications`
- `RemoteManifestDesktop`
- `RemoteManifestState`

Behavior:

1. Build a blocking `reqwest` client with a short timeout
2. GET `https://r2.tolearn.cc/manifest.json`
3. Parse only:
   - `notifications.cn`
   - `notifications.en`
   - `desktop.version`
4. Read the local desktop version from Tauri package metadata already exposed through the running app
5. Compare the remote version against the local version using numeric dot-separated segments
6. Return:
   - `notifications`: selected-language string array
   - `remoteVersion`: remote desktop version or `null`
   - `hasUpdate`: `true` only when the remote version is strictly newer than local

Failure behavior:

- Any request, parse, or validation failure returns an empty state instead of surfacing a fatal startup error
- No disk persistence

## Frontend Design

Update `src/App.tsx` to request remote manifest state during launch initialization.

State additions:

- `remoteNotifications: string[]`
- `hasRemoteUpdate: boolean`
- `remoteDesktopVersion: string | null`

Rendering:

- Show a top banner inside the right-side scrollable content section before page-specific content
- Render one paragraph per remote notification line
- Hide the banner when the remote notifications array is empty
- In the left sidebar version row, append an inline button next to `WhereClaw vX.Y.Z` when `hasRemoteUpdate` is true
- The button text uses the existing localized copy for update availability and opens the official website through the existing handler

## Error Handling

- Backend command never blocks app render if the network is down
- Frontend treats command failures as empty remote state
- The UI remains stable when the language changes after startup by re-requesting remote state for the newly selected language

## Testing

Add automated coverage for:

- Backend source exposing a new remote manifest command and URL constant
- Frontend requesting the new command on startup
- Frontend rendering hook referencing the update label and website handler in the version row path

This keeps the regression test aligned with the restored feature without introducing network-dependent tests.
