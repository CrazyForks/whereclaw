$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent $PSScriptRoot
$Target = 'x86_64-pc-windows-msvc'
$ReleaseDir = Join-Path $RootDir "src-tauri\target\$Target\release"
$PortableRoot = Join-Path $ReleaseDir 'portable\WhereClaw'
$OutDir = Join-Path $RootDir 'release-artifacts\windows-x64'
$ZipPath = Join-Path $OutDir 'WhereClaw_x86_64-pc-windows-msvc_portable.zip'

Set-Location $RootDir
npm ci
npm run prepare:openclaw-engine:windows
npm run tauri build -- --target $Target

Remove-Item -Recurse -Force $PortableRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $PortableRoot | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Copy-Item (Join-Path $ReleaseDir 'app.exe') (Join-Path $PortableRoot 'WhereClaw.exe')
Copy-Item -Recurse -Force (Join-Path $RootDir 'whereclaw-engine') (Join-Path $PortableRoot 'whereclaw-engine')
Remove-Item -Force $ZipPath -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $PortableRoot '*') -DestinationPath $ZipPath -Force
Write-Host "Created $ZipPath"
