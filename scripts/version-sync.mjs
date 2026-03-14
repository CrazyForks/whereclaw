import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value, space = 2) {
  const serialized =
    space > 0
      ? `${JSON.stringify(value, null, space)}\n`
      : `${JSON.stringify(value)}\n`;
  writeFileSync(path, serialized);
}

function normalizeVersion(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function replaceCargoVersion(source, version) {
  const match = source.match(/^version\s*=\s*"([^"]+)"/m);

  if (!match) {
    throw new Error('failed to locate Cargo package version');
  }

  return source.replace(match[0], `version = "${version}"`);
}

function createPaths(rootDir) {
  const root = resolve(rootDir);

  return {
    manifest: resolve(root, 'VERSION.json'),
    packageJson: resolve(root, 'package.json'),
    packageLock: resolve(root, 'package-lock.json'),
    tauriConfig: resolve(root, 'src-tauri/tauri.conf.json'),
    cargoToml: resolve(root, 'src-tauri/Cargo.toml'),
    skillsCatalog: resolve(root, 'skills.json'),
  };
}

function ensureManifestShape(manifest) {
  return {
    appVersion: normalizeVersion(manifest.appVersion, 'manifest.appVersion'),
    skillsCatalogVersion: normalizeVersion(
      manifest.skillsCatalogVersion,
      'manifest.skillsCatalogVersion',
    ),
  };
}

function compareValue(mismatches, label, actual, expected) {
  if (actual !== expected) {
    mismatches.push(`${label}: expected ${expected}, received ${actual}`);
  }
}

export async function syncVersionFiles({
  rootDir = process.cwd(),
  fromPackageJson = false,
  check = false,
} = {}) {
  const paths = createPaths(rootDir);

  let manifest = existsSync(paths.manifest) ? readJson(paths.manifest) : null;

  if (fromPackageJson) {
    const packageJson = readJson(paths.packageJson);
    const packageVersion = normalizeVersion(
      packageJson.version,
      'package.json version',
    );
    const existingSkillsCatalogVersion = normalizeVersion(
      manifest?.skillsCatalogVersion ?? packageVersion,
      'skills catalog version',
    );

    manifest = {
      ...(manifest && typeof manifest === 'object' ? manifest : {}),
      appVersion: packageVersion,
      skillsCatalogVersion: existingSkillsCatalogVersion,
    };

    if (!check) {
      writeJson(paths.manifest, manifest, 2);
    }
  }

  if (!manifest) {
    throw new Error(`missing version manifest at ${paths.manifest}`);
  }

  const normalizedManifest = ensureManifestShape(manifest);
  const packageJson = readJson(paths.packageJson);
  const packageLock = existsSync(paths.packageLock)
    ? readJson(paths.packageLock)
    : null;
  const tauriConfig = readJson(paths.tauriConfig);
  const cargoToml = readFileSync(paths.cargoToml, 'utf8');
  const skillsCatalog = readJson(paths.skillsCatalog);

  if (check) {
    const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    const mismatches = [];

    compareValue(
      mismatches,
      'package.json version',
      packageJson.version,
      normalizedManifest.appVersion,
    );
    if (packageLock) {
      compareValue(
        mismatches,
        'package-lock.json version',
        packageLock.version,
        normalizedManifest.appVersion,
      );
      compareValue(
        mismatches,
        'package-lock.json packages[""] version',
        packageLock.packages?.['']?.version,
        normalizedManifest.appVersion,
      );
    }
    compareValue(
      mismatches,
      'src-tauri/tauri.conf.json version',
      tauriConfig.version,
      normalizedManifest.appVersion,
    );
    compareValue(
      mismatches,
      'src-tauri/Cargo.toml version',
      cargoVersion,
      normalizedManifest.appVersion,
    );
    compareValue(
      mismatches,
      'skills.json version field',
      Object.prototype.hasOwnProperty.call(skillsCatalog, 'version'),
      false,
    );

    return { ok: mismatches.length === 0, mismatches, manifest: normalizedManifest };
  }

  packageJson.version = normalizedManifest.appVersion;
  writeJson(paths.packageJson, packageJson, 2);

  if (packageLock) {
    packageLock.version = normalizedManifest.appVersion;
    packageLock.packages = packageLock.packages ?? {};
    packageLock.packages[''] = packageLock.packages[''] ?? {};
    packageLock.packages[''].version = normalizedManifest.appVersion;
    writeJson(paths.packageLock, packageLock, 2);
  }

  tauriConfig.version = normalizedManifest.appVersion;
  writeJson(paths.tauriConfig, tauriConfig, 2);

  writeFileSync(
    paths.cargoToml,
    replaceCargoVersion(cargoToml, normalizedManifest.appVersion),
  );

  delete skillsCatalog.version;
  writeJson(paths.skillsCatalog, skillsCatalog, 0);

  return { ok: true, mismatches: [], manifest: normalizedManifest };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const result = await syncVersionFiles({
    rootDir: process.cwd(),
    fromPackageJson: args.has('--from-package-json'),
    check: args.has('--check'),
  });

  if (!args.has('--check')) {
    console.log(
      `Synchronized app version ${result.manifest.appVersion} and skills catalog version ${result.manifest.skillsCatalogVersion}.`,
    );
    return;
  }

  if (!result.ok) {
    for (const mismatch of result.mismatches) {
      console.error(mismatch);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Version files match manifest: app=${result.manifest.appVersion}, skills=${result.manifest.skillsCatalogVersion}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
