<#
.SYNOPSIS
git에서 최신 코드를 받아 채널들을 배포하거나 갱신한다.

.DESCRIPTION
처음 실행하면 배포가 되고, 다시 실행하면 갱신이 된다. 같은 스크립트를 계속 돌리면 되고,
받아올 변경이 없으면 아무것도 건드리지 않고 끝낸다.

하는 일
  1. git fetch 로 원격과 비교. 받아올 변경도 없고 배포도 이미 끝나 있으면 여기서 끝
     (git이 최신이어도 venv나 서비스가 없으면 배포되지 않은 것으로 보고 이어서 진행한다)
  2. git reset --hard 로 원격 상태에 맞춤 (.env와 data 폴더는 git 밖이라 그대로 남는다)
  3. 의존성(requirements*.txt, pyproject.toml)이 바뀌었으면 venv에 pip install
  4. 바뀐 채널의 서비스를 재시작. 의존성이나 packages\ 공용 코드가 바뀌었으면 전체 재시작
  5. /health 확인. 하나라도 실패하면 이전 커밋으로 되돌리고 다시 띄운다

어떤 채널을 이 서버에서 돌릴지는 channels\<이름>\.env 유무로 정한다. .env는 git에 올라가지
않으므로 서버마다 다르게 켤 수 있고, 포트도 그 .env의 PORT를 그대로 쓴다.

패키지는 editable로 설치되므로 코드 변경은 pip 재설치 없이 재시작만으로 반영된다.

준비물
  - git, python 3.11+, NSSM (winget install NSSM.NSSM)
  - 채널마다 channels\<이름>\.env (CHANNEL_API_KEYS, PORT 필수)
  - 관리자 권한 PowerShell

.EXAMPLE
  # 배포된 저장소 안에서 그냥 실행 (스케줄러가 부르는 형태)
  .\deploy-channels.ps1

.EXAMPLE
  # 최초 배포: 저장소가 없으면 clone까지 한다
  .\deploy-channels.ps1 -Root C:\egi-channel -Repo https://github.com/egibiz/egi-ai-channel.git

.EXAMPLE
  # 변경이 없어도 강제로 재설치·재시작
  .\deploy-channels.ps1 -Force

.EXAMPLE
  # 채널 하나만. -shop 이 아니라 -Channel shop
  .\deploy-channels.ps1 -Channel shop -Nssm C:\tools\nssm.exe
#>
[CmdletBinding()]
param(
    # 이 이름만 설치·재시작한다. 폴더 이름 (예: shop). -shop 처럼 쓰면 안 된다.
    [string]$Channel,

    # 배포 위치. 비우면 이 스크립트가 들어 있는 저장소를 쓴다.
    [string]$Root,

    # $Root가 저장소가 아닐 때 clone할 주소
    [string]$Repo = 'https://github.com/egibiz/egi-ai-channel.git',

    [string]$Branch = 'master',

    # 받아올 변경이 없어도 재설치하고 재시작한다
    [switch]$Force,

    # 코드만 받고 서비스는 건드리지 않는다
    [switch]$NoRestart,

    [string]$Nssm = 'nssm',

    # venv를 만들 때 쓸 파이썬
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
chcp 65001 > $null
. "$PSScriptRoot\_common.ps1"

# 서비스를 건드릴 때만 관리자 권한이 필요하다. -NoRestart는 코드만 받으므로 그냥 돌아간다.
if (-not $NoRestart) { Assert-Admin }
if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }

function Write-Step { param([string]$Text) Write-Line "  $Text" }

Write-Line "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 채널 배포 시작 - $Root ($Branch), PS $($PSVersionTable.PSVersion)"

# ── 1. 저장소 준비 ──────────────────────────────────────────────────────────
$firstRun = $false
if (-not (Test-Path (Join-Path $Root '.git'))) {
    if (Test-Path $Root) {
        $hasFiles = (Get-ChildItem $Root -Force | Measure-Object).Count -gt 0
        if ($hasFiles) { throw "$Root 는 git 저장소가 아니고 비어 있지도 않습니다. 다른 경로를 쓰거나 비워주세요." }
    }
    Write-Step "저장소를 clone합니다: $Repo"
    Invoke-Native -Label "git clone $Repo" -Command { & git clone --branch $Branch $Repo $Root } | Out-Null
    $firstRun = $true
}

$before = (Invoke-Git -Root $Root 'rev-parse' 'HEAD' | Out-String).Trim()

# ── 2. 배포가 이미 끝나 있는지 ──────────────────────────────────────────────
# git이 최신이어도 venv나 서비스가 없으면 아직 배포된 게 아니다. 손으로 clone한 서버가
# 여기 해당하는데, git만 보고 판단하면 첫 배포가 영원히 안 된다.
$venv = Join-Path $Root '.venv'
$venvPython = Join-Path $venv 'Scripts\python.exe'

