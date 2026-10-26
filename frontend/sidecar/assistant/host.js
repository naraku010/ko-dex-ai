// 렌더러 ↔ CLI 어댑터 ↔ 인프로세스 MCP 서버를 잇는다.

const fs = require('fs')
const os = require('os')
const path = require('path')
const mcpServer = require('../mcp/server')
const mcpUi = require('../mcp/ui')
const channels = require('../channels')
const { listAdapters, getAdapter, DEFAULT_ADAPTER_ID } = require('./adapters')
const { isCurrentModel } = require('./modelHints')
const { setChannelLabels } = require('./toolLabels')
const setup = require('./setup')
const attachments = require('./attachments')
const pdfPage = require('./pdfPage')
const pdfText = require('./pdfText')
const { stamp } = require('./stamp')
const projects = require('./projects')
const projectSync = require('./projectSync')
const config = require('../config')
const { randomUUID } = require('crypto')
const auth = require('../auth')
const usage = require('./usage')
const apiKeys = require('./apiKeys')

let emitFn = null
let activeTurn = null
let sessionId = null
let sessionStarted = false
let sessionOwnerId = null
let cachedDetect = null
let currentProjectId = null
const detectCache = new Map()
const modelsCache = new Map()
const MODELS_TTL_MS = 10 * 60 * 1000

function rememberDetect(adapterId, result) {
  const value = { ...result, adapterId }
  detectCache.set(adapterId, value)
  cachedDetect = value
  return value
}

function setEmitter(fn) {
  emitFn = typeof fn === 'function' ? fn : null
}

function broadcast(payload) {
  if (!emitFn) return
  try {
    emitFn(payload)
  } catch {
    // ignore
  }
}

function currentAdapter(adapterId) {
  return getAdapter(adapterId || config.read().adapterId || DEFAULT_ADAPTER_ID)
}

function currentModel(adapter, cfg) {
  const raw = adapter.resolveModel ? adapter.resolveModel(cfg.model) : cfg.model
  if (raw && (isCurrentModel(raw) || adapter.kind === 'api')) return raw
  return adapter.defaultModel || raw
}

function explainNotReady(adapter, detected) {
  if (adapter.kind === 'api') {
    if (detected?.loggedIn) return null
    return detected?.message || `${adapter.label} 키를 설정에서 입력해주세요.`
  }
  if (!detected?.installed) {
    return `${adapter.label} CLI를 찾을 수 없습니다. 설정에서 연결을 다시 진행해주세요.`
  }
  if (!detected?.loggedIn) {
    return `${adapter.label} CLI에 로그인되어 있지 않습니다. ${adapter.loginHint}`
  }
  return null
}

function knownModel(adapter, model) {
  const listed = modelsCache.get(adapter.id)?.models || adapter.models || []
  return listed.some((item) => item.id === model)
}

function resetSession() {
  sessionId = null
  sessionStarted = false
  sessionOwnerId = null
}

function loggedInUser() {
  return auth.getUser()
}

// 툴 진행 표시에 쓸 한글 라벨을 활성 채널 manifest에서 가져온다.
function applyChannelLabels() {
  try {
    setChannelLabels(channels.store.getActive()?.tools)
  } catch {
    setChannelLabels([])
  }
}

function listChannels() {
  return channels.list()
}

function previewChannel(payload = {}) {
  return channels.preview(payload)
}

async function addChannel(payload = {}) {
  const result = await channels.add(payload)
  applyChannelLabels()
  return { ...result, ...channels.list() }
}

function removeChannel(payload = {}) {
  if (activeTurn) throw new Error('응답 중에는 채널을 지울 수 없습니다. 먼저 중단해주세요.')
  const wasActive = channels.store.activeId() === String(payload.channelId || '')
  const result = channels.remove(payload)
  if (wasActive) {
    resetSession()
    applyChannelLabels()
  }
  return { ...result, ...channels.list() }
}

// 채널을 바꾸면 툴과 시스템 프롬프트가 달라지므로 CLI 세션을 새로 시작한다.
function setChannel(payload = {}) {
  if (activeTurn) throw new Error('응답 중에는 채널을 바꿀 수 없습니다. 먼저 중단해주세요.')
  const channel = channels.setActive(payload)
  resetSession()
  applyChannelLabels()
  return { channel, ...channels.list() }
}

async function refreshChannel(payload = {}) {
  const result = await channels.refresh(payload)
  applyChannelLabels()
  return { ...result, ...channels.list() }
}

async function setChannelCredentials(payload = {}) {
  const result = await channels.setCredentials(payload)
  return { ...result, ...channels.list() }
}

function listChannelFiles(payload = {}) {
  return channels.listFiles(payload)
}

function uploadChannelFile(payload = {}) {
  return channels.uploadFile(payload)
}

function deleteChannelFile(payload = {}) {
  return channels.deleteFile(payload)
}

function openChannelFile(payload = {}) {
  return channels.openFile(payload)
}

async function detect({ adapterId, manualPath } = {}) {
  const cfg = config.read()
  const adapter = currentAdapter(adapterId)
  const pathToUse = manualPath !== undefined ? manualPath : cfg.manualPath

  const result = await adapter.detect(pathToUse || undefined)
  rememberDetect(adapter.id, result)

  return {
    ...result,
    adapterId: adapter.id,
    adapterLabel: adapter.label,
    installHint: adapter.installHint,
    loginHint: adapter.loginHint,
  }
}

// CLI를 앱에서 직접 설치한다. 진행 로그는 setup-log 이벤트로 흘려보낸다.
async function installCli({ adapterId } = {}) {
  const adapter = currentAdapter(adapterId)
  if (adapter.kind === 'api') throw new Error(`${adapter.label}는 설치가 필요 없습니다. API 키를 입력해주세요.`)
  const log = (text) => broadcast({ type: 'setup-log', text })

  log(`${adapter.label} 설치를 시작합니다.`)
  const { via } = await setup.install(adapter, log)

  const detected = await detect({ adapterId: adapter.id, manualPath: null })
  log(detected.installed
    ? `설치 확인 — ${detected.version ?? adapter.label}`
    : '설치는 끝났지만 실행 파일을 찾지 못했습니다. 경로를 직접 지정해주세요.')

  return { ...detected, installedVia: via }
}

