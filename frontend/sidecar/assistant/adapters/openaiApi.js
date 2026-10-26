// OpenAI Chat Completions API. CLI 없이 API 키로 같은 MCP 툴을 쓴다.

const { buildSystemPrompt } = require('../prompt')
const { koreanHint, isCurrentModel } = require('../modelHints')
const runtime = require('./apiRuntime')

const ID = 'openai-api'
const MODELS_URL = 'https://api.openai.com/v1/models'
const CHAT_URL = 'https://api.openai.com/v1/chat/completions'

const MODELS = [
  { id: 'gpt-5.6', label: 'GPT-5.6', hint: '복잡한 코딩·분석에 강함' },
  { id: 'gpt-5', label: 'GPT-5', hint: '성능과 비용의 균형 · 일상 작업에 권장' },
]
const DEFAULT_MODEL = MODELS[0].id
const RANK = [/gpt-5\.6/i, /gpt-5(?!\.)/i, /gpt-/i]

function headers(apiKey) {
  return { authorization: `Bearer ${apiKey}` }
}

function chatModel(id) {
  const key = String(id || '').toLowerCase()
  if (!key || /embed|whisper|tts|dall-e|moderation|realtime|audio|transcribe|image/.test(key)) return false
  return /^(gpt-|o\d|chatgpt)/.test(key) && isCurrentModel(key)
}

function resolveModel(model) {
  const id = String(model || '').trim()
  return id && id !== 'default' ? id : DEFAULT_MODEL
}

async function fetchModels(apiKey) {
  const data = await runtime.probeKey(MODELS_URL, headers(apiKey))
  const items = (Array.isArray(data?.data) ? data.data : [])
    .map((item) => String(item?.id || '').trim())
    .filter(chatModel)
    .map((id) => ({ id, label: id, hint: koreanHint(id, '') }))
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
      type: 'image_url',
      image_url: { url: `data:${file.mime};base64,${file.data}` },
    })),
    { type: 'text', text: prompt },
  ]
}

function providerTools(tools) {
  return (tools || []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || tool.name,
      parameters: runtime.jsonSchema(tool),
    },
  }))
}

async function streamTurn({ apiKey, model, system, messages, tools, signal, onEvent }) {
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { ...headers(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      ...(tools.length ? { tools } : {}),
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  })
  if (!res.ok) throw new Error(await runtime.apiError(res))

  let text = ''
  const calls = []
  let finish = null
  const usage = runtime.emptyUsage()
  let textStarted = false

  await runtime.readSse(res, (evt) => {
    if (evt.usage) {
      usage.inputTokens += evt.usage.prompt_tokens || 0
      usage.outputTokens += evt.usage.completion_tokens || 0
      usage.cachedInputTokens += evt.usage.prompt_tokens_details?.cached_tokens || 0
    }
    const choice = evt.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finish = choice.finish_reason
    const delta = choice.delta || {}
    if (delta.content) {
      if (!textStarted) {
        textStarted = true
        onEvent({ type: 'text-start' })
      }
      text += delta.content
      onEvent({ type: 'text-delta', text: delta.content })
    }
    for (const call of delta.tool_calls || []) {
      const index = call.index ?? 0
      if (!calls[index]) calls[index] = { id: '', name: '', arguments: '' }
      if (call.id) calls[index].id = call.id
      if (call.function?.name) calls[index].name += call.function.name
      if (call.function?.arguments) calls[index].arguments += call.function.arguments
    }
  })

  const toolUses = calls.filter(Boolean).map((call) => {
    let input = {}
    try {
      input = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      input = {}
    }
    return { id: call.id || `call-${call.name}`, name: call.name, input, arguments: call.arguments || '{}' }
  })
  return {
    assistantMessage: {
      role: 'assistant',
      content: text || null,
      ...(toolUses.length
        ? {
            tool_calls: toolUses.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    },
    toolUses,
    stop: (finish === 'tool_calls' || toolUses.length) && toolUses.length ? 'tool' : 'end',
    text,
    usage,
  }
}

function send({ prompt, sessionId, isResume, model, user, onEvent, images }) {
  const apiKey = runtime.getKey(ID)
  if (!apiKey) throw new Error('OpenAI API 키가 없습니다. 설정에서 입력해주세요.')
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
    toolMessages: (outputs) => outputs.map(({ call, output }) => ({
      role: 'tool',
      tool_call_id: call.id,
      content: output.text,
    })),
  })
}

async function complete({ prompt, model, images, signal }) {
  const apiKey = runtime.getKey(ID)
  if (!apiKey) throw new Error('OpenAI API 키가 없습니다. 설정에서 입력해주세요.')
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { ...headers(apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({
      model: resolveModel(model),
      messages: [{ role: 'user', content: userContent(prompt, images) }],
    }),
    signal,
  })
  if (!res.ok) throw new Error(await runtime.apiError(res))
  const data = await res.json()
  return String(data.choices?.[0]?.message?.content || '').trim()
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
  label: 'OpenAI API',
  installHint: '',
  loginHint: 'platform.openai.com에서 발급한 API 키를 입력하세요.',
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
