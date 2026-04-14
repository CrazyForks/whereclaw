import test from "node:test";
import assert from "node:assert/strict";

test("shared macOS packaging helper resolves DMG names from VERSION.json", async () => {
  const module = await import("../scripts/package-version.mjs");

  assert.equal(module.readAppVersion(process.cwd()), "1.1.0");
  assert.equal(
    module.buildMacosDmgFilename({
      rootDir: process.cwd(),
      archLabel: "aarch64",
      buildVariant: "local",
    }),
    "WhereClaw_1.1.0_aarch64_local.dmg",
  );
  assert.equal(
    module.buildMacosDmgFilename({
      rootDir: process.cwd(),
      archLabel: "x64",
      buildVariant: "ci",
    }),
    "WhereClaw_1.1.0_x64_ci.dmg",
  );
});
