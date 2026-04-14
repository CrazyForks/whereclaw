import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("tray icon svgs reuse the lobster silhouette rather than fallback paw shapes", () => {
  const macos = read("src-tauri/icons/tray-icon-macos.svg");
  const windows = read("src-tauri/icons/tray-icon-windows.svg");
  const lobsterPathSnippet = 'd="m135.88 214.09c0 0-23.25 14.58-12.91 26.35';

  assert.ok(macos.includes(lobsterPathSnippet));
  assert.ok(windows.includes(lobsterPathSnippet));
  assert.ok(!macos.includes("<circle"));
  assert.ok(!windows.includes("<circle"));
});

test("macos tray icon png keeps transparent corners for template rendering", () => {
  const output = execFileSync(
    "python3",
    [
      "-c",
      [
        "from PIL import Image",
        "img = Image.open('src-tauri/icons/tray-icon-macos.png').convert('RGBA')",
        "print(img.getpixel((0, 0))[3])",
        "print(img.getpixel((63, 63))[3])",
      ].join("; "),
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  )
    .trim()
    .split(/\s+/)
    .map(Number);

  assert.deepEqual(output, [0, 0]);
});
