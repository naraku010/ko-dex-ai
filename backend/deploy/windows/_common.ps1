<#
배포 스크립트들이 함께 쓰는 함수 모음. 단독 실행용이 아니라 dot-source로 불러 쓴다.

  . "$PSScriptRoot\_common.ps1"
#>

# UTF-8 스크립트 + 구형 콘솔(PS 4). 코드페이지를 먼저 맞추지 않으면 한글이 깨진다.
try {
    $script:EgiUtf8 = New-Object System.Text.UTF8Encoding $false
    [Console]::InputEncoding = $script:EgiUtf8
    [Console]::OutputEncoding = $script:EgiUtf8
    $OutputEncoding = $script:EgiUtf8
    chcp 65001 > $null
} catch { }

# 구형 서버(PS 2.0)에서는 여기 쓰인 문법이 안 돌아간다. 엉뚱한 오류로 헤매지 않게 먼저 막는다.
if ($PSVersionTable.PSVersion.Major -lt 3) {
    throw "PowerShell 3.0 이상이 필요합니다. 현재 $($PSVersionTable.PSVersion) 입니다."
}

<#
콘솔에 한 줄 찍는다. 구형 콘솔 호스트는 한글이 섞인 줄을 쓰다가 IndexOutOfRangeException을
던지는 일이 있는데, 안내 문구 하나 때문에 정상 배포가 실패로 뒤집히면 안 된다. 그래서 출력
실패는 삼키고, 대신 .NET 콘솔로 한 번 더 시도해 기록은 남긴다.
#>
function Write-Line {
    param([AllowEmptyString()][string]$Text = '')

    try { Write-Host $Text; return } catch { }
    try { [Console]::Out.WriteLine($Text) } catch { }
}

# Write-Warning도 같은 출력 경로를 타므로 쓰지 않는다.
function Write-Note {
    param([AllowEmptyString()][string]$Text = '')
    Write-Line "경고: $Text"
}

function Assert-Admin {
    $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '관리자 권한 PowerShell에서 실행해주세요.'
    }
}

function Get-ServiceName {
    param([Parameter(Mandatory)][string]$Channel)
    "EgiChannel-$Channel"
}

# .env에서 값 하나를 읽는다. 주석과 앞뒤 공백, 따옴표는 걷어낸다.
function Get-EnvValue {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Key
    )
    if (-not (Test-Path $Path)) { return $null }
    # Get-Content는 BOM 없는 UTF-8을 ANSI로 읽는다. .env는 UTF-8이라 .NET으로 직접 읽는다.
    # [Type]::new()는 PS 5.0부터라서, 구형 서버에서도 되는 New-Object를 쓴다.
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $lines = [System.IO.File]::ReadAllLines($Path, $utf8)
    $pattern = "^\s*$([regex]::Escape($Key))\s*=\s*(.*?)\s*$"
    $hit = $lines | Where-Object { $_ -match $pattern } | Select-Object -Last 1
    if (-not $hit) { return $null }
    # $Matches는 Where-Object 안에서 설정돼 여기선 이전 값이 남아 있을 수 있다. 다시 매치한다.
    $value = [regex]::Match($hit, $pattern).Groups[1].Value
    $value = ($value -split '\s+#')[0].Trim()
    $value.Trim('"').Trim("'")
}

<#
이 서버에서 돌릴 채널 목록. channels\<이름>\.env 가 있는 것만 대상으로 본다.
.env는 git에 올라가지 않으니, 어떤 채널을 켤지는 서버마다 .env 유무로 정해진다.

설정이 덜 된 채널도 Ready=$false로 함께 돌려준다. 하나 잘못 적힌 .env 때문에 나머지 채널
갱신까지 멈추면 안 되고, 경고를 언제 찍을지는 부르는 쪽이 정하는 게 낫다.
#>
function Get-EnabledChannels {
    param([Parameter(Mandatory)][string]$Root)

    $dir = Join-Path $Root 'channels'
    if (-not (Test-Path $dir)) { throw "channels 폴더가 없습니다: $dir" }

    foreach ($folder in Get-ChildItem $dir -Directory | Sort-Object Name) {
        $envFile = Join-Path $folder.FullName '.env'
        if (-not (Test-Path $envFile)) { continue }

        $port = Get-EnvValue -Path $envFile -Key 'PORT'
        $key = Get-EnvValue -Path $envFile -Key 'CHANNEL_API_KEYS'

        $skip = $null
        $portNumber = 0
        if (-not $port) {
            $skip = "$envFile 에 PORT가 없습니다. 채널마다 다른 포트를 지정해주세요."
        } elseif ($port -notmatch '^\d+$') {
            $skip = "$envFile 의 PORT가 숫자가 아닙니다: $port"
        } elseif (-not $key) {
            # 키를 비운 채로 올리면 인증 없이 열린다. 배포 사고로 이어지니 여기서 막는다.
            $skip = "$envFile 의 CHANNEL_API_KEYS가 비어 있습니다. 채널이 인증 없이 열립니다."
        } elseif ($key -eq 'change-me') {
            $skip = "$envFile 의 CHANNEL_API_KEYS가 예시값(change-me) 그대로입니다."
        }
        if ($port -match '^\d+$') { $portNumber = [int]$port }

        [pscustomobject]@{
            Name    = $folder.Name
            Dir     = $folder.FullName
            EnvFile = $envFile
            Port    = $portNumber
            Package = "$($folder.Name)-channel"
            Service = Get-ServiceName $folder.Name
            Ready   = -not $skip
            Skip    = $skip
        }
    }
}

