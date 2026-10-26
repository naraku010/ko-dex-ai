<#
.SYNOPSIS
deploy-channels.ps1을 주기적으로 돌리는 작업 스케줄러 항목을 만든다.

.DESCRIPTION
등록해두면 git에 올린 변경이 알아서 서버에 반영된다. 받아올 변경이 없으면 스크립트가
바로 끝나므로 자주 돌려도 부담이 없다.

SYSTEM 계정으로 돌기 때문에 서비스 재시작 권한이 있다. 실행 기록은 로그 파일에 쌓인다.

.EXAMPLE
  .\install-update-task.ps1

.EXAMPLE
  .\install-update-task.ps1 -IntervalMinutes 30

.EXAMPLE
  # 없애기
  .\install-update-task.ps1 -Remove
#>
[CmdletBinding()]
param(
    [string]$Root = (Join-Path $PSScriptRoot '..\..'),
    [string]$Branch = 'master',

    # 확인 주기(분)
    [int]$IntervalMinutes = 15,

    # nssm이 SYSTEM의 PATH에 없으면 (winget 설치는 사용자 범위일 수 있다) 절대 경로를 준다.
    [string]$Nssm = 'nssm',

    [string]$TaskName = 'EGI 채널 자동 갱신',

    # 등록을 지운다
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_common.ps1"

Assert-Admin

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Line "'$TaskName' 등록을 지웠습니다."
    } else {
        Write-Line "'$TaskName' 등록이 없습니다."
    }
    exit 0
}

$root = (Resolve-Path $Root).Path
$script = Join-Path $root 'deploy\windows\deploy-channels.ps1'
if (-not (Test-Path $script)) { throw "배포 스크립트가 없습니다: $script" }

$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'update.log'

# SYSTEM으로 돌 때 nssm을 찾을 수 있는지 지금 확인해둔다. 실패는 스케줄 실행 때가 아니라 여기서 보는 게 낫다.
Resolve-Nssm -Nssm $Nssm | Out-Null

# 실행 결과를 한 파일에 이어 붙인다. 스케줄러 자체는 출력을 남기지 않기 때문에 필요하다.
$command = "& '$script' -Root '$root' -Branch '$Branch' -Nssm '$Nssm' *>> '$log'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command `"$command`""

# RepetitionDuration을 비우면 버전에 따라 반복이 하루 만에 끝나버린다. 넉넉히 못박아 둔다.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

# 반복 설정이 실제로 붙었는지 읽어서 보여준다. 버전에 따라 조용히 무시되는 경우가 있다.
$registered = Get-ScheduledTask -TaskName $TaskName
$repetition = @($registered.Triggers)[0].Repetition

Write-Line "'$TaskName' 을 등록했습니다."
Write-Line "  저장소 : $root ($Branch)"
Write-Line "  반복   : $($repetition.Interval) 간격, $($repetition.Duration) 동안"
Write-Line "  로그   : $log"
Write-Line ''
Write-Line "지금 한 번 돌려보려면:"
Write-Line "  Start-ScheduledTask -TaskName '$TaskName'; Get-Content '$log' -Tail 20 -Wait"
