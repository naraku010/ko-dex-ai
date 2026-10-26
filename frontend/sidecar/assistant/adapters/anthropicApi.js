// Anthropic Messages API. CLI 없이 API 키로 같은 MCP 툴을 쓴다.

const { buildSystemPrompt } = require('../prompt')
const { koreanHint } = require('../modelHints')
const runtime = require('./apiRuntime')

const ID = 'claude-api'
const MODELS_URL = 'https://api.anthropic.com/v1/models'
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const VERSION = '2023-06-01'

const MODELS = [
  { id: 'claude-sonnet-4-5', label: 'Sonnet', hint: '속도와 정확도의 균형 · 일상 작업에 권장' },
  { id: 'claude-opus-4-1', label: 'Opus', hint: '가장 정확 · 느리지만 어려운 질문에 강함' },
  { id: 'claude-haiku-4-5', label: 'Haiku', hint: '빠르고 경제적 · 짧은 조회에 적합' },
]
const DEFAULT_MODEL = MODELS[0].id
const RANK = [/sonnet/i, /opus/i, /haiku/i]

function headers(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': VERSION,
  }
}

function resolveModel(model) {
  const id = String(model || '').trim()
  if (!id || id === 'sonnet') return DEFAULT_MODEL
  if (id === 'opus') return 'claude-opus-4-1'
  if (id === 'haiku') return 'claude-haiku-4-5'
  return id
}

async function fetchModels(apiKey) {
  const data = await runtime.probeKey(MODELS_URL, headers(apiKey))
  const items = (Array.isArray(data?.data) ? data.data : [])
    .map((item) => {
      const id = String(item?.id || '').trim()
      if (!id) return null
      return {
        id,
        label: String(item.display_name || id),
        hint: koreanHint(id, ''),
      }
    })
    .filter(Boolean)
  return runtime.rankModels(items, RANK)
}

async function listModels() {
  const key = runtime.getKey(ID)
  if (!key) return MODELS
  try {
    const items = await fetchModels(key)
    return items.length ? items : MODELS
  } catch {
    return MODELS
  }
}

function detect() {
  return runtime.detectKey(ID, (key) => runtime.probeKey(MODELS_URL, headers(key)))
}

function userContent(prompt, images) {
  const files = (images || []).map((file) => runtime.readImage(file))
  if (!files.length) return prompt
  return [
    ...files.map((file) => ({
      type: 'image',
      source: { type: 'base64', media_type: file.mime, data: file.data },
    })),
    { type: 'text', text: prompt },
  ]
}

function providerTools(tools) {
  return (tools || []).map((tool) => ({
    name: tool.name,
    description: tool.description || tool.name,
    input_schema: runtime.jsonSchema(tool),
  }))
}

async function streamTurn({ apiKey, model, system, messages, tools, signal, onEvent }) {
  const res = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: { ...headers(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system,
      messages,
      ...(tools.length ? { tools } : {}),
      stream: true,
    }),
    signal,
  })
  if (!res.ok) throw new Error(await runtime.apiError(res))

  const blocks = []
  let stop = 'end_turn'
  const usage = runtime.emptyUsage()
  let textStarted = false

  await runtime.readSse(res, (evt) => {
    if (evt.type === 'message_start') {
      const used = evt.message?.usage || {}
      usage.inputTokens += used.input_tokens || 0
      usage.cachedInputTokens += (used.cache_read_input_tokens || 0) + (used.cache_creation_input_tokens || 0)
    } else if (evt.type === 'content_block_start') {
      const block = evt.content_block || {}
      blocks[evt.index] = block.type === 'tool_use'
        ? { type: 'tool_use', id: block.id, name: block.name, inputJson: '' }
        : { type: 'text', text: block.text || '' }
    } else if (evt.type === 'content_block_delta') {
      const block = blocks[evt.index]
      if (!block) return
      if (evt.delta?.type === 'text_delta') {
        const chunk = evt.delta.text || ''
        block.text += chunk
        if (chunk && !textStarted) {
          textStarted = true
          onEvent({ type: 'text-start' })
        }
        if (chunk) onEvent({ type: 'text-delta', text: chunk })
      } else if (evt.delta?.type === 'input_json_delta') {
        block.inputJson += evt.delta.partial_json || ''
      }
    } else if (evt.type === 'message_delta') {
      if (evt.delta?.stop_reason) stop = evt.delta.stop_reason
      usage.outputTokens += evt.usage?.output_tokens || 0
    }
  })

  const content = blocks.filter(Boolean).flatMap((block) => {
    if (block.type !== 'tool_use') {
      return block.text ? [{ type: 'text', text: block.text }] : []
    }
    let input = {}
    try {
      input = block.inputJson ? JSON.parse(block.inputJson) : {}
    } catch {
      input = {}
    }
    return [{ type: 'tool_use', id: block.id, name: block.name, input }]
  })
  const toolUses = content.filter((block) => block.type === 'tool_use')
  return {
    assistantMessage: { role: 'assistant', content },
    toolUses,
    stop: stop === 'tool_use' && toolUses.length ? 'tool' : 'end',
    text: content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
    usage,
  }
}

function send({ prompt, sessionId, isResume, model, user, onEvent, images }) {
  const apiKey = runtime.getKey(ID)
  if (!apiKey) throw new Error('Claude API 키가 없습니다. 설정에서 입력해주세요.')
  const resolved = resolveModel(model)
  return runtime.runChat({
    adapterId: ID,
    model: resolved,
    sessionId,
    isResume,
    userMessage: { role: 'user', content: userContent(prompt, images) },
    onEvent,
    providerTools,
    turn: ({ messages, tools, signal }) => streamTurn({
      apiKey,
      model: resolved,
      system: buildSystemPrompt(user),
      messages,
      tools,
      signal,
      onEvent,
    }),
    toolMessages: (outputs) => [{
      role: 'user',
      content: outputs.map(({ call, output }) => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: output.text,
        is_error: output.isError,
      })),
    }],
  })
}

async function complete({ prompt, model, images, signal }) {
  const apiKey = runtime.getKey(ID)
  if (!apiKey) throw new Error('Claude API 키가 없습니다. 설정에서 입력해주세요.')
  const res = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: { ...headers(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({
      model: resolveModel(model),
      max_tokens: 4096,
      messages: [{ role: 'user', content: userContent(prompt, images) }],
    }),
    signal,
  })
  if (!res.ok) throw new Error(await runtime.apiError(res))
  const data = await res.json()
  return (data.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('').trim()
}

function promptOnce(options) {
  return complete(options)
}

function readOnce(options) {
  return complete(options)
}

module.exports = {
  id: ID,
  kind: 'api',
  label: 'Claude API',
  installHint: '',
  loginHint: 'console.anthropic.com에서 발급한 API 키를 입력하세요.',
  models: MODELS,
  defaultModel: DEFAULT_MODEL,
  resolveModel,
  detect,
  listModels,
  send,
  promptOnce,
  readOnce,
  accountLabel: runtime.accountLabel,
  newSessionId: runtime.newSessionId,
}
