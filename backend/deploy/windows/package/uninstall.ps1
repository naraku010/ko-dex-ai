<#
.SYNOPSIS
EGI 채널 서버의 Windows 서비스를 멈추거나 지운다.

.DESCRIPTION
이 설치 폴더의 채널만 다룬다. 저장소에서 직접 등록한 서비스(다른 경로의 exe)는 건드리지 않는다.
.env 와 data\ 는 지우지 않는다.

  -Upgrade  설치 마법사가 새 버전을 복사하기 전에 부른다. 서비스를 멈추고 옛 실행 파일만 지운다.
  (없음)    제거 마법사가 부른다. 서비스와 방화벽 규칙을 지운다.
#>
[CmdletBinding()]
param([switch]$Upgrade)

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$nssm = Join-Path $Root 'tools\nssm.exe'
if (-not (Test-Path $nssm)) {
    $cmd = Get-Command nssm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $nssm = if ($cmd) { $cmd.Path } else { $null }
}

$channels = Join-Path $Root 'channels'
if (-not (Test-Path $channels)) { exit 0 }

foreach ($folder in Get-ChildItem $channels -Directory) {
    $name = $folder.Name
    $service = "EgiChannel-$name"
    $svc = Get-CimInstance Win32_Service -Filter "Name='$service'" -ErrorAction SilentlyContinue
    if ($svc) {
        # NSSM 서비스의 PathName은 nssm.exe다. 실제 실행 파일은 NSSM 설정에서 확인한다.
        $app = if ($nssm) { ((& $nssm get $service Application 2>$null) -join '') -replace "`0", '' } else { '' }
        $ours = $app -and $app.StartsWith($folder.FullName, [StringComparison]::OrdinalIgnoreCase)
        if ($ours -or -not $nssm) {
            Stop-Service -Name $service -Force -ErrorAction SilentlyContinue
            if (-not $Upgrade) {
                if ($nssm) { & $nssm remove $service confirm 2>&1 | Out-Null } else { sc.exe delete $service | Out-Null }
            }
        }
    }
    if ($Upgrade) {
        # 새 버전과 섞이지 않게 옛 라이브러리를 비운다. .env, data\ 는 남는다.
        Remove-Item (Join-Path $folder.FullName '_internal') -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Get-NetFirewallRule -DisplayName "EGI channel $name" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    }
}
exit 0
