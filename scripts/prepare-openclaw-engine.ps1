param(
  [string]$OpenClawPackage = "openclaw-cn@latest",
  [string]$NodeVersion = "22.20.0",
  [string]$OllamaVersion = "0.17.7"
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$EngineDir = Join-Path $RootDir "whereclaw-engine"
$NodeRuntimeDir = Join-Path $EngineDir "node-runtime"
$OllamaRootDir = Join-Path $EngineDir "ollama"
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("whereclaw-engine-" + [System.Guid]::NewGuid().ToString("N"))
$OptionalChannelPluginDirs = @(
  "bluebubbles",
  "feishu",
  "googlechat",
  "line",
  "matrix",
  "mattermost",
  "msteams",
  "nextcloud-talk",
  "nostr",
  "qqbot",
  "synology-chat",
  "tlon",
  "twitch",
  "zalo",
  "zalouser"
)

function Remove-DirectoryIfExists {
  param([string]$PathValue)
  if (Test-Path $PathValue) {
    Remove-Item -Recurse -Force $PathValue
  }
}

function Install-OptionalChannelPluginDependencies {
  $ExtensionsRoot = Join-Path $EngineDir "openclaw\node_modules\openclaw-cn\extensions"
  if (-not (Test-Path $ExtensionsRoot)) {
    return
  }

  foreach ($PluginDir in $OptionalChannelPluginDirs) {
    $PluginRoot = Join-Path $ExtensionsRoot $PluginDir
    $PluginPackageJson = Join-Path $PluginRoot "package.json"
    if (Test-Path $PluginPackageJson) {
      Write-Host "Installing bundled plugin dependencies for $PluginDir..."
      try {
        & $NpmCmd install --prefix $PluginRoot --no-audit --no-fund --omit=dev
      }
      catch {
        Write-Warning "Skipping optional plugin dependency install for $PluginDir due to npm install failure."
      }
    }
  }
}

function Get-OllamaPlatformDir {
  switch ($env:PROCESSOR_ARCHITECTURE) {
    "ARM64" { return "windows-arm64" }
    "AMD64" { return "windows-x64" }
    default { throw "Unsupported Windows architecture for Ollama: $($env:PROCESSOR_ARCHITECTURE)" }
  }
}

function Get-OllamaArchiveName {
  switch ($env:PROCESSOR_ARCHITECTURE) {
    "ARM64" { return "ollama-windows-arm64.zip" }
    "AMD64" { return "ollama-windows-amd64.zip" }
    default { throw "Unsupported Windows architecture for Ollama: $($env:PROCESSOR_ARCHITECTURE)" }
  }
}

function Get-NodeArchiveName {
  switch ($env:PROCESSOR_ARCHITECTURE) {
    "ARM64" { return "node-v$NodeVersion-win-arm64.zip" }
    "AMD64" { return "node-v$NodeVersion-win-x64.zip" }
    default { throw "Unsupported Windows architecture: $($env:PROCESSOR_ARCHITECTURE)" }
  }
}

try {
  New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
  New-Item -ItemType Directory -Force -Path $EngineDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $EngineDir "openclaw") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $EngineDir "templates") | Out-Null
  New-Item -ItemType Directory -Force -Path $OllamaRootDir | Out-Null

  $ArchiveName = Get-NodeArchiveName
  $ArchivePath = Join-Path $TempDir $ArchiveName
  $ExtractDir = Join-Path $TempDir "node-extract"

  Write-Host "Downloading Node.js $NodeVersion ($ArchiveName)..."
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/$ArchiveName" -OutFile $ArchivePath
  Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force

  $RuntimeRoot = Get-ChildItem -Path $ExtractDir -Directory | Select-Object -First 1
  if (-not $RuntimeRoot) {
    throw "Unable to locate the extracted Node runtime directory."
  }

  Remove-DirectoryIfExists $NodeRuntimeDir
  New-Item -ItemType Directory -Force -Path $NodeRuntimeDir | Out-Null
  Copy-Item -Recurse -Force (Join-Path $RuntimeRoot.FullName "*") $NodeRuntimeDir

  $NodeExe = Join-Path $NodeRuntimeDir "node.exe"
  $NpmCmd = Join-Path $NodeRuntimeDir "npm.cmd"
  if (-not (Test-Path $NodeExe)) {
    throw "Bundled Node runtime is missing node.exe."
  }
  if (-not (Test-Path $NpmCmd)) {
    throw "Bundled Node runtime is missing npm.cmd."
  }

  $OllamaArchiveName = Get-OllamaArchiveName
  $OllamaArchivePath = Join-Path $TempDir $OllamaArchiveName
  $OllamaExtractDir = Join-Path $TempDir "ollama-extract"
  $OllamaPlatformDir = Get-OllamaPlatformDir
  $OllamaRuntimeDir = Join-Path $OllamaRootDir $OllamaPlatformDir

  Write-Host "Downloading Ollama $OllamaVersion ($OllamaArchiveName)..."
  Invoke-WebRequest -Uri "https://github.com/ollama/ollama/releases/download/v$OllamaVersion/$OllamaArchiveName" -OutFile $OllamaArchivePath
  Expand-Archive -Path $OllamaArchivePath -DestinationPath $OllamaExtractDir -Force

  Remove-DirectoryIfExists $OllamaRuntimeDir
  New-Item -ItemType Directory -Force -Path $OllamaRuntimeDir | Out-Null
  Copy-Item -Recurse -Force (Join-Path $OllamaExtractDir "*") $OllamaRuntimeDir

  $OllamaExe = Join-Path $OllamaRuntimeDir "ollama.exe"
  if (-not (Test-Path $OllamaExe)) {
    throw "Bundled Ollama runtime is missing ollama.exe."
  }

  $InstallRoot = Join-Path $TempDir "openclaw-install"
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

  Write-Host "Installing OpenClaw package $OpenClawPackage..."
  $OriginalPath = $env:Path
  try {
    $env:Path = "$NodeRuntimeDir;$OriginalPath"
    & $NpmCmd init -y --prefix $InstallRoot | Out-Null
    & $NpmCmd install --prefix $InstallRoot --no-audit --no-fund --omit=dev $OpenClawPackage
  }
  finally {
    $env:Path = $OriginalPath
  }

  Remove-DirectoryIfExists (Join-Path $EngineDir "openclaw\node_modules")
  Copy-Item -Recurse -Force (Join-Path $InstallRoot "node_modules") (Join-Path $EngineDir "openclaw\node_modules")
  Copy-Item -Force (Join-Path $InstallRoot "package.json") (Join-Path $EngineDir "openclaw\package.json")

  $PackageLock = Join-Path $InstallRoot "package-lock.json"
  if (Test-Path $PackageLock) {
    Copy-Item -Force $PackageLock (Join-Path $EngineDir "openclaw\package-lock.json")
  }

  $EntryPath = Join-Path $EngineDir "openclaw\node_modules\openclaw-cn\dist\entry.js"
  $UiPath = Join-Path $EngineDir "openclaw\node_modules\openclaw-cn\dist\control-ui\index.html"
  $RuntimeUiDir = Join-Path $NodeRuntimeDir "control-ui"
  $RuntimeUiIndex = Join-Path $RuntimeUiDir "index.html"

  if (-not (Test-Path $EntryPath)) {
    throw "Installed OpenClaw entry script was not found."
  }

  if (-not (Test-Path $UiPath)) {
    throw "Installed OpenClaw Control UI assets were not found."
  }

  Remove-DirectoryIfExists $RuntimeUiDir
  Copy-Item -Recurse -Force (Join-Path $EngineDir "openclaw\node_modules\openclaw-cn\dist\control-ui") $RuntimeUiDir

  Install-OptionalChannelPluginDependencies

  Set-Content -Path (Join-Path $OllamaRootDir "VERSION") -Value $OllamaVersion

  $TemplatePath = Join-Path $EngineDir "templates\openclaw.json"
  if (-not (Test-Path $TemplatePath)) {
    Set-Content -Path $TemplatePath -Value "{}"
  }

  Write-Host ""
  Write-Host "Prepared whereclaw-engine successfully."
  Write-Host "Node version:      $NodeVersion"
  Write-Host "OpenClaw package:  $OpenClawPackage"
  Write-Host "Node runtime:      $NodeRuntimeDir"
  Write-Host "Node binary:       $NodeExe"
  Write-Host "NPM binary:        $NpmCmd"
  Write-Host "Ollama version:    $OllamaVersion"
  Write-Host "Ollama runtime:    $OllamaRuntimeDir"
  Write-Host "Ollama binary:     $OllamaExe"
  Write-Host "OpenClaw entry:    $EntryPath"
  Write-Host "Control UI:        $UiPath"
  Write-Host "Runtime UI copy:   $RuntimeUiIndex"
}
finally {
  Remove-DirectoryIfExists $TempDir
}
