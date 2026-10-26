$ErrorActionPreference = "SilentlyContinue"

$repo = Split-Path -Parent $PSScriptRoot
$targets = @(
  (Join-Path $repo "src-tauri\target\debug\node.exe"),
  (Join-Path $repo "src-tauri\target\debug\node-x86_64-pc-windows-msvc.exe"),
  (Join-Path $repo "src-tauri\target\release\node.exe"),
  (Join-Path $repo "src-tauri\target\release\node-x86_64-pc-windows-msvc.exe"),
  (Join-Path $repo "src-tauri\target\debug\app.exe"),
  (Join-Path $repo "src-tauri\target\release\app.exe")
) | ForEach-Object { [System.IO.Path]::GetFullPath($_) }

$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and ($targets -contains [System.IO.Path]::GetFullPath($_.ExecutablePath))
}

foreach ($p in $procs) {
  Write-Host "잠금 해제: $($p.ProcessId) $($p.ExecutablePath)"
  Stop-Process -Id $p.ProcessId -Force
}

if ($procs) {
  Start-Sleep -Seconds 1
}

foreach ($path in $targets) {
  if (-not (Test-Path $path)) { continue }
  try {
    $fs = [System.IO.File]::Open($path, "Open", "Write", "None")
    $fs.Close()
  } catch {
    $moved = "$path.old-lock"
    Remove-Item $moved -Force -ErrorAction SilentlyContinue
    try {
      Rename-Item $path $moved -Force
      Write-Host "이름 변경으로 잠금 회피: $path"
    } catch {
      Write-Host "잠금 유지 중: $path"
    }
  }
}
