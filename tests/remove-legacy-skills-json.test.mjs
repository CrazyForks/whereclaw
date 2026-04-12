import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("tauri backend no longer exposes legacy skills.json refresh commands", () => {
  const source = read("src-tauri/src/lib.rs");

  assert.equal(source.includes("ensure_remote_skill_catalog_fresh"), false);
  assert.equal(source.includes("read_active_skill_catalog"), false);
  assert.equal(source.includes('include_str!("../../skills.json")'), false);
  assert.equal(source.includes("REMOTE_SKILLS_MANIFEST_URL"), false);
});

test("frontend no longer triggers legacy skills.json refresh on startup", () => {
  const source = read("src/App.tsx");

  assert.equal(source.includes("ensure_remote_skill_catalog_fresh"), false);
});

test("version sync script no longer references the legacy skills.json catalog file", () => {
  const source = read("scripts/version-sync.mjs");

  assert.equal(source.includes("skills.json"), false);
  assert.equal(source.includes("skillsCatalogVersion"), false);
});
