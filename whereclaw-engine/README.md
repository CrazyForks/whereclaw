Place the platform-specific portable runtime here before packaging:

- `node-runtime/`
- `node-runtime/node.exe` on Windows builds, or `node-runtime/bin/node` on macOS builds
- `node-runtime/npm.cmd` on Windows builds, or `node-runtime/bin/npm` on macOS builds
- `node-runtime/control-ui/` on Windows builds, or `node-runtime/bin/control-ui/` on macOS builds
- `openclaw/node_modules/openclaw/openclaw.mjs`
- `openclaw/node_modules/`
- `openclaw/node_modules/openclaw/dist/control-ui/`
- `templates/openclaw.json`

This directory is bundled into the Tauri app as the `whereclaw-engine` resource.

To generate the runtime layout, use:

- `npm run prepare:openclaw-engine` on macOS/Linux
- `npm run prepare:openclaw-engine:windows` on Windows PowerShell
