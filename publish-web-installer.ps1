# Publish the Site Audit web installer to GitHub Releases.
#
#   pwsh -File publish-web-installer.ps1
#   pwsh -File publish-web-installer.ps1 -Version 6.2.1
#
# Creates release tag v<Version> on jerome653/migration-qa and uploads:
#   sgen-site-qa-desktop-<Version>-x64.nsis.7z   the payload the stub downloads
#   Site-Audit-Web-Setup-<Version>.exe           the 0.59 MB file you hand out
#   latest.yml                                   update metadata
#
# The token is read from the Git credential store (same as publish-engine.ps1)
# and is never printed. Nothing is deleted; re-running against an existing tag
# reuses the release and replaces same-named assets.

param(
    [string]$Version = '6.2.1',
    [string]$Owner   = 'jerome653',
    [string]$Repo    = 'migration-qa'
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot 'release\nsis-web'

$payload = Join-Path $root "sgen-site-qa-desktop-$Version-x64.nsis.7z"
$stub    = Join-Path $root "Site Audit Web Setup $Version.exe"
$meta    = Join-Path $root 'latest.yml'

foreach ($f in @($payload, $stub, $meta)) {
    if (-not (Test-Path $f)) { throw "missing build artifact: $f  (run: npx electron-builder --win nsis-web --x64)" }
}

# ---------------------------------------------------------------- token
$env:GIT_TERMINAL_PROMPT = '0'
$cred = ("protocol=https`nhost=github.com`n`n" | git credential fill 2>$null)
$token = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (-not $token) { throw 'no GitHub credential found. Sign in via Git Credential Manager, or store a PAT with repo scope.' }
$H = @{ Authorization = "Bearer $token"; 'User-Agent' = 'site-audit-publish'; Accept = 'application/vnd.github+json' }
Write-Host "credential acquired" -ForegroundColor Green

# ---------------------------------------------------------------- release
$tag = "v$Version"
try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/tags/$tag" -Headers $H -TimeoutSec 30
    Write-Host "reusing existing release $tag (id $($rel.id))" -ForegroundColor Yellow
} catch {
    $body = @{
        tag_name = $tag
        name     = "Site Audit $Version"
        body     = "Site Audit $Version - shell and engine both $Version.`n`n" +
                   "**Download ``Site-Audit-Web-Setup-$Version.exe``** (0.59 MB). It pulls the payload from this release during install.`n`n" +
                   "The audit engine hot-updates separately from the ``engine-latest`` tag - no reinstall is needed for engine updates."
        draft      = $false
        prerelease = $false
    } | ConvertTo-Json
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases" -Headers $H -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 60
    Write-Host "created release $tag (id $($rel.id))" -ForegroundColor Green
}

# ---------------------------------------------------------------- assets
# Asset names must match latest.yml exactly, so the stub and the updater both resolve.
$uploads = @(
    @{ Path = $payload; Name = "sgen-site-qa-desktop-$Version-x64.nsis.7z"; Type = 'application/x-7z-compressed' }
    @{ Path = $stub;    Name = "Site-Audit-Web-Setup-$Version.exe";         Type = 'application/vnd.microsoft.portable-executable' }
    @{ Path = $meta;    Name = 'latest.yml';                                Type = 'text/yaml' }
)

foreach ($u in $uploads) {
    $existing = $rel.assets | Where-Object { $_.name -eq $u.Name }
    if ($existing) {
        Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/assets/$($existing.id)" -Headers $H -Method Delete -TimeoutSec 60 | Out-Null
        Write-Host "  replaced existing asset $($u.Name)" -ForegroundColor Yellow
    }
    $mb = [math]::Round((Get-Item $u.Path).Length / 1MB, 2)
    Write-Host "  uploading $($u.Name)  ($mb MB) ..." -NoNewline
    $uri = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($rel.id)/assets?name=$([uri]::EscapeDataString($u.Name))"
    $null = Invoke-RestMethod -Uri $uri -Headers $H -Method Post -InFile $u.Path -ContentType $u.Type -TimeoutSec 1800
    Write-Host " done" -ForegroundColor Green
}

# ---------------------------------------------------------------- verify unauthenticated
$base = "https://github.com/$Owner/$Repo/releases/download/$tag"
Write-Host "`nverifying public reachability (no auth):" -ForegroundColor Cyan
$ok = $true
foreach ($n in @("sgen-site-qa-desktop-$Version-x64.nsis.7z", "Site-Audit-Web-Setup-$Version.exe")) {
    try {
        $r = Invoke-WebRequest -Uri "$base/$n" -Method Head -MaximumRedirection 5 -TimeoutSec 60
        Write-Host ("  [OK]   {0}  HTTP {1}" -f $n, $r.StatusCode) -ForegroundColor Green
    } catch {
        $ok = $false
        Write-Host ("  [FAIL] {0}  {1}" -f $n, $_.Exception.Message) -ForegroundColor Red
    }
}

Write-Host ""
if ($ok) {
    Write-Host "PUBLISHED. Share this link:" -ForegroundColor Green
    Write-Host "  $base/Site-Audit-Web-Setup-$Version.exe"
    Write-Host "The stub will fetch:"
    Write-Host "  $base/sgen-site-qa-desktop-$Version-x64.nsis.7z"
} else {
    Write-Host "Assets uploaded but not publicly reachable - check the release is not a draft." -ForegroundColor Red
    exit 1
}
