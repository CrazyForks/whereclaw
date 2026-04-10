param(
  [string]$NodeVersion = "22.20.0"
)

$ErrorActionPreference = "Stop"

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}
catch {
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$RootDir = Split-Path -Parent $PSScriptRoot
$EngineDir = Join-Path $RootDir "whereclaw-engine"
$NodeRuntimeDir = Join-Path $EngineDir "node-runtime"
$OllamaRootDir = Join-Path $EngineDir "ollama"
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("whereclaw-engine-" + [System.Guid]::NewGuid().ToString("N"))
$NpmCacheDir = Join-Path $TempDir "npm-cache"
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
  "synology-chat",
  "tlon",
  "twitch",
  "zalo",
  "zalouser"
)

function Get-WindowsArchitecture {
  if ([Environment]::Is64BitOperatingSystem) {
    if ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64' -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
      return 'ARM64'
    }
    return 'AMD64'
  }

  return $env:PROCESSOR_ARCHITECTURE
}

function Remove-DirectoryIfExists {
  param([string]$PathValue)
  if (-not (Test-Path $PathValue)) {
    return
  }

  try {
    Get-ChildItem -LiteralPath $PathValue -Recurse -Force -ErrorAction SilentlyContinue |
      ForEach-Object {
        if (-not $_.PSIsContainer) {
          $_.Attributes = 'Archive'
        }
      }
  }
  catch {
  }

  try {
    Remove-Item -LiteralPath $PathValue -Recurse -Force -ErrorAction Stop
    return
  }
  catch {
    if (Test-Path $PathValue) {
      cmd /c rd /s /q "$PathValue" | Out-Null
    }
  }

  if (Test-Path $PathValue) {
    throw "Failed to remove directory: $PathValue"
  }
}

function Stop-BundledWhereClawProcesses {
  $NormalizedEngineDir = [System.IO.Path]::GetFullPath($EngineDir)
  $NormalizedNodeRuntimeDir = [System.IO.Path]::GetFullPath($NodeRuntimeDir)
  $NormalizedOllamaRootDir = [System.IO.Path]::GetFullPath($OllamaRootDir)

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $ExecutablePath = $_.ExecutablePath
      if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
        return $false
      }

      $FullPath = [System.IO.Path]::GetFullPath($ExecutablePath)
      $FullPath.StartsWith($NormalizedNodeRuntimeDir, [System.StringComparison]::OrdinalIgnoreCase) -or
      $FullPath.StartsWith($NormalizedOllamaRootDir, [System.StringComparison]::OrdinalIgnoreCase) -or
      $FullPath.StartsWith($NormalizedEngineDir, [System.StringComparison]::OrdinalIgnoreCase)
    } |
    ForEach-Object {
      try {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
      }
      catch {
      }
    }
}

function Write-Utf8File {
  param(
    [string]$PathValue,
    [string]$Content
  )

  [System.IO.File]::WriteAllText($PathValue, $Content, $Utf8NoBom)
}

function Download-File {
  param(
    [string]$Uri,
    [string]$OutFile,
    [string]$Label
  )

  $CurlCmd = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($CurlCmd) {
    Write-Host "Downloading $Label with curl..."
    & $CurlCmd.Source --fail --location --retry 3 --retry-delay 2 --output $OutFile $Uri
    if ($LASTEXITCODE -eq 0 -and (Test-Path $OutFile)) {
      return
    }

    Write-Warning "curl download failed for $Label, falling back to Invoke-WebRequest."
    Remove-Item -Force $OutFile -ErrorAction SilentlyContinue
  }

  Write-Host "Downloading $Label with Invoke-WebRequest..."
  Invoke-WebRequest -Uri $Uri -OutFile $OutFile
}

