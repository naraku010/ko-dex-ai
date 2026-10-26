const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { randomUUID } = require('crypto')
const { validateManualPath, execFileAsync, IS_WINDOWS } = require('../locate')
const { koreanHint, keepCurrentModels } = require('../modelHints')
const { buildSystemPrompt } = require('../prompt')
const { toolLabel: sharedToolLabel } = require('../toolLabels')

const COMMAND = 'codex'
const MCP_SERVER_NAME = 'egi'
const MCP_TOKEN_ENV = 'EGI_MCP_TOKEN'

// 'default'는 -m을 넘기지 않고 codex config.toml 또는 계정의 권장 모델을 그대로 쓴다.
// 계정(요금제)과 롤아웃마다 사용 가능한 모델이 달라, 강제로 지정하면 실패할 수 있어 기본은 CLI 설정을 따른다.
const DEFAULT_MODEL = 'default'
const MODELS = [
  { id: 'default', label: 'CLI 기본값', hint: 'config.toml 설정 또는 계정의 권장 모델 사용' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', hint: '가장 어려운 복합 작업 · 계정별 순차 제공' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', hint: '복잡한 코딩·리서치에 최적화' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', hint: '성능과 비용의 균형 · 일상 작업에 권장' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', hint: '빠르고 경제적인 반복 작업용' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', hint: '초고속 코딩 프리뷰 · Pro 계정 전용' },
]

function resolveModel(model) {
  const id = String(model || '').trim()
  return id || DEFAULT_MODEL
}

function runCliWithTimeout(located, args, timeout = 20000) {
  if (located.viaShell) {
    return execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${located.path}" ${args.join(' ')}`], { timeout })
  }
  return execFileAsync(located.path, args, { timeout })
}

// CLI 설명의 상태(최상위·이전 세대)를 한국어 설명 앞에 붙인다.
function codexHint(model, isTop) {
  const text = String(model.description || '')
  const base = koreanHint(model.slug, text)
  if (isTop) return `추천 · ${base}`
  if (/^(older|legacy|previous)\b/i.test(text)) return `이전 세대 · ${base.replace(/일상 작업에 권장/, '일상 작업용')}`
  return base
}

async function listModels(located) {
  if (!located?.path) return MODELS
  const { error, stdout, stderr } = await runCliWithTimeout(located, ['debug', 'models'])
  if (error) return MODELS
  try {
    const raw = `${stdout || ''}\n${stderr || ''}`
    const start = raw.indexOf('{')
    if (start < 0) return MODELS
    const data = JSON.parse(raw.slice(start))
    const items = Array.isArray(data?.models) ? data.models : []
    // CLI가 숨기거나 후속 모델로 옮기라고 안내(upgrade)하는 모델은 뺀다.
    const mapped = items
      .filter((m) => m?.slug && m.visibility !== 'hide' && !m.upgrade)
      .sort((a, b) => (a.priority || 0) - (b.priority || 0))
      .map((m, index) => ({
        id: String(m.slug),
        label: String(m.display_name || m.slug),
        hint: codexHint(m, index === 0),
      }))
    const current = keepCurrentModels(mapped)
    if (current.length === 0) return MODELS
    return [
      { id: 'default', label: 'CLI 기본값', hint: 'config.toml 설정 또는 계정의 권장 모델 사용' },
      ...current,
    ]
  } catch {
    return MODELS
  }
}

// 'default'이면 -m을 생략한다.
function modelArgs(model) {
  const resolved = resolveModel(model)
  return resolved === 'default' ? [] : ['-m', resolved]
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

// codex는 npm shim(codex.cmd → node → codex.js)으로 설치되는 경우가 많다.
// Claude용 셰임 해석은 node.exe로 잘못 풀리므로, codex는 여기서 직접 찾는다.
async function whichAll() {
  if (IS_WINDOWS) {
    const { error, stdout } = await execFileAsync('where.exe', [COMMAND])
    if (error) return []
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  }
  const { error, stdout } = await execFileAsync('/usr/bin/which', ['-a', COMMAND])
  if (error) return []
  return stdout.split(/\n/).map((l) => l.trim()).filter(Boolean)
}

// codex.cmd 옆의 실제 네이티브 바이너리(codex.exe)를 npm 설치 구조에서 찾는다.
function resolveNativeExe(cmdPath) {
  const dir = path.dirname(cmdPath)
  const pkgRoot = path.join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai')
  let entries
  try {
    entries = fs.readdirSync(pkgRoot)
  } catch {
    return null
  }
  for (const name of entries) {
    if (!name.startsWith('codex-')) continue
    const candidate = path.join(pkgRoot, name, 'vendor')
    const exe = findExeUnder(candidate)
    if (exe) return exe
  }
  return null
}

function findExeUnder(root) {
  let stack = [root]
  let steps = 0
  while (stack.length && steps < 5000) {
    steps += 1
    const cur = stack.pop()
    let stat
    try {
      stat = fs.statSync(cur)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      let children = []
      try {
        children = fs.readdirSync(cur).map((c) => path.join(cur, c))
      } catch {
        children = []
      }
      stack = stack.concat(children)
    } else if (path.basename(cur).toLowerCase() === 'codex.exe') {
      return cur
    }
  }
  return null
}

// 설치 직후에는 사이드카의 PATH가 갱신되지 않아 where.exe가 못 찾는다.
function npmGlobalCandidates() {
  if (IS_WINDOWS) {
    return [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', `${COMMAND}.exe`),
      path.join(process.env.APPDATA || '', 'npm', `${COMMAND}.cmd`),
    ]
  }
  return [
    path.join(os.homedir(), '.npm-global', 'bin', COMMAND),
    `/usr/local/bin/${COMMAND}`,
    `/opt/homebrew/bin/${COMMAND}`,
  ]
}

async function locate(manualPath) {
  if (manualPath) return validateManualPath(manualPath)

  const found = await whichAll()

  // 1. PATH 위의 네이티브 실행 파일(.exe / 확장자 없는 유닉스 바이너리)
  for (const candidate of found) {
    const ext = path.extname(candidate).toLowerCase()
    if (IS_WINDOWS) {
      if (ext === '.exe' && fileExists(candidate)) return { path: candidate, viaShell: false, source: 'PATH' }
    } else if (ext !== '.cmd' && ext !== '.bat' && ext !== '.ps1' && fileExists(candidate)) {
      return { path: candidate, viaShell: false, source: 'PATH' }
    }
  }

  // 2. npm shim(.cmd)이면 옆의 네이티브 codex.exe를 직접 찾고, 없으면 셸 경유로 실행
  for (const candidate of found) {
    const ext = path.extname(candidate).toLowerCase()
    if (ext !== '.cmd' && ext !== '.bat') continue
    if (!fileExists(candidate)) continue
    const real = resolveNativeExe(candidate)
    if (real) return { path: real, viaShell: false, source: '설치 경로' }
    return { path: candidate, viaShell: true, source: '셸 경유' }
  }

  // 3. PATH에 아직 안 올라온 npm 전역 설치 위치
  for (const candidate of npmGlobalCandidates()) {
    if (!fileExists(candidate)) continue
    const ext = path.extname(candidate).toLowerCase()
    if (ext !== '.cmd' && ext !== '.bat') return { path: candidate, viaShell: false, source: '설치 경로' }
    const real = resolveNativeExe(candidate)
    if (real) return { path: real, viaShell: false, source: '설치 경로' }
    return { path: candidate, viaShell: true, source: '셸 경유' }
  }

  // 4. 마지막 수단: 아무 후보나 셸 경유로
  for (const candidate of found) {
    if (fileExists(candidate)) return { path: candidate, viaShell: true, source: '셸 경유' }
  }

  return null
}

function runCli(located, args) {
  if (located.viaShell) {
    return execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${located.path}" ${args.join(' ')}`])
  }
  return execFileAsync(located.path, args)
}

async function detect(manualPath) {
  let located
  try {
    located = await locate(manualPath)
  } catch (err) {
    return { installed: false, loggedIn: false, path: null, version: null, source: null, message: err.message }
  }
  if (!located) {
    return {
      installed: false,
      loggedIn: false,
      path: null,
      version: null,
      source: null,
      message: 'OpenAI Codex CLI를 찾을 수 없습니다.',
    }
  }

  const version = await runCli(located, ['--version'])
  if (version.error) {
    return {
      installed: false,
      loggedIn: false,
      path: located.path,
      version: null,
      source: located.source,
      message: `CLI 실행에 실패했습니다: ${version.stderr || version.error.message}`,
    }
  }

  const auth = await runCli(located, ['login', 'status'])
  const authText = `${auth.stdout || ''}\n${auth.stderr || ''}`
  const loggedIn = !auth.error && /logged\s*in/i.test(authText)
  let account = null
  const match = authText.match(/Logged in using ([^\r\n]+)/i)
  if (match) account = match[1].trim()

  return {
    installed: true,
    loggedIn,
    account,
    path: located.path,
    viaShell: located.viaShell,
    version: version.stdout.trim().split(/\r?\n/)[0] || null,
    source: located.source,
    message: loggedIn ? 'CLI 연결 준비 완료' : 'CLI는 설치되어 있지만 로그인되어 있지 않습니다.',
  }
}

function mcpArgs(mcpConfig) {
  const server = mcpConfig?.mcpServers?.[MCP_SERVER_NAME]
  const url = server?.url
  if (!url) throw new Error('MCP 서버 주소를 확인할 수 없습니다.')
  return [
    '-c', `mcp_servers.${MCP_SERVER_NAME}.url=${url}`,
    '-c', `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var=${MCP_TOKEN_ENV}`,
  ]
}

function mcpToken(mcpConfig) {
  const server = mcpConfig?.mcpServers?.[MCP_SERVER_NAME]
  return String(server?.headers?.Authorization || '').replace(/^Bearer\s+/i, '')
}

// codex는 시스템 프롬프트 플래그가 없다. 새 대화 첫 턴에만 지침을 프롬프트 앞에 붙인다.
function composePrompt(prompt, isResume, user) {
  if (isResume) return prompt
  return `${buildSystemPrompt(user)}\n\n---\n\n${prompt}`
}

// codex exec는 비대화형이라 승인 요청에 응답할 사람이 없다(approval_policy는 사실상 never로 고정).
// --approve-for-me는 승인 요청을 자동 리뷰(guardian)로 처리해 MCP 툴 호출을 막지 않는다.
// 이 옵션은 workspace-write 샌드박스를 쓰므로 -s read-only와 함께 쓸 수 없다.
const AUTO_ARGS = ['--approve-for-me']

function baseArgs(mcpConfig, model) {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    ...AUTO_ARGS,
    ...modelArgs(model),
    ...mcpArgs(mcpConfig),
  ]
}

function spawnCodex(located, args, workDir, token) {
  const spawnOptions = {
    cwd: workDir,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      NODE_OPTIONS: undefined,
      [MCP_TOKEN_ENV]: token,
    },
  }
  if (located.viaShell) {
    return spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', `"${located.path}" ${args.map(quoteForCmd).join(' ')}`],
      spawnOptions,
    )
  }
  return spawn(located.path, args, spawnOptions)
}

