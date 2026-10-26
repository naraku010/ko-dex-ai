// 추가된 채널과 API 키를 파일에 보관한다. 채널은 전부 URL로 추가되고, 내장 채널은 없다.

const fs = require('fs')
const path = require('path')
const config = require('../config')
const { DEFAULT_AUTH_HEADER } = require('./client')

function filePath() {
  return path.join(config.dataDir(), 'channels.json')
}

function readFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'))
    return {
      activeId: typeof raw?.activeId === 'string' ? raw.activeId : '',
      channels: Array.isArray(raw?.channels) ? raw.channels : [],
    }
  } catch {
    return { activeId: '', channels: [] }
  }
}

function writeFile(next) {
  config.ensureDir()
  fs.writeFileSync(filePath(), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  return next
}

function toChannel(entry) {
  const manifest = entry?.manifest ?? {}
  const name = manifest.name || entry?.id || '채널'
  return {
    id: String(manifest.id || entry?.id || ''),
    name,
    short: manifest.short || name.slice(0, 2),
    description: manifest.description ?? '',
    version: manifest.version ?? null,
    type: manifest.type === 'files' || manifest.id === 'files' || manifest.icon === 'files' ? 'files' : 'data',
    icon: manifest.icon || 'cog',
    url: entry?.url ?? null,
    apiKey: entry?.apiKey ?? null,
    authHeader: manifest.auth?.header || DEFAULT_AUTH_HEADER,
    systemPrompt: manifest.systemPrompt ?? '',
    tools: Array.isArray(manifest.tools) ? manifest.tools : [],
    skills: Array.isArray(manifest.skills) ? manifest.skills : [],
    credentialFields: Array.isArray(manifest.credentials) ? manifest.credentials : [],
    credentials: entry?.credentials && typeof entry.credentials === 'object' ? entry.credentials : {},
    addedAt: entry?.addedAt ?? null,
    refreshedAt: entry?.refreshedAt ?? null,
  }
}

function missingCredentialKeys(channel) {
  return (channel.credentialFields ?? [])
    .filter((field) => field.required !== false && !String(channel.credentials?.[field.key] ?? '').trim())
    .map((field) => field.key)
}

// API 키와 계정 값은 빼고 렌더러로 보낸다. 어떤 항목이 필요한지와 채웠는지만 알려준다.
function publicTools(tools) {
  return (tools ?? []).map((tool) => {
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {}
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    return {
      name: tool.name,
      label: tool.label || tool.name,
      description: String(tool.description || ''),
      params: Object.entries(props).map(([name, spec]) => ({
        name,
        type: String(spec?.type || 'string'),
        description: String(spec?.description || '').slice(0, 240),
        required: required.has(name),
        ...(Array.isArray(spec?.enum) ? { enum: spec.enum.slice(0, 20).map(String) } : {}),
      })),
    }
  })
}

function toPublic(channel) {
  const missing = missingCredentialKeys(channel)
  const tools = publicTools(channel.tools)
  return {
    id: channel.id,
    name: channel.name,
    short: channel.short,
    description: channel.description,
    version: channel.version,
    type: channel.type === 'files' || channel.id === 'files' || channel.icon === 'files' ? 'files' : 'data',
    icon: channel.icon || 'cog',
    url: channel.url,
    toolCount: tools.length,
    toolLabels: tools.map((tool) => tool.label || tool.name),
    tools,
    skills: (channel.skills ?? []).map((skill) => ({ name: skill.name, description: skill.description })),
    hasApiKey: Boolean(channel.apiKey),
    credentialFields: channel.credentialFields ?? [],
    filledCredentialKeys: Object.keys(channel.credentials ?? {}).filter(
      (key) => String(channel.credentials[key] ?? '').trim() !== '',
    ),
    missingCredentialKeys: missing,
    credentialsReady: missing.length === 0,
    addedAt: channel.addedAt,
    refreshedAt: channel.refreshedAt,
  }
}

function list() {
  return readFile().channels.map(toChannel).filter((channel) => channel.id)
}

function publicList() {
  return list().map(toPublic)
}

function get(id) {
  const wanted = String(id || '')
  if (!wanted) return null
  return list().find((channel) => channel.id === wanted) ?? null
}

// 저장된 활성 채널이 사라졌으면 남은 첫 채널로, 하나도 없으면 빈 문자열.
function activeId() {
  const file = readFile()
  if (get(file.activeId)) return file.activeId
  const first = list()[0]
  return first ? first.id : ''
}

function getActive() {
  return get(activeId())
}

function setActive(id) {
  const channel = get(id)
  if (!channel) throw new Error('없는 채널입니다. 목록을 새로고침해주세요.')
  const file = readFile()
  writeFile({ ...file, activeId: channel.id })
  return channel
}

// 같은 id면 URL·키·manifest를 갈아끼운다. 계정 정보는 넘겨준 값이 없으면 그대로 둔다.
function upsert({ id, url, apiKey, manifest, credentials }) {
  const file = readFile()
  const now = new Date().toISOString()
  const index = file.channels.findIndex((entry) => (entry?.manifest?.id || entry?.id) === id)
  const previous = index >= 0 ? file.channels[index] : null

  const entry = {
    id,
    url,
    apiKey: apiKey ?? previous?.apiKey ?? null,
    credentials: credentials ?? previous?.credentials ?? {},
    manifest,
    addedAt: previous?.addedAt ?? now,
    refreshedAt: now,
  }

  const channels = [...file.channels]
  if (index >= 0) channels[index] = entry
  else channels.push(entry)

  writeFile({ ...file, channels })
  return { channel: toChannel(entry), replaced: index >= 0 }
}

function manifestOf(id) {
  const entry = readFile().channels.find((item) => (item?.manifest?.id || item?.id) === id)
  return entry?.manifest ?? null
}

// manifest가 그대로일 때 확인 시각만 갱신한다.
function touch(id) {
  const file = readFile()
  const index = file.channels.findIndex((entry) => (entry?.manifest?.id || entry?.id) === id)
  if (index < 0) return null
  const channels = [...file.channels]
  channels[index] = { ...channels[index], refreshedAt: new Date().toISOString() }
  writeFile({ ...file, channels })
  return toChannel(channels[index])
}

// 사용자가 입력한 계정 정보를 저장한다. 빈 값은 지운다.
function saveCredentials(id, values) {
  const file = readFile()
  const index = file.channels.findIndex((entry) => (entry?.manifest?.id || entry?.id) === id)
  if (index < 0) throw new Error('없는 채널입니다.')

  const fields = file.channels[index]?.manifest?.credentials ?? []
  const allowed = new Set(fields.map((field) => field.key))
  const next = {}
  for (const [key, value] of Object.entries(values || {})) {
    if (!allowed.has(key)) continue
    const text = String(value ?? '').trim()
    if (text) next[key] = text
  }

  const channels = [...file.channels]
  channels[index] = { ...channels[index], credentials: next }
  writeFile({ ...file, channels })
  return toChannel(channels[index])
}

function remove(id) {
  const file = readFile()
  const channels = file.channels.filter((entry) => (entry?.manifest?.id || entry?.id) !== id)
  if (channels.length === file.channels.length) throw new Error('없는 채널입니다.')
  const fallback = file.activeId === id ? (channels[0]?.manifest?.id ?? channels[0]?.id ?? '') : file.activeId
  writeFile({ activeId: fallback, channels })
  return { removed: id, activeId: fallback }
}

module.exports = {
  list,
  publicList,
  toPublic,
  get,
  activeId,
  getActive,
  setActive,
  upsert,
  manifestOf,
  touch,
  saveCredentials,
  missingCredentialKeys,
  remove,
}