// 로그인 콘솔 창을 띄운다. 실제 완료 여부는 렌더러가 detect로 다시 확인한다.
async function loginCli({ adapterId } = {}) {
  const adapter = currentAdapter(adapterId)
  if (adapter.kind === 'api') throw new Error(`${adapter.label}는 로그인 창이 없습니다. API 키를 입력해주세요.`)
  const detected = await detect({ adapterId: adapter.id })
  if (!detected.installed) {
    throw new Error(`${adapter.label} CLI가 설치되어 있지 않습니다. 먼저 설치해주세요.`)
  }

  setup.cleanupLoginScripts()
  setup.openLogin(adapter, { path: detected.path, viaShell: Boolean(detected.viaShell) })
  return { started: true, adapterId: adapter.id }
}

function saveApiKey({ adapterId, apiKey } = {}) {
  const adapter = currentAdapter(adapterId)
  if (adapter.kind !== 'api') throw new Error('이 연결은 API 키를 쓰지 않습니다.')
  const saved = apiKeys.save(adapter.id, apiKey)
  detectCache.delete(adapter.id)
  modelsCache.delete(adapter.id)
  if (!saved.hasApiKey && config.read().adapterId === adapter.id) {
    config.write({ connected: false })
    resetSession()
  }
  return saved
}

async function connect({ adapterId, manualPath, apiKey } = {}) {
  const adapter = currentAdapter(adapterId)
  if (adapter.kind === 'api') {
    if (typeof apiKey === 'string' && apiKey.trim()) {
      apiKeys.save(adapter.id, apiKey)
      detectCache.delete(adapter.id)
      modelsCache.delete(adapter.id)
    }
    const detected = await detect({ adapterId: adapter.id })
    const reason = explainNotReady(adapter, detected)
    if (reason) {
      config.write({ adapterId: adapter.id, connected: false })
      throw new Error(reason)
    }
    await mcpServer.start()
    const cfg = config.read()
    let model = cfg.modelsByAdapter?.[adapter.id] || adapter.defaultModel || null
    try {
      const models = await modelsFor(adapter, null)
      if (models.length && !models.some((item) => item.id === model)) model = models[0].id
    } catch {
      // 목록을 못 가져와도 기본 모델로 연결한다.
    }
    const modelsByAdapter = { ...(cfg.modelsByAdapter || {}), [adapter.id]: model }
    config.write({
      adapterId: adapter.id,
      connected: true,
      model,
      modelsByAdapter,
    })
    resetSession()
    return { ...detected, connected: true, mcpRunning: mcpServer.isRunning() }
  }

  const detected = await detect({ adapterId: adapter.id, manualPath })

  if (!detected.installed) {
    config.write({ adapterId: adapter.id, connected: false })
    throw new Error(`${adapter.label} CLI를 찾을 수 없습니다. 설치 후 다시 시도하거나 실행 파일 경로를 직접 지정해주세요.`)
  }
  if (!detected.loggedIn) {
    config.write({ adapterId: adapter.id, manualPath: manualPath ?? null, connected: false })
    throw new Error(`${adapter.label} CLI에 로그인되어 있지 않습니다. ${adapter.loginHint}`)
  }

  await mcpServer.start()
  config.write({
    adapterId: adapter.id,
    manualPath: manualPath ?? config.read().manualPath ?? null,
    connected: true,
  })
  resetSession()

  return { ...detected, connected: true, mcpRunning: mcpServer.isRunning() }
}

function setModel(model) {
  if (activeTurn) throw new Error('응답 중에는 모델을 바꿀 수 없습니다. 먼저 중단해주세요.')
  const cfg = config.read()
  const adapter = currentAdapter(cfg.adapterId)
  const resolved = adapter.resolveModel ? adapter.resolveModel(model) : model
  const allowed = adapter.kind === 'api' && knownModel(adapter, resolved)
  if (!resolved || (!isCurrentModel(resolved) && !allowed)) throw new Error('구형 모델은 사용할 수 없습니다. 최신 모델을 선택해주세요.')
  const modelsByAdapter = { ...(cfg.modelsByAdapter || {}), [adapter.id]: resolved }
  config.write({ model: resolved, modelsByAdapter })
  return { model: resolved }
}

async function modelsFor(adapter, located) {
  const hit = modelsCache.get(adapter.id)
  if (hit && Date.now() - hit.at < MODELS_TTL_MS) return hit.models
  let models = []
  try {
    if (adapter.listModels && (located?.path || adapter.kind === 'api')) {
      models = await adapter.listModels(located)
    }
  } catch (err) {
    process.stderr.write(`[models] ${adapter.id} 목록 실패: ${err?.message || err}\n`)
  }
  if (!Array.isArray(models) || models.length === 0) models = adapter.models ?? []
  modelsCache.set(adapter.id, { at: Date.now(), models })
  return models
}

async function snapshotAdapters() {
  const infos = listAdapters()
  return Promise.all(infos.map(async (info) => {
    const adapter = getAdapter(info.id)
    let detected = detectCache.get(info.id)
    if (!detected) {
      try {
        detected = await detect({ adapterId: info.id })
      } catch {
        detected = { installed: false, loggedIn: false, path: null }
      }
    }
    const located = detected?.path ? { path: detected.path, viaShell: Boolean(detected.viaShell) } : null
    const models = located || adapter.kind === 'api'
      ? await modelsFor(adapter, located)
      : (info.models ?? [])
    return {
      ...info,
      installed: Boolean(detected?.installed),
      loggedIn: Boolean(detected?.loggedIn),
      ready: adapter.kind === 'api' ? Boolean(detected?.loggedIn) : Boolean(detected?.installed && detected?.loggedIn),
      hasApiKey: Boolean(apiKeys.get(info.id)),
      keyHint: apiKeys.hint(info.id),
      models,
    }
  }))
}

async function setAdapter({ adapterId } = {}) {
  if (activeTurn) throw new Error('응답 중에는 CLI를 바꿀 수 없습니다. 먼저 중단해주세요.')
  const adapter = currentAdapter(adapterId)
  const detected = await detect({ adapterId: adapter.id })
  const reason = explainNotReady(adapter, detected)
  if (reason) {
    throw new Error(adapter.kind === 'api'
      ? reason
      : `${adapter.label} CLI가 준비되지 않았습니다. 설정에서 설치와 로그인을 먼저 해주세요.`)
  }
  await mcpServer.start()
  const cfg = config.read()
  const saved = cfg.modelsByAdapter?.[adapter.id]
  config.write({
    adapterId: adapter.id,
    connected: true,
    model: saved || adapter.defaultModel || null,
  })
  resetSession()
  return status()
}