function send({ located, workDir, mcpConfig, prompt, sessionId, isResume, model, user, onEvent, images }) {
  const token = mcpToken(mcpConfig)
  const imageArgs = []
  for (const image of images || []) {
    if (image) imageArgs.push('-i', image)
  }
  const args = isResume
    ? ['exec', '--json', '--skip-git-repo-check', ...AUTO_ARGS, ...modelArgs(model),
       ...mcpArgs(mcpConfig), 'resume', String(sessionId), ...imageArgs, '-']
    : [...baseArgs(mcpConfig, model), ...imageArgs, '-']
  const finalPrompt = composePrompt(prompt, isResume, user)
  const translate = createTranslator()

  const child = spawnCodex(located, args, workDir, token)

  let cancelled = false
  let stdoutBuf = ''
  let stderrText = ''
  let resultSessionId = sessionId
  let finalText = ''
  let fatal = null
  let resultUsage = null

  const done = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk
      let idx
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim().replace(/^﻿/, '')
        stdoutBuf = stdoutBuf.slice(idx + 1)
        if (!line || line[0] !== '{') continue
        let evt
        try {
          evt = JSON.parse(line)
        } catch {
          continue
        }
        const parsed = translate(evt)
        if (parsed?.sessionId) resultSessionId = parsed.sessionId
        if (parsed?.finalText) finalText = parsed.finalText
        if (parsed?.fatal) fatal = parsed.fatal
        if (parsed?.usage) resultUsage = parsed.usage
        for (const out of parsed?.events ?? []) onEvent(out)
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderrText += chunk
      if (stderrText.length > 8000) stderrText = stderrText.slice(-8000)
    })

    child.on('error', (err) => {
      reject(new Error(`CLI 실행에 실패했습니다: ${err.message}`))
    })

    child.on('close', (code) => {
      if (cancelled) {
        resolve({ cancelled: true, sessionId: resultSessionId, text: finalText, usage: resultUsage })
        return
      }
      if (fatal) {
        reject(new Error(interpretFailure(code, fatal)))
        return
      }
      if (code !== 0) {
        reject(new Error(interpretFailure(code, stderrText)))
        return
      }
      resolve({ cancelled: false, sessionId: resultSessionId, text: finalText, usage: resultUsage })
    })
  })

  try {
    child.stdin.end(finalPrompt, 'utf8')
  } catch {
    // close handler
  }

  return {
    done,
    cancel: () => {
      cancelled = true
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
        } else {
          child.kill('SIGTERM')
        }
      } catch { /* ignore */ }
    },
  }
}

