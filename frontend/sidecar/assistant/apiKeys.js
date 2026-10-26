// 모델 API 키. assistant-config.json에만 두고, 상태 응답에는 끝 4자리만 보낸다.

const config = require('../config')

function readAll() {
  const raw = config.read().apiKeys
  return raw && typeof raw === 'object' ? raw : {}
}

function get(adapterId) {
  const key = String(readAll()[adapterId] || '').trim()
  return key || null
}

function hint(adapterId) {
  const key = get(adapterId)
  if (!key) return null
  return key.slice(-4)
}

function save(adapterId, apiKey) {
  const next = { ...readAll() }
  const key = String(apiKey || '').trim()
  if (key) next[adapterId] = key
  else delete next[adapterId]
  config.write({ apiKeys: next })
  return { hasApiKey: Boolean(key), keyHint: key ? key.slice(-4) : null }
}

module.exports = { get, hint, save }
