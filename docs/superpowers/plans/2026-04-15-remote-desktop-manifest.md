# Remote Desktop Manifest Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore launch-time remote desktop manifest fetching so the app shows top-of-page notifications and an update button when the remote desktop version is newer than the local app version.

**Architecture:** The Tauri backend owns remote fetch, payload sanitization, and version comparison. The React frontend requests a single launch-time manifest state, renders a banner at the top of the main content column, and conditionally shows an update button beside the sidebar version label.

**Tech Stack:** Tauri 2, Rust, reqwest, React, TypeScript, Node test runner

---

## Chunk 1: Backend manifest command

### Task 1: Add the remote manifest types and helpers

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Test: `tests/remote-desktop-manifest.test.mjs`

- [ ] **Step 1: Write the failing test**

Assert that `src-tauri/src/lib.rs` contains the new manifest URL constant and command name.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/remote-desktop-manifest.test.mjs`
Expected: FAIL because the command and constant do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Add:
- `REMOTE_DESKTOP_MANIFEST_URL`
- serde structs for manifest payload/state
- semantic version comparison helper

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/remote-desktop-manifest.test.mjs`
Expected: PASS for backend string checks.

### Task 2: Expose the Tauri command

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Test: `tests/remote-desktop-manifest.test.mjs`

- [ ] **Step 1: Write the failing test**

Assert the command is present in `tauri::generate_handler!`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/remote-desktop-manifest.test.mjs`
Expected: FAIL because the handler entry is missing.

- [ ] **Step 3: Write minimal implementation**

Implement `read_remote_manifest_state` so it:
- fetches the manifest
- selects language-specific notification lines
- returns empty state on failure

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/remote-desktop-manifest.test.mjs`
Expected: PASS for backend handler checks.

## Chunk 2: Frontend launch integration

### Task 3: Load remote manifest state at startup

**Files:**
- Modify: `src/App.tsx`
- Test: `tests/remote-desktop-manifest.test.mjs`

- [ ] **Step 1: Write the failing test**

Assert `src/App.tsx` invokes `read_remote_manifest_state`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/remote-desktop-manifest.test.mjs`
Expected: FAIL because the frontend does not request remote manifest state.

- [ ] **Step 3: Write minimal implementation**

Add frontend state and launch effect to request the command, normalize the payload, and fall back to an empty state on failure.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/remote-desktop-manifest.test.mjs`
Expected: PASS for startup command checks.

### Task 4: Render the top banner and version-row update button

**Files:**
- Modify: `src/App.tsx`
- Test: `tests/remote-desktop-manifest.test.mjs`

- [ ] **Step 1: Write the failing test**

Assert the version row references the update label and website handler, and the main content path references remote notifications.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/remote-desktop-manifest.test.mjs`
Expected: FAIL because the UI paths are absent.

- [ ] **Step 3: Write minimal implementation**

Render:
- top notification banner in the main content column
- inline update button beside the version label when `hasRemoteUpdate` is true

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/remote-desktop-manifest.test.mjs`
Expected: PASS for UI string/path checks.

## Chunk 3: Verification

### Task 5: Run focused verification

**Files:**
- Test: `tests/remote-desktop-manifest.test.mjs`

- [ ] **Step 1: Run the focused test suite**

Run: `node --test tests/remote-desktop-manifest.test.mjs`
Expected: PASS

- [ ] **Step 2: Run the legacy regression test**

Run: `node --test tests/remove-legacy-skills-json.test.mjs`
Expected: PASS, except for assertions that intentionally conflict with the restored remote manifest feature and need updating.

- [ ] **Step 3: Run the app test/build command if available**

Run the smallest existing verification command that covers TypeScript compile validity for `src/App.tsx`.

- [ ] **Step 4: Review git diff**

Run: `git diff -- src-tauri/src/lib.rs src/App.tsx tests/*.test.mjs docs/superpowers/specs/2026-04-15-remote-desktop-manifest-design.md docs/superpowers/plans/2026-04-15-remote-desktop-manifest.md`
Expected: only the intended manifest restoration changes.