function promptOnce({ located, prompt, model }) {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-s', 'read-only',
    '-c', 'approval_policy=never',
    ...modelArgs(model),
    '-',
  ]
  const spawnOptions = {
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      NODE_OPTIONS: undefined,
    },
  }
  return new Promise((resolve, reject) => {
    const child = located.viaShell
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${located.path}" ${args.map(quoteForCmd).join(' ')}`], spawnOptions)
      : spawn(located.path, args, spawnOptions)
    let buf = ''
    let text = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line || line[0] !== '{') continue
        let evt
        try {
          evt = JSON.parse(line)
        } catch {
          continue
        }
        if ((evt.type === 'item.completed' || evt.type === 'item.updated')
          && (evt.item?.type === 'agent_message' || evt.item?.type === 'assistant_message')) {
          text = String(evt.item.text || '')
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code !== 0 && !text) {
        reject(new Error(interpretFailure(code, err)))
        return
      }
      resolve(text.trim())
    })
    try {
      child.stdin.end(prompt, 'utf8')
    } catch {
      // close handler
    }
  })
}

// 빈 폴더에서 돌려야 에이전트가 원본 폴더를 뒤지며 시간을 쓰지 않는다.
function emptyDir() {
  const dir = path.join(os.tmpdir(), 'egi-codex-read')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// 프로젝트 색인용. 본문·페이지 이미지는 직접 넘기고, 결과 글만 돌려받는다.
function readOnce({ located, prompt, model, effort = 'medium', images = [], timeoutMs = 10 * 60 * 1000, signal }) {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-s', 'read-only',
    '-c', 'approval_policy=never',
    '-c', `model_reasoning_effort=${effort}`,
    ...modelArgs(model),
    ...images.flatMap((image) => ['-i', image]),
    '-',
  ]
  const spawnOptions = {
    cwd: emptyDir(),
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      NODE_OPTIONS: undefined,
    },
  }
  return new Promise((resolve, reject) => {
    const child = located.viaShell
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${located.path}" ${args.map(quoteForCmd).join(' ')}`], spawnOptions)
      : spawn(located.path, args, spawnOptions)
    let buf = ''
    let text = ''
    let err = ''
    const stop = () => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
        else child.kill('SIGTERM')
      } catch { /* ignore */ }
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line || line[0] !== '{') continue
        let evt
        try {
          evt = JSON.parse(line)
        } catch {
          continue
        }
        if ((evt.type === 'item.completed' || evt.type === 'item.updated')
          && (evt.item?.type === 'agent_message' || evt.item?.type === 'assistant_message')) {
          text = String(evt.item.text || '')
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (signal?.aborted) {
        reject(new Error('멈춤'))
        return
      }
      if (timedOut && !text) {
        reject(new Error(`시간 초과 (${Math.round(timeoutMs / 60000)}분 동안 답이 없음)`))
        return
      }
      if (code !== 0 && !text) {
        reject(new Error(interpretFailure(code, err)))
        return
      }
      resolve(text.trim())
    })
    try {
      child.stdin.end(prompt, 'utf8')
    } catch {
      // close handler
    }
  })
}

