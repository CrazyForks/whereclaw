import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function patchWeixinPackageManifest(manifest) {
  const nextManifest = { ...manifest };
  const extensions = Array.isArray(manifest.openclaw?.extensions)
    ? manifest.openclaw.extensions.map((entry) =>
        entry === "./index.ts" ? "./index.js" : entry,
      )
    : ["./index.js"];

  nextManifest.openclaw = {
    ...manifest.openclaw,
    extensions,
  };

  return nextManifest;
}

export function buildWeixinCompileTsconfig() {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      rootDir: ".",
      outDir: "./.whereclaw-compiled",
      declaration: false,
      sourceMap: false,
      skipLibCheck: true,
      resolveJsonModule: true,
      allowSyntheticDefaultImports: true,
      verbatimModuleSyntax: true,
    },
    include: ["index.ts", "src/**/*.ts"],
  };
}

export function promoteCompiledWeixinOutput(compiledRoot, pluginRoot) {
  for (const entryName of fs.readdirSync(compiledRoot)) {
    fs.cpSync(path.join(compiledRoot, entryName), path.join(pluginRoot, entryName), {
      recursive: true,
      force: true,
    });
  }
}

export function compileBundledWeixinPlugin(pluginRoot) {
  const normalizedPluginRoot = path.resolve(pluginRoot);
  const packageJsonPath = path.join(normalizedPluginRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const tscScriptPath = path.resolve(__dirname, "../node_modules/typescript/bin/tsc");
  const tsconfigPath = path.join(normalizedPluginRoot, ".whereclaw-tsconfig.json");
  const compiledRoot = path.join(normalizedPluginRoot, ".whereclaw-compiled");

  fs.writeFileSync(
    tsconfigPath,
    `${JSON.stringify(buildWeixinCompileTsconfig(), null, 2)}\n`,
  );

  const compileResult = spawnSync(process.execPath, [tscScriptPath, "-p", tsconfigPath], {
    cwd: normalizedPluginRoot,
    stdio: "inherit",
  });

  if (compileResult.status !== 0) {
    throw new Error(`TypeScript compile failed with exit code ${compileResult.status ?? 1}`);
  }

  promoteCompiledWeixinOutput(compiledRoot, normalizedPluginRoot);
  fs.rmSync(compiledRoot, { recursive: true, force: true });
  fs.rmSync(tsconfigPath, { force: true });
  fs.writeFileSync(
    packageJsonPath,
    `${JSON.stringify(patchWeixinPackageManifest(manifest), null, 2)}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const pluginRoot = process.argv[2];
  if (!pluginRoot) {
    throw new Error("Usage: node scripts/compile-bundled-weixin-plugin.mjs <plugin-root>");
  }

  compileBundledWeixinPlugin(pluginRoot);
}
