import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("tauri backend exposes remote desktop manifest command", () => {
  const source = read("src-tauri/src/lib.rs");

  assert.equal(source.includes("REMOTE_DESKTOP_MANIFEST_URL"), true);
  assert.equal(source.includes("read_remote_manifest_state"), true);
  assert.equal(source.includes("https://r2.tolearn.cc/manifest.json"), true);
});

test("tauri invoke handler registers remote desktop manifest command", () => {
  const source = read("src-tauri/src/lib.rs");

  assert.equal(
    source.includes("read_remote_manifest_state,"),
    true,
  );
});

test("frontend requests remote desktop manifest state on startup", () => {
  const source = read("src/App.tsx");

  assert.equal(source.includes('"read_remote_manifest_state"'), true);
});

test("frontend renders remote notifications and update button", () => {
  const source = read("src/App.tsx");

  assert.equal(source.includes("remoteNotifications"), true);
  assert.equal(source.includes("hasRemoteUpdate"), true);
  assert.equal(source.includes("copy.updateAvailableLabel"), true);
  assert.equal(source.includes("handleOpenWhereClawWebsite"), true);
  assert.equal(source.includes("RemoteUpdateIcon"), true);
  assert.equal(source.includes("handleDismissRemoteNotifications"), true);
  assert.equal(source.includes("CloseIcon"), true);
});

test("launcher preferences persist dismissed notification fingerprints", () => {
  const frontendSource = read("src/App.tsx");
  const backendSource = read("src-tauri/src/lib.rs");

  assert.equal(
    frontendSource.includes("dismissedRemoteNotificationFingerprintZhCn"),
    true,
  );
  assert.equal(
    frontendSource.includes("dismissedRemoteNotificationFingerprintEn"),
    true,
  );
  assert.equal(
    backendSource.includes("dismissed_remote_notification_fingerprint_zh_cn"),
    true,
  );
  assert.equal(
    backendSource.includes("dismissed_remote_notification_fingerprint_en"),
    true,
  );
});
