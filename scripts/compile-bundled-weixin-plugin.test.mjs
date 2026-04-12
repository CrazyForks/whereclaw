import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildWeixinCompileTsconfig,
  patchWeixinPackageManifest,
  promoteCompiledWeixinOutput,
} from "./compile-bundled-weixin-plugin.mjs";

test("patchWeixinPackageManifest points bundled extension entry at index.js", () => {
  const result = patchWeixinPackageManifest({
    name: "@tencent-weixin/openclaw-weixin",
    openclaw: {
      extensions: ["./index.ts"],
    },
  });

  assert.deepEqual(result.openclaw.extensions, ["./index.js"]);
});

test("buildWeixinCompileTsconfig emits js into compiled directory", () => {
  const result = buildWeixinCompileTsconfig();

  assert.equal(result.compilerOptions.module, "NodeNext");
  assert.equal(result.compilerOptions.outDir, "./.whereclaw-compiled");
  assert.deepEqual(result.include, ["index.ts", "src/**/*.ts"]);
});

test("promoteCompiledWeixinOutput copies compiled files into plugin root instead of nesting them", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "whereclaw-weixin-"));
  const compiledRoot = path.join(tempRoot, ".whereclaw-compiled");
  const pluginRoot = path.join(tempRoot, "plugin");

  fs.mkdirSync(path.join(compiledRoot, "src", "monitor"), { recursive: true });
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(compiledRoot, "index.js"), "export default {};\n");
  fs.writeFileSync(
    path.join(compiledRoot, "src", "monitor", "monitor.js"),
    "export const monitorWeixinProvider = () => {};\n",
  );

  promoteCompiledWeixinOutput(compiledRoot, pluginRoot);

  assert.equal(fs.existsSync(path.join(pluginRoot, "index.js")), true);
  assert.equal(
    fs.existsSync(path.join(pluginRoot, "src", "monitor", "monitor.js")),
    true,
  );
  assert.equal(fs.existsSync(path.join(pluginRoot, ".whereclaw-compiled")), false);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
