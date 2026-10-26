// 채널 서버(egi.channel/v1)와 통신한다. manifest 받기 → 검증 → 툴 실행.

const { createHash, randomUUID } = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const config = require('../config')
const { assertToolSchema } = require('./schema')
const { stripHeavy } = require('../mcp/tools/helpers')
const mcpUi = require('../mcp/ui')

const SPEC = 'egi.channel/v1'
const DEFAULT_AUTH_HEADER = 'X-Channel-Key'
const CREDENTIALS_HEADER = 'X-Channel-Credentials'
const RESERVED_TOOLS = new Set(['whoami', 'render_chart', 'render_calendar', 'propose_followups', 'render_drawing_3d', 'use_skill'])
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/
const SKILL_RE = /^[a-z][a-z0-9-]{1,63}$/
const MAX_SKILLS = 32
const SKILL_TIMEOUT_MS = 15 * 1000
const MAX_SKILL_CHARS = 60000
const TOOL_RE = /^[a-z][a-z0-9_]{2,63}$/
const CRED_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/
const MAX_TOOLS = 64
const MAX_CREDENTIALS = 6
const MAX_UI_BLOCKS = 4
const MAX_UI_ITEMS = 12
const MAX_UI_FIELDS = 6
const MAX_CALENDAR_EVENTS = 90
const MAX_HTML = 200000
const CALENDAR_TONES = new Set(['info', 'ok', 'warn', 'danger'])
const CHANNEL_TYPES = new Set(['data', 'files'])
const CHANNEL_ICONS = new Set(['files', 'database', 'factory', 'shop', 'cog'])
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
const MANIFEST_TIMEOUT_MS = 10 * 1000
const TOOL_TIMEOUT_MS = 60 * 1000
const VERIFY_TIMEOUT_MS = 20 * 1000
const DOWNLOAD_TIMEOUT_MS = 120 * 1000
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
const FILE_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/

function timeoutSignal(ms) {
  if (typeof AbortSignal === 'undefined' || !AbortSignal.timeout) return undefined
  return AbortSignal.timeout(ms)
}

// 스킴을 생략했을 때 http로 볼 주소. 사내 서버를 IP나 포트로 적는 경우가 대부분이다.
const LOCAL_HOST_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^/]+\.local)$/i

function defaultScheme(text) {
  const authority = text.split('/')[0]
  const host = authority.replace(/:\d+$/, '')
  const hasPort = /:\d+$/.test(authority)
  // 포트를 직접 적었거나 사설·루프백 주소면 http, 그 밖의 도메인은 https.
  if (hasPort && !authority.endsWith(':443')) return 'http'
  return LOCAL_HOST_RE.test(host) ? 'http' : 'https'
}

// 사용자가 "example.com/smt", "https://example.com/smt/channel.json", "127.0.0.1:8801"
// 어느 쪽으로 넣어도 같은 base가 된다.
function normalizeBase(raw) {
  const text = String(raw || '').trim()
  if (!text) throw new Error('채널 URL을 입력해주세요.')

  let url
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `${defaultScheme(text)}://${text}`)
  } catch {
    throw new Error('채널 URL 형식이 올바르지 않습니다.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('채널 URL은 http 또는 https로 시작해야 합니다.')
  }

  url.hash = ''
  url.search = ''
  let pathname = url.pathname.replace(/\/+$/, '')
  if (pathname.endsWith('/channel.json')) pathname = pathname.slice(0, -'/channel.json'.length)
  url.pathname = pathname

  return url.toString().replace(/\/+$/, '')
}