# 키를 비운 채로 올리면 인증 없이 열린다. 배포 사고로 이어지니 여기서 막는다.
function Assert-ChannelKey {
    param([Parameter(Mandatory)][string]$EnvFile)

    $key = Get-EnvValue -Path $EnvFile -Key 'CHANNEL_API_KEYS'
    if (-not $key) { throw "$EnvFile 의 CHANNEL_API_KEYS가 비어 있습니다. 채널이 인증 없이 열립니다." }
    if ($key -eq 'change-me') { throw "$EnvFile 의 CHANNEL_API_KEYS가 예시값(change-me) 그대로입니다." }
}

<#
git·nssm·pip은 정상 진행 상황도 stderr로 찍는다. $ErrorActionPreference='Stop'과 겹치면
잘 끝난 명령에서도 예외가 터지므로, 여기서만 Continue로 낮추고 성패는 종료 코드로 판단한다.
stdout 줄만 돌려주고, 실패하면 stderr까지 합쳐 메시지에 담는다.
#>
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][scriptblock]$Command
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $merged = & $Command 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }

    if ($code -ne 0) {
        $text = ($merged | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
        throw "$Label 실패 (종료 코드 $code):`n$text"
    }
    $merged |
        Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } |
        ForEach-Object { $_.ToString() }
}

function Resolve-Nssm {
    param([string]$Nssm = 'nssm')

    if (-not $Nssm) { throw 'NSSM 경로가 비어 있습니다. -Nssm 으로 nssm.exe 경로를 주세요.' }

    # 경로를 직접 준 경우가 대부분이다. Get-Command를 거치지 않고 바로 확인한다.
    if (Test-Path -LiteralPath $Nssm -PathType Leaf) {
        return (Resolve-Path -LiteralPath $Nssm).ProviderPath
    }

    $cmd = Get-Command $Nssm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) {
        throw "NSSM을 찾을 수 없습니다2: $Nssm — nssm.exe를 설치하고 -Nssm 으로 경로를 주세요 (예: -Nssm C:\tools\nssm.exe)."
    }
    # PS 4.0의 ApplicationInfo는 Source가 비어 있다. Path가 버전에 상관없이 채워진다.
    $path = $cmd.Path
    if (-not $path) { $path = $cmd.Source }
    if (-not $path) { $path = $cmd.Definition }
    if (-not $path) { throw "NSSM 실행 경로를 확인할 수 없습니다: $Nssm" }
    $path
}

function Invoke-Nssm {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$NssmPath,
        [Parameter(ValueFromRemainingArguments)][string[]]$Arguments
    )
    # 빈 문자열이 오면 매개 변수 바인딩 오류가 나서 원인을 찾기 어렵다. 여기서 짚어준다.
    if (-not $NssmPath) { throw 'NSSM 경로를 확인하지 못했습니다. -Nssm 으로 nssm.exe 경로를 주세요.' }
    Invoke-Native -Label "nssm $($Arguments -join ' ')" -Command { & $NssmPath @Arguments } | Out-Null
}

<#
채널이 실제로 응답하는지 본다. shop 채널은 처음 뜰 때 데모 DB를 만들어서 몇 초 걸릴 수 있다.
#>
function Test-ChannelHealth {
    param(
        [Parameter(Mandatory)][int]$Port,
        [int]$TimeoutSec = 30
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 700
        try {
            return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
        } catch { }
    }
    $null
}

function Invoke-Git {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(ValueFromRemainingArguments)][string[]]$Arguments
    )
    Invoke-Native -Label "git $($Arguments -join ' ')" -Command { & git -C $Root @Arguments }
}
