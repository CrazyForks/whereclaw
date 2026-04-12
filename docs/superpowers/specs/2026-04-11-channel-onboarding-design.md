# Channel Onboarding Design

## Goal

Update the final initialization step so WhereClaw offers `WeChat`, `QQ`, or `Skip for now`, defaults to WeChat, and treats both WeChat and QQ as preinstalled channel options. WeChat should complete its QR login flow from the WhereClaw onboarding UI instead of deferring to a later manual install.

## Current State

- The onboarding flow ends on a dedicated `qq` screen.
- QQ is configured directly by writing `channels.qqbot.appId` and `channels.qqbot.clientSecret`.
- WeChat is not bundled by WhereClaw and is not part of onboarding.
- Engine preparation only installs OpenClaw itself and bundled optional plugin dependencies already present under `openclaw/dist/extensions`.

## Requirements

- Replace the final `QQ only` decision with a channel selection step:
  - default selection is `WeChat`
  - second choice is `QQ`
  - third choice is `Skip for now`
- Keep QQ direct configuration in-app.
- Bundle the WeChat plugin ahead of time instead of installing it at first selection.
- Let WeChat onboarding complete from WhereClaw:
  - enable the bundled WeChat plugin
  - start QR login
  - show the QR code in the WhereClaw UI
  - wait for login completion
  - finish initialization when login succeeds

## Design

### Engine Packaging

- During engine preparation, download and unpack `@tencent-weixin/openclaw-weixin` into `whereclaw-engine/openclaw/node_modules/openclaw/dist/extensions/openclaw-weixin`.
- Install the plugin's production dependencies during engine preparation so released bundles contain a ready-to-load plugin tree.
- QQ remains the official bundled `qqbot` extension shipped by OpenClaw, but onboarding will now treat it as a first-class preinstalled option alongside WeChat.

### Onboarding UI

- Replace the `qq` screen with a generalized channel onboarding screen.
- The screen contains three choices:
  - WeChat
  - QQ
  - Skip for now
- WeChat is preselected on first entry.
- Conditional sub-content:
  - WeChat: explanation, QR login status, QR image area, retry-safe progress messaging
  - QQ: existing AppID/App Secret instructions and inputs
  - Skip: no extra inputs

### Backend

- Expand initial setup request payload to carry `channelSelection` plus QQ credentials when needed.
- Add backend support to:
  - mark WeChat as enabled in config
  - invoke the bundled WeChat plugin QR start/wait methods through Node
  - return QR login payloads to the frontend
- Preserve the existing QQ config writer for `qqbot`.

### WeChat Login Flow

- Use the bundled Node runtime plus the bundled WeChat plugin source under `openclaw/dist/extensions/openclaw-weixin`.
- Call the plugin's QR login helpers directly rather than shelling out to the interactive CLI:
  - `loginWithQrStart` returns the QR data URL and session key
  - `loginWithQrWait` blocks until success, timeout, or failure
- Store completion in normal OpenClaw state so the channel appears in channel management after onboarding.

### Validation

- Add pure logic tests for channel onboarding button state.
- Add Rust unit tests for:
  - WeChat plugin config enablement
  - preinstalled plugin metadata writing
  - request-to-config behavior for channel selection
- Run targeted tests plus project build/lint verification.