function requireText(value, label, max = 200) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${label}이 비어 있습니다.`)
  return text.slice(0, max)
}

// 채널이 사용자에게 요구하는 계정 항목. 앱이 입력칸을 그려 준다.
function validateCredentials(raw) {
  const list = Array.isArray(raw) ? raw : []
  if (list.length > MAX_CREDENTIALS) {
    throw new Error(`채널이 요구하는 계정 항목이 너무 많습니다. (최대 ${MAX_CREDENTIALS}개)`)
  }
  const seen = new Set()
  return list.map((field) => {
    const key = String(field?.key ?? '').trim()
    if (!CRED_KEY_RE.test(key)) {
      throw new Error(`계정 항목 key가 규격에 맞지 않습니다: ${key || '(없음)'}`)
    }
    if (seen.has(key)) throw new Error(`계정 항목 key가 중복됩니다: ${key}`)
    seen.add(key)
    return {
      key,
      label: requireText(field?.label, `${key} 라벨`, 40),
      secret: field?.secret !== false,
      required: field?.required !== false,
      hint: String(field?.hint ?? '').trim().slice(0, 120),
    }
  })
}

function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('채널 응답이 올바른 manifest가 아닙니다.')
  }
  if (raw.spec !== SPEC) {
    throw new Error(`지원하지 않는 채널 규격입니다. (${raw.spec ?? '없음'} — ${SPEC}이어야 합니다)`)
  }

  const id = String(raw.id ?? '').trim()
  if (!ID_RE.test(id)) {
    throw new Error('채널 id는 영문 소문자·숫자·하이픈 2~32자여야 합니다.')
  }

  const tools = Array.isArray(raw.tools) ? raw.tools : []
  if (tools.length === 0) throw new Error('채널에 등록된 툴이 없습니다.')
  if (tools.length > MAX_TOOLS) throw new Error(`툴은 최대 ${MAX_TOOLS}개까지 쓸 수 있습니다. (받은 값: ${tools.length})`)

  const seen = new Set()
  const normalizedTools = tools.map((tool) => {
    const name = String(tool?.name ?? '').trim()
    if (!TOOL_RE.test(name)) {
      throw new Error(`툴 이름이 규격에 맞지 않습니다: ${name || '(없음)'} — 영문 소문자·숫자·밑줄 3~64자.`)
    }
    if (seen.has(name)) throw new Error(`툴 이름이 중복됩니다: ${name}`)
    if (RESERVED_TOOLS.has(name)) throw new Error(`${name}은 앱 내장 툴 이름입니다. 다른 이름을 써주세요.`)
    seen.add(name)

    assertToolSchema(tool?.inputSchema, name)
    return {
      name,
      label: tool?.label ? String(tool.label).slice(0, 40) : null,
      description: requireText(tool?.description, `${name} 설명`, 1200),
      inputSchema: tool?.inputSchema ?? { type: 'object', properties: {} },
    }
  })

  const authType = raw.auth?.type ?? 'none'
  if (authType !== 'none' && authType !== 'apiKey') {
    throw new Error(`지원하지 않는 인증 방식입니다: ${authType}`)
  }

  const name = requireText(raw.name, '채널 이름', 60)
  const channelType = CHANNEL_TYPES.has(raw.type) ? raw.type : 'data'
  const icon = CHANNEL_ICONS.has(raw.icon) ? raw.icon : 'cog'
  return {
    spec: SPEC,
    id,
    name,
    short: String(raw.short ?? '').trim().slice(0, 4) || name.slice(0, 2),
    description: String(raw.description ?? '').trim().slice(0, 300),
    version: raw.version ? String(raw.version).slice(0, 40) : null,
    type: channelType,
    icon,
    systemPrompt: String(raw.systemPrompt ?? '').trim().slice(0, 8000),
    auth: { type: authType, header: String(raw.auth?.header ?? DEFAULT_AUTH_HEADER).trim() || DEFAULT_AUTH_HEADER },
    credentials: validateCredentials(raw.credentials),
    tools: normalizedTools,
    skills: validateSkills(raw.skills),
  }
}

// 채널이 알려주는 스킬 목록. 본문은 AI가 use_skill로 부를 때 /skills/{name}에서 받는다.
function validateSkills(raw) {
  const list = Array.isArray(raw) ? raw : []
  if (list.length > MAX_SKILLS) throw new Error(`스킬은 최대 ${MAX_SKILLS}개까지 쓸 수 있습니다. (받은 값: ${list.length})`)
  const seen = new Set()
  return list.map((skill) => {
    const name = String(skill?.name ?? '').trim()
    if (!SKILL_RE.test(name)) {
      throw new Error(`스킬 이름이 규격에 맞지 않습니다: ${name || '(없음)'} — 영문 소문자·숫자·하이픈 2~64자.`)
    }
    if (seen.has(name)) throw new Error(`스킬 이름이 중복됩니다: ${name}`)
    seen.add(name)
    return { name, description: requireText(skill?.description, `${name} 스킬 설명`, 300) }
  })
}

// fetch는 실패하면 "fetch failed"만 던지고 실제 원인은 cause에 숨긴다. 꺼내서 사람 말로 바꾼다.
function connectionReason(err, base, timedOutText) {
  if (err?.name === 'TimeoutError') return timedOutText
  const cause = err?.cause
  const code = cause?.code || err?.code || ''
  const isHttps = String(base || '').startsWith('https://')

  if (code === 'ECONNREFUSED') return '연결이 거부되었습니다. 주소와 포트를 확인해주세요'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '주소를 찾을 수 없습니다'
  if (code === 'ECONNRESET') {
    return isHttps ? 'https로 붙지 못했습니다. 채널이 http로 열려 있으면 주소를 http://로 적어주세요' : '연결이 끊겼습니다'
  }
  if (code === 'EPROTO' || code === 'ERR_SSL_WRONG_VERSION_NUMBER') {
    return 'https로 붙지 못했습니다. 채널이 http로 열려 있으면 주소를 http://로 적어주세요'
  }
  if (/CERT|SSL|certificate/i.test(code)) {
    return `인증서를 신뢰할 수 없습니다 (${code}). 사내 인증서라면 이 PC에 설치해야 합니다`
  }
  return cause?.message || err?.message || String(err)
}

async function readJson(res, label) {
  const text = await res.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} 응답이 JSON이 아닙니다. 채널 URL을 확인해주세요.`)
  }
}