// Codex 내장 image_gen으로 그림을 만든다. CLI는 결과를 $CODEX_HOME/generated_images/<thread_id>/ 에 저장한다.
function generateImage({ located, prompt, images = [], outDir, baseName, model, timeoutMs = 6 * 60 * 1000, signal }) {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-s', 'read-only',
    '-c', 'approval_policy=never',
    ...modelArgs(model),
    ...images.flatMap((image) => ['-i', image]),
    '-',
  ]
  const spawnOptions = {
    cwd: emptyDir(),
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      NODE_OPTIONS: undefined,
    },
  }
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const child = located.viaShell
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${located.path}" ${args.map(quoteForCmd).join(' ')}`], spawnOptions)
      : spawn(located.path, args, spawnOptions)
    let buf = ''
    let threadId = ''
    let text = ''
    let err = ''
    const stop = () => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
        else child.kill('SIGTERM')
      } catch { /* ignore */ }
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    signal?.addEventListener('abort', stop, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line || line[0] !== '{') continue
        let evt
        try {
          evt = JSON.parse(line)
        } catch {
          continue
        }
        if (evt.type === 'thread.started' && evt.thread_id) threadId = String(evt.thread_id)
        if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') text = String(evt.item.text || '')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (signal?.aborted) return reject(new Error('멈춤'))
      const made = threadId ? newestImage(path.join(codexHome(), 'generated_images', threadId), startedAt) : null
      if (!made) {
        if (timedOut) return reject(new Error(`이미지 생성 시간 초과 (${Math.round(timeoutMs / 60000)}분)`))
        if (code !== 0) return reject(new Error(interpretFailure(code, err)))
        return reject(new Error(`이미지를 만들지 못했습니다. ${text.trim().slice(0, 300)}`.trim()))
      }
      fs.mkdirSync(outDir, { recursive: true })
      const dest = path.join(outDir, `${baseName}${path.extname(made) || '.png'}`)
      fs.copyFileSync(made, dest)
      resolve({ path: dest, name: path.basename(dest), size: fs.statSync(dest).size })
    })
    try {
      child.stdin.end(prompt, 'utf8')
    } catch {
      // close handler
    }
  })
}

