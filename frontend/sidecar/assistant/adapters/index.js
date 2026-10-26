const claude = require('./claude')
const codex = require('./codex')
const anthropicApi = require('./anthropicApi')
const openaiApi = require('./openaiApi')

const adapters = [claude, codex, anthropicApi, openaiApi]
const byId = new Map(adapters.map((a) => [a.id, a]))

function listAdapters() {
  return adapters.map((a) => ({
    id: a.id,
    kind: a.kind || 'cli',
    label: a.label,
    installHint: a.installHint,
    loginHint: a.loginHint,
    canInstall: (a.installSteps ?? []).length > 0,
    canLogin: Boolean(a.loginCommand),
    models: a.models ?? [],
    defaultModel: a.defaultModel ?? null,
  }))
}

function getAdapter(id) {
  const adapter = byId.get(id || 'claude')
  if (!adapter) throw new Error(`지원하지 않는 연결입니다: ${id}`)
  return adapter
}

module.exports = { listAdapters, getAdapter, DEFAULT_ADAPTER_ID: 'claude' }