async function status() {
  const cfg = config.read()
  const adapter = currentAdapter(cfg.adapterId)
  const user = loggedInUser()
  const adapters = await snapshotAdapters()
  const current = adapters.find((a) => a.id === adapter.id) ?? adapters[0]
  return {
    adapterId: adapter.id,
    adapterLabel: adapter.label,
    installHint: adapter.installHint,
    loginHint: adapter.loginHint,
    models: current?.models ?? [],
    model: currentModel(adapter, cfg),
    manualPath: cfg.manualPath,
    connected: Boolean(cfg.connected),
    mcpRunning: mcpServer.isRunning(),
    busy: Boolean(activeTurn),
    hasSession: sessionStarted,
    sessionId,
    lastDetect: cachedDetect,
    loggedInUser: Boolean(user?.user_id),
    adapters,
    channelId: channels.store.activeId(),
    channels: channels.store.publicList(),
    imageGen: { connected: Boolean(adapters.find((a) => a.id === IMAGE_ADAPTER_ID)?.ready) },
  }
}

function newSession() {
  if (activeTurn) throw new Error('진행 중인 대화가 있습니다. 먼저 중단해주세요.')
  resetSession()
  return { ok: true }
}

function setSession({ sessionId: nextId } = {}) {
  if (activeTurn) throw new Error('진행 중인 대화가 있습니다. 먼저 중단해주세요.')
  const user = loggedInUser()
  const trimmed = nextId ? String(nextId) : ''
  if (trimmed) {
    sessionId = trimmed
    sessionStarted = true
    sessionOwnerId = user?.user_id ?? null
  } else {
    resetSession()
  }
  return { sessionId, hasSession: sessionStarted }
}

function cancel() {
  if (!activeTurn) return { ok: false, reason: 'idle' }
  activeTurn.cancel()
  return { ok: true }
}

// 이미지는 Codex 내장 image_gen으로 만든다. Claude는 그림을 읽기만 하고 만들지 못한다.
const IMAGE_ADAPTER_ID = 'codex'
const DRAWING_PROMPT = [
  '$imagegen',
  'Use case: sketch-to-render',
  'Input images: Image 1 is an engineering drawing used as the reference.',
  'Primary request: a photorealistic 3D product render of the equipment or part shown in the drawing.',
  'Constraints: keep the shape, proportions, nozzles and supports as drawn; three-quarter isometric view; plain light studio background; soft even light; keep the top-left and bottom-left corners empty for a logo and a label.',
  'Avoid: dimension lines, title block, annotations, any text.',
  'Generate exactly one image and do not edit any files.',
].join('\n')

async function readyImageGen() {
  let detected = detectCache.get(IMAGE_ADAPTER_ID)
  if (!detected?.installed || !detected?.loggedIn) {
    try {
      const own = config.read().adapterId === IMAGE_ADAPTER_ID
      detected = await detect({ adapterId: IMAGE_ADAPTER_ID, manualPath: own ? undefined : null })
    } catch {
      detected = null
    }
  }
  if (!detected?.installed || !detected?.loggedIn || !detected?.path) return null
  return detected
}

// 사용자가 고른 쪽(없으면 1쪽)을 PNG로 뜬 뒤 Codex로 동시에 만든다.
async function renderDrawingPages(ready, drawing, dir) {
  const isPdf = drawing.path.toLowerCase().endsWith('.pdf')
  if (!isPdf && !attachments.isImage(drawing.path)) {
    return [{ page: 1, tag: '', error: '도면 이미지는 PDF나 이미지 파일로만 만들 수 있습니다.' }]
  }
  if (!isPdf) return Promise.all([renderOne(ready, { page: 1, tag: drawing.tag || '', imagePath: drawing.path }, dir)])
  const pages = drawing.pages.length ? drawing.pages : [1]
  const labels = new Map()
  try {
    for (const item of (await pdfText.drawingPages(drawing.path)).items) labels.set(item.page, item.tag)
  } catch {
    // 글자 층이 없는 PDF도 쪽 번호만으로 만든다.
  }
  const targets = []
  for (const page of pages) {
    const target = { page, tag: drawing.tag || labels.get(page) || '', imagePath: path.join(dir, `page-${page}.png`) }
    try {
      await pdfPage.rasterize(drawing.path, target.imagePath, page)
      target.pagePath = target.imagePath
    } catch (err) {
      target.error = err instanceof Error ? err.message : String(err)
    }
    targets.push(target)
  }
  return Promise.all(targets.map((target) => (target.error ? target : renderOne(ready, target, dir))))
}

async function renderOne(ready, target, dir) {
  const toolId = `img-${randomUUID()}`
  const label = target.tag ? `도면 이미지 생성 · ${target.tag}` : `도면 이미지 생성 · ${target.page}쪽`
  broadcast({ type: 'tool-start', id: toolId, tool: 'image_gen', label })
  try {
    const render = await getAdapter(IMAGE_ADAPTER_ID).generateImage({
      located: { path: ready.path, viaShell: Boolean(ready.viaShell) },
      prompt: DRAWING_PROMPT,
      images: [target.imagePath],
      outDir: dir,
      baseName: safeFileName(target.tag || `page-${target.page}`),
    })
    await stamp(render.path, { tag: target.tag, logo: channels.store.activeId() === 'woosung' })
    render.size = fs.statSync(render.path).size
    broadcast({ type: 'tool-end', id: toolId, isError: false })
    broadcast({ type: 'file', id: randomUUID(), name: render.name, path: render.path, size: render.size })
    return { ...target, path: render.path }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    broadcast({ type: 'tool-end', id: toolId, isError: true, preview: error })
    return { ...target, error }
  }
}

function safeFileName(name) {
  return `render-${String(name).replace(/[<>:"/\\|?*\s]+/g, '_')}`
}

function parseDrawingChoice(raw, candidates) {
  const match = String(raw || '').match(/\{[\s\S]*\}/)
  if (!match) return null
  let json
  try {
    json = JSON.parse(match[0])
  } catch {
    return null
  }
  const rel = String(json.rel || json.file || '')
  const hit = candidates.find((item) => item.rel === rel) || (candidates.length === 1 ? candidates[0] : null)
  if (!hit || hit.kind === 'doc') return null
  const page = Number(json.page)
  if (hit.kind === 'image') return { rel: hit.rel, page: 1 }
  if (!Number.isInteger(page) || page < 1) return null
  return { rel: hit.rel, page }
}