async function fetchManifest(url, apiKey, { timeoutMs = MANIFEST_TIMEOUT_MS } = {}) {
  const base = normalizeBase(url)
  const headers = { Accept: 'application/json' }
  if (apiKey) headers[DEFAULT_AUTH_HEADER] = String(apiKey)

  let res
  try {
    res = await fetch(`${base}/channel.json`, { headers, signal: timeoutSignal(timeoutMs) })
  } catch (err) {
    throw new Error(`채널 서버에 연결할 수 없습니다: ${connectionReason(err, base, '응답이 없습니다')}`)
  }

  if (res.status === 401 || res.status === 403) throw new Error('API 키가 올바르지 않습니다.')
  if (res.status === 404) throw new Error('이 URL에는 채널이 없습니다. (channel.json을 찾을 수 없음)')
  const payload = await readJson(res, '채널')
  if (!res.ok) {
    throw new Error(payload?.error || `채널 정보를 가져오지 못했습니다. (HTTP ${res.status})`)
  }

  return { url: base, manifest: validateManifest(payload) }
}

// 헤더는 ASCII만 담을 수 있어서 한글 이름은 퍼센트 인코딩해 보낸다.
function userHeaders(user) {
  if (!user?.user_id) return {}
  return {
    'X-User-Id': String(user.user_id),
    'X-User-Name': encodeURIComponent(String(user.user_name ?? '')),
    'X-User-Role': String(user.role ?? 'manager'),
  }
}

// 사용자가 입력한 계정 정보. base64(JSON)으로 담아 요청마다 보낸다.
function credentialHeaders(credentials) {
  const entries = Object.entries(credentials || {}).filter(([, value]) => String(value ?? '').trim() !== '')
  if (entries.length === 0) return {}
  const json = JSON.stringify(Object.fromEntries(entries.map(([key, value]) => [key, String(value)])))
  return { [CREDENTIALS_HEADER]: Buffer.from(json, 'utf8').toString('base64') }
}

function requestHeaders(channel, { user, credentials, json } = {}) {
  const headers = {
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...userHeaders(user),
    ...credentialHeaders(credentials),
  }
  if (channel.apiKey) headers[channel.authHeader || DEFAULT_AUTH_HEADER] = channel.apiKey
  return headers
}

