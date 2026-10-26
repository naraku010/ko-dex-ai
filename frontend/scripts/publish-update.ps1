# 로컬에서 설치 파일을 만들고 GitHub 릴리스에 올린다.
# 빌드에 깃 토큰을 넣고, 설치 파일은 GitHub API 주소로 받는다.
# -SkipBuild: 이미 만든 설치 파일을 다시 올리기만 한다.
param([switch]$SkipBuild)
$ErrorActionPreference = "Stop"
$repo = "naraku010/ko-dex-ai"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$key = Join-Path $env:USERPROFILE ".tauri\kodex-ai.key"
$passFile = Join-Path $env:USERPROFILE ".tauri\kodex-ai.key.password"
if (-not (Test-Path -LiteralPath $key)) { throw "서명 키가 없습니다: $key" }
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -LiteralPath $key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -LiteralPath $passFile -Raw).Trim()

# 토큰은 naraku010 계정이어야 한다. 환경 변수 → gh의 naraku010 계정 → git 자격 증명 순으로 찾는다.
$token = $env:KODEX_RELEASE_TOKEN
if (-not $token -and (Get-Command gh -ErrorAction SilentlyContinue)) {
  $ghToken = (gh auth token --user naraku010 2>$null)
  if ($LASTEXITCODE -eq 0 -and $ghToken) { $token = "$ghToken".Trim() }
}
if (-not $token) {
  $credText = "protocol=https`nhost=github.com`nusername=naraku010`n`n" | git credential fill
  foreach ($line in ($credText -split "`n")) {
    if ($line.StartsWith("password=")) { $token = $line.Substring(9).Trim() }
  }
}
if (-not $token) { throw "naraku010 계정 GitHub 토큰을 찾지 못했습니다." }
$headers = @{ Authorization = "Bearer $token"; Accept = "application/vnd.github+json"; "User-Agent" = "kodex-ai-chat" }
try {
  $repoInfo = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repo"
} catch {
  throw "이 토큰으로는 $repo 저장소가 보이지 않습니다. naraku010 계정으로 로그인하세요: gh auth login (naraku010 계정 선택)"
}
if (-not $repoInfo.permissions.push) { throw "이 토큰은 $repo 에 쓰기 권한이 없습니다. naraku010 계정 토큰이 필요합니다." }
$env:KODEX_UPDATE_TOKEN = $token

if (-not $SkipBuild) {
  npm run tauri:build
  if ($LASTEXITCODE -ne 0) { throw "빌드에 실패했습니다." }
}

$version = (Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$bundle = Join-Path $root "src-tauri\target\release\bundle\nsis"
$setup = Get-ChildItem -LiteralPath $bundle -Filter "*-setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$sig = Get-Item -LiteralPath ($setup.FullName + ".sig")
$signature = (Get-Content -LiteralPath $sig.FullName -Raw).Trim()
$tag = "v$version"
$assetName = $setup.Name -replace ' ', '.'
if ($setup.Name -notlike "*_${version}_*") { throw "설치 파일 버전이 package.json($version)과 다릅니다: $($setup.Name)" }
$body = @{ tag_name = $tag; name = "KODEX AI $version"; body = "Windows 설치 파일"; target_commitish = "master" } | ConvertTo-Json
try {
  $release = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/releases" -Headers $headers -Body $body -ContentType "application/json"
} catch {
  $code = 0
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  if ($code -ne 422) { throw }
  $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repo/releases/tags/$tag"
}
function Send-Asset($path, $assetName) {
  $existing = $release.assets | Where-Object { $_.name -eq $assetName }
  if ($existing) {
    Invoke-RestMethod -Method Delete -Headers $headers -Uri "https://api.github.com/repos/$repo/releases/assets/$($existing.id)" | Out-Null
  }
  $encoded = [uri]::EscapeDataString($assetName)
  $upload = "https://uploads.github.com/repos/$repo/releases/$($release.id)/assets?name=$encoded"
  $bytes = [System.IO.File]::ReadAllBytes($path)
  return Invoke-RestMethod -Method Post -Uri $upload -Headers ($headers + @{ "Content-Type" = "application/octet-stream" }) -Body $bytes
}
$exeAsset = Send-Asset $setup.FullName $assetName
Send-Asset $sig.FullName ($assetName + ".sig") | Out-Null
$latest = @{
  version = $version
  notes = "KODEX AI $version"
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = @{
    "windows-x86_64" = @{
      signature = $signature
      url = $exeAsset.url
    }
  }
}
$latestPath = Join-Path $bundle "latest.json"
$json = $latest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($latestPath, $json, (New-Object System.Text.UTF8Encoding $false))
Send-Asset $latestPath "latest.json" | Out-Null
Write-Output "릴리스 $tag"
