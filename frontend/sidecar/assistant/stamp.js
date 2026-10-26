// 생성한 도면 이미지에 회사 로고(좌상단)와 태그 번호(좌하단)를 얹는다. AI가 글자를 그리면 틀릴 수 있어 직접 그린다.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { randomUUID } = require('crypto')
const LOGO_BASE64 = require('./woosungLogo')

const SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Drawing',
  '$imagePath = $args[0]',
  '$logoPath = $args[1]',
  '$tag = $args[2]',
  '$bytes = [IO.File]::ReadAllBytes($imagePath)',
  '$ms = New-Object IO.MemoryStream(,$bytes)',
  '$src = [Drawing.Image]::FromStream($ms)',
  '$bmp = New-Object Drawing.Bitmap($src.Width, $src.Height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)',
  '$g = [Drawing.Graphics]::FromImage($bmp)',
  '$g.DrawImage($src, 0, 0, $src.Width, $src.Height)',
  '$src.Dispose()',
  '$g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias',
  '$g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
  '$g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit',
  '$w = [double]$bmp.Width',
  '$margin = [Math]::Round($w * 0.03)',
  '$pad = [Math]::Round($w * 0.016)',
  '$fill = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(215, 14, 38, 74))',
  'function Badge($x, $y, $bw, $bh) {',
  '  $r = [Math]::Min($bh / 2, $w * 0.014) * 2',
  '  $p = New-Object Drawing.Drawing2D.GraphicsPath',
  '  $p.AddArc($x, $y, $r, $r, 180, 90)',
  '  $p.AddArc($x + $bw - $r, $y, $r, $r, 270, 90)',
  '  $p.AddArc($x + $bw - $r, $y + $bh - $r, $r, $r, 0, 90)',
  '  $p.AddArc($x, $y + $bh - $r, $r, $r, 90, 90)',
  '  $p.CloseFigure()',
  '  $g.FillPath($fill, $p)',
  '  $p.Dispose()',
  '}',
  'if ($logoPath -and (Test-Path $logoPath)) {',
  '  $logo = [Drawing.Image]::FromFile($logoPath)',
  '  $lw = [Math]::Round($w * 0.26)',
  '  $lh = [Math]::Round($lw * $logo.Height / $logo.Width)',
  '  Badge $margin $margin ($lw + $pad * 2) ($lh + $pad * 2)',
  '  $g.DrawImage($logo, [int]($margin + $pad), [int]($margin + $pad), [int]$lw, [int]$lh)',
  '  $logo.Dispose()',
  '}',
  'if ($tag) {',
  '  $font = New-Object Drawing.Font("Segoe UI Semibold", [single]($w * 0.03), [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)',
  '  $size = $g.MeasureString($tag, $font)',
  '  $bw = $size.Width + $pad * 2',
  '  $bh = $size.Height + $pad',
  '  $y = $bmp.Height - $margin - $bh',
  '  Badge $margin $y $bw $bh',
  '  $g.DrawString($tag, $font, [Drawing.Brushes]::White, [single]($margin + $pad), [single]($y + $pad / 2))',
  '  $font.Dispose()',
  '}',
  '$g.Dispose()',
  '$bmp.Save($imagePath, [Drawing.Imaging.ImageFormat]::Png)',
  '$bmp.Dispose()',
].join('\r\n')

// logo는 우성 채널에서만 켠다. 태그는 채널과 상관없이 찍는다.
function stamp(imagePath, { tag = '', logo: withLogo = false } = {}) {
  if (process.platform !== 'win32' || (!tag && !withLogo)) return Promise.resolve(imagePath)
  const id = randomUUID()
  const script = path.join(os.tmpdir(), `egi-stamp-${id}.ps1`)
  const logo = withLogo ? path.join(os.tmpdir(), `egi-stamp-${id}.png`) : ''
  fs.writeFileSync(script, `${SCRIPT}\r\n`, 'utf8')
  if (logo) fs.writeFileSync(logo, Buffer.from(LOGO_BASE64, 'base64'))
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, path.resolve(imagePath), logo, String(tag || '')],
      { timeout: 60000, windowsHide: true },
      (error, _stdout, stderr) => {
        fs.rmSync(script, { force: true })
        if (logo) fs.rmSync(logo, { force: true })
        if (error) {
          reject(new Error(String(stderr || error.message || '이미지에 로고를 넣지 못했습니다.').trim().slice(0, 300)))
          return
        }
        resolve(imagePath)
      },
    )
  })
}

module.exports = { stamp }
