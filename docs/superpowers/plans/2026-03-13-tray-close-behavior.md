# Tray Close Behavior Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the app running in the system tray when the main window is closed, and only perform process cleanup on explicit tray exit.

**Architecture:** Extend the Tauri backend to create a tray icon and menu, intercept main window close requests to hide instead of exiting, and reuse the existing exit cleanup helper for the tray quit path. Keep the behavior in `src-tauri/src/lib.rs` to match the current launcher lifecycle code.

**Tech Stack:** Rust, Tauri 2 tray/menu/window lifecycle APIs.

---

### Task 1: Add tray and window-close lifecycle handling

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Choose verification target**
Use `cargo check` because there is no existing test harness for Tauri tray lifecycle behavior in this repository.

- [ ] **Step 2: Add tray menu and icon setup**
Create a tray icon with show and quit menu items during app setup/build.

- [ ] **Step 3: Intercept main window close**
Handle main window close requests by preventing exit and hiding the window instead.

### Task 2: Wire tray actions to window restore and app exit

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Restore main window from tray**
Show and focus the main window from a tray action.

- [ ] **Step 2: Quit through cleanup path**
Mark explicit quit intent, run cleanup, then exit the app.

### Task 3: Verify compilation

**Files:**
- Verify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Run focused verification**
Run: `cargo check`
Expected: succeeds without introducing Rust compile errors.
