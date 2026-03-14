# Gateway Model Latest Compatibility Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make gateway local-model availability checks treat `model` and `model:latest` as the same Ollama model when users click Start Gateway.

**Architecture:** Keep the change inside `src/runtime/gatewayState.ts` by introducing one normalization helper for comparison-only logic. Reuse that helper in availability, downloading, and refresh checks so gateway state stays consistent without changing displayed model names.

**Tech Stack:** TypeScript, Node test runner, existing runtime state helpers

---

### Task 1: Add regression tests for `:latest` compatibility

**Files:**
- Modify: `tests/gateway-model-availability.test.ts`
- Modify: `tests/gateway-state-ui.test.ts`
- Test: `tests/gateway-model-availability.test.ts`
- Test: `tests/gateway-state-ui.test.ts`

- [ ] **Step 1: Write the failing test**
Add coverage showing `qwen3.5` matches `qwen3.5:latest` when checking local model availability and download progress transitions.

- [ ] **Step 2: Run test to verify it fails**
Run: `node --import tsx --test tests/gateway-model-availability.test.ts tests/gateway-state-ui.test.ts`
Expected: FAIL because current comparison treats bare names and `:latest` as different strings.

### Task 2: Implement comparison-only normalization

**Files:**
- Modify: `src/runtime/gatewayState.ts`
- Test: `tests/gateway-model-availability.test.ts`
- Test: `tests/gateway-state-ui.test.ts`

- [ ] **Step 3: Write minimal implementation**
Add a helper that trims/lowercases model names and removes a trailing `:latest` before equality checks. Reuse it everywhere in `gatewayState.ts` that compares configured and observed local model names.

- [ ] **Step 4: Run test to verify it passes**
Run: `node --import tsx --test tests/gateway-model-availability.test.ts tests/gateway-state-ui.test.ts`
Expected: PASS with all gateway model compatibility tests green.
