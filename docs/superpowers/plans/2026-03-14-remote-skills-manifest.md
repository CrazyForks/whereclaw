# Remote Skills Manifest Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Check a remote startup manifest, download a newer skills catalog when available, cache it locally, and make the UI read the active catalog from backend-managed storage with local fallback.

**Architecture:** The Tauri backend manages remote fetch, semver comparison, local persistence, and fallback selection. The React frontend triggers refresh on startup and reads the active skill catalog and active skills version via backend commands.

**Tech Stack:** Rust + Tauri commands, reqwest blocking client, serde JSON, React + TypeScript, Node test runner

---

## Chunk 1: Add failing tests

### Task 1: Frontend integration expectations

**Files:**
- Modify: `tests/skills-catalog-path.test.ts`
- Create: `tests/remote-skills-startup.test.ts`

- [ ] **Step 1: Write failing tests for backend-driven catalog loading**
- [ ] **Step 2: Run focused tests and confirm failure**

## Chunk 2: Implement backend cache/update flow

### Task 2: Add manifest and cache helpers

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add remote manifest structs and semver comparison helpers**
- [ ] **Step 2: Add cache path helpers under app local data**
- [ ] **Step 3: Add update command and read-active-catalog command**
- [ ] **Step 4: Register commands and log failures without blocking startup**

## Chunk 3: Switch frontend loading path

### Task 3: Use backend active catalog

**Files:**
- Modify: `src/App.tsx`
- Modify: `tests/version-manifest.test.ts`
- Modify: `tests/skills-catalog-path.test.ts`

- [ ] **Step 1: Trigger backend refresh during startup**
- [ ] **Step 2: Load active skill catalog through invoke instead of static fetch**
- [ ] **Step 3: Surface active skills version in the UI**

## Chunk 4: Verify behavior

### Task 4: Run focused verification

**Files:**
- Verify only

- [ ] **Step 1: Run focused Node tests**
- [ ] **Step 2: Run `cargo check` for Tauri backend**
- [ ] **Step 3: Report exact verification results**
