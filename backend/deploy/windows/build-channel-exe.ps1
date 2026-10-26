<#
.SYNOPSIS
채널 하나를 실행 파일로 묶는다. 실제 빌드는 packages/channel-exe 가 한다. OS별 설치 파일은 channel-exe --release.

.EXAMPLE
  .\deploy\windows\build-channel-exe.ps1 -Channel shop
  .\build-exe.ps1 shop
#>
[CmdletBinding()]
param(
    [string]$Channel = 'shop',
    [string]$Root
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_common.ps1"

if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$builder = Join-Path $Root 'build-exe.ps1'
if (-not (Test-Path $builder)) { throw "빌드 스크립트가 없습니다: $builder" }

Write-Line "exe 빌드: $Channel"
& $builder $Channel
if ($LASTEXITCODE -ne 0) { throw "exe 빌드가 실패했습니다." }
