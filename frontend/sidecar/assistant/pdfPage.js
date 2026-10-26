// Windows.Data.Pdf로 도면 PDF 페이지를 PNG로 만든다.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$path = $args[0]',
  '$out = $args[1]',
  'if (-not $path -or -not $out) { throw "pdf path required" }',
  '$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]',
  '$null = [Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime]',
  '$null = [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]',
  '$null = [Windows.Data.Pdf.PdfPageRenderOptions,Windows.Data.Pdf,ContentType=WindowsRuntime]',
  '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1" })[0]',
  'function Await($WinRtTask, $ResultType) {',
  '  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)',
  '  $netTask = $asTask.Invoke($null, @($WinRtTask))',
  '  $netTask.Wait() | Out-Null',
  '  return $netTask.Result',
  '}',
  'function AwaitAction($WinRtAction) {',
  '  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and -not $_.IsGenericMethod })[0]',
  '  $netTask = $asTask.Invoke($null, @($WinRtAction))',
  '  $netTask.Wait() | Out-Null',
  '}',
  '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])',
  '$pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])',
  'if ($pdf.PageCount -lt 1) { throw "pdf has no pages" }',
  '$index = [Math]::Min([Math]::Max([int]$args[2], 0), [int]$pdf.PageCount - 1)',
  '$page = $pdf.GetPage([uint32]$index)',
  '$stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream',
  '$opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions',
  '$opts.DestinationWidth = [uint32]1600',
  'AwaitAction ($page.RenderToStreamAsync($stream, $opts))',
  '$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))',
  '$loaded = Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32])',
  '$bytes = New-Object byte[] $loaded',
  '$reader.ReadBytes($bytes)',
  '[IO.File]::WriteAllBytes($out, $bytes)',
].join('\r\n')

// page는 1부터 센다.
function rasterize(pdfPath, pngPath, page = 1) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('PDF 페이지는 Windows에서만 이미지로 만들 수 있습니다.'))
  }
  const script = path.join(os.tmpdir(), `kodex-pdf-page-${process.pid}.ps1`)
  fs.writeFileSync(script, `${SCRIPT}\r\n`, 'utf8')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, path.resolve(pdfPath), path.resolve(pngPath), String(Math.max(1, page) - 1)],
      { timeout: 90000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || 'PDF를 이미지로 만들지 못했습니다.').trim().slice(0, 300)))
          return
        }
        if (!fs.existsSync(pngPath) || fs.statSync(pngPath).size < 32) {
          reject(new Error('PDF 첫 페이지 이미지가 비어 있습니다.'))
          return
        }
        resolve(pngPath)
      },
    )
  })
}

const ALL_PAGES = SCRIPT
  .replace('$out = $args[1]', '$outDir = $args[1]\r\n$max = [int]$args[2]')
  .replace('if (-not $path -or -not $out) { throw "pdf path required" }', 'if (-not $path -or -not $outDir) { throw "pdf path required" }')
  .split('if ($pdf.PageCount -lt 1)')[0] + [
  '$count = [Math]::Min([int]$pdf.PageCount, $max)',
  'for ($i = 0; $i -lt $count; $i++) {',
  '  $page = $pdf.GetPage([uint32]$i)',
  '  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream',
  '  $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions',
  '  $opts.DestinationWidth = [uint32]1400',
  '  AwaitAction ($page.RenderToStreamAsync($stream, $opts))',
  '  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))',
  '  $loaded = Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32])',
  '  $bytes = New-Object byte[] $loaded',
  '  $reader.ReadBytes($bytes)',
  '  [IO.File]::WriteAllBytes((Join-Path $outDir ("p{0:D3}.png" -f ($i + 1))), $bytes)',
  '  $page.Dispose()',
  '}',
  'Write-Output $pdf.PageCount',
].join('\r\n')

// 스캔 PDF를 AI가 이미지로 보도록 페이지마다 PNG로 만든다. poppler 없이 Windows 기능만 쓴다.
function rasterizeAll(pdfPath, outDir, maxPages = 80) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('스캔 PDF는 Windows에서만 이미지로 만들 수 있습니다.'))
  }
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const script = path.join(os.tmpdir(), `kodex-pdf-pages-${process.pid}-${Date.now()}.ps1`)
  fs.writeFileSync(script, `${ALL_PAGES}\r\n`, 'utf8')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, path.resolve(pdfPath), path.resolve(outDir), String(maxPages)],
      { timeout: 10 * 60 * 1000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        fs.rmSync(script, { force: true })
        if (error) {
          reject(new Error(String(stderr || error.message || 'PDF를 이미지로 만들지 못했습니다.').trim().slice(0, 300)))
          return
        }
        const pages = fs.readdirSync(outDir).filter((name) => name.endsWith('.png')).sort().map((name) => path.join(outDir, name))
        if (!pages.length) {
          reject(new Error('PDF 페이지 이미지가 비어 있습니다.'))
          return
        }
        resolve({ pages, total: Number(String(stdout).trim()) || pages.length })
      },
    )
  })
}

module.exports = { rasterize, rasterizeAll }
