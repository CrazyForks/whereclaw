# Version Manifest Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a root `VERSION.json` manifest, synchronize app and catalog versions from it, and make the app show the skill catalog version sourced from `skills.json`.

**Architecture:** `VERSION.json` becomes the canonical repository manifest. A Node sync script updates derived files for Tauri, Cargo, npm metadata, and the skill catalog. The UI continues to read app version through Tauri and additionally reads the skill catalog version from the fetched `skills.json` payload.

**Tech Stack:** Node.js scripts, Tauri config, Cargo manifest, React + TypeScript, Node test runner

---

## Chunk 1: Add failing regression tests

### Task 1: Version manifest consistency test

**Files:**
- Create: `tests/version-manifest.test.ts`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run `node --test tests/version-manifest.test.ts` and confirm failure**
- [ ] **Step 3: Keep the failure output for guidance**

### Task 2: Sync script behavior test

**Files:**
- Create: `tests/version-sync.test.ts`

- [ ] **Step 1: Write the failing test against a temp workspace**
- [ ] **Step 2: Run `node --test tests/version-sync.test.ts` and confirm failure**
- [ ] **Step 3: Keep the failure output for guidance**

## Chunk 2: Implement version synchronization

### Task 3: Add version manifest and sync library

**Files:**
- Create: `VERSION.json`
- Create: `scripts/version-sync.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the root manifest with `appVersion` and `skillsCatalogVersion`**
- [ ] **Step 2: Implement sync logic for npm, Tauri, Cargo, and `skills.json`**
- [ ] **Step 3: Add npm scripts for normal sync and `npm version` lifecycle sync**
- [ ] **Step 4: Run the sync-script test and make it pass**

### Task 4: Sync repository files

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `skills.json`

- [ ] **Step 1: Run the sync script against the repo**
- [ ] **Step 2: Run the manifest consistency test and make it pass**

## Chunk 3: Expose catalog version in UI

### Task 5: Read and display catalog metadata

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Extend catalog typing with top-level `version`**
- [ ] **Step 2: Display the catalog version in the skill catalog UI**
- [ ] **Step 3: Re-run the manifest consistency test**

## Chunk 4: Verify end-to-end behavior

### Task 6: Run focused verification

**Files:**
- Verify only

- [ ] **Step 1: Run `node --test tests/version-manifest.test.ts tests/version-sync.test.ts tests/skills-catalog-path.test.ts`**
- [ ] **Step 2: Run `node ./scripts/version-sync.mjs --check`**
- [ ] **Step 3: Report exact results without extrapolation**
