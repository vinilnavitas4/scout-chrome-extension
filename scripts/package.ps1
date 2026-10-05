# Builds the store upload zip: dist/scout-edge-<version>.zip with manifest.json at the root.
# Usage (from repo root):  powershell -ExecutionPolicy Bypass -File scripts/package.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
$stage = Join-Path $root "dist/stage"
$zip = Join-Path $root "dist/scout-edge-$version.zip"

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null
if (Test-Path $zip) { Remove-Item -Force $zip }

Copy-Item manifest.json $stage
foreach ($d in "background", "content_scripts", "offscreen", "popup", "lib", "icons") {
  Copy-Item -Recurse $d (Join-Path $stage $d)
}
# The 300x300 logo is uploaded separately in Partner Center, not shipped in the package.
Remove-Item -Force (Join-Path $stage "icons/store-logo-300.png") -ErrorAction SilentlyContinue

# Fail fast if any file the manifest names is missing from the package.
$m = Get-Content manifest.json -Raw | ConvertFrom-Json
$refs = @($m.background.service_worker, $m.side_panel.default_path) +
        @($m.icons.PSObject.Properties.Value) +
        @($m.action.default_icon.PSObject.Properties.Value) +
        @($m.content_scripts | ForEach-Object { $_.js }) +
        @($m.web_accessible_resources | ForEach-Object { $_.resources }) +
        @("offscreen/offscreen.html", "lib/ort-wasm-simd-threaded.jsep.wasm")
foreach ($f in $refs) {
  if (-not (Test-Path (Join-Path $stage $f))) { throw "Missing from package: $f" }
}

# Not Compress-Archive: on PowerShell 5.1 it writes backslash entry names, which
# extension stores reject. Write entries with forward slashes explicitly.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, "Create")
try {
  Get-ChildItem $stage -Recurse -File | ForEach-Object {
    $entry = $_.FullName.Substring($stage.Length + 1) -replace "\\", "/"
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entry) | Out-Null
  }
} finally { $archive.Dispose() }
Remove-Item -Recurse -Force $stage
Write-Host "Built $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)"