async function post(channel, pathname, body, { user, credentials, timeoutMs }) {
  let res
  try {
    res = await fetch(`${channel.url}${pathname}`, {
      method: 'POST',
      headers: requestHeaders(channel, { user, credentials, json: true }),
      body: JSON.stringify(body ?? {}),
      signal: timeoutSignal(timeoutMs),
    })
  } catch (err) {
    const reason = connectionReason(err, channel.url, '시간이 초과되었습니다')
    throw new Error(`${channel.name} 채널에 연결할 수 없습니다: ${reason}`)
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(`${channel.name} 채널 API 키가 유효하지 않습니다. 설정에서 채널을 다시 추가해주세요.`)
  }
  return { res, payload: await readJson(res, channel.name) }
}

// 채널이 보낸 표시 지시. 외부 서버 값이라 앱에서 한 번 더 자른 뒤 화면에 넘긴다.
function uiText(value, limit) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, limit)
}

function uiCard(raw) {
  if (!raw || typeof raw !== 'object') return null
  const title = uiText(raw.title, 120)
  if (!title) return null

  const image = uiText(raw.image, 500)
  const fields = (Array.isArray(raw.fields) ? raw.fields : [])
    .slice(0, MAX_UI_FIELDS)
    .map((field) => ({ label: uiText(field?.label, 24), value: uiText(field?.value, 120) }))
    .filter((field) => field.label !== '')

  return {
    title,
    subtitle: uiText(raw.subtitle, 120) || null,
    image: /^https?:\/\//i.test(image) ? image : null,
    badge: uiText(raw.badge, 24) || null,
    fields,
  }
}

function uiExcel(raw) {
  const title = uiText(raw?.title, 120)
  const sheet = uiText(raw?.sheet, 40) || 'Sheet1'
  const rows = (Array.isArray(raw?.rows) ? raw.rows : []).slice(0, 700).map((row) =>
    (Array.isArray(row) ? row : []).slice(0, 12).map((cell) => uiText(cell, 80)),
  )
  if (!title || rows.length === 0) return null
  const filePath = uiText(raw?.path, 400)
  const merges = (Array.isArray(raw?.merges) ? raw.merges : []).slice(0, 400).map((item) => ({
    r: Number(item?.r) || 0,
    c: Number(item?.c) || 0,
    rows: Number(item?.rows) || 1,
    cols: Number(item?.cols) || 1,
  })).filter((item) => item.rows > 0 && item.cols > 0)
  const styles = (Array.isArray(raw?.styles) ? raw.styles : []).slice(0, 700).map((row) =>
    (Array.isArray(row) ? row : []).slice(0, 12).map((cell) => uiText(cell, 8)),
  )
  const borders = (Array.isArray(raw?.borders) ? raw.borders : []).slice(0, 700).map((row) =>
    (Array.isArray(row) ? row : []).slice(0, 12).map((cell) => uiText(cell, 4)),
  )
  const heights = (Array.isArray(raw?.heights) ? raw.heights : []).slice(0, 700).map((item) => {
    const value = Number(item)
    return Number.isFinite(value) && value > 0 ? value : 15
  })
  const widths = (Array.isArray(raw?.widths) ? raw.widths : [])
    .slice(0, 12)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
  return {
    type: 'excel',
    id: createHash('sha1').update(`${title}\n${sheet}\n${rows.length}`).digest('hex').slice(0, 20),
    title,
    sheet,
    path: filePath,
    rows,
    merges,
    styles,
    borders,
    heights,
    widths,
  }
}

function uiReport(raw) {
  const title = uiText(raw?.title, 120)
  const html = typeof raw?.html === 'string' ? raw.html.trim() : ''
  if (!title || !html || html.length > MAX_HTML) return null
  if (/<script/i.test(html)) return null
  const norm = `${title}\n${html.replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?/g, '')}`
  return {
    type: 'report',
    id: createHash('sha1').update(norm).digest('hex').slice(0, 20),
    title,
    html,
  }
}

