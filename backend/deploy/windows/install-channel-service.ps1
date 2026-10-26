<#
.SYNOPSIS
채널 하나를 Windows 서비스로 등록한다.

.DESCRIPTION
NSSM으로 채널 프로세스를 서비스로 감싼다. 채널마다 한 번씩 실행하면 된다.
이미 등록된 서비스면 멈추고 설정만 다시 맞춘 뒤 재시작한다.

보통은 deploy-channels.ps1이 필요할 때 이 스크립트를 알아서 부른다.
서비스 설정만 손볼 때 직접 쓴다.

준비물
  - dist\<채널>-channel\<채널>-channel.exe (build-channel-exe.ps1) 또는
    .venv\Scripts\<채널>-channel.exe
  - channels\<채널>\.env 를 채워둬야 한다 (CHANNEL_API_KEYS, PORT 필수)
    exe 옆에 .env 가 있으면 그쪽을 쓴다
  - NSSM (winget install NSSM.NSSM 또는 https://nssm.cc)
  - 관리자 권한 PowerShell

.EXAMPLE
  .\install-channel-service.ps1 -Channel shop

.EXAMPLE
  .\install-channel-service.ps1 -Channel shop -Port 12001 -Nssm C:\tools\nssm.exe
#>
[CmdletBinding()]
param(
    # channels\ 아래 폴더 이름
    [Parameter(Mandatory)][string]$Channel,

    # 채널이 뜰 포트. 비우면 채널 .env의 PORT를 쓴다.
    [int]$Port,

    # 바인딩 주소. 비우면 채널 .env의 HOST를 쓰고, 그것도 없으면 루프백.
    # 프록시 없이 외부에서 바로 붙으려면 0.0.0.0. ($Host는 PowerShell 예약 변수라 이름이 다르다)
    [string]$BindHost,

    # pyproject의 project.scripts 이름. 기본은 "<채널>-channel".
    [string]$Package,

    # 미리 만든 standalone exe. 비우면 dist\ 또는 .venv\Scripts\ 에서 찾는다.
    [string]$Exe,

    [string]$Root = (Join-Path $PSScriptRoot '..\..'),
    [string]$Nssm = 'nssm',
    [string]$LogDir
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_common.ps1"

Assert-Admin

if (-not $Package) { $Package = "$Channel-channel" }

$root = (Resolve-Path $Root).Path
$channelDir = Join-Path $root "channels\$Channel"
if (-not $LogDir) { $LogDir = Join-Path $root 'logs' }

if (-not $Exe) {
    $standalone = Join-Path $root "dist\$Package\$Package.exe"
    $venvExe = Join-Path $root ".venv\Scripts\$Package.exe"
    if (Test-Path $standalone) { $Exe = $standalone }
    elseif (Test-Path $venvExe) { $Exe = $venvExe }
}
if (-not $Exe -or -not (Test-Path $Exe)) {
    throw "실행 파일이 없습니다. .\deploy\windows\build-channel-exe.ps1 -Channel $Channel 로 만들거나, -Exe 로 경로를 주세요."
}
$exe = (Resolve-Path $Exe).Path
$exeDir = Split-Path $exe

$envFile = Join-Path $exeDir '.env'
if (-not (Test-Path $envFile)) { $envFile = Join-Path $channelDir '.env' }
if (-not (Test-Path $envFile)) { throw ".env가 없습니다. exe 옆이나 $channelDir 에 채워주세요." }
if (-not (Test-Path $channelDir) -and -not (Test-Path (Join-Path $exeDir '.env'))) {
    throw "채널 폴더가 없습니다: $channelDir"
}

$appDir = if (Test-Path (Join-Path $exeDir '.env')) { $exeDir } else { $channelDir }

Assert-ChannelKey -EnvFile $envFile

if (-not $Port) {
    $Port = Get-EnvValue -Path $envFile -Key 'PORT'
    if (-not $Port) { throw "$envFile 에 PORT가 없고 -Port도 주지 않았습니다." }
}

# load_dotenv()는 이미 설정된 환경변수를 덮지 않는다. 서비스 환경에 HOST를 박아 넣으면 .env의
# HOST가 무시되므로, 여기서 .env 값을 읽어 그대로 넘겨준다.
if (-not $BindHost) {
    $BindHost = Get-EnvValue -Path $envFile -Key 'HOST'
    if (-not $BindHost) { $BindHost = '127.0.0.1' }
}

$nssmPath = Resolve-Nssm -Nssm $Nssm
$service = Get-ServiceName $Channel
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$existing = Get-Service -Name $service -ErrorAction SilentlyContinue
if ($existing) {
    Write-Line "기존 서비스 $service 를 멈추고 설정을 다시 맞춥니다."
    if ($existing.Status -ne 'Stopped') { Invoke-Nssm -NssmPath $nssmPath stop $service }
} else {
    Write-Line "서비스 $service 를 등록합니다."
    Invoke-Nssm -NssmPath $nssmPath install $service $exe
}

Invoke-Nssm -NssmPath $nssmPath set $service Application $exe
# .env는 exe 옆 또는 채널 폴더. frozen exe는 runtime_dir()에서도 읽는다.
Invoke-Nssm -NssmPath $nssmPath set $service AppDirectory $appDir
Invoke-Nssm -NssmPath $nssmPath set $service AppEnvironmentExtra "HOST=$BindHost" "PORT=$Port"
Invoke-Nssm -NssmPath $nssmPath set $service DisplayName "EGI 채널 - $Channel"
Invoke-Nssm -NssmPath $nssmPath set $service Description "egi.channel/v1 채널 서버 ($Channel). ${BindHost}:$Port"
Invoke-Nssm -NssmPath $nssmPath set $service Start SERVICE_AUTO_START
Invoke-Nssm -NssmPath $nssmPath set $service AppExit Default Restart
Invoke-Nssm -NssmPath $nssmPath set $service AppRestartDelay 5000
Invoke-Nssm -NssmPath $nssmPath set $service AppStdout (Join-Path $LogDir "$Channel.out.log")
Invoke-Nssm -NssmPath $nssmPath set $service AppStderr (Join-Path $LogDir "$Channel.err.log")
Invoke-Nssm -NssmPath $nssmPath set $service AppRotateFiles 1
Invoke-Nssm -NssmPath $nssmPath set $service AppRotateOnline 1
Invoke-Nssm -NssmPath $nssmPath set $service AppRotateBytes 10485760

Invoke-Nssm -NssmPath $nssmPath start $service

# 처음 등록할 때는 채널이 데이터를 준비하는 시간이 더 걸린다 (shop은 1년치 데모 DB를 만든다).
$health = Test-ChannelHealth -Port $Port -TimeoutSec 60
if (-not $health) {
    throw "서비스는 떴지만 http://127.0.0.1:$Port/health 가 응답하지 않습니다. $LogDir\$Channel.err.log 를 확인하세요."
}

$loopback = $BindHost -in @('127.0.0.1', 'localhost', '::1')

Write-Line "정상: 툴 $($health.tools)개, 버전 $($health.version)"
Write-Line ''
Write-Line "서비스   : $service"
Write-Line "바인딩   : ${BindHost}:$Port"
Write-Line "로그     : $LogDir\$Channel.out.log"
Write-Line ''

if ($loopback) {
    Write-Line "이 서버 안에서만 붙습니다. 외부에서 쓰려면 둘 중 하나입니다."
    Write-Line "  - 앞단 프록시를 둔다 (iis-channels.example.config 참고)"
    Write-Line "  - .env의 HOST를 0.0.0.0으로 바꾸고 이 스크립트를 다시 실행한다"
} else {
    Write-Line "앱에 넣을 주소 : http://<서버IP>:$Port"
    Write-Line "방화벽에서 이 포트를 열어야 외부에서 붙습니다."
    Write-Line "  New-NetFirewallRule -DisplayName 'EGI channel $Channel' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow"

    # 이미지 주소가 루프백으로 남아 있으면 채널은 정상인데 앱에서 상품 사진만 안 나온다.
    $publicBase = Get-EnvValue -Path $envFile -Key 'PUBLIC_BASE_URL'
    if ($publicBase -and $publicBase -match '127\.0\.0\.1|localhost') {
        Write-Line ''
        Write-Note "PUBLIC_BASE_URL이 $publicBase 입니다. 이대로면 앱에서 사진이 안 보이니 공개 주소로 바꿔주세요."
    }
}
