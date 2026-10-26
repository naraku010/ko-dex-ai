<#
.SYNOPSIS
EGI 채널 서버 설치 (Windows x64, Python 필요 없음)

.DESCRIPTION
설치 마법사(setup.exe)가 파일을 복사한 뒤 이 스크립트를 부른다. zip으로 받았으면 풀어둔 폴더에서
관리자 PowerShell로 직접 실행한다.

  1. 채널마다 .env 가 없으면 .env.example 로 만들고 API 키를 새로 뽑아 넣는다
  2. NSSM으로 Windows 서비스 EgiChannel-<채널> 을 등록하고 /health 응답까지 확인한다
  3. 앱에 넣을 주소와 키를 install-summary.txt 에 남긴다

다시 실행해도 된다. .env 와 data\ 는 그대로 두고 서비스 설정만 다시 맞춘다.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -Channel shop -BindHost 0.0.0.0 -OpenFirewall
  .\install.ps1 -NoService
#>
[CmdletBinding()]
param(
    # 이 채널만 설치. 비우면 channels\ 아래 전부.
    [string[]]$Channel,

    # 새로 만드는 .env 의 HOST. 0.0.0.0 이면 다른 PC에서 바로 붙는다.
    [string]$BindHost,

    # HOST가 루프백이 아닌 채널의 포트를 방화벽에서 연다.
    [switch]$OpenFirewall,

    # .env 만 준비하고 서비스는 등록하지 않는다.
    [switch]$NoService,

    # 끝나고 창을 바로 닫지 않는다 (설치 마법사가 쓴다).
    [switch]$Pause,

    [string]$Nssm
)

$ErrorActionPreference = 'Stop'
try {
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
} catch { }

$Root = $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Write-Line([AllowEmptyString()][string]$Text = '') {
    try { Write-Host $Text } catch { try { [Console]::Out.WriteLine($Text) } catch { } }
}
function Write-Note([string]$Text) { Write-Line "경고: $Text" }

function Get-EnvValue([string]$Path, [string]$Key) {
    if (-not (Test-Path $Path)) { return $null }
    $pattern = "^\s*$([regex]::Escape($Key))\s*=\s*(.*?)\s*$"
    $hit = [System.IO.File]::ReadAllLines($Path, $Utf8NoBom) | Where-Object { $_ -match $pattern } | Select-Object -Last 1
    if (-not $hit) { return $null }
    $value = [regex]::Match($hit, $pattern).Groups[1].Value
    $value = ($value -split '\s+#')[0].Trim()
    $value.Trim('"').Trim("'")
}

# KEY=값 줄을 바꾼다. 주석 처리된 줄(#KEY=)도 살려서 바꾸고, 없으면 끝에 붙인다.
function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.AddRange([string[]][System.IO.File]::ReadAllLines($Path, $Utf8NoBom))
    $pattern = "^\s*#?\s*$([regex]::Escape($Key))\s*="
    $done = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) { $lines[$i] = "$Key=$Value"; $done = $true; break }
    }
    if (-not $done) { $lines.Add("$Key=$Value") }
    [System.IO.File]::WriteAllLines($Path, $lines.ToArray(), $Utf8NoBom)
}

function New-ChannelKey {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Get-LanAddress {
    try {
        Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
            Sort-Object InterfaceMetric |
            Select-Object -First 1 -ExpandProperty IPAddress
    } catch { $null }
}

function Invoke-Nssm {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = & $script:NssmPath @args 2>&1; $code = $LASTEXITCODE }
    finally { $ErrorActionPreference = $previous }
    if ($code -ne 0) { throw "nssm $($args -join ' ') 실패 (종료 코드 $code): $($out -join ' ')" }
}

function Test-ChannelHealth([int]$Port, [int]$TimeoutSec = 60) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 700
        try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 } catch { }
    }
    $null
}