function uiCalendar(raw) {
  const title = uiText(raw?.title, 120)
  if (!title) return null
  const events = []
  for (const item of (Array.isArray(raw?.events) ? raw.events : []).slice(0, MAX_CALENDAR_EVENTS)) {
    const date = uiText(item?.date, 10)
    const name = uiText(item?.title, 120)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !name) continue
    const tone = uiText(item?.tone, 16)
    events.push({
      date,
      title: name,
      subtitle: uiText(item?.subtitle, 120) || null,
      tone: CALENDAR_TONES.has(tone) ? tone : 'info',
    })
  }
  if (events.length === 0) return null
  const norm = `${title}\n${events.map((item) => `${item.date}|${item.title}|${item.tone}`).join('\n')}`
  return {
    type: 'calendar',
    id: createHash('sha1').update(norm).digest('hex').slice(0, 20),
    title,
    events,
  }
}

function uiBlocks(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
  const out = []
  for (const block of list.slice(0, MAX_UI_BLOCKS)) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'cards') {
      const items = (Array.isArray(block.items) ? block.items : [])
        .slice(0, MAX_UI_ITEMS)
        .map(uiCard)
        .filter(Boolean)
      if (items.length === 0) continue
      out.push({ type: 'cards', id: randomUUID(), title: uiText(block.title, 120) || null, items })
      continue
    }
    if (block.type === 'excel') {
      const item = uiExcel(block)
      if (item) out.push(item)
      continue
    }
    if (block.type === 'report') {
      const item = uiReport(block)
      if (item) out.push(item)
      continue
    }
    if (block.type === 'calendar') {
      const item = uiCalendar(block)
      if (item) out.push(item)
      continue
    }
    if (block.type === 'file') {
      const item = uiFile(block)
      if (item) out.push(item)
    }
  }
  return out
}

function uiFile(raw) {
  const name = safeFileName(uiText(raw?.name, 120))
  const token = uiText(raw?.token, 64)
  if (!name || !FILE_TOKEN_RE.test(token)) return null
  const size = Number(raw?.size)
  return { type: 'file', name, token, size: Number.isFinite(size) && size >= 0 ? size : null }
}

function safeFileName(value) {
  const base = String(value || '').split(/[\\/]/).pop() || ''
  const cleaned = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim()
  if (!cleaned || /^\.+$/.test(cleaned)) return ''
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned
}

function downloadsDir() {
  const custom = String(process.env.EGI_DOWNLOAD_DIR || '').trim()
  return custom || path.join(os.homedir(), 'Downloads')
}

function uniquePath(dir, name) {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = path.join(dir, name)
  for (let i = 1; fs.existsSync(candidate); i += 1) candidate = path.join(dir, `${stem} (${i})${ext}`)
  return candidate
}

// 채널 서버에 만들어진 파일은 사용자 PC에서 열 수 없으니, 받아서 다운로드 폴더에 둔다.
async function downloadFile(channel, block, user) {
  let res
  try {
    res = await fetch(`${channel.url}/downloads/${encodeURIComponent(block.token)}`, {
      headers: { ...requestHeaders(channel, { user, credentials: channel.credentials }), Accept: '*/*' },
      signal: timeoutSignal(DOWNLOAD_TIMEOUT_MS),
    })
  } catch (err) {
    const reason = connectionReason(err, channel.url, '시간이 초과되었습니다')
    throw new Error(`${channel.name} 채널에서 파일을 받지 못했습니다: ${reason}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${channel.name} 채널 API 키가 유효하지 않습니다. 설정에서 채널을 다시 추가해주세요.`)
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => null)
    throw new Error(String(payload?.error || `파일을 받지 못했습니다. (HTTP ${res.status})`))
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('파일이 100MB를 넘어 받지 않았습니다.')
  const dir = downloadsDir()
  fs.mkdirSync(dir, { recursive: true })
  const target = uniquePath(dir, block.name)
  fs.writeFileSync(target, bytes)
  return { type: 'file', id: randomUUID(), name: path.basename(target), path: target, size: bytes.length }
}

function withDownloads(data, saved, failed) {
  if (saved.length === 0 && failed.length === 0) return data
  const extra = {}
  if (saved.length) extra['내려받은파일'] = saved.length === 1 ? saved[0] : saved
  if (failed.length) extra['내려받기실패'] = failed
  if (data && typeof data === 'object' && !Array.isArray(data)) return { ...data, ...extra }
  return { 결과: data, ...extra }
}