$channels = @(Get-EnabledChannels -Root $Root)
if ($Channel) {
    $wanted = $channels | Where-Object { $_.Name -eq $Channel }
    if (-not $wanted) {
        $names = if ($channels.Count) { ($channels | ForEach-Object { $_.Name }) -join ', ' } else { '(없음)' }
        throw "채널 '$Channel' 을 찾지 못했습니다. channels\<이름>\.env 가 있는 채널: $names"
    }
    $channels = @($wanted)
}
$ready = @($channels | Where-Object { $_.Ready })

# 돌릴 채널이 하나도 준비되지 않은 상태도 매번 알려야 한다. 조용히 "변경 없음"으로 끝나면
# .env를 빼먹은 걸 눈치챌 방법이 없다.
$pending = -not (Test-Path $venvPython) -or $ready.Count -eq 0
if (-not $pending) {
    foreach ($channel in $ready) {
        if (-not (Get-Service -Name $channel.Service -ErrorAction SilentlyContinue)) { $pending = $true }
    }
}

if (-not $firstRun) {
    Invoke-Git -Root $Root 'fetch' '--prune' 'origin' $Branch | Out-Null
    $remote = (Invoke-Git -Root $Root 'rev-parse' "origin/$Branch" | Out-String).Trim()

    if ($remote -eq $before -and -not $Force -and -not $pending) {
        Write-Line "변경 없음 ($($before.Substring(0,7))). 그대로 둡니다."
        exit 0
    }
    if ($remote -eq $before -and $pending) {
        Write-Step "코드는 최신이지만 아직 배포되지 않았습니다. 이어서 진행합니다."
    }
    if ($remote -ne $before) {
        $count = (Invoke-Git -Root $Root 'rev-list' '--count' "$before..$remote" | Out-String).Trim()
        Write-Step "새 커밋 $count 개: $($before.Substring(0,7)) -> $($remote.Substring(0,7))"
        # .env와 data\ 는 git 밖이라 reset의 영향을 받지 않는다. clean은 그 파일들을 지우므로 쓰지 않는다.
        Invoke-Git -Root $Root 'reset' '--hard' "origin/$Branch" | Out-Null
    }
}

$after = (Invoke-Git -Root $Root 'rev-parse' 'HEAD' | Out-String).Trim()

# ── 3. 무엇이 바뀌었는지 ────────────────────────────────────────────────────
$changed = @()
if (-not $firstRun -and $after -ne $before) {
    $changed = @(Invoke-Git -Root $Root 'diff' '--name-only' "$before..$after")
}

$depsChanged = $firstRun -or $Force -or ($changed | Where-Object {
    $_ -match '^requirements(\.lock)?\.txt$' -or $_ -match 'pyproject\.toml$'
})
# packages\ 아래 공용 코드는 모든 채널 프로세스가 물고 있어서 특정 채널로 좁힐 수 없다.
$sharedChanged = $firstRun -or $Force -or ($changed | Where-Object { $_ -like 'packages/*' })

# ── 4. 의존성 ───────────────────────────────────────────────────────────────
function Install-Requirements {
    # requirements.txt의 -e ./... 는 pip 프로세스의 작업 폴더를 기준으로 풀린다. 스케줄러가 부르면
    # 작업 폴더가 System32라서, 저장소로 옮겨놓고 실행하지 않으면 엉뚱한 경로가 설치된다.
    Push-Location $Root
    try {
        Invoke-Native -Label 'pip install -r requirements.txt' -Command {
            & $venvPython -m pip install --quiet --disable-pip-version-check -r 'requirements.txt'
        } | Out-Null
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $venvPython)) {
    Write-Step 'venv를 만듭니다.'
    Invoke-Native -Label "$Python -m venv" -Command { & $Python -m venv $venv } | Out-Null
    $depsChanged = $true
}

if ($depsChanged) {
    Write-Step '의존성을 설치합니다 (pip install -r requirements.txt)'
    Install-Requirements
} else {
    Write-Step '의존성 변경 없음 (editable 설치라 코드는 재시작만으로 반영됩니다)'
}

# pip을 새로 돌렸으면 이미 돌고 있는 프로세스는 아직 옛 라이브러리를 메모리에 물고 있다.
# venv를 다시 만든 경우도 여기 걸린다(위에서 $depsChanged가 켜진다). 공용 코드도 같은 이유로
# 어느 채널이 영향받는지 가릴 수 없으니, 이럴 때는 켜둔 채널을 전부 재시작한다.
$restartAll = [bool]$depsChanged -or [bool]$sharedChanged

# ── 5. 재시작할 채널 고르기 ─────────────────────────────────────────────────
# 설정이 덜 된 채널은 건너뛴다. 하나 때문에 나머지 채널 갱신까지 막히면 안 된다.
foreach ($channel in $channels | Where-Object { -not $_.Ready }) {
    Write-Note "$($channel.Name) 건너뜀 - $($channel.Skip)"
}

