$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $repo "src-tauri\binaries"
$out = Join-Path $dir "node-x86_64-pc-windows-msvc.exe"

if (Test-Path $out) {
  Write-Host "bundled Node already exists"
  exit 0
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null
$url = "https://nodejs.org/dist/v22.14.0/win-x64/node.exe"
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
Write-Host "saved $out"