function isEmptyNotice(message) {
  const text = String(message || '')
  if (/연결|비밀번호|인증|계정 정보|툴 실행 중 오류|HTTP |형식이 올바르지|시간이 초과|JSON이 아니/.test(text)) {
    return false
  }
  return /없습|찾을 수 없|찾지 못했|조회에 실패|조회할 수 없|조회하지 못|데이터가 없/.test(text)
}

async function callTool(channel, name, args, user) {
  if (!channel?.url) throw new Error('채널 정보가 없습니다. 설정에서 채널을 다시 추가해주세요.')

  const { res, payload } = await post(channel, `/tools/${encodeURIComponent(name)}`, args, {
    user,
    credentials: channel.credentials,
    timeoutMs: TOOL_TIMEOUT_MS,
  })

  if (res.status === 404 && (!payload || payload.ok === false)) {
    const err = new Error(`채널에 ${name} 툴이 없습니다.`)
    err.code = 'TOOL_NOT_FOUND'
    throw err
  }
  if (payload && payload.ok === false) {
    const message = String(payload.error || '채널 툴 실행에 실패했습니다.')
    if (isEmptyNotice(message)) return { 표시: '주의', 안내: message, 건수: 0 }
    throw new Error(message)
  }
  if (!res.ok) throw new Error(`채널 툴 실행에 실패했습니다. (HTTP ${res.status})`)

  // AI는 data만 읽고, 카드·리포트·달력은 앱이 바로 그린다. HTML은 data에 넣지 않는다.
  const saved = []
  const failed = []
  for (const block of uiBlocks(payload?.ui)) {
    if (block.type !== 'file') {
      mcpUi.emitUi(block)
      continue
    }
    try {
      const file = await downloadFile(channel, block, user)
      mcpUi.emitUi(file)
      saved.push(file.path)
    } catch (err) {
      failed.push(`${block.name}: ${err?.message || err}`)
    }
  }

  return withDownloads(stripHeavy(payload && 'data' in payload ? payload.data : payload), saved, failed)
}

// 스킬 본문(SKILL.md)과 딸린 참고 문서를 받는다. 응답: { body, files?: { "이름.md": "본문" } }
async function fetchSkill(channel, name, user) {
  if (!channel?.url) throw new Error('채널 정보가 없습니다. 설정에서 채널을 다시 추가해주세요.')
  let res
  try {
    res = await fetch(`${channel.url}/skills/${encodeURIComponent(name)}`, {
      headers: requestHeaders(channel, { user, credentials: channel.credentials }),
      signal: timeoutSignal(SKILL_TIMEOUT_MS),
    })
  } catch (err) {
    const reason = connectionReason(err, channel.url, '시간이 초과되었습니다')
    throw new Error(`${channel.name} 채널에서 스킬을 받지 못했습니다: ${reason}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${channel.name} 채널 API 키가 유효하지 않습니다. 설정에서 채널을 다시 추가해주세요.`)
  }
  const payload = await readJson(res, channel.name)
  if (res.status === 404) throw new Error(`${channel.name} 채널에 ${name} 스킬이 없습니다.`)
  if (payload && payload.ok === false) throw new Error(String(payload.error || '스킬을 받지 못했습니다.'))
  if (!res.ok) throw new Error(`스킬을 받지 못했습니다. (HTTP ${res.status})`)
  const data = payload && 'data' in payload ? payload.data : payload
  const body = typeof data?.body === 'string' ? data.body.trim().slice(0, MAX_SKILL_CHARS) : ''
  if (!body) throw new Error(`${name} 스킬 본문이 비어 있습니다.`)
  const files = {}
  for (const [file, text] of Object.entries(data?.files && typeof data.files === 'object' ? data.files : {}).slice(0, 20)) {
    const clean = String(file).replace(/\\/g, '/')
    if (!clean || clean.startsWith('/') || clean.split('/').includes('..') || typeof text !== 'string') continue
    files[clean] = text.slice(0, MAX_SKILL_CHARS)
  }
  return { body, files }
}