function newestImage(dir, since) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  const files = names
    .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
    .map((name) => {
      const full = path.join(dir, name)
      return { full, mtime: fs.statSync(full).mtimeMs }
    })
    .filter((item) => item.mtime >= since - 5000)
    .sort((a, b) => b.mtime - a.mtime)
  return files[0]?.full ?? null
}

function quoteForCmd(arg) {
  if (arg === '') return '""'
  if (!/[\s"&|<>^%]/.test(arg)) return arg
  return `"${String(arg).replace(/"/g, '\\"')}"`
}

function interpretFailure(code, detail) {
  const text = String(detail || '').trim()
  if (/refresh token|not logged in|sign ?in again|unauthorized|401/i.test(text)) {
    return 'CLI 인증이 만료되었습니다. 터미널에서 codex login 을 다시 진행해주세요.'
  }
  if (/usage limit|rate limit|quota|too many requests|insufficient_quota/i.test(text)) {
    return 'CLI 사용 한도에 도달했습니다. 잠시 후 다시 시도해주세요.'
  }
  // 매번 찍히는 skills 설치 경고는 실제 원인이 아니다.
  const tail = text.split(/\r?\n/)
    .filter((line) => line.trim() && !/codex_skills_extension|system skills/i.test(line))
    .slice(-3)
    .join(' ')
  return tail ? `CLI가 오류로 종료했습니다 (코드 ${code}): ${tail}` : `CLI가 오류로 종료했습니다 (코드 ${code}).`
}

function toolLabel(rawName) {
  return sharedToolLabel(rawName, MCP_SERVER_NAME)
}

function previewOf(item) {
  const err = item?.error
  if (err) {
    const text = typeof err === 'string' ? err : (err.message ?? safeJson(err))
    return String(text).slice(0, 300)
  }
  const result = item?.result
  if (result == null) return ''
  if (typeof result === 'string') return result.slice(0, 300)
  // MCP 툴 결과: { content: [{ type:'text', text }], structured_content }
  if (Array.isArray(result.content)) {
    const text = result.content.map((c) => c?.text ?? '').join('').trim()
    if (text) return text.slice(0, 300)
  }
  return safeJson(result).slice(0, 300)
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

// codex exec --json 이벤트(JSONL) → 렌더러 공통 이벤트로 변환한다.
function createTranslator() {
  const seenTools = new Set()
  const seenMessages = new Set()
  const texts = []

  return function translate(evt) {
    const events = []

    if (evt.type === 'thread.started') {
      return {
        events: [{ type: 'session', sessionId: evt.thread_id, mcpConnected: true, mcpStatus: 'connected', model: null }],
        sessionId: evt.thread_id,
      }
    }

    if (evt.type === 'item.started' || evt.type === 'item.updated' || evt.type === 'item.completed') {
      const item = evt.item || {}
      if (item.type === 'mcp_tool_call' || item.type === 'tool_call') {
        const id = item.id || `${item.server || ''}:${item.tool || item.name || ''}`
        if (!seenTools.has(id)) {
          seenTools.add(id)
          const { short, label } = toolLabel(item.tool || item.name)
          events.push({ type: 'tool-start', id, tool: short, label })
        }
        if (evt.type === 'item.completed') {
          const isError = item.status === 'failed' || item.status === 'error' || Boolean(item.error)
          const preview = previewOf(item)
          events.push({
            type: 'tool-end',
            id,
            isError,
            warn: !isError && /"표시"\s*:\s*"주의"/.test(preview),
            preview,
          })
        }
      } else if ((item.type === 'agent_message' || item.type === 'assistant_message') && evt.type === 'item.completed') {
        // 같은 메시지가 agent_message/assistant_message로 두 번 오거나
        // 같은 id가 다시 완료되면 본문이 두 번 붙는다.
        const text = String(item.text || '').trim()
        const key = item.id ? `id:${item.id}` : `text:${text}`
        if (text && !seenMessages.has(key) && !texts.includes(text)) {
          seenMessages.add(key)
          texts.push(text)
          events.push({ type: 'text', text })
        }
      }
      return { events, finalText: texts.join('\n\n') }
    }

    if (evt.type === 'turn.completed') {
      const finalText = texts.join('\n\n')
      const usage = normalizeUsage(evt.usage)
      events.push({ type: 'turn-end', isError: false, text: finalText, costUsd: null, durationMs: null, usage })
      return { events, finalText, usage }
    }

    if (evt.type === 'turn.failed') {
      return { events, fatal: evt.error?.message || '요청이 실패했습니다.' }
    }

    if (evt.type === 'error') {
      return { events, fatal: evt.message || evt.error?.message || '요청이 실패했습니다.' }
    }

    return { events }
  }
}

function normalizeUsage(u) {
  const usage = u || {}
  return {
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cachedInputTokens: usage.cached_input_tokens || 0,
    costUsd: null,
  }
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

function listRollouts(dir) {
  const out = []
  let stack = [dir]
  let steps = 0
  while (stack.length && steps < 20000) {
    steps += 1
    const cur = stack.pop()
    let stat
    try {
      stat = fs.statSync(cur)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      try {
        stack = stack.concat(fs.readdirSync(cur).map((c) => path.join(cur, c)))
      } catch {
        // ignore
      }
    } else if (cur.endsWith('.jsonl')) {
      out.push({ path: cur, mtime: stat.mtimeMs })
    }
  }
  return out
}

function findRateLimits(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null
  if (obj.rate_limits && typeof obj.rate_limits === 'object') return obj.rate_limits
  for (const key of Object.keys(obj)) {
    const found = findRateLimits(obj[key], depth + 1)
    if (found) return found
  }
  return null
}

function latestRateLimitsInFile(file) {
  let lines
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  } catch {
    return null
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line || !line.includes('rate_limits')) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const rl = findRateLimits(obj)
    if (rl) return rl
  }
  return null
}

function mapWindow(w) {
  if (!w || typeof w !== 'object') return null
  return {
    usedPercent: Number.isFinite(w.used_percent) ? w.used_percent : null,
    windowMinutes: Number.isFinite(w.window_minutes) ? w.window_minutes : null,
    resetsAt: Number.isFinite(w.resets_at) ? w.resets_at * 1000 : null,
  }
}

// codex 세션 rollout 파일에 기록된 최신 요금제 한도(rate_limits)를 읽는다.
// primary = 5시간 창, secondary = 주간 창. 없으면 null.
function planUsage() {
  try {
    const dir = path.join(codexHome(), 'sessions')
    const files = listRollouts(dir).sort((a, b) => b.mtime - a.mtime).slice(0, 12)
    for (const f of files) {
      const rl = latestRateLimitsInFile(f.path)
      if (!rl) continue
      const primary = mapWindow(rl.primary)
      const secondary = mapWindow(rl.secondary)
      if (!primary && !secondary) continue
      return { primary, secondary }
    }
  } catch {
    // ignore
  }
  return null
}

// detect 결과에서 계정 라벨을 뽑는다.
function accountLabel(detected) {
  return detected?.account || (detected?.loggedIn ? 'ChatGPT' : null)
}

module.exports = {
  id: 'codex',
  label: 'OpenAI Codex',
  installHint: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
  loginHint: '로그인 창에서 ChatGPT 계정으로 로그인하세요.',
  installSteps: [
    {
      label: 'Codex 공식 설치 스크립트',
      kind: 'powershell',
      requires: 'PowerShell',
      // chatgpt.com이 가끔 500을 주므로 같은 스크립트가 올라가는 GitHub 릴리즈로 한 번 더 받는다.
      script: "$env:CODEX_NON_INTERACTIVE='1'; try { $s = irm https://chatgpt.com/codex/install.ps1 } catch { $s = irm https://github.com/openai/codex/releases/latest/download/install.ps1 }; iex $s",
    },
    { label: 'npm 전역 설치', kind: 'npm', requires: 'npm', pkg: '@openai/codex' },
  ],
  loginCommand: { args: ['login'] },
  models: MODELS,
  defaultModel: DEFAULT_MODEL,
  resolveModel,
  detect,
  listModels,
  send,
  promptOnce,
  readOnce,
  generateImage,
  planUsage,
  accountLabel,
  newSessionId: () => randomUUID(),
}
