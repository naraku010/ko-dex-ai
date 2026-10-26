// 채널 명령 구현. 목록·미리보기·추가·삭제·전환·새로고침·계정 정보 저장.

const auth = require('../auth')
const store = require('./store')
const client = require('./client')

function list() {
  return { activeId: store.activeId(), channels: store.publicList() }
}

// 저장하지 않고 URL만 검증해서 미리 보여준다. 계정 항목이 있으면 입력칸도 함께 알려준다.
async function preview({ url, apiKey } = {}) {
  const { url: base, manifest } = await client.fetchManifest(url, apiKey ? String(apiKey).trim() : null)
  return {
    url: base,
    replaces: Boolean(store.get(manifest.id)),
    channel: {
      id: manifest.id,
      name: manifest.name,
      short: manifest.short,
      description: manifest.description,
      version: manifest.version,
      type: manifest.type,
      icon: manifest.icon,
      toolCount: manifest.tools.length,
      requiresApiKey: manifest.auth.type === 'apiKey',
    },
    credentialFields: manifest.credentials,
    tools: manifest.tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description.slice(0, 120),
    })),
  }
}

// URL을 검증해서 채널로 등록한다. 같은 id가 이미 있으면 갈아끼운다.
async function add({ url, apiKey, credentials } = {}) {
  const key = apiKey ? String(apiKey).trim() : null
  const { url: base, manifest } = await client.fetchManifest(url, key)

  const values = pickCredentials(manifest.credentials, credentials)
  const missing = manifest.credentials
    .filter((field) => field.required !== false && !values[field.key])
    .map((field) => field.label)
  if (missing.length > 0) {
    throw new Error(`다음 항목을 입력해주세요: ${missing.join(', ')}`)
  }

  // 저장하기 전에 채널이 계정 정보를 받아들이는지 확인한다.
  if (manifest.credentials.length > 0) {
    await client.verifyCredentials(
      { url: base, name: manifest.name, apiKey: key, authHeader: manifest.auth.header },
      values,
      auth.getUser(),
    )
  }

  const { channel, replaced } = store.upsert({
    id: manifest.id,
    url: base,
    apiKey: key,
    credentials: manifest.credentials.length > 0 ? values : undefined,
    manifest,
  })
  return { channel: store.toPublic(channel), replaced }
}

async function refresh({ channelId } = {}) {
  const existing = store.get(channelId)
  if (!existing) throw new Error('없는 채널입니다.')

  const { url: base, manifest } = await client.fetchManifest(existing.url, existing.apiKey)
  if (manifest.id !== existing.id) {
    throw new Error(`채널 id가 바뀌었습니다 (${existing.id} → ${manifest.id}). 채널을 새로 추가해주세요.`)
  }
  const { channel } = store.upsert({ id: manifest.id, url: base, apiKey: existing.apiKey, manifest })
  return { channel: store.toPublic(channel), replaced: true }
}

const FRESH_MS = 60 * 1000
const FRESH_TIMEOUT_MS = 3 * 1000
const inflight = new Map()
const failedAt = new Map()

// 채널 서버가 갱신되면 툴·설명·시스템 프롬프트가 바뀐다. 질문 직전에 가볍게 다시 받아 둔다.
// 채널이 응답하지 않으면 저장된 manifest를 그대로 쓴다.
function ensureFresh(channelId, { force = false } = {}) {
  const id = String(channelId || '')
  if (inflight.has(id)) return inflight.get(id)

  const task = (async () => {
    const existing = store.get(id)
    if (!existing?.url) return { changed: false }
    const now = Date.now()
    const checked = Date.parse(existing.refreshedAt || '') || 0
    if (!force && (now - checked < FRESH_MS || now - (failedAt.get(id) || 0) < FRESH_MS)) {
      return { changed: false }
    }

    let manifest
    try {
      ;({ manifest } = await client.fetchManifest(existing.url, existing.apiKey, { timeoutMs: FRESH_TIMEOUT_MS }))
    } catch (err) {
      failedAt.set(id, now)
      process.stderr.write(`[channel] ${id} manifest 확인 실패: ${err?.message || err}\n`)
      return { changed: false }
    }
    failedAt.delete(id)
    if (manifest.id !== existing.id) return { changed: false }

    if (JSON.stringify(manifest) === JSON.stringify(store.manifestOf(id))) {
      store.touch(id)
      return { changed: false }
    }
    store.upsert({ id, url: existing.url, apiKey: existing.apiKey, manifest })
    return { changed: true }
  })().finally(() => inflight.delete(id))

  inflight.set(id, task)
  return task
}

// 채널이 요구한 항목만 남긴다.
function pickCredentials(fields, values) {
  const allowed = new Set((fields ?? []).map((field) => field.key))
  const out = {}
  for (const [key, value] of Object.entries(values || {})) {
    if (!allowed.has(key)) continue
    const text = String(value ?? '').trim()
    if (text) out[key] = text
  }
  return out
}

async function setCredentials({ channelId, credentials } = {}) {
  const channel = store.get(channelId)
  if (!channel) throw new Error('없는 채널입니다.')

  const values = pickCredentials(channel.credentialFields, credentials)
  const missing = (channel.credentialFields ?? [])
    .filter((field) => field.required !== false && !values[field.key])
    .map((field) => field.label)
  if (missing.length > 0) throw new Error(`다음 항목을 입력해주세요: ${missing.join(', ')}`)

  const verified = await client.verifyCredentials(channel, values, auth.getUser())
  const saved = store.saveCredentials(channel.id, values)
  return { channel: store.toPublic(saved), detail: verified.detail }
}

function remove({ channelId } = {}) {
  return store.remove(String(channelId || ''))
}

function setActive({ channelId } = {}) {
  return store.toPublic(store.setActive(channelId))
}

async function listFiles({ channelId } = {}) {
  const channel = store.get(channelId)
  if (!channel) throw new Error('없는 채널입니다.')
  return client.listFiles(channel, auth.getUser())
}

async function uploadFile({ channelId, filename, bytesBase64 } = {}) {
  const channel = store.get(channelId)
  if (!channel) throw new Error('없는 채널입니다.')
  return client.uploadFile(channel, { filename, bytesBase64 }, auth.getUser())
}

async function deleteFile({ channelId, itemId } = {}) {
  const channel = store.get(channelId)
  if (!channel) throw new Error('없는 채널입니다.')
  return client.deleteFile(channel, itemId, auth.getUser())
}

async function openFile({ channelId, itemId, filename } = {}) {
  const channel = store.get(channelId)
  if (!channel) throw new Error('없는 채널입니다.')
  return client.downloadStoredFile(channel, { itemId, filename }, auth.getUser())
}

module.exports = { list, preview, add, refresh, ensureFresh, remove, setActive, setCredentials, listFiles, uploadFile, deleteFile, openFile, store, client }
