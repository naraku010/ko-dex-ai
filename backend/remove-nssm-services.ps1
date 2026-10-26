<#
.SYNOPSIS
NSSM으로 등록한 KODEX 채널 서비스를 전부 지운다.
nssm remove confirm 은 구형 nssm에서 "매개 변수가 틀립니다"가 나므로 쓰지 않는다.

.EXAMPLE
  .\remove-nssm-services.ps1
  .\remove-nssm-services.ps1 -Channel shop
#>
[CmdletBinding()]
param(
    [string]$Channel
)

$ErrorActionPreference = 'Continue'
try { chcp 65001 > $null } catch { }

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '관리자 권한 PowerShell에서 실행해주세요.'
}

function Test-KodexService {
    param($Svc)
    if ($Channel) {
        $exact = "KodexChannel-$Channel"
        return ($Svc.Name -eq $exact) -or ($Svc.DisplayName -like "*$Channel*")
    }
    if ($Svc.Name -like 'KodexChannel-*') { return $true }
    if ($Svc.DisplayName -like 'KODEX 채널*') { return $true }
    if ($Svc.DisplayName -like 'KODEX채널*') { return $true }
    if ($Svc.Description -and ($Svc.Description -like '*kodex.channel*')) { return $true }
    return $false
}

$wanted = @(Get-WmiObject Win32_Service | Where-Object { Test-KodexService $_ })
if ($wanted.Count -eq 0) {
    Write-Host '지울 KODEX 채널 서비스가 없습니다.'
    exit 0
}
image.png
$sc = Join-Path $env:SystemRoot 'System32\sc.exe'
foreach ($svc in $wanted) {
    $name = [string]$svc.Name
    Write-Host ("중지/삭제: {0}  ({1})" -f $name, $svc.DisplayName)
    if ($svc.State -ne 'Stopped') {
        & $sc stop $name | Out-Null
        Start-Sleep -Seconds 2
    }
    $out = & $sc delete $name 2>&1 | Out-String
    Write-Host $out.Trim()
}

Start-Sleep -Seconds 1
$left = @(Get-WmiObject Win32_Service | Where-Object { Test-KodexService $_ })
if ($left.Count -gt 0) {
    $names = ($left | ForEach-Object { $_.Name }) -join ', '
    throw "아직 남아 있습니다: $names"
}
Write-Host 'NSSM 서비스를 지웠습니다. services.msc를 새로고침하세요.'
