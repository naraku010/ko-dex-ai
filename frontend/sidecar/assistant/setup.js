// CLI 설치와 로그인을 앱이 대신 실행한다.
// 설치는 출력만 흘려보내고, 로그인은 브라우저 OAuth라 사용자가 직접 조작할 콘솔 창을 띄운다.

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { randomUUID } = require('crypto')
const { execFileAsync, IS_WINDOWS } = require('./locate')
const config = require('../config')

function comspec() {
  return process.env.ComSpec || 'cmd.exe'
}

// 설치 스크립트가 사이드카의 Node 환경변수를 물려받으면 엉뚱하게 동작한다.
function cleanEnv() {
  return { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }
}

async function hasCommand(command) {
  if (IS_WINDOWS) {
    const { error } = await execFileAsync('where.exe', [command])
    return !error
  }
  const { error } = await execFileAsync('/usr/bin/which', [command])
  return !error
}

function powershellPath() {
  if (!process.env.SystemRoot) return 'powershell.exe'
  return path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

// installSteps의 한 단계를 실제 실행 명령으로 바꾼다. 필요한 도구가 없으면 null.
async function resolveStep(step) {
  if (step.kind === 'powershell') {
    if (!IS_WINDOWS) return null
    return { file: powershellPath(), args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', step.script] }
  }
  if (step.kind === 'npm') {
    if (!(await hasCommand('npm'))) return null
    // 윈도우 npm은 .cmd 셰임이라 셸을 거쳐야 한다.
    if (IS_WINDOWS) return { shellLine: `npm install -g ${step.pkg}` }
    return { file: 'npm', args: ['install', '-g', step.pkg] }
  }
  return null
}

function runStreaming({ file, args, shellLine }, onLine) {
  return new Promise((resolve) => {
    const child = shellLine
      ? spawn(comspec(), ['/d', '/s', '/c', shellLine], {
          windowsHide: true,
          windowsVerbatimArguments: true,
          env: cleanEnv(),
        })
      : spawn(file, args, { windowsHide: true, env: cleanEnv() })

    let buf = ''
    const pump = (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (line.trim()) onLine(line.trim())
      }
      if (buf.length > 4000) buf = buf.slice(-4000)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', pump)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', pump)
    child.on('error', (err) => resolve({ code: -1, error: err.message }))
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf.trim())
      resolve({ code, error: null })
    })
  })
}

// installSteps를 순서대로 시도하고, 하나라도 성공하면 끝낸다.
async function install(adapter, onLine) {
  const steps = adapter.installSteps ?? []
  if (steps.length === 0) {
    throw new Error(`${adapter.label}은(는) 앱에서 자동 설치를 지원하지 않습니다.`)
  }

  const missing = []
  let ran = 0

  for (const step of steps) {
    const command = await resolveStep(step)
    if (!command) {
      missing.push(step.requires ?? step.label)
      continue
    }
    ran += 1
    onLine(`[${step.label}] 시작`)
    const { code, error } = await runStreaming(command, onLine)
    if (code === 0) {
      onLine(`[${step.label}] 완료`)
      return { via: step.label }
    }
    onLine(`[${step.label}] 실패 — ${error || `종료 코드 ${code}`}`)
  }

  if (ran === 0) {
    throw new Error(`설치에 필요한 도구가 없습니다: ${[...new Set(missing)].join(', ')}`)
  }
  throw new Error('설치 명령이 모두 실패했습니다. 로그를 확인한 뒤 수동으로 설치해주세요.')
}

function loginScript(adapter, located, title) {
  const args = (adapter.loginCommand?.args ?? []).join(' ')
  const ext = path.extname(located.path).toLowerCase()
  // .cmd를 배치 안에서 그냥 부르면 npm 셰임이 부모 창을 끝내 버린다.
  const invoke = ext === '.cmd' || ext === '.bat'
    ? `call "${located.path}" ${args}`
    : `"${located.path}" ${args}`
  return [
    '@echo off',
    'chcp 65001 > nul',
    `title ${title}`,
    `echo ${adapter.label} 로그인을 시작합니다. 브라우저 안내를 따라주세요.`,
    'echo.',
    invoke,
    'echo.',
    'echo 로그인이 끝나면 이 창을 닫고 앱에서 "로그인 확인"을 눌러주세요.',
    'pause',
  ].join('\r\n')
}

// 로그인은 브라우저 인증이라 사용자가 직접 진행해야 한다. 보이는 콘솔 창으로 띄운다.
function openLogin(adapter, located) {
  if (!adapter.loginCommand) {
    throw new Error(`${adapter.label}은(는) 앱에서 로그인 창을 열 수 없습니다.`)
  }

  const args = adapter.loginCommand.args ?? []

  if (!IS_WINDOWS) {
    const child = spawn(located.path, args, { detached: true, stdio: 'ignore' })
    child.unref()
    return { started: true }
  }

  const title = `${adapter.label} 로그인`
  const file = path.join(config.workDir(), `login-${randomUUID()}.cmd`)
  fs.writeFileSync(file, `${loginScript(adapter, located, title)}\r\n`, 'utf8')

  // start로 띄워야 사이드카와 분리된 새 창에서 대화형 입력을 받을 수 있다.
  const child = spawn(comspec(), ['/d', '/s', '/c', `start "" "${file}"`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
    env: cleanEnv(),
  })
  child.unref()
  return { started: true }
}

// 로그인용 임시 .cmd는 창을 닫아도 남으므로 오래된 것만 지운다.
function cleanupLoginScripts() {
  const ONE_HOUR = 60 * 60 * 1000
  try {
    const dir = config.workDir()
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('login-') || !name.endsWith('.cmd')) continue
      const full = path.join(dir, name)
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > ONE_HOUR) fs.unlinkSync(full)
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

module.exports = { install, openLogin, cleanupLoginScripts }
