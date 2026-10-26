<#
.SYNOPSIS
저장소 루트에서 채널 exe를 만든다.

.EXAMPLE
  .\build-exe.ps1 shop
  .\build-exe.ps1 --all
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Remaining
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "uv가 필요합니다. 저장소 루트에서 uv sync --all-packages 를 먼저 실행하세요."
}

Set-Location $Root
& uv sync --all-packages
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& uv run --package channel-exe channel-exe @Remaining
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