function Sanitize-OptionalPluginManifest {
  param([string]$PluginRoot)

  $PackageJsonPath = Join-Path $PluginRoot 'package.json'
  if (-not (Test-Path $PackageJsonPath)) {
    return $false
  }

  $OriginalContent = Get-Content -Path $PackageJsonPath -Raw
  $SanitizedContent = [regex]::Replace(
    $OriginalContent,
    '(?m)^\s*"[^"]+"\s*:\s*"(?:file|workspace):[^"]*"\s*,?\r?\n',
    ''
  )
  $SanitizedContent = [regex]::Replace($SanitizedContent, ',(\s*[}\]])', '$1')

  if ($SanitizedContent -eq $OriginalContent) {
    return $false
  }

  Write-Warning "Removing unsafe file:/workspace: dependencies from $(Split-Path $PluginRoot -Leaf) before packaging."
  Write-Utf8File -PathValue $PackageJsonPath -Content $SanitizedContent
  Remove-Item -Force (Join-Path $PluginRoot 'package-lock.json') -ErrorAction SilentlyContinue
  return $true
}

function Remove-UnsafePluginLocalLinks {
  param([string]$PluginRoot)

  $PluginNodeModules = Join-Path $PluginRoot 'node_modules'
  if (-not (Test-Path $PluginNodeModules)) {
    return
  }

  @('whereclaw', 'openclaw') | ForEach-Object {
    $UnsafePath = Join-Path $PluginNodeModules $_
    if (Test-Path $UnsafePath) {
      Write-Warning "Removing unsafe local linked dependency from $(Split-Path $PluginRoot -Leaf): $_"
      Remove-DirectoryIfExists $UnsafePath
    }
  }
}

function Install-OptionalChannelPluginDependencies {
  $ExtensionsRoot = Join-Path $EngineDir "openclaw\node_modules\openclaw\dist\extensions"
  if (-not (Test-Path $ExtensionsRoot)) {
    return
  }

  foreach ($PluginDir in $OptionalChannelPluginDirs) {
    $PluginRoot = Join-Path $ExtensionsRoot $PluginDir
    $PluginPackageJson = Join-Path $PluginRoot "package.json"
    $PluginNodeModules = Join-Path $PluginRoot "node_modules"

    if (-not (Test-Path $PluginPackageJson)) {
      continue
    }

    Remove-DirectoryIfExists $PluginNodeModules
    $ManifestWasSanitized = Sanitize-OptionalPluginManifest -PluginRoot $PluginRoot

    Write-Host "Installing bundled plugin dependencies for $PluginDir..."
    $OriginalNpmConfigCache = $env:NPM_CONFIG_CACHE
    $OriginalLowerNpmConfigCache = $env:npm_config_cache
    try {
      $env:NPM_CONFIG_CACHE = $NpmCacheDir
      $env:npm_config_cache = $NpmCacheDir
      & $NpmCmd install --prefix $PluginRoot --no-audit --no-fund --omit=dev
      if ($LASTEXITCODE -ne 0) {
        throw "npm install exited with code $LASTEXITCODE"
      }

      Remove-UnsafePluginLocalLinks -PluginRoot $PluginRoot
    }
    catch {
      if ($ManifestWasSanitized) {
        Write-Warning "Plugin dependency install still failed for $PluginDir after sanitizing unsafe local dependencies."
      }
      else {
        Write-Warning "Skipping optional plugin dependency install for $PluginDir due to npm install failure."
      }
      Remove-DirectoryIfExists $PluginNodeModules
    }
    finally {
      $env:NPM_CONFIG_CACHE = $OriginalNpmConfigCache
      $env:npm_config_cache = $OriginalLowerNpmConfigCache
    }
  }
}

function Get-OllamaPlatformDir {
  switch (Get-WindowsArchitecture) {
    "ARM64" { return "windows-arm64" }
    "AMD64" { return "windows-x64" }
    default { throw "Unsupported Windows architecture for Ollama: $(Get-WindowsArchitecture)" }
  }
}

