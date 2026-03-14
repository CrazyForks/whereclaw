# WhereClaw Terminal Ollama Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users run `ollama` directly inside the WhereClaw terminal without modifying system-wide shell configuration.

**Architecture:** Extend the terminal bootstrap to create an `ollama` wrapper alongside the existing `openclaw` wrapper, pointing at the bundled Ollama runtime. Export `OLLAMA_HOST` and `OLLAMA_MODELS` inside the terminal session so the wrapper behaves like the rest of the app.

**Tech Stack:** Rust, Tauri backend, Node test runner, Rust unit tests

---

### Task 1: Lock terminal behavior with failing tests

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**
Add Rust unit tests for the terminal wrapper/environment builders showing the terminal advertises `ollama`, exports `OLLAMA_HOST`/`OLLAMA_MODELS`, and generates an `ollama` wrapper script.

- [ ] **Step 2: Run test to verify it fails**
Run: `cargo test --manifest-path src-tauri/Cargo.toml whereclaw_terminal -- --nocapture`
Expected: FAIL because the current terminal builders do not mention `ollama`.

### Task 2: Implement minimal terminal support

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/lib.rs`

- [ ] **Step 3: Write minimal implementation**
Refactor the terminal setup to use small builder helpers, create an `ollama` wrapper in `terminal-bin`, and export `OLLAMA_HOST` plus `OLLAMA_MODELS` in the launched shell.

- [ ] **Step 4: Run tests to verify they pass**
Run: `cargo test --manifest-path src-tauri/Cargo.toml whereclaw_terminal -- --nocapture`
Expected: PASS with new terminal wrapper tests green.