// 계정 정보를 저장하기 전에 채널에 한 번 확인시킨다.
async function verifyCredentials(channel, credentials, user) {
  const { res, payload } = await post(channel, '/credentials/verify', {}, {
    user,
    credentials,
    timeoutMs: VERIFY_TIMEOUT_MS,
  })

  if (res.status === 404) return { skipped: true, detail: null }
  if (payload && payload.ok === false) {
    throw new Error(String(payload.error || '계정 정보를 확인할 수 없습니다.'))
  }
  if (!res.ok) throw new Error(`계정 정보를 확인할 수 없습니다. (HTTP ${res.status})`)
  return { skipped: false, detail: payload && 'data' in payload ? payload.data : null }
}

function requireFilesChannel(channel) {
  if (!channel?.url) throw new Error('채널 정보가 없습니다. 설정에서 채널을 다시 추가해주세요.')
  if (channel.type !== 'files' && channel.id !== 'files' && channel.icon !== 'files') {
    throw new Error('파일 채널에서만 문서를 관리할 수 있습니다.')
  }
  return channel
}

async function filesRequest(channel, pathname, { user, method = 'GET', body, timeoutMs = TOOL_TIMEOUT_MS } = {}) {
  const target = requireFilesChannel(channel)
  let res
  try {
    res = await fetch(`${target.url}${pathname}`, {
      method,
      headers: requestHeaders(target, { user, credentials: target.credentials, json: false }),
      body,
      signal: timeoutSignal(timeoutMs),
    })
  } catch (err) {
    const reason = connectionReason(err, target.url, '시간이 초과되었습니다')
    throw new Error(`${target.name} 채널에 연결할 수 없습니다: ${reason}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${target.name} 채널 API 키가 유효하지 않습니다. 설정에서 채널을 다시 추가해주세요.`)
  }
  const payload = await readJson(res, target.name)
  if (payload && payload.ok === false) throw new Error(String(payload.error || '파일 요청이 실패했습니다.'))
  if (!res.ok) throw new Error(`파일 요청이 실패했습니다. (HTTP ${res.status})`)
  return payload && 'data' in payload ? payload.data : payload
}

async function listFiles(channel, user) {
  return filesRequest(channel, '/files', { user })
}

async function uploadFile(channel, { filename, bytesBase64 }, user) {
  const raw = Buffer.from(String(bytesBase64 || ''), 'base64')
  if (!raw.length) throw new Error('올릴 파일이 비어 있습니다.')
  if (raw.length > MAX_UPLOAD_BYTES) throw new Error('파일은 20MB를 넘을 수 없습니다.')
  const name = String(filename || 'upload.pdf')
  if (!name.toLowerCase().endsWith('.pdf')) throw new Error('PDF만 올릴 수 있습니다.')
  const form = new FormData()
  form.append('file', new Blob([raw], { type: 'application/pdf' }), name)
  return filesRequest(channel, '/files', { user, method: 'POST', body: form })
}

