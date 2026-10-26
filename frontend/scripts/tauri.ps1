# tauri-winres는 rc.exe가 PATH에 있어야 아이콘을 넣는다.
# 이 PC는 Windows SDK bin이 비어 있고, VS NuGet의 rc.exe만 있다.
$ErrorActionPreference = "Stop"

function Import-VcVars {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path -LiteralPath $vswhere)) { return }
  $install = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $install) { return }
  $bat = Join-Path $install "VC\Auxiliary\Build\vcvars64.bat"
  if (-not (Test-Path -LiteralPath $bat)) { return }
  cmd /c "`"$bat`" >nul && set" | ForEach-Object {
    $line = $_.Trim()
    if ($line -match "^([^=]+)=(.*)$") {
      Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
    }
  }
}

function Find-Rc {
  if ($env:RC -and (Test-Path -LiteralPath $env:RC)) {
    return $env:RC
  }
  $roots = @(
    (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"),
    (Join-Path $env:ProgramFiles "Windows Kits\10\bin"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Shared\NuGetPackages\microsoft.windows.sdk.buildtools")
  )
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $hit = Get-ChildItem -LiteralPath $root -Filter rc.exe -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\rc\.exe$' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

Import-VcVars
if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
  throw "link.exe를 찾지 못했습니다. Visual Studio Build Tools의 C++ 도구가 설치되어 있는지 확인하세요."
}

$rc = Find-Rc
if (-not $rc) {
  throw "rc.exe를 찾지 못했습니다. Visual Studio Installer에서 Windows SDK를 설치하세요."
}
$env:RC = $rc
Write-Host "RC=$rc"

$tauriArgs = @($args)
if ($tauriArgs.Count -eq 0) { $tauriArgs = @("dev") }

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
& npx tauri @tauriArgs
exit $LASTEXITCODE