function Get-OllamaArchiveName {
  switch (Get-WindowsArchitecture) {
    "ARM64" { return "ollama-windows-arm64.zip" }
    "AMD64" { return "ollama-windows-amd64.zip" }
    default { throw "Unsupported Windows architecture for Ollama: $(Get-WindowsArchitecture)" }
  }
}

function Get-NodeArchiveName {
  switch (Get-WindowsArchitecture) {
    "ARM64" { return "node-v$NodeVersion-win-arm64.zip" }
    "AMD64" { return "node-v$NodeVersion-win-x64.zip" }
    default { throw "Unsupported Windows architecture: $(Get-WindowsArchitecture)" }
  }
}

function Test-ExistingNodeRuntime {
  $NodeExePath = Join-Path $NodeRuntimeDir "node.exe"
  $NpmCmdPath = Join-Path $NodeRuntimeDir "npm.cmd"
  $NodeVersionPath = Join-Path $NodeRuntimeDir "VERSION"

  if (-not ((Test-Path $NodeExePath) -and (Test-Path $NpmCmdPath) -and (Test-Path $NodeVersionPath))) {
    return $false
  }

  $ExistingVersion = (Get-Content -Path $NodeVersionPath -Raw).Trim()
  return $ExistingVersion -eq $NodeVersion
}