function Install-Channel([string]$Name) {
    $dir = Join-Path $Root "channels\$Name"
    $exe = Join-Path $dir "$Name-channel.exe"
    $envFile = Join-Path $dir '.env'
    $example = Join-Path $dir '.env.example'
    if (-not (Test-Path $exe)) { throw "[$Name] 실행 파일이 없습니다: $exe" }

    $created = $false
    if (-not (Test-Path $envFile)) {
        if (-not (Test-Path $example)) { throw "[$Name] .env.example 이 없습니다." }
        Copy-Item $example $envFile
        $created = $true
    }
    $key = Get-EnvValue $envFile 'CHANNEL_API_KEYS'
    if (-not $key -or $key -eq 'change-me') {
        $key = New-ChannelKey
        Set-EnvValue $envFile 'CHANNEL_API_KEYS' $key
        Write-Line "[$Name] API 키를 새로 만들었습니다."
    }
    if ($created -and $BindHost) {
        Set-EnvValue $envFile 'HOST' $BindHost
        $public = Get-EnvValue $envFile 'PUBLIC_BASE_URL'
        $ip = Get-LanAddress
        if ($ip -and $public -and $public -match '127\.0\.0\.1|localhost') {
            Set-EnvValue $envFile 'PUBLIC_BASE_URL' "http://${ip}:$(Get-EnvValue $envFile 'PORT')"
        }
    }

    $port = Get-EnvValue $envFile 'PORT'
    if ($port -notmatch '^\d+$') { throw "[$Name] $envFile 의 PORT가 비었거나 숫자가 아닙니다." }
    $hostValue = Get-EnvValue $envFile 'HOST'
    if (-not $hostValue) { $hostValue = '127.0.0.1' }
    $loopback = $hostValue -in @('127.0.0.1', 'localhost', '::1')

    $ok = $true
    if (-not $NoService) {
        $service = "EgiChannel-$Name"
        $existing = Get-Service -Name $service -ErrorAction SilentlyContinue
        if ($existing) {
            if ($existing.Status -ne 'Stopped') { Invoke-Nssm stop $service }
        } else {
            Write-Line "[$Name] 서비스 $service 를 등록합니다."
            Invoke-Nssm install $service $exe
        }
        Invoke-Nssm set $service Application $exe
        Invoke-Nssm set $service AppDirectory $dir
        Invoke-Nssm set $service DisplayName "EGI 채널 - $Name"
        Invoke-Nssm set $service Description "egi.channel/v1 채널 서버 ($Name). ${hostValue}:$port"
        Invoke-Nssm set $service Start SERVICE_AUTO_START
        Invoke-Nssm set $service AppExit Default Restart
        Invoke-Nssm set $service AppRestartDelay 5000
        Invoke-Nssm set $service AppStdout (Join-Path $LogDir "$Name.out.log")
        Invoke-Nssm set $service AppStderr (Join-Path $LogDir "$Name.err.log")
        Invoke-Nssm set $service AppRotateFiles 1
        Invoke-Nssm set $service AppRotateOnline 1
        Invoke-Nssm set $service AppRotateBytes 10485760
        Invoke-Nssm start $service

        Write-Line "[$Name] 기동 확인 중 (http://127.0.0.1:$port/health)..."
        $health = Test-ChannelHealth -Port ([int]$port)
        if ($health) {
            Write-Line "[$Name] 정상: 툴 $($health.tools)개, 버전 $($health.version)"
        } else {
            Write-Note "[$Name] /health 가 응답하지 않습니다. $LogDir\$Name.err.log 를 확인하세요."
            $ok = $false
        }
    }

    if ($OpenFirewall -and -not $loopback) {
        $rule = "EGI channel $Name"
        Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort ([int]$port) -Action Allow | Out-Null
        Write-Line "[$Name] 방화벽에서 TCP $port 를 열었습니다."
    }

    $url = if ($loopback) { "http://127.0.0.1:$port" } else { "http://<서버IP>:$port" }
    if (-not $loopback) {
        $public = Get-EnvValue $envFile 'PUBLIC_BASE_URL'
        if ($public -and $public -match '127\.0\.0\.1|localhost') {
            Write-Note "[$Name] PUBLIC_BASE_URL이 $public 입니다. 앱에서 이미지가 보이려면 공개 주소로 바꾸세요."
        }
    }
    [pscustomobject]@{ Name = $Name; Url = $url; Key = $key; Bind = "${hostValue}:$port"; Ok = $ok }
}

$failed = $false
try {
    $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '관리자 권한 PowerShell에서 실행해주세요.'
    }

    $packaged = @(Get-ChildItem (Join-Path $Root 'channels') -Directory | Sort-Object Name | ForEach-Object { $_.Name })
    if (-not $packaged) { throw "channels 폴더에 채널이 없습니다: $Root\channels" }
    $targets = if ($Channel) { @($Channel | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { $packaged }
    foreach ($name in $targets) {
        if ($name -notin $packaged) { throw "패키지에 없는 채널입니다: $name (있는 채널: $($packaged -join ', '))" }
    }

    if (-not $NoService) {
        $candidates = @($Nssm, (Join-Path $Root 'tools\nssm.exe')) | Where-Object { $_ }
        $script:NssmPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $script:NssmPath) {
            $cmd = Get-Command nssm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($cmd) { $script:NssmPath = $cmd.Path }
        }
        if (-not $script:NssmPath) {
            throw 'NSSM을 찾을 수 없습니다. winget install NSSM.NSSM 으로 설치하거나 -Nssm 으로 경로를 주세요.'
        }
        New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    }

    $version = (Get-Content (Join-Path $Root 'VERSION') -ErrorAction SilentlyContinue | Select-Object -First 1)
    Write-Line "EGI 채널 서버 $version 설치 → $Root"
    $results = @(foreach ($name in $targets) { Install-Channel $name })

    $summary = New-Object System.Collections.Generic.List[string]
    $summary.Add("EGI 채널 서버 $version")
    $summary.Add("설치 폴더: $Root")
    $summary.Add('')
    $summary.Add('앱 설정 → 채널 → 채널 추가 에 아래 주소와 키를 넣습니다.')
    foreach ($r in $results) { $summary.Add("  $($r.Name)  주소 $($r.Url)  키 $($r.Key)  ($($r.Bind))") }
    $summary.Add('')
    $summary.Add("설정 파일 : $Root\channels\<채널>\.env  (바꾼 뒤 서비스 EgiChannel-<채널> 재시작)")
    $summary.Add("로그      : $LogDir")
    $summaryFile = Join-Path $Root 'install-summary.txt'
    [System.IO.File]::WriteAllLines($summaryFile, $summary.ToArray(), (New-Object System.Text.UTF8Encoding $true))

    Write-Line ''
    $summary | ForEach-Object { Write-Line $_ }
    $bad = @($results | Where-Object { -not $_.Ok })
    if ($bad) { throw "응답하지 않는 채널: $(($bad | ForEach-Object { $_.Name }) -join ', ')" }
} catch {
    $failed = $true
    Write-Line ''
    Write-Line "오류: $($_.Exception.Message)"
} finally {
    if ($Pause) {
        Write-Line ''
        try { Read-Host '엔터를 누르면 창이 닫힙니다' | Out-Null } catch { }
    }
}
if ($failed) { exit 1 }
