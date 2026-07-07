# SolidKG standalone installer for Windows (PowerShell).
#
# Downloads a self-contained bundle (a vendored Node runtime + the app) from
# solidkg.local release artifacts. No Node.js, no build tools required.
#
#   irm https://solidkg.local/install/install.ps1 | iex
#
# Re-run to upgrade. To uninstall: remove $env:LOCALAPPDATA\solidkg and drop
# its \current\bin entry from your user PATH.
#
# Environment:
#   SOLIDKG_VERSION      release tag to install (default: latest)
#   SOLIDKG_INSTALL_DIR  install location (default: %LOCALAPPDATA%\solidkg)

$ErrorActionPreference = 'Stop'
$installDir = if ($env:SOLIDKG_INSTALL_DIR) { $env:SOLIDKG_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'solidkg' }
$latestUrl = if ($env:SOLIDKG_LATEST_URL) { $env:SOLIDKG_LATEST_URL } else { 'https://solidkg.local/releases/latest' }
$downloadBase = if ($env:SOLIDKG_DOWNLOAD_BASE) { $env:SOLIDKG_DOWNLOAD_BASE } else { 'https://solidkg.local/releases/download' }

# 1. Detect architecture -> target matching the release archives.
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
$target = "win32-$arch"

# 2. Resolve the version (latest release unless pinned).
$version = $env:SOLIDKG_VERSION
if (-not $version) {
  $version = ((Invoke-WebRequest -Uri $latestUrl -ErrorAction Stop).BaseResponse.ResponseUri.AbsoluteUri -replace '.*/releases/tag/', '')
}
if (-not $version) { throw "solidkg: could not resolve latest version; set SOLIDKG_VERSION." }

# 3. Download + extract the bundle into a stable 'current' dir (overwritten on upgrade).
$url = "$downloadBase/$version/solidkg-$target.zip"
$asset = "solidkg-$target.zip"
Write-Host "Installing SolidKG $version ($target)..."
$tmp = Join-Path $env:TEMP ("cg-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp 'cg.zip'
Invoke-WebRequest -Uri $url -OutFile $zip
$sums = Join-Path $tmp 'SHA256SUMS'
$sumsUrl = "$downloadBase/$version/SHA256SUMS"
try {
  Invoke-WebRequest -Uri $sumsUrl -OutFile $sums
} catch {
  Remove-Item -Recurse -Force $tmp
  throw "solidkg: checksum unavailable: $sumsUrl"
}
$expected = $null
foreach ($line in Get-Content $sums) {
  if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
    $name = (($Matches[2].Trim() -split '[\\/]')[-1])
    if ($name -eq $asset) {
      $expected = $Matches[1].ToLowerInvariant()
      break
    }
  }
}
if (-not $expected) {
  Remove-Item -Recurse -Force $tmp
  throw "solidkg: checksum unavailable for $asset"
}
$actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
  Remove-Item -Recurse -Force $tmp
  throw "solidkg: checksum mismatch for $asset"
}
Write-Host "solidkg: checksum verified."

$dest = Join-Path $installDir 'current'
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Expand-Archive -Path $zip -DestinationPath $dest -Force
# Archives contain a top-level solidkg-<target>\ dir; flatten it.
$inner = Join-Path $dest "solidkg-$target"
if (Test-Path $inner) {
  Get-ChildItem -Force $inner | Move-Item -Destination $dest -Force
  Remove-Item -Recurse -Force $inner
}
Remove-Item -Recurse -Force $tmp

# 4. Put the launcher dir on the user's PATH.
$binDir = Join-Path $dest 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable('Path', "$binDir;$userPath", 'User')
  Write-Host "Added $binDir to your PATH (restart your terminal to pick it up)."
}

Write-Host "Installed to $dest"
Write-Host "Run: solidkg --help"