try {
  Stop-BundledWhereClawProcesses
  New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
  New-Item -ItemType Directory -Force -Path $EngineDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $EngineDir "openclaw") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $EngineDir "templates") | Out-Null
  New-Item -ItemType Directory -Force -Path $OllamaRootDir | Out-Null
  New-Item -ItemType Directory -Force -Path $NpmCacheDir | Out-Null

  $ArchiveName = Get-NodeArchiveName
  $ArchivePath = Join-Path $TempDir $ArchiveName
  $ExtractDir = Join-Path $TempDir "node-extract"

  if (Test-ExistingNodeRuntime) {
    Write-Host "Reusing bundled Node.js runtime $NodeVersion from $NodeRuntimeDir"
  }
  else {
    Write-Host "Downloading Node.js $NodeVersion ($ArchiveName)..."
    Download-File -Uri "https://nodejs.org/dist/v$NodeVersion/$ArchiveName" -OutFile $ArchivePath -Label "Node.js $NodeVersion"
    Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force

    $RuntimeRoot = Get-ChildItem -Path $ExtractDir -Directory | Select-Object -First 1
    if (-not $RuntimeRoot) {
      throw "Unable to locate the extracted Node runtime directory."
    }

    Remove-DirectoryIfExists $NodeRuntimeDir
    New-Item -ItemType Directory -Force -Path $NodeRuntimeDir | Out-Null
    Copy-Item -Recurse -Force (Join-Path $RuntimeRoot.FullName "*") $NodeRuntimeDir
    Set-Content -Path (Join-Path $NodeRuntimeDir "VERSION") -Value $NodeVersion
  }

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

  Write-Host "Downloading latest Ollama ($OllamaArchiveName)..."
  Download-File -Uri "https://github.com/ollama/ollama/releases/latest/download/$OllamaArchiveName" -OutFile $OllamaArchivePath -Label "latest Ollama"
  Expand-Archive -Path $OllamaArchivePath -DestinationPath $OllamaExtractDir -Force

  Remove-DirectoryIfExists $OllamaRuntimeDir
  New-Item -ItemType Directory -Force -Path $OllamaRuntimeDir | Out-Null
  Copy-Item -Recurse -Force (Join-Path $OllamaExtractDir "*") $OllamaRuntimeDir

  $OllamaExe = Join-Path $OllamaRuntimeDir "ollama.exe"
  if (-not (Test-Path $OllamaExe)) {
    throw "Bundled Ollama runtime is missing ollama.exe."
  }
  $OllamaVersionOutput = & $OllamaExe --version
  $OllamaVersionMatch = [regex]::Match($OllamaVersionOutput, '([0-9]+\.[0-9]+\.[0-9]+)')
  if (-not $OllamaVersionMatch.Success) {
    throw "Unable to determine downloaded Ollama version from: $OllamaVersionOutput"
  }
  $ResolvedOllamaVersion = $OllamaVersionMatch.Groups[1].Value
  Set-Content -Path (Join-Path $OllamaRootDir "VERSION") -Value $ResolvedOllamaVersion

  $InstallRoot = Join-Path $TempDir "openclaw-install"
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

  Write-Host "Installing OpenClaw package openclaw@latest..."
  $OriginalPath = $env:Path
  $OriginalNpmConfigCache = $env:NPM_CONFIG_CACHE
  $OriginalLowerNpmConfigCache = $env:npm_config_cache
  try {
    $env:Path = "$NodeRuntimeDir;$OriginalPath"
    $env:NPM_CONFIG_CACHE = $NpmCacheDir
    $env:npm_config_cache = $NpmCacheDir
    & $NpmCmd init -y --prefix $InstallRoot | Out-Null
    & $NpmCmd install --prefix $InstallRoot --no-audit --no-fund --omit=dev openclaw@latest
  }
  finally {
    $env:Path = $OriginalPath
    $env:NPM_CONFIG_CACHE = $OriginalNpmConfigCache
    $env:npm_config_cache = $OriginalLowerNpmConfigCache
  }

  Remove-DirectoryIfExists (Join-Path $EngineDir "openclaw\node_modules")
  Copy-Item -Recurse -Force (Join-Path $InstallRoot "node_modules") (Join-Path $EngineDir "openclaw\node_modules")
  Copy-Item -Force (Join-Path $InstallRoot "package.json") (Join-Path $EngineDir "openclaw\package.json")

  $PackageLock = Join-Path $InstallRoot "package-lock.json"
  if (Test-Path $PackageLock) {
    Copy-Item -Force $PackageLock (Join-Path $EngineDir "openclaw\package-lock.json")
  }

  $EntryPath = Join-Path $EngineDir "openclaw\node_modules\openclaw\openclaw.mjs"
  $UiPath = Join-Path $EngineDir "openclaw\node_modules\openclaw\dist\control-ui\index.html"
  $RuntimeUiDir = Join-Path $NodeRuntimeDir "control-ui"
  $RuntimeUiIndex = Join-Path $RuntimeUiDir "index.html"

  if (-not (Test-Path $EntryPath)) {
    throw "Installed OpenClaw entry script was not found."
  }

  if (-not (Test-Path $UiPath)) {
    throw "Installed OpenClaw Control UI assets were not found."
  }

  Remove-DirectoryIfExists $RuntimeUiDir
  Copy-Item -Recurse -Force (Join-Path $EngineDir "openclaw\node_modules\openclaw\dist\control-ui") $RuntimeUiDir

  Install-OptionalChannelPluginDependencies

  $TemplatePath = Join-Path $EngineDir "templates\openclaw.json"
  if (-not (Test-Path $TemplatePath)) {
    Set-Content -Path $TemplatePath -Value "{}"
  }

  Write-Host ""
  Write-Host "Prepared whereclaw-engine successfully."
  Write-Host "Node version:      $NodeVersion"
  Write-Host "OpenClaw package:  openclaw@latest"
  Write-Host "Node runtime:      $NodeRuntimeDir"
  Write-Host "Node binary:       $NodeExe"
  Write-Host "NPM binary:        $NpmCmd"
  Write-Host "Ollama version:    $ResolvedOllamaVersion"
  Write-Host "Ollama runtime:    $OllamaRuntimeDir"
  Write-Host "Ollama binary:     $OllamaExe"
  Write-Host "OpenClaw entry:    $EntryPath"
  Write-Host "Control UI:        $UiPath"
  Write-Host "Runtime UI copy:   $RuntimeUiIndex"
}
finally {
  Remove-DirectoryIfExists $TempDir
}
