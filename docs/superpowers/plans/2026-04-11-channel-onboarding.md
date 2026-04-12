# Channel Onboarding Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace QQ-only onboarding with a preinstalled WeChat/QQ/skip channel step, default WeChat, and complete WeChat QR login inside WhereClaw.

**Architecture:** Bundle the WeChat plugin into the packaged OpenClaw extensions tree, add backend helpers for enabling and driving the bundled plugin login flow, and replace the onboarding screen with a generalized channel selector that branches into WeChat QR login or QQ credential entry. Keep config writes aligned with official OpenClaw schemas.

**Tech Stack:** React 19 + TypeScript, Tauri Rust backend, Node-based OpenClaw runtime, shell and PowerShell packaging scripts.

---

## Chunk 1: Onboarding UI and request shape

### Task 1: Add failing tests for channel onboarding state

**Files:**
- Create: `src/onboarding/channelStep.test.ts`
- Create: `src/onboarding/channelStep.ts`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run test to verify it fails**
Run: `node --test src/onboarding/channelStep.test.ts`
Expected: FAIL because `src/onboarding/channelStep.ts` does not exist yet.
- [ ] **Step 3: Write minimal implementation**
- [ ] **Step 4: Run test to verify it passes**
Run: `node --test src/onboarding/channelStep.test.ts`
Expected: PASS

### Task 2: Replace QQ-only onboarding UI with channel selection UI

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/onboarding/qqStep.ts` or replace its usage with `src/onboarding/channelStep.ts`

- [ ] **Step 1: Update the request types and screen state for channel selection**
- [ ] **Step 2: Render the new channel selector with WeChat default**
- [ ] **Step 3: Keep QQ credentials conditional on QQ selection**
- [ ] **Step 4: Add WeChat QR status UI states and retry-safe copy**
- [ ] **Step 5: Run frontend verification**
Run: `npm run build`
Expected: PASS

## Chunk 2: Rust config and WeChat QR backend

### Task 3: Add failing Rust tests for WeChat config helpers

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add tests for enabling bundled WeChat plugin metadata and config**
- [ ] **Step 2: Run targeted Rust tests to verify they fail**
Run: `cargo test weixin --manifest-path src-tauri/Cargo.toml`
Expected: FAIL until helpers exist.
- [ ] **Step 3: Implement minimal helper functions**
- [ ] **Step 4: Run targeted Rust tests to verify they pass**
Run: `cargo test weixin --manifest-path src-tauri/Cargo.toml`
Expected: PASS

### Task 4: Add Tauri commands for WeChat QR login

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add backend commands to start and wait for bundled WeChat QR login**
- [ ] **Step 2: Wire the React flow to request QR start, display the QR image, and await completion**
- [ ] **Step 3: Finish initialization on success and surface errors on failure**
- [ ] **Step 4: Re-run focused verification**
Run: `cargo test weixin --manifest-path src-tauri/Cargo.toml`
Expected: PASS

## Chunk 3: Engine packaging

### Task 5: Prebundle the WeChat plugin into the engine

**Files:**
- Modify: `scripts/prepare-openclaw-engine.sh`
- Modify: `scripts/prepare-openclaw-engine.ps1`

- [ ] **Step 1: Add engine-preparation logic to install/extract the WeChat plugin into bundled extensions**
- [ ] **Step 2: Install production dependencies for the bundled plugin**
- [ ] **Step 3: Ensure packaging reuses the bundled plugin on subsequent runs where possible**
- [ ] **Step 4: Run script-level verification where practical**

## Chunk 4: Full verification

### Task 6: Verify end-to-end build integrity

**Files:**
- Modify: `src/App.tsx`
- Modify: `src-tauri/src/lib.rs`
- Modify: `scripts/prepare-openclaw-engine.sh`
- Modify: `scripts/prepare-openclaw-engine.ps1`

- [ ] **Step 1: Run targeted TypeScript tests**
Run: `node --test src/onboarding/channelStep.test.ts`
Expected: PASS
- [ ] **Step 2: Run Rust tests**
Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS
- [ ] **Step 3: Run lint**
Run: `npm run lint`
Expected: PASS
- [ ] **Step 4: Run build**
Run: `npm run build`
Expected: PASS
