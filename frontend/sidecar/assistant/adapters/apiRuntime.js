// API 키 어댑터 공통. 대화 기록은 이 PC에 두고, 툴은 로컬 MCP와 같은 핸들러를 바로 부른다.

const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const config = require('../../config')
const { openLocalClient } = require('../../mcp/server')
const { toolLabel } = require('../toolLabels')
const apiKeys = require('../apiKeys')

const MAX_ROUNDS = 8
const MAX_TOOL_TEXT = 100_000
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null }
}

function addUsage(total, next) {
  if (!next) return total
  total.inputTokens += next.inputTokens || 0
  total.outputTokens += next.outputTokens || 0
  total.cachedInputTokens += next.cachedInputTokens || 0
  return total
}

function sessionFile(adapterId, sessionId) {
  const safeId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '')
  const safeAdapter = String(adapterId || '').replace(/[^a-zA-Z0-9_-]/g, '')
  return path.join(config.dataDir(), 'api-sessions', safeAdapter, `${safeId}.json`)
}

function loadSession(adapterId, sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile(adapterId, sessionId), 'utf8'))
    return Array.isArray(parsed.messages) ? parsed.messages : null
  } catch {
    return null
  }
}

function saveSession(adapterId, sessionId, messages) {
  const file = sessionFile(adapterId, sessionId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ messages }), 'utf8')
}

function readImage(filePath) {
  const resolved = path.resolve(String(filePath || ''))
  const stat = fs.statSync(resolved)
  if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) {
    throw new Error('이미지를 모델에 넣을 수 없습니다.')
  }
  const mime = IMAGE_MIME[path.extname(resolved).toLowerCase()] || 'image/png'
  return { mime, data: fs.readFileSync(resolved).toString('base64') }
}

function jsonSchema(tool) {
  const raw = tool?.inputSchema && typeof tool.inputSchema === 'object'
    ? { ...tool.inputSchema }
    : { type: 'object', properties: {} }
  delete raw.$schema
  if (!raw.type) raw.type = 'object'
  return raw
}

async function apiError(res) {
  let message = ''
  try {
    const body = await res.json()
    message = body?.error?.message || body?.error?.type || ''
  } catch {
    message = ''
  }
  if (res.status === 401) return 'API 키가 올바르지 않습니다.'
  if (res.status === 429) return 'API 사용 한도에 도달했습니다. 잠시 후 다시 시도해주세요.'
  return message || `API 요청이 실패했습니다 (${res.status}).`
}

async function readSse(res, onEvent) {
  const reader = res.body?.getReader?.()
  if (!reader) throw new Error('API 응답을 읽을 수 없습니다.')
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        onEvent(JSON.parse(data))
      } catch {
        // 깨진 이벤트 한 줄은 건너뛴다.
      }
    }
  }
}

function toolOutput(result) {
  const parts = Array.isArray(result?.content) ? result.content : []
  let text = parts.map((part) => part?.text || '').join('\n').trim() || '(결과 없음)'
  if (text.length > MAX_TOOL_TEXT) text = `${text.slice(0, MAX_TOOL_TEXT)}\n…(이하 생략)`
  return { text, isError: Boolean(result?.isError) }
}

function rankModels(models, tests) {
  const ranked = []
  for (const test of tests) {
    const hit = models.find((item) => test.test(item.id) && !ranked.includes(item))
    if (hit) ranked.push(hit)
  }
  for (const item of models) {
    if (!ranked.includes(item)) ranked.push(item)
  }
  return ranked
}

async function probeKey(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(await apiError(res))
  return res.json()
}

async function detectKey(adapterId, probe) {
  const key = apiKeys.get(adapterId)
  if (!key) {
    return {
      installed: false,
      loggedIn: false,
      path: null,
      version: null,
      source: 'api',
      account: null,
      message: 'API 키를 입력해주세요.',
    }
  }
  try {
    await probe(key)
    return {
      installed: true,
      loggedIn: true,
      path: null,
      version: null,
      source: 'api',
      account: 'API 키',
      message: 'API 키 확인 완료',
    }
  } catch (err) {
    return {
      installed: true,
      loggedIn: false,
      path: null,
      version: null,
      source: 'api',
      account: null,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

// messages에 userMessage를 붙인 뒤, 툴 호출이 끝날 때까지 turn을 반복한다.
function runChat({
  adapterId,
  model,
  sessionId,
  isResume,
  userMessage,
  onEvent,
  providerTools,
  turn,
  toolMessages,
}) {
  const controller = new AbortController()
  let cancelled = false

  const done = (async () => {
    let messages = []
    if (isResume) {
      messages = loadSession(adapterId, sessionId)
      if (!messages) throw new Error('session not found')
    }
    messages = [...messages, userMessage]
    onEvent({
      type: 'session',
      sessionId,
      mcpConnected: true,
      mcpStatus: 'connected',
      model,
    })

    const mcp = await openLocalClient()
    const usage = emptyUsage()
    let finalText = ''
    try {
      const tools = providerTools(await mcp.tools())
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        if (cancelled || controller.signal.aborted) break
        const result = await turn({ messages, tools, signal: controller.signal, onEvent })
        addUsage(usage, result.usage)
        messages = [...messages, result.assistantMessage]
        if (result.text) finalText = finalText ? `${finalText}\n${result.text}` : result.text
        if (result.stop !== 'tool' || !result.toolUses?.length) break

        const outputs = []
        for (const call of result.toolUses) {
          if (cancelled || controller.signal.aborted) break
          const { short, label } = toolLabel(call.name)
          onEvent({ type: 'tool-start', id: call.id, tool: short, label })
          let output
          try {
            output = toolOutput(await mcp.call(call.name, call.input))
          } catch (err) {
            output = { text: err instanceof Error ? err.message : String(err), isError: true }
          }
          onEvent({
            type: 'tool-end',
            id: call.id,
            isError: output.isError,
            preview: output.text.slice(0, 300),
          })
          outputs.push({ call, output })
        }
        if (!outputs.length) break
        messages = [...messages, ...toolMessages(outputs)]
      }
      if (!cancelled) saveSession(adapterId, sessionId, messages)
      return { cancelled, sessionId, text: finalText, usage }
    } finally {
      await mcp.close()
    }
  })().catch((err) => {
    if (cancelled || err?.name === 'AbortError') {
      return { cancelled: true, sessionId, text: '', usage: emptyUsage() }
    }
    throw err
  })

  return {
    done,
    cancel: () => {
      cancelled = true
      controller.abort()
    },
  }
}

function accountLabel(detected) {
  return detected?.loggedIn ? 'API 키' : null
}

module.exports = {
  emptyUsage,
  readImage,
  jsonSchema,
  apiError,
  readSse,
  rankModels,
  probeKey,
  detectKey,
  runChat,
  accountLabel,
  getKey: (id) => apiKeys.get(id),
  newSessionId: () => randomUUID(),
}
