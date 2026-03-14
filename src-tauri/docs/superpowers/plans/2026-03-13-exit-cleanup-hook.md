# Exit Cleanup Hook Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the Tauri app attempts to stop launcher-managed gateway and Ollama processes when the app exits.

**Architecture:** Add a backend-only cleanup helper in `src-tauri/src/lib.rs` that operates directly on managed process state, then invoke it from Tauri runtime exit events. Keep behavior scoped to processes started by this launcher and avoid changing frontend flow.

**Tech Stack:** Rust, Tauri 2 runtime lifecycle hooks, existing process management helpers.

---

### Task 1: Add backend exit cleanup helper

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test or choose verification target**

No Rust unit test harness exists for this lifecycle path in the current file, so use `cargo check` as the verification target for this focused change.

- [ ] **Step 2: Add minimal cleanup helper**

Create a small synchronous helper that reads `GatewayState` and `OllamaState` from the app handle, stops tracked child processes, closes the control UI window if present, and logs failures without panicking.

- [ ] **Step 3: Keep cleanup ownership-scoped**

Only stop child processes recorded in app state. Do not broaden behavior to kill unrelated external processes.

### Task 2: Hook cleanup into app exit

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Register runtime exit handler**

Switch the Tauri `.run(...)` call to the callback form and listen for exit-related events.

- [ ] **Step 2: Invoke cleanup once per shutdown**

Call the helper on app exit events and ignore/log errors so shutdown can still continue.

### Task 3: Verify compilation

**Files:**
- Verify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Run focused verification**

Run: `cargo check`
Expected: succeeds without introducing Rust compile errors.
