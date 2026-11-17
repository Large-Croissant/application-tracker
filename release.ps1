# Release script for JobTracker.
#
# Usage:  .\release.ps1 -Version 0.2.2 -Notes "What's new in this release"
#
# What it does, in order:
#   1. Bumps the version in package.json, src-tauri/tauri.conf.json and
#      src-tauri/Cargo.toml (kept in sync automatically).
#   2. Refreshes Cargo.lock's copy of the version, commits ("Release
#      vX.Y.Z: bump version") and pushes.
#   3. Runs the Rust test suite; aborts on failure.
#   4. Builds the installers with the updater signing key, producing the
#      signed .sig updater artifacts.
#   5. Generates latest.json — the updater manifest — WITHOUT a UTF-8 BOM
#      (PowerShell's default UTF8 encoding and most text writers prepend a
#      BOM that the updater's JSON decoder rejects; this is why the script
#      writes bytes directly).
#   6. Publishes a GitHub release with the NSIS installer, its .sig, the
#      MSI, and latest.json.
#   7. Verifies the public updater feed serves the new manifest correctly
#      (HTTP 200, no BOM, right version).
#
# Requirements: gh CLI authenticated; updater signing key at
# %USERPROFILE%\.tauri\jobtracker_updater.key (override with -KeyPath).
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = "Maintenance release.",
  [string]$KeyPath = (Join-Path $env:USERPROFILE ".tauri\jobtracker_updater.key"),
  [string]$Repo = "Large-Croissant/application-tracker"
)
$ErrorActionPreference = "Stop"
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Version must be semver (x.y.z), got: '$Version'"
}
if (-not (Test-Path $KeyPath)) {
  throw "Updater signing key not found at: $KeyPath"
}
$gh = "C:\Program Files\GitHub CLI\gh.exe"
if (-not (Test-Path $gh)) { throw "gh CLI not found at: $gh" }
$repoRoot = $PSScriptRoot
$tmp = Join-Path $env:TEMP "jobtracker-release"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Replace-Version([string]$file, [string]$pattern, [string]$replacement) {
  $path = Join-Path $repoRoot $file
  $text = [IO.File]::ReadAllText($path)
  $new = [regex]::Replace($text, $pattern, $replacement, [Text.RegularExpressions.RegexOptions]::Multiline)
  if ($new -eq $text) { throw "Version pattern not found or unchanged in $file" }
  [IO.File]::WriteAllText($path, $new, [Text.UTF8Encoding]::new($false))
  Write-Host "  bumped $file -> $Version"
}

Write-Host "==> 1/6 Bumping version to $Version"
Replace-Version "package.json" '("version"\s*:\s*")[^"]*(")' ('${1}' + $Version + '${2}')
Replace-Version "src-tauri\tauri.conf.json" '("version"\s*:\s*")[^"]*(")' ('${1}' + $Version + '${2}')
Replace-Version "src-tauri\Cargo.toml" '(^version = ")[^"]*(")' ('${1}' + $Version + '${2}')

Write-Host "==> 2/6 Committing the bump"
Push-Location $repoRoot
# Cargo.lock records the package version; refresh it to match the manifest.
& "$repoRoot\dev_env.cmd" cargo update -p jobtracker
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
$staged = git diff --cached --name-only
if ($staged) {
  git commit -m "Release v$($Version): bump version"
  git push
} else {
  Write-Host "  version already at $Version; nothing to commit"
}
Pop-Location

Write-Host "==> 3/6 Running tests"
Push-Location (Join-Path $repoRoot "src-tauri")
& "$repoRoot\dev_env.cmd" cargo test --lib
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Tests failed; aborting release" }
Pop-Location

Write-Host "==> 4/6 Building signed installers (takes a few minutes)"
$env:TAURI_SIGNING_PRIVATE_KEY = $KeyPath
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
Push-Location $repoRoot
& ".\dev_env.cmd" npm run tauri build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Build failed; aborting release" }
Pop-Location

$nsisDir = Join-Path $repoRoot "src-tauri\target\release\bundle\nsis"
$msiDir = Join-Path $repoRoot "src-tauri\target\release\bundle\msi"
$setup = Join-Path $nsisDir "JobTracker_${Version}_x64-setup.exe"
$setupSig = "$setup.sig"
$msi = Join-Path $msiDir "JobTracker_${Version}_x64_en-US.msi"
foreach ($f in @($setup, $setupSig, $msi)) {
  if (-not (Test-Path $f)) { throw "Expected artifact missing: $f" }
}

Write-Host "==> 5/6 Generating BOM-less latest.json + notes"
$sig = ([IO.File]::ReadAllText($setupSig)).Trim()
$manifest = [ordered]@{
  version = $Version
  notes = $Notes
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $sig
      url = "https://github.com/$Repo/releases/download/v$Version/JobTracker_${Version}_x64-setup.exe"
    }
  }
}
$latestJson = Join-Path $tmp "latest.json"
[IO.File]::WriteAllText($latestJson, ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$notesFile = Join-Path $tmp "release-notes.md"
[IO.File]::WriteAllText($notesFile, $Notes, [Text.UTF8Encoding]::new($false))
$first = [IO.File]::ReadAllBytes($latestJson)[0]
if ($first -ne 123) { throw "latest.json has a BOM or is not JSON (first byte $first)" }

Write-Host "==> 6/6 Publishing release v$Version"
& $gh release create "v$Version" $setup $setupSig $msi $latestJson `
  --repo $Repo --title "JobTracker v$Version" --notes-file $notesFile
if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }

$feed = "https://github.com/$Repo/releases/latest/download/latest.json"
$resp = Invoke-WebRequest -Uri $feed -UseBasicParsing
$body = $resp.RawContentStream.ToArray()
if ($resp.StatusCode -ne 200 -or $body[0] -ne 123) {
  throw "Updater feed check failed (HTTP $($resp.StatusCode), first byte $($body[0]))"
}
$content = [Text.Encoding]::UTF8.GetString($body)
if (-not $content.Contains('"version": "' + $Version + '"')) {
  throw "Updater feed does not advertise $Version yet"
}
Write-Host ""
Write-Host "Release v$Version published and verified:"
Write-Host "  https://github.com/$Repo/releases/tag/v$Version"
Write-Host "Updater feed serves the new manifest (no BOM)."
