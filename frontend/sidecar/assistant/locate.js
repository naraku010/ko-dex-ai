const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')

const IS_WINDOWS = process.platform === 'win32'

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15000, windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

async function whichAll(command) {
  if (IS_WINDOWS) {
    const { error, stdout } = await execFileAsync('where.exe', [command])
    if (error) return []
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  }
  const { error, stdout } = await execFileAsync('/usr/bin/which', ['-a', command])
  if (error) return []
  return stdout.split(/\n/).map((l) => l.trim()).filter(Boolean)
}

function resolveShim(shimPath) {
  let text
  try {
    text = fs.readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }

  const dir = path.dirname(shimPath)
  const candidates = []
  for (const match of text.matchAll(/"([^"\n]*?\.exe)"/gi)) candidates.push(match[1])
  for (const match of text.matchAll(/^\s*(?:@?CALL\s+)?([^\s"]*?\.exe)\s/gim)) candidates.push(match[1])

  for (const raw of candidates) {
    const expanded = raw
      .replace(/%~dp0\\?/gi, `${dir}${path.sep}`)
      .replace(/%dp0%\\?/gi, `${dir}${path.sep}`)
      .replace(/\\\\/g, '\\')
    const resolved = path.resolve(expanded)
    if (fs.existsSync(resolved)) return resolved
  }
  return null
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function commonPaths(command) {
  const home = os.homedir()
  const list = []
  if (IS_WINDOWS) {
    list.push(
      path.join(home, '.local', 'bin', `${command}.exe`),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', command, `${command}.exe`),
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      path.join(process.env.ProgramFiles || '', 'nodejs', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    )
  } else {
    list.push(
      path.join(home, '.local', 'bin', command),
      `/usr/local/bin/${command}`,
      `/opt/homebrew/bin/${command}`,
      path.join(home, '.npm-global', 'bin', command),
    )
  }
  return list.filter(Boolean)
}

async function locateCli(command) {
  const found = await whichAll(command)

  for (const candidate of found) {
    const ext = path.extname(candidate).toLowerCase()
    if (IS_WINDOWS) {
      if (ext !== '.exe' && ext !== '.com') continue
    } else if (ext === '.ps1' || ext === '.cmd' || ext === '.bat') {
      continue
    }
    if (fileExists(candidate)) return { path: candidate, viaShell: false, source: 'PATH' }
  }

  for (const candidate of found) {
    const ext = path.extname(candidate).toLowerCase()
    if (ext !== '.cmd' && ext !== '.bat') continue
    const real = resolveShim(candidate)
    if (real) return { path: real, viaShell: false, source: '셰임 해석' }
  }

  for (const candidate of commonPaths(command)) {
    if (fileExists(candidate)) return { path: candidate, viaShell: false, source: '설치 경로' }
  }

  for (const candidate of found) {
    if (fileExists(candidate)) return { path: candidate, viaShell: true, source: '셸 경유' }
  }

  return null
}

function validateManualPath(rawPath) {
  const trimmed = String(rawPath || '').trim().replace(/^"|"$/g, '')
  if (!trimmed) throw new Error('경로가 비어 있습니다.')
  if (!fileExists(trimmed)) throw new Error(`해당 경로에 파일이 없습니다: ${trimmed}`)

  const ext = path.extname(trimmed).toLowerCase()
  if (ext === '.cmd' || ext === '.bat') {
    const real = resolveShim(trimmed)
    if (real) return { path: real, viaShell: false, source: '셰임 해석' }
    return { path: trimmed, viaShell: true, source: '셸 경유' }
  }
  if (ext === '.ps1') throw new Error('PowerShell 스크립트(.ps1)는 지원하지 않습니다. .exe 또는 .cmd 경로를 지정해주세요.')
  return { path: trimmed, viaShell: false, source: '직접 지정' }
}

module.exports = { locateCli, validateManualPath, execFileAsync, IS_WINDOWS }