if ($channels.Count -eq 0) {
    Write-Note "channels\<이름>\.env 가 없어 이 서버에서 켤 채널이 없습니다. .env.example을 복사해 채워주세요."
    exit 0
}
if ($ready.Count -eq 0) { throw '설정이 끝난 채널이 없습니다. 위 경고를 확인해주세요.' }

$labels = $ready | ForEach-Object { '{0}:{1}' -f $_.Name, $_.Port }
Write-Step "대상 채널: $($labels -join ', ')"

$targets = foreach ($channel in $ready) {
    $exists = [bool](Get-Service -Name $channel.Service -ErrorAction SilentlyContinue)
    $touched = $restartAll -or ($changed | Where-Object { $_ -like "channels/$($channel.Name)/*" })
    if (-not $exists) { $channel | Add-Member -NotePropertyName Reason -NotePropertyValue '신규 등록' -PassThru }
    elseif ($touched) { $channel | Add-Member -NotePropertyName Reason -NotePropertyValue '변경 반영' -PassThru }
}
$targets = @($targets)

if ($NoRestart) {
    Write-Line "코드만 갱신했습니다 ($($after.Substring(0,7))). -NoRestart 라 서비스는 그대로입니다."
    exit 0
}
if ($targets.Count -eq 0) {
    Write-Line "코드는 갱신했지만 재시작이 필요한 채널이 없습니다 ($($after.Substring(0,7)))."
    exit 0
}

$nssmPath = Resolve-Nssm -Nssm $Nssm

# ── 6. 적용 + 확인 ──────────────────────────────────────────────────────────
function Update-Channel {
    param([Parameter(Mandatory)]$Channel)

    $standalone = Join-Path $Root "dist\$($Channel.Package)\$($Channel.Package).exe"
    $venvExe = Join-Path $Root ".venv\Scripts\$($Channel.Package).exe"
    if (-not (Test-Path $standalone) -and -not (Test-Path $venvExe)) {
        throw "실행 파일이 없습니다. build-channel-exe.ps1 로 exe를 만들거나 requirements.txt에 -e ./channels/$($Channel.Name) 을 넣으세요."
    }

    # 등록 스크립트에 맡긴다. 이미 등록된 서비스도 같은 길을 타야 .env에서 바꾼 HOST·PORT가
    # NSSM 설정에 반영된다. 단순 재시작만 하면 예전 값으로 계속 뜬다.
    # 스크립트가 재시작 후 /health까지 확인하고 실패하면 throw한다. 다만 확인과 무관한 곳(안내
    # 출력 등)에서 터졌을 때 정상으로 뜬 채널을 실패로 되돌리면 안 되니, 성패는 다시 확인한다.
    try {
        & (Join-Path $PSScriptRoot 'install-channel-service.ps1') -Channel $Channel.Name -Root $Root -Nssm $Nssm
    } catch {
        if (-not (Test-ChannelHealth -Port $Channel.Port -TimeoutSec 10)) { throw }
        Write-Note "$($Channel.Name) 등록 중 오류가 있었지만 채널은 정상입니다: $($_.Exception.Message)"
    }
}

$failed = $null
foreach ($channel in $targets) {
    Write-Step "$($channel.Name) $($channel.Reason)..."
    try {
        Update-Channel -Channel $channel
    } catch {
        $failed = $_
        Write-Note $_.Exception.Message
        # 원인을 로그만 보고 찾을 수 있게 예외 종류와 위치를 남긴다.
        Write-Line "  ($($_.Exception.GetType().Name) @ $($_.InvocationInfo.ScriptName):$($_.InvocationInfo.ScriptLineNumber))"
        break
    }
}

if (-not $failed) {
    Write-Line "[$(Get-Date -Format 'HH:mm:ss')] 배포 완료 - $($after.Substring(0,7)), 채널 $($targets.Count)개"
    exit 0
}

# ── 7. 되돌리기 ─────────────────────────────────────────────────────────────
if ($firstRun -or $after -eq $before) {
    throw "배포에 실패했습니다: $($failed.Exception.Message)"
}

Write-Note "이전 커밋 $($before.Substring(0,7)) 으로 되돌립니다."
Invoke-Git -Root $Root 'reset' '--hard' $before | Out-Null
if ($depsChanged) { Install-Requirements }
foreach ($channel in $targets) {
    if (-not (Get-Service -Name $channel.Service -ErrorAction SilentlyContinue)) { continue }
    try {
        Invoke-Nssm -NssmPath $nssmPath restart $channel.Service
        if (Test-ChannelHealth -Port $channel.Port) { Write-Step "$($channel.Name): 되돌린 상태로 정상" }
        else { Write-Note "$($channel.Name): 되돌린 뒤에도 응답이 없습니다. 수동 확인이 필요합니다." }
    } catch {
        Write-Note "$($channel.Name) 되돌리기 실패: $($_.Exception.Message)"
    }
}

throw "배포에 실패해 $($before.Substring(0,7)) 으로 되돌렸습니다: $($failed.Exception.Message)"
