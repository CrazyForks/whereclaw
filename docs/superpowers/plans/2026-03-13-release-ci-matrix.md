# Release CI Matrix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linux runtime preparation and GitHub Actions workflows that validate multi-platform builds on push/PR and publish release artifacts only on version tags.

**Architecture:** Keep platform runtime preparation in the existing shell/PowerShell scripts and let GitHub Actions run native builds per OS/arch runner. Use one matrix-based workflow for CI/release so platform-specific setup stays centralized.

**Tech Stack:** Tauri 2, GitHub Actions, Bash, PowerShell, Rust, Node.js

---

### Task 1: Linux runtime preparation

**Files:**
- Modify: `scripts/prepare-openclaw-engine.sh`
- Test: `scripts/prepare-openclaw-engine.sh`

- [ ] Add Linux Ollama platform detection and archive selection
- [ ] Keep macOS behavior unchanged while supporting Linux x64
- [ ] Run targeted script checks on shell syntax and branch selection

### Task 2: Release metadata cleanup

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] Change bundle identifier away from `.app` suffix
- [ ] Keep existing bundle targets/resources intact

### Task 3: GitHub Actions matrix

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] Add push/PR matrix for macOS arm64, macOS x64, Windows x64, Linux x64
- [ ] Prepare platform runtime before `tauri build`
- [ ] Upload CI artifacts on push/PR for inspection
- [ ] Upload GitHub Release assets only for `v*` tags

### Task 4: Verification

**Files:**
- Modify: `README.md`

- [ ] Document supported build targets and release flow
- [ ] Run config/script validation commands
- [ ] Summarize any remaining signing or packaging gaps
