$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent $PSScriptRoot
$Target = 'x86_64-pc-windows-msvc'
$BuildVariant = if ([string]::IsNullOrWhiteSpace($env:WHERECLAW_BUILD_VARIANT)) { 'local' } else { $env:WHERECLAW_BUILD_VARIANT }
$ReleaseDir = Join-Path $RootDir "src-tauri\target\$Target\release"
$OutDir = Join-Path $RootDir "release-artifacts\windows-x64-$BuildVariant"
$StageRoot = Join-Path $env:TEMP ("wc-portable-" + [System.Guid]::NewGuid().ToString('N'))
$PortableRoot = Join-Path $StageRoot 'WhereClaw'
$ZipPath = Join-Path $OutDir "WhereClaw_x86_64-pc-windows-msvc_${BuildVariant}_portable.zip"

function Ensure-ToolOnPath {
  param(
    [string]$CommandName,
    [string[]]$CandidatePaths
  )

  if (Get-Command $CommandName -ErrorAction SilentlyContinue) {
    return
  }

  foreach ($Candidate in $CandidatePaths) {
    if (-not [string]::IsNullOrWhiteSpace($Candidate) -and (Test-Path $Candidate)) {
      $env:Path = "$Candidate;$env:Path"
      if (Get-Command $CommandName -ErrorAction SilentlyContinue) {
        return
      }
    }
  }

  throw "Required tool '$CommandName' was not found in PATH."
}

function Invoke-Step {
  param(
    [string]$Label,
    [scriptblock]$Action
  )

  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

function Invoke-Robocopy {
  param(
    [string]$Source,
    [string]$Destination,
    [string]$Label,
    [string[]]$ExcludeDirs = @()
  )

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $Arguments = @($Source, $Destination, '/E', '/XJ', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($ExcludeDirs.Count -gt 0) {
    $Arguments += '/XD'
    $Arguments += $ExcludeDirs
  }

  & robocopy @Arguments
  if ($LASTEXITCODE -gt 7) {
    throw "$Label failed with robocopy exit code $LASTEXITCODE."
  }
}

function Remove-PathSafely {
  param([string]$PathValue)

  if (-not (Test-Path $PathValue)) {
    return
  }

  $ResolvedPath = (Resolve-Path -LiteralPath $PathValue).Path
  $Item = Get-Item -LiteralPath $ResolvedPath -Force -ErrorAction SilentlyContinue
  if ($null -eq $Item) {
    return
  }

  if ($Item.PSIsContainer) {
    cmd /c rd /s /q "$ResolvedPath" | Out-Null
  }
  else {
    Remove-Item -LiteralPath $ResolvedPath -Force -ErrorAction SilentlyContinue
  }
}

function Remove-UnsafeExtensionPluginArtifacts {
  param([string]$ExtensionsRoot)

  if (-not (Test-Path $ExtensionsRoot)) {
    return
  }

  Get-ChildItem -Path $ExtensionsRoot -Directory -ErrorAction SilentlyContinue |
    ForEach-Object {
      $PluginNodeModules = Join-Path $_.FullName 'node_modules'
      foreach ($UnsafeName in @('whereclaw', 'openclaw')) {
        Remove-PathSafely -PathValue (Join-Path $PluginNodeModules $UnsafeName)
      }
    }
}

try {
  Set-Location $RootDir
  Ensure-ToolOnPath -CommandName 'cargo' -CandidatePaths @(
    (Join-Path $env:USERPROFILE '.cargo\bin')
  )
  Invoke-Step 'npm ci' { npm ci }
  $env:WHERECLAW_BUILD_VARIANT = $BuildVariant
  Invoke-Step 'prepare:openclaw-engine:windows' { npm run prepare:openclaw-engine:windows }
  Invoke-Step 'tauri build' { npm run tauri build -- --target $Target --no-bundle }

  $SourceExtensionsRoot = Join-Path $RootDir 'whereclaw-engine\openclaw\node_modules\openclaw\dist\extensions'
  Remove-UnsafeExtensionPluginArtifacts -ExtensionsRoot $SourceExtensionsRoot

  Remove-PathSafely -PathValue $ZipPath
  New-Item -ItemType Directory -Force -Path $PortableRoot | Out-Null
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  Copy-Item (Join-Path $ReleaseDir 'app.exe') (Join-Path $PortableRoot 'WhereClaw.exe')
  Invoke-Robocopy -Source (Join-Path $RootDir 'whereclaw-engine') -Destination (Join-Path $PortableRoot 'whereclaw-engine') -Label 'Copy whereclaw-engine'
  Remove-UnsafeExtensionPluginArtifacts -ExtensionsRoot (Join-Path $PortableRoot 'whereclaw-engine\openclaw\node_modules\openclaw\dist\extensions')

  Push-Location $StageRoot
  try {
    Invoke-Step 'create portable zip' { tar.exe -a -c -f $ZipPath 'WhereClaw' }
  }
  finally {
    Pop-Location
  }

  Write-Host "Created $ZipPath"
}
finally {
  Remove-PathSafely -PathValue $StageRoot
}
