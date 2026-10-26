<#
.SYNOPSIS
채널 관제를 띄운다. NSSM 서비스는 만들지 않는다.

.EXAMPLE
  .\start-console.ps1
  .\start-console.ps1 -NoBrowser
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$BindHost = '0.0.0.0',
    [int]$Port = 12000,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
try { chcp 65001 > $null } catch { }

# PowerShell 5는 param 기본값에서 $PSScriptRoot가 비어 있다.
if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }
$root = (Resolve-Path $Root).Path
Push-Location $root
try { git pull } catch { Write-Warning "git pull 실패: $_" } finally { Pop-Location }
$envDir = Join-Path $root 'packages\console'
$envFile = Join-Path $envDir '.env'
$example = Join-Path $envDir '.env.example'
if (-not (Test-Path $envFile) -and (Test-Path $example)) {
    Copy-Item $example $envFile
    Write-Host ".env를 만들었습니다: $envFile"
}

$exe = Join-Path $root '.venv\Scripts\kodex-console.exe'
$consoleArgs = @('--host', $BindHost, '--port', "$Port")
if ($NoBrowser) { $consoleArgs += '--no-browser' }

Set-Location $root
if (Test-Path $exe) {
    Write-Host "관제: http://<서버IP>:$Port/"
    & $exe @consoleArgs
    exit $LASTEXITCODE
}

if (Get-Command uv -ErrorAction SilentlyContinue) {
    Write-Host "관제: http://<서버IP>:$Port/"
    & uv run --package kodex-console kodex-console @consoleArgs
    exit $LASTEXITCODE
}

throw "kodex-console을 찾지 못했습니다. 저장소에서 uv sync --all-packages 를 먼저 실행하세요."
