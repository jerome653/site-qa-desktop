# Publish a hot-update engine bundle to the GitHub Releases feed (tag "engine-latest").
# The bundle is JS-only (sgen-qa-serve.js + lib/ + package.json) — the app's shell supplies node_modules.
# Usage:  pwsh -File publish-engine.ps1 -Version 2.4.1
param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = 'Stop'
$app  = 'D:\AI\_dist\siteqa-app'
$repo = 'docssgen-admin/migration-qa'
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
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
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