async function downloadStoredFile(channel, { itemId, filename }, user) {
  const target = requireFilesChannel(channel)
  const id = String(itemId || '').trim()
  if (!id) throw new Error('열 파일이 없습니다.')
  let res
  try {
    res = await fetch(`${target.url}/files/${encodeURIComponent(id)}`, {
      headers: { ...requestHeaders(target, { user, credentials: target.credentials }), Accept: '*/*' },
      signal: timeoutSignal(DOWNLOAD_TIMEOUT_MS),
    })
  } catch (err) {
    const reason = connectionReason(err, target.url, '시간이 초과되었습니다')
    throw new Error(`${target.name} 채널에서 파일을 받지 못했습니다: ${reason}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${target.name} 채널 API 키가 유효하지 않습니다. 설정에서 채널을 다시 추가해주세요.`)
  }
  const type = res.headers.get('content-type') || ''
  if (!res.ok || type.includes('json')) {
    const payload = await res.json().catch(() => null)
    const message = String(payload?.error || '')
    if (res.status === 404 && !message) {
      throw new Error('이 채널 서버는 파일 열기를 아직 지원하지 않습니다. 서버를 갱신한 뒤 다시 열어주세요.')
    }
    throw new Error(message || `파일을 받지 못했습니다. (HTTP ${res.status})`)
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  if (!bytes.length) throw new Error('받은 파일이 비어 있습니다.')
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('파일이 100MB를 넘어 열지 않았습니다.')
  const name = safeFileName(filename) || safeFileName(id) || 'document.pdf'
  const dir = path.join(config.dataDir(), 'opened', target.id)
  fs.mkdirSync(dir, { recursive: true })
  const saved = path.join(dir, name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`)
  fs.writeFileSync(saved, bytes)
  return { path: saved, name: path.basename(saved) }
}

// 공유 프로젝트 API(/projects…). json은 JSON 본문, bytes는 파일 본문. download면 Buffer와 헤더를 준다.
// 서버가 이 경로를 모르면(404) 공유 프로젝트를 안 쓰는 채널로 본다.
async function projectRequest(channel, pathname, { user, method = 'GET', json, bytes, download = false, timeoutMs = TOOL_TIMEOUT_MS } = {}) {
  if (!channel?.url) throw new Error('채널 정보가 없습니다. 설정에서 채널을 다시 추가해주세요.')
  let res
  try {
    res = await fetch(`${channel.url}${pathname}`, {
      method,
      headers: {
        ...requestHeaders(channel, { user, credentials: channel.credentials, json: json !== undefined }),
        ...(bytes ? { 'Content-Type': 'application/octet-stream' } : {}),
        ...(download ? { Accept: '*/*' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : bytes,
      signal: timeoutSignal(timeoutMs),
    })
  } catch (err) {
    const reason = connectionReason(err, channel.url, '시간이 초과되었습니다')
    throw new Error(`${channel.name} 채널에 연결할 수 없습니다: ${reason}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${channel.name} 채널 API 키가 유효하지 않습니다. 설정에서 채널을 다시 추가해주세요.`)
  }
  if (download && res.ok && !(res.headers.get('content-type') || '').includes('json')) {
    return { bytes: Buffer.from(await res.arrayBuffer()), mtime: Number(res.headers.get('x-file-mtime')) || 0 }
  }
  const payload = await res.json().catch(() => null)
  if (res.status === 404 && !payload?.error) {
    const err = new Error(`${channel.name} 채널은 공유 프로젝트를 지원하지 않습니다.`)
    err.unsupported = true
    throw err
  }
  if (payload && payload.ok === false) throw new Error(String(payload.error || '프로젝트 요청이 실패했습니다.'))
  if (!res.ok) throw new Error(`프로젝트 요청이 실패했습니다. (HTTP ${res.status})`)
  return payload && 'data' in payload ? payload.data : payload
}

// 데이터시트 검증용 저장. 태그×항목이 수천 행이라 AI 툴이 아니라 채널 전용 경로로 보낸다.
async function saveDatasheet(channel, body, user) {
  if (!channel?.url) throw new Error('채널 정보가 없습니다. 설정에서 채널을 다시 추가해주세요.')
  const { res, payload } = await post(channel, '/datasheets', body, {
    user,
    credentials: channel.credentials,
    timeoutMs: 5 * 60 * 1000,
  })
  if (res.status === 404 || res.status === 405) {
    throw new Error(`${channel.name} 채널은 데이터시트 DB 저장을 지원하지 않습니다. 채널 서버를 갱신해주세요.`)
  }
  if (payload && payload.ok === false) throw new Error(String(payload.error || 'DB에 저장하지 못했습니다.'))
  if (!res.ok) throw new Error(`DB에 저장하지 못했습니다. (HTTP ${res.status})`)
  return payload && 'data' in payload ? payload.data : payload
}

async function deleteFile(channel, itemId, user) {
  const id = String(itemId || '').trim()
  if (!id) throw new Error('삭제할 항목이 없습니다.')
  return filesRequest(channel, `/files/${encodeURIComponent(id)}`, { user, method: 'DELETE' })
}

module.exports = {
  SPEC,
  DEFAULT_AUTH_HEADER,
  CREDENTIALS_HEADER,
  normalizeBase,
  validateManifest,
  uiBlocks,
  fetchManifest,
  callTool,
  fetchSkill,
  verifyCredentials,
  listFiles,
  uploadFile,
  deleteFile,
  downloadStoredFile,
  saveDatasheet,
  projectRequest,
}