// 태그로 프로젝트 파일을 찾고, AI에게 그 파일을 다시 보게 한 뒤 고른 쪽으로 3D 이미지를 만든다.
// 파일은 PDF가 아닐 수 있다. 그림 파일이면 그 파일을 그대로 쓴다.
async function renderIndexedDrawing({ tag, file, page } = {}) {
  const wanted = String(tag || '').trim()
  if (!wanted) throw new Error('어떤 도면인지 태그(모델)를 알려주세요.')
  if (!currentProjectId) throw new Error('도면은 프로젝트 안에서 찾습니다. 프로젝트를 연 뒤 다시 요청해 주세요.')
  const project = projects.readProject(currentProjectId)
  const scans = new Map()
  const scan = async (rel) => {
    if (!scans.has(rel)) {
      let items = []
      try {
        items = (await pdfText.drawingPages(path.resolve(project.folder, rel))).items
      } catch {
        // 글자층이 없으면 AI 판단에 맡긴다.
      }
      scans.set(rel, items)
    }
    return scans.get(rel)
  }
  // 글자층에서 그 태그 하나만 적힌 도면 쪽. 태그가 여러 개 나열된 목록·표 쪽은 뺀다.
  const exactPage = async (rel) => (await scan(rel)).find((item) => !item.list && item.tag === wanted)?.page ?? null
  let choice = null
  if (file) {
    const rel = String(file).replace(/\//g, path.sep)
    const ext = path.extname(rel).toLowerCase()
    const image = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)
    const exact = ext === '.pdf' ? await exactPage(rel) : null
    choice = { rel, page: image ? 1 : exact || Number(page) || 1 }
  } else {
    const candidates = await projects.filesForTag(currentProjectId, wanted)
    const drawable = candidates.filter((item) => item.kind === 'pdf' || item.kind === 'image')
    if (!drawable.length) {
      throw new Error(`'${wanted}'가 들어 있는 도면 파일(PDF나 이미지)을 프로젝트에서 찾지 못했습니다.`)
    }
    for (const item of drawable) {
      if (item.kind !== 'pdf') continue
      const exact = await exactPage(item.rel)
      if (exact) {
        choice = { rel: item.rel, page: exact }
        break
      }
    }
    for (const item of drawable) {
      if (item.kind !== 'pdf') continue
      const lists = new Set((await scan(item.rel)).filter((entry) => entry.list).map((entry) => entry.page))
      const kept = item.pages.filter((part) => !lists.has(part.page))
      if (kept.length) item.pages = kept
    }
    if (choice) {
      process.stderr.write(`[drawing3d] ${wanted} → ${choice.rel} ${choice.page}쪽 (글자층)\n`)
    } else if (drawable.length === 1 && drawable[0].kind === 'image') {
      choice = { rel: drawable[0].rel, page: 1 }
    } else if (drawable.length === 1 && drawable[0].pages.length === 1) {
      choice = { rel: drawable[0].rel, page: drawable[0].pages[0].page }
    } else {
      const user = loggedInUser()
      const reader = await projectReader(currentProjectId, user.user_id, { tier: 'light' })
      const lines = drawable.map((item) => {
        if (item.kind === 'image') return `- ${item.rel} (이미지 파일, page는 1)`
        const pages = item.pages.map((part) => `  ${part.page}쪽: ${part.excerpt}`).join('\n')
        return `- ${item.rel} (PDF)\n${pages || '  (쪽에서 태그를 특정하지 못함)'}`
      })
      const prompt = [
        `태그 ${wanted}의 3D 이미지를 만들 도면 파일과 쪽을 고르세요.`,
        '파일은 PDF가 아닐 수 있습니다. 이미지 파일이면 page는 1입니다.',
        '태그가 표로만 나열된 목록 쪽보다, 그 태그 장비의 도면으로 보이는 쪽을 고르세요.',
        '읽을 수 있으면 아래 파일을 직접 다시 읽고 판단하세요.',
        'JSON만 출력하세요. {"rel":"프로젝트 안 상대경로","page":숫자}',
        '',
        ...lines,
      ].join('\n')
      const controller = new AbortController()
      const raw = await reader(prompt, controller.signal, true, [], { shell: false })
      choice = parseDrawingChoice(raw, drawable)
      if (!choice) throw new Error(`'${wanted}' 도면을 다시 읽었지만 3D로 만들 쪽을 정하지 못했습니다.`)
    }
  }
  const full = path.resolve(project.folder, choice.rel)
  const folder = path.resolve(project.folder)
  if (!full.toLowerCase().startsWith(folder.toLowerCase()) || !fs.existsSync(full)) {
    throw new Error('고른 도면 파일이 프로젝트 안에 없습니다.')
  }
  const ready = await readyImageGen()
  if (!ready) throw new Error('도면 이미지는 OpenAI Codex로 만듭니다. 설정 > CLI에서 Codex를 설치하고 ChatGPT 계정으로 로그인한 뒤 다시 요청해 주세요.')
  const dir = path.join(config.workDir(), 'inbox', randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  const made = await renderDrawingPages(ready, { path: full, pages: [choice.page], tag: wanted }, dir)
  const render = made[0]
  if (!render || render.error) {
    throw new Error(`${choice.rel} ${choice.page}쪽으로 만들지 못했습니다. ${render?.error || ''}`.trim())
  }
  return { tag: wanted, page: choice.page, file: choice.rel, image: render.path }
}

async function drawingPages({ name, bytesBase64 } = {}) {
  const raw = String(bytesBase64 || '').replace(/\s/g, '')
  if (!raw) throw new Error('도면 파일이 비어 있습니다.')
  if (!String(name || '').toLowerCase().endsWith('.pdf')) return { pages: 1, items: [] }
  const temp = path.join(os.tmpdir(), `kodex-drawing-${randomUUID()}.pdf`)
  fs.writeFileSync(temp, Buffer.from(raw, 'base64'))
  try {
    return { ...(await pdfText.drawingPages(temp)), max: attachments.MAX_RENDERS }
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

async function prepareTurnFiles(workDir, items) {
  const { dir, files } = attachments.save(workDir, items)
  if (!files.length) return { note: '', images: [], saved: [] }
  let renders = []
  const drawing = files.find((file) => file.drawing)
  if (drawing && dir) {
    const ready = await readyImageGen()
    if (ready) renders = await renderDrawingPages(ready, drawing, dir)
  }
  const images = []
  for (const file of files) {
    if (attachments.isImage(file.path)) images.push(file.path)
  }
  for (const item of renders) {
    if (item.pagePath && item.pagePath !== drawing?.path) images.push(item.pagePath)
    if (item.path) images.push(item.path)
  }
  return {
    note: attachments.describe(files, renders),
    images,
    saved: files.map((file) => ({ name: file.name, path: file.path, size: file.size })),
  }
}

const PREVIEW_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

function requireUser() {
  const user = loggedInUser()
  if (!user?.user_id) throw new Error('로그인 정보가 없습니다. 다시 로그인해주세요.')
  return user
}

function activeChannelId(channelId) {
  const id = channelId || channels.store.activeId()
  if (!id) throw new Error('연결된 채널이 없습니다.')
  return id
}

function pickFolder() {
  return projects.pickFolder()
}

// 대화 속 표를 엑셀로 저장한다. 저장 위치는 사용자가 고른다.
async function exportTable({ title, headers, rows } = {}) {
  const head = (Array.isArray(headers) ? headers : []).slice(0, 64).map((cell) => String(cell ?? '').slice(0, 200))
  const body = (Array.isArray(rows) ? rows : [])
    .slice(0, 5000)
    .map((row) => (Array.isArray(row) ? row : []).slice(0, head.length || 64).map((cell) => String(cell ?? '').slice(0, 2000)))
  if (head.length === 0 && body.length === 0) throw new Error('보낼 표가 없습니다.')
  const picked = await projects.pickSaveFile(String(title || '표').slice(0, 60))
  if (!picked) return { saved: false }
  const { writeXlsx } = require('./xlsxWrite')
  writeXlsx(picked, [{ name: '표', rows: [head, ...body] }])
  return { saved: true, path: picked }
}

// ---------- 공유 프로젝트 (채널 서버가 원본) ----------

function projectChannel(channelId) {
  const channel = channels.store.get(channelId)
  if (!channel) throw new Error('이 프로젝트의 채널을 찾을 수 없습니다.')
  return channel
}

// 공유 프로젝트면 { channel, user }를 준다. 이 PC 전용이면 null.
function sharedContext(id) {
  const user = requireUser()
  const project = projects.readProject(id)
  if (!project.shared) return null
  return { channel: projectChannel(project.channelId), user, project }
}

// 색인 결과를 쓰는 즉시 서버에 올린다. 실패하면 색인 로그에 남기고 다음 색인 때 다시 올린다.
projects.setHooks({
  onEntry: (project, key, entry) => {
    const ctx = sharedContext(project.id)
    if (!ctx) return
    projectSync.putEntry(ctx.channel, ctx.user, project.id, key, entry).catch((err) => {
      broadcast({ type: 'project-index', ...projects.jobStatus(), log: `  서버에 색인 올리기 실패 (${entry.rel}): ${err.message}` })
    })
  },
  onEntryRemoved: (project, key) => {
    const ctx = sharedContext(project.id)
    if (ctx) projectSync.deleteEntry(ctx.channel, ctx.user, project.id, key).catch(() => {})
  },
  onScope: (project, scope) => {
    const ctx = sharedContext(project.id)
    if (ctx) projectSync.putScope(ctx.channel, ctx.user, project.id, scope).catch(() => {})
  },
})

function syncProgress(id, phase) {
  return (status) => broadcast({ type: 'project-sync', projectId: id, phase, ...status })
}

async function listProjects({ channelId } = {}) {
  const user = requireUser()
  const id = activeChannelId(channelId)
  let shared = false
  let syncError = ''
  const channel = channels.store.get(id)
  if (channel) {
    try {
      shared = await projectSync.supports(channel, user)
      if (shared) await projectSync.listShared(channel, user)
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err)
    }
  }
  return { projects: projects.list({ userId: user.user_id, channelId: id }), job: projects.jobStatus(), shared, syncError }
}

// 공유를 지원하는 채널이면 서버에 만들고 고른 폴더의 파일을 올린다. 아니면 예전처럼 이 PC에만 만든다.
async function createProject({ channelId, folder, name } = {}) {
  const user = requireUser()
  const id = activeChannelId(channelId)
  const channel = channels.store.get(id)
  if (channel && (await projectSync.supports(channel, user).catch(() => false))) {
    const resolved = path.resolve(String(folder || ''))
    if (!folder || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('폴더를 찾을 수 없습니다.')
    const projectName = String(name || '').trim().slice(0, 60) || path.basename(resolved) || '새 프로젝트'
    const created = await projectSync.create(channel, user, { name: projectName, folder: resolved }, { onProgress: syncProgress(null, 'upload') })
    const detail = projects.detail({ id: created.id, userId: user.user_id })
    return { ...detail, upload: created }
  }
  return projects.create({ userId: user.user_id, channelId: id, folder, name })
}

// 프로젝트를 열 때 부른다. 서버에서 바뀐 파일·색인만 받는다. 이 PC 전용 프로젝트는 아무것도 안 한다.
async function syncProject({ id } = {}) {
  const ctx = sharedContext(id)
  if (!ctx) return { shared: false }
  const job = projects.jobStatus()
  const indexing = Boolean(job?.running && job.projectId === id)
  const result = await projectSync.pull(ctx.channel, ctx.user, id, { onProgress: syncProgress(id, 'download'), keepIndex: indexing })
  return { shared: true, ...result }
}

async function uploadProjectFolder({ id } = {}) {
  const ctx = sharedContext(id)
  if (!ctx) throw new Error('공유 프로젝트만 파일을 올릴 수 있습니다.')
  const picked = await projects.pickFolder()
  if (!picked?.folder) return { cancelled: true }
  return projectSync.uploadFolder(ctx.channel, ctx.user, id, picked.folder, { onProgress: syncProgress(id, 'upload') })
}

function assertIdle(id) {
  const job = projects.jobStatus()
  if (job?.running && job.projectId === id) throw new Error('색인·엑셀 작업 중에는 파일을 바꿀 수 없습니다. 끝난 뒤에 다시 해 주세요.')
}

// 공유 프로젝트는 서버에서 지워 모두에게서 사라지고, 이 PC 프로젝트는 원본을 휴지통으로 보낸다.
async function deleteProjectFile({ id, rel } = {}) {
  assertIdle(id)
  const ctx = sharedContext(id)
  if (ctx) {
    await projectSync.deleteFile(ctx.channel, ctx.user, id, String(rel || ''))
    return { ok: true }
  }
  return projects.recycleLocalFile({ id, userId: requireUser().user_id, rel })
}

async function addProjectFiles({ id } = {}) {
  assertIdle(id)
  const user = requireUser()
  const ctx = sharedContext(id)
  if (!ctx) projects.detail({ id, userId: user.user_id })
  const { files } = await projects.pickFiles()
  if (!files.length) return { cancelled: true }
  if (ctx) return projectSync.uploadFiles(ctx.channel, ctx.user, id, files, { onProgress: syncProgress(id, 'upload') })
  const res = projects.addLocalFiles({ id, userId: user.user_id, files })
  return { uploaded: res.added.length, skipped: res.skipped.length, failed: res.skipped.map((name) => `${name}: 같은 이름의 파일이 이미 있습니다`) }
}

async function migrateProject({ id } = {}) {
  const user = requireUser()
  const project = projects.detail({ id, userId: user.user_id }).project
  const channel = projectChannel(project.channelId)
  if (!(await projectSync.supports(channel, user))) throw new Error(`${channel.name} 채널은 공유 프로젝트를 지원하지 않습니다.`)
  return projectSync.migrate(channel, user, id, { onProgress: syncProgress(id, 'upload') })
}

function projectDetail({ id } = {}) {
  return { ...projects.detail({ id, userId: requireUser().user_id }), job: projects.jobStatus() }
}

async function renameProject({ id, name } = {}) {
  const clean = String(name || '').trim().slice(0, 60)
  if (!clean) throw new Error('프로젝트 이름을 입력해 주세요.')
  const ctx = sharedContext(id)
  if (ctx) await projectSync.patch(ctx.channel, ctx.user, id, { name: clean })
  return projects.rename({ id, userId: requireUser().user_id, name: clean })
}

async function setProjectDatasheet({ id, rel } = {}) {
  const result = projects.setDatasheet({ id, userId: requireUser().user_id, rel })
  const ctx = sharedContext(id)
  if (ctx) await projectSync.patch(ctx.channel, ctx.user, id, { datasheet: result.datasheet })
  return result
}

async function setProjectOptions({ id, skipImages } = {}) {
  const result = projects.setOptions({ id, userId: requireUser().user_id, skipImages })
  const ctx = sharedContext(id)
  if (ctx) await projectSync.patch(ctx.channel, ctx.user, id, { skipImages: result.skipImages })
  return result
}

// 공유 프로젝트를 지우면 서버에서도 지워져 모두에게서 사라진다. 각자의 대화는 PC에 남는다.
async function removeProject({ id } = {}) {
  const job = projects.jobStatus()
  if (job?.running && job.projectId === id) throw new Error('색인·엑셀 작업 중에는 프로젝트를 지울 수 없습니다. 끝난 뒤에 다시 해 주세요.')
  const ctx = sharedContext(id)
  if (ctx) {
    await projectSync.remove(ctx.channel, ctx.user, id).catch((err) => {
      if (!/찾지 못했/.test(err.message)) throw err
    })
  }
  return projects.remove({ id, userId: requireUser().user_id })
}

function trashChannel(channelId) {
  const channel = channels.store.get(activeChannelId(channelId))
  if (!channel) throw new Error('채널을 찾을 수 없습니다.')
  return channel
}

async function listProjectTrash({ channelId } = {}) {
  return { projects: await projectSync.listTrash(trashChannel(channelId), requireUser()) }
}

async function restoreProject({ channelId, id } = {}) {
  return projectSync.restore(trashChannel(channelId), requireUser(), id)
}

// 공유 프로젝트는 색인·엑셀 동안 서버에 잠금을 건다.
// 색인 뒤 엑셀이 곧바로 이어지므로 running=false를 받고 잠시 뒤에도 멈춰 있을 때 푼다.
async function withProjectLock(id, purpose, start) {
  const ctx = sharedContext(id)
  const release = ctx ? await projectSync.lock(ctx.channel, ctx.user, id, purpose) : async () => {}
  const onProgress = (status) => {
    broadcast({ type: 'project-index', ...status })
    if (status.running) return
    setTimeout(() => {
      if (!projects.jobStatus()?.running) void release()
    }, 2000)
  }
  try {
    const status = start(onProgress)
    if (!status?.running) void release()
    return status
  } catch (err) {
    await release()
    throw err
  }
}

// 색인 모델. deep은 사양서·데이터시트(지시를 골라 적용 범위까지 판단), light는 도면·양식 같은 나머지.
// 그 밖(적용 범위 판단 등)은 채팅에 고른 모델을 쓴다.
const INDEX_MODELS = {
  light: { claude: 'haiku', 'claude-api': /haiku/i, codex: /luna/i, 'openai-api': /mini|nano/i },
  deep: { claude: 'sonnet', 'claude-api': /sonnet/i, codex: /sol/i, 'openai-api': /gpt-5/i },
}

async function projectReader(id, userId, { tier } = {}) {
  const cfg = config.read()
  const adapter = currentAdapter(cfg.adapterId)
  if (!adapter.readOnce) throw new Error(`${adapter.label}는 문서 색인을 지원하지 않습니다.`)
  const cached = detectCache.get(adapter.id) || cachedDetect
  const detected = cached?.adapterId === adapter.id && (adapter.kind === 'api' ? cached.loggedIn : cached.installed && cached.loggedIn)
    ? cached
    : await detect({ adapterId: adapter.id })
  const reason = explainNotReady(adapter, detected)
  if (reason) throw new Error(reason)
  const project = projects.detail({ id, userId }).project
  const located = detected.path ? { path: detected.path, viaShell: Boolean(detected.viaShell) } : null
  let model = currentModel(adapter, cfg)
  const pick = INDEX_MODELS[tier]?.[adapter.id]
  if (typeof pick === 'string') model = pick
  if (pick instanceof RegExp) {
    const models = await modelsFor(adapter, located)
    model = models.find((item) => pick.test(item.id))?.id || model
  }
  return (prompt, signal, read, images, { shell = false } = {}) => adapter.readOnce({
    signal,
    read,
    shell,
    images: images || [],
    effort: 'medium',
    located,
    prompt,
    model,
    cwd: project.folder,
    dirs: [project.folder, path.join(config.workDir(), 'projects', project.id)],
  })
}

async function indexProject({ id, force } = {}) {
  const user = requireUser()
  const reader = await projectReader(id, user.user_id, { tier: 'light' })
  const deepReader = await projectReader(id, user.user_id, { tier: 'deep' })
  const judge = await projectReader(id, user.user_id)
  // 다른 사람이 막 올린 색인을 다시 하지 않도록 시작 전에 서버 것을 받는다.
  if (sharedContext(id)) await syncProject({ id })
  return withProjectLock(id, '색인', (onProgress) => projects.startIndex({
    id,
    userId: user.user_id,
    reader,
    deepReader,
    judge,
    force: Boolean(force),
    onProgress,
  }))
}

// 적용 범위 판단에 AI를 쓴다. CLI가 연결되지 않았으면 판단 없이 엑셀만 만든다.
async function exportProjectReport({ id } = {}) {
  const user = requireUser()
  const judge = await projectReader(id, user.user_id).catch(() => null)
  return withProjectLock(id, '엑셀 만들기', (onProgress) => projects.exportReport({
    id,
    userId: user.user_id,
    reader: judge,
    onProgress,
  }))
}

// 데이터시트를 프로젝트 채널의 검증용 스테이징 테이블에 넣는다. 엑셀 때 남긴 판단만 쓰고 AI는 부르지 않는다.
async function saveProjectDatasheet({ id, replace = false } = {}) {
  const user = requireUser()
  const records = projects.datasheetRecords({ id, userId: user.user_id })
  const project = projects.detail({ id, userId: user.user_id }).project
  const { changed } = await channels.ensureFresh(project.channelId, { force: true }).catch(() => ({ changed: false }))
  if (changed) broadcast({ type: 'channels-changed' })
  const channel = channels.store.get(project.channelId)
  if (!channel) throw new Error('이 프로젝트의 채널을 찾을 수 없습니다.')
  if (!(channel.tools ?? []).some((tool) => tool.name === 'get_datasheet')) {
    throw new Error(`${channel.name} 채널은 데이터시트 DB 저장을 지원하지 않습니다.`)
  }
  return channels.client.saveDatasheet(channel, { ...records, replace: Boolean(replace) }, user)
}

function cancelProjectIndex() {
  return projects.cancelIndex()
}

function previewImage({ path: filePath } = {}) {
  const resolved = path.resolve(String(filePath || ''))
  const root = path.resolve(config.dataDir())
  const lower = resolved.toLowerCase()
  const rootLower = root.toLowerCase()
  if (lower !== rootLower && !lower.startsWith(`${rootLower}${path.sep}`)) {
    throw new Error('미리보기를 열 수 없습니다.')
  }
  const ext = path.extname(resolved).toLowerCase()
  const mime = PREVIEW_EXT[ext]
  if (!mime) throw new Error('이미지가 아닙니다.')
  const stat = fs.statSync(resolved)
  if (!stat.isFile() || stat.size > 12 * 1024 * 1024) throw new Error('이미지를 미리볼 수 없습니다.')
  return { mime, bytesBase64: fs.readFileSync(resolved).toString('base64') }
}

async function send({ text, sessionId: requestedSessionId, attachments: incoming, projectId } = {}) {
  const prompt = String(text || '').trim()
  const hasFiles = Array.isArray(incoming) && incoming.length > 0
  if (!prompt && !hasFiles) throw new Error('보낼 내용이 없습니다.')
  if (activeTurn) throw new Error('이전 요청이 아직 처리 중입니다.')

  const user = loggedInUser()
  if (!user?.user_id) throw new Error('로그인 정보가 없습니다. 다시 로그인해주세요.')

  const activeId = channels.store.activeId()
  if (activeId) {
    const { changed } = await channels.ensureFresh(activeId)
    if (changed) broadcast({ type: 'channels-changed' })
  }
  const channel = channels.store.getActive()
  if (!channel) throw new Error('연결된 채널이 없습니다. 설정 → 채널에서 채널을 먼저 추가해주세요.')

  // 계정 정보가 비어 있으면 툴이 전부 실패하니 먼저 알려준다.
  const missingCreds = channels.store.missingCredentialKeys(channel)
  if (missingCreds.length > 0) {
    const labels = (channel.credentialFields ?? [])
      .filter((field) => missingCreds.includes(field.key))
      .map((field) => field.label)
      .join(', ')
    throw new Error(`${channel.name} 채널을 쓰려면 계정 정보(${labels})가 필요합니다. 설정 → 채널에서 입력해주세요.`)
  }

  const cfg = config.read()
  const adapter = currentAdapter(cfg.adapterId)

  const cached = detectCache.get(adapter.id) || cachedDetect
  const detected = cached?.adapterId === adapter.id && (adapter.kind === 'api' ? cached.loggedIn : cached.installed && cached.loggedIn)
    ? cached
    : await detect({ adapterId: adapter.id })

  const reason = explainNotReady(adapter, detected)
  if (reason) throw new Error(reason)

  await mcpServer.start()
  applyChannelLabels()

  if (sessionOwnerId && sessionOwnerId !== user.user_id) resetSession()
  sessionOwnerId = user.user_id

  if (requestedSessionId && requestedSessionId !== sessionId) {
    sessionId = String(requestedSessionId)
    sessionStarted = true
  }

  const workDir = config.workDir()
  const isResume = sessionStarted && Boolean(sessionId)
  if (!sessionId) sessionId = adapter.newSessionId()

  mcpUi.setEmitter(broadcast)

  const prepared = await prepareTurnFiles(workDir, incoming)
  currentProjectId = projectId || null
  const brief = projectId ? projects.buildBrief(projectId, user.user_id) : null
  const body = [brief?.text, prepared.note, prompt].filter(Boolean).join('\n\n')
  const followupHint =
    '\n\n답변 글을 모두 쓴 뒤에만 차트(render_chart)·달력(render_calendar)을 호출하고, 맨 마지막에 propose_followups로 후속 질문 5개를 보내세요. 질문 문구는 본문에 쓰지 마세요.'
  const freshPrompt =
    `답하기 전에 반드시 whoami를 호출해 현재 로그인 사용자를 확인하세요.\n\n${body}` + followupHint

  const runTurn = (resume) => {
    const turn = adapter.send({
      located: detected.path ? { path: detected.path, viaShell: Boolean(detected.viaShell) } : null,
      workDir,
      mcpConfig: mcpServer.buildMcpConfig(),
      prompt: resume ? body + followupHint : freshPrompt,
      sessionId,
      isResume: resume,
      model: currentModel(adapter, cfg),
      user,
      allowRead: prepared.saved.length > 0 || Boolean(brief),
      images: prepared.images,
      onEvent: (evt) => {
        if (evt.type === 'session' && evt.sessionId) sessionId = evt.sessionId
        broadcast(evt)
      },
    })
    activeTurn = turn
    return turn.done
  }

  try {
    let result
    try {
      result = await runTurn(isResume)
    } catch (err) {
      // 이어가려던 대화 기록이 CLI에 없으면 새 대화로 한 번 더 보낸다.
      if (!(isResume && /no rollout found|thread\/resume|session not found/i.test(err.message))) throw err
      resetSession()
      sessionId = adapter.newSessionId()
      sessionOwnerId = user.user_id
      result = await runTurn(false)
    }
    sessionStarted = true
    if (result.sessionId) sessionId = result.sessionId
    if (!result.cancelled && result.usage) {
      try {
        const label = adapter.accountLabel ? adapter.accountLabel(detected) : detected.account
        usage.record(adapter.id, { account: label, ...result.usage })
      } catch {
        // 사용량 기록 실패는 대화에 영향 주지 않는다.
      }
    }
    return { ok: true, cancelled: Boolean(result.cancelled), text: result.text ?? '', sessionId, saved: prepared.saved }
  } catch (err) {
    if (isResume && /session|resume/i.test(err.message)) resetSession()
    broadcast({ type: 'error', message: err.message })
    throw err
  } finally {
    activeTurn = null
    cleanupWorkDir(workDir)
  }
}

function parsePromptList(raw) {
  const text = String(raw || '').trim()
  const match = text.match(/\[[\s\S]*\]/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0])
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 5)
      }
    } catch {
      // fall through
    }
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+[\.)]|[-*])\s*/, '').replace(/^["']|["']$/g, '').trim())
    .filter((line) => line.length >= 4 && !/^출력|JSON|배열/i.test(line))
    .slice(0, 5)
}

async function suggestFollowups({ question, answer } = {}) {
  const q = String(question || '').trim()
  const a = String(answer || '').trim().slice(0, 1600)
  if (!q && !a) return { items: [] }

  const cfg = config.read()
  const adapter = currentAdapter(cfg.adapterId)
  if (!adapter.promptOnce) return { items: [] }

  const cached = detectCache.get(adapter.id) || cachedDetect
  const detected = cached?.adapterId === adapter.id && (adapter.kind === 'api' ? cached.loggedIn : cached.installed && cached.loggedIn)
    ? cached
    : await detect({ adapterId: adapter.id })
  if (explainNotReady(adapter, detected)) return { items: [] }

  const channelName = channels.store.getActive()?.name || 'KODEX AI'
  const prompt = `방금 ${channelName} AI 비서 대화가 끝났습니다. 사용자가 이어서 물어볼 한국어 질문 5개만 만드세요.
질문은 바로 보낼 수 있게 짧고 구체적으로, 오늘/어제/이번 주처럼 실제 조회에 쓸 표현으로.
이미 답한 내용을 그대로 반복하지 마세요.

사용자: ${q || '(없음)'}
비서 답변 요약:
${a || '(없음)'}

출력 예: ["오늘 라인별 목표 대비 실적 보여줘","오늘 최근 NG 알려줘","오늘 알람 요약해줘"]`

  try {
    const raw = await adapter.promptOnce({
      located: detected.path ? { path: detected.path, viaShell: Boolean(detected.viaShell) } : null,
      prompt,
      model: currentModel(adapter, cfg),
    })
    return { items: parsePromptList(raw) }
  } catch (err) {
    process.stderr.write(`[followups] CLI 제안 실패: ${err?.message || err}\n`)
    return { items: [] }
  }
}

function cleanupWorkDir(dir) {
  const ONE_HOUR = 60 * 60 * 1000
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('mcp-') || !name.endsWith('.json')) continue
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

// 각 CLI(계정)별 사용량. 앱 누적 사용량 + (가능하면) 요금제 잔여 한도를 합친다.
async function getUsage() {
  const stored = usage.read()
  const items = []
  for (const info of listAdapters()) {
    const adapter = getAdapter(info.id)
    let detected = detectCache.get(info.id) || null
    try {
      if (!detected) detected = await detect({ adapterId: info.id })
    } catch {
      detected = null
    }
    let plan = null
    try {
      plan = adapter.planUsage ? await adapter.planUsage() : null
    } catch {
      plan = null
    }
    const app = { ...usage.emptyEntry(), ...(stored[info.id] || {}) }
    const account = (detected && detected.loggedIn && adapter.accountLabel ? adapter.accountLabel(detected) : null)
      || app.account
      || null
    items.push({
      id: info.id,
      label: info.label,
      installed: Boolean(detected?.installed),
      loggedIn: Boolean(detected?.loggedIn),
      account,
      app,
      plan,
    })
  }
  return { adapters: items }
}

function resetUsage({ adapterId } = {}) {
  usage.reset(adapterId || undefined)
  return { ok: true }
}

module.exports = {
  renderIndexedDrawing,
  setEmitter,
  detect,
  installCli,
  loginCli,
  connect,
  saveApiKey,
  setAdapter,
  status,
  setModel,
  listChannels,
  previewChannel,
  addChannel,
  removeChannel,
  setChannel,
  refreshChannel,
  setChannelCredentials,
  listChannelFiles,
  uploadChannelFile,
  deleteChannelFile,
  openChannelFile,
  previewImage,
  drawingPages,
  pickFolder,
  exportTable,
  listProjects,
  createProject,
  projectDetail,
  renameProject,
  setProjectDatasheet,
  setProjectOptions,
  removeProject,
  listProjectTrash,
  restoreProject,
  indexProject,
  exportProjectReport,
  saveProjectDatasheet,
  syncProject,
  uploadProjectFolder,
  deleteProjectFile,
  addProjectFiles,
  migrateProject,
  cancelProjectIndex,
  send,
  cancel,
  suggestFollowups,
  newSession,
  setSession,
  getUsage,
  resetUsage,
}
