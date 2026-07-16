# Publish a hot-update engine bundle to the GitHub Releases feed (tag "engine-latest").
# The bundle is JS-only (sgen-qa-serve.js + lib/ + package.json) — the app's shell supplies node_modules.
# Usage:  pwsh -File publish-engine.ps1 -Version 2.4.1
param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = 'Stop'
# Staging source. Was 'D:\AI\_dist\siteqa-app' — that is the OLD setup and there is NO D: drive on this
# machine (verified 2026-07-16). The live tree is this repo itself, on C:. A stale path here is not a
# harmless comment: publish-engine.ps1 stages the payload FROM $app, so pointing at a dead/old dir
# either fails outright or ships whatever stale engine happens to sit there — the exact drift this
# repo spent 14 versions recovering from. $PSScriptRoot = this script's own folder, so it cannot go
# stale again when the tree moves.
$app  = $PSScriptRoot
# Owner is jerome653 (the repo's current home). It was 'docssgen-admin/migration-qa', which worked only
# because GitHub 301s the transferred owner (-> api.github.com/repositories/1293719342/..., same host,
# so auth survives and Invoke-RestMethod follows it — verified 2026-07-16, publishes did succeed this way).
# The redirect is the problem, not a broken call: GitHub retires it the instant the old path is
# re-registered, and this script would then publish into a repo we do not control. Don't point it back.
$repo = 'jerome653/migration-qa'
$tag  = 'engine-latest'

# --- token (never printed) ---
$cred  = "protocol=https`nhost=github.com`n`n" | git credential fill
$token = (($cred -split "`n") | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (-not $token) { throw 'no GitHub token from git credential' }
$H = @{ Authorization = "Bearer $token"; 'User-Agent' = 'sgen-publish'; Accept = 'application/vnd.github+json' }

# --- stage JS-only engine ---
$stage = Join-Path $env:TEMP ("engine-stage-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item "$app\engine\sgen-qa-serve.js" $stage
Copy-Item "$app\engine\package.json"     $stage -ErrorAction SilentlyContinue
Copy-Item "$app\engine\lib"              $stage -Recurse

# --- zip (contents at archive root), sha256, version.txt ---
$zip = Join-Path $env:TEMP 'engine.zip'; Remove-Item $zip -ErrorAction SilentlyContinue
# DO NOT use Compress-Archive here. It writes BACKSLASH entry names ("lib\site-qa\audit.js"), which
# violates APPNOTE 4.4.17.1 (entry paths use forward slashes). A spec-following extractor then emits
# ONE flat file literally named "lib\site-qa\audit.js" instead of a lib/ tree, so sgen-qa-serve.js
# cannot resolve ./lib/... and EVERY install that updates is broken. The sha256 still matches
# perfectly — a valid checksum over a corrupt archive, which is the worst failure this tool can ship.
# Re-verified 2026-07-16 on this machine: Compress-Archive -> 'lib\site-qa\audit.js';
# build-zip.js -> 'lib/site-qa/audit.js'. This is why 3.0.2/3.0.3/3.1.0 were published with the
# hand-written builder and NOT with this script — build-zip.js used to live only in a temp scratchpad;
# it is now adopted into this repo beside this script so the working path cannot be lost again.
& node (Join-Path $app 'build-zip.js') $stage $zip
if ($LASTEXITCODE -ne 0) { throw "build-zip.js failed (exit $LASTEXITCODE) — refusing to publish a bad payload" }
$sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
$shaFile = Join-Path $env:TEMP 'engine.zip.sha256'; Set-Content $shaFile "$sha  engine.zip" -NoNewline
$verFile = Join-Path $env:TEMP 'version.txt';       Set-Content $verFile $Version -NoNewline
$zipKB = [int]((Get-Item $zip).Length / 1KB)

# --- ensure the release exists ---
try { $rel = Invoke-RestMethod -Headers $H "https://api.github.com/repos/$repo/releases/tags/$tag" }
catch {
  $body = @{ tag_name = $tag; name = 'SGEN Site QA — engine (hot-update channel)'; body = 'Volatile engine bundle, auto-fetched + applied by the app. Not an installer.'; draft = $false; prerelease = $false } | ConvertTo-Json
  $rel = Invoke-RestMethod -Headers $H -Method Post "https://api.github.com/repos/$repo/releases" -Body $body -ContentType 'application/json'
}

# --- replace same-named assets ---
foreach ($a in $rel.assets) {
  if ($a.name -in @('engine.zip', 'engine.zip.sha256', 'version.txt')) {
    Invoke-RestMethod -Headers $H -Method Delete "https://api.github.com/repos/$repo/releases/assets/$($a.id)" | Out-Null
  }
}
$UP = ($rel.upload_url -replace '\{.*\}', '')
function Up($file, $name, $type) { Invoke-RestMethod -Headers ($H + @{ 'Content-Type' = $type }) -Method Post "$UP`?name=$name" -InFile $file | Out-Null }
Up $zip     'engine.zip'        'application/zip'
Up $shaFile 'engine.zip.sha256' 'text/plain'
Up $verFile 'version.txt'       'text/plain'

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
"published engine $Version to '$tag'  ($zipKB KB, sha256 $sha)"
