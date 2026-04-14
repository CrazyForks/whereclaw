import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readAppVersion(rootDir = process.cwd()) {
  const manifest = readJson(resolve(rootDir, "VERSION.json"));
  const version = manifest?.appVersion;

  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("VERSION.json appVersion must be a non-empty string");
  }

  return version.trim();
}

export function buildMacosDmgFilename({
  rootDir = process.cwd(),
  archLabel,
  buildVariant,
}) {
  if (typeof archLabel !== "string" || archLabel.trim() === "") {
    throw new Error("archLabel must be a non-empty string");
  }
  if (typeof buildVariant !== "string" || buildVariant.trim() === "") {
    throw new Error("buildVariant must be a non-empty string");
  }

  const version = readAppVersion(rootDir);
  return `WhereClaw_${version}_${archLabel.trim()}_${buildVariant.trim()}.dmg`;
}

export function buildMacosDmgPath({
  rootDir = process.cwd(),
  archDir,
  archLabel,
  buildVariant,
}) {
  if (typeof archDir !== "string" || archDir.trim() === "") {
    throw new Error("archDir must be a non-empty string");
  }

  return resolve(
    rootDir,
    "release-artifacts",
    `${archDir.trim()}-${buildVariant.trim()}`,
    buildMacosDmgFilename({ rootDir, archLabel, buildVariant }),
  );
}

function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "version") {
    console.log(readAppVersion());
    return;
  }

  if (command === "macos-dmg-filename") {
    const [archLabel, buildVariant] = args;
    console.log(buildMacosDmgFilename({ archLabel, buildVariant }));
    return;
  }

  if (command === "macos-dmg-path") {
    const [archDir, archLabel, buildVariant] = args;
    console.log(buildMacosDmgPath({ archDir, archLabel, buildVariant }));
    return;
  }

  throw new Error(
    "usage: node scripts/package-version.mjs <version|macos-dmg-filename|macos-dmg-path> ...args",
  );
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
