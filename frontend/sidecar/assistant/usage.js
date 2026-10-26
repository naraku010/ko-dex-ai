// 어댑터(CLI 계정)별 앱 누적 사용량. 대화 턴이 끝날 때마다 토큰/비용을 더한다.
// dataDir()/usage.json 에 저장한다.

const fs = require('fs')
const path = require('path')
const config = require('../config')

function usagePath() {
  return path.join(config.dataDir(), 'usage.json')
}

function emptyEntry() {
  return {
    account: null,
    messages: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    lastUsedAt: null,
  }
}

function read() {
  try {
    const raw = fs.readFileSync(usagePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function write(data) {
  config.ensureDir()
  fs.writeFileSync(usagePath(), JSON.stringify(data, null, 2), 'utf8')
}

function num(value) {
  return Number.isFinite(value) ? value : 0
}

// 한 턴의 사용량을 누적한다.
function record(adapterId, { account, inputTokens, outputTokens, cachedInputTokens, costUsd } = {}) {
  if (!adapterId) return
  const data = read()
  const entry = { ...emptyEntry(), ...(data[adapterId] || {}) }
  entry.messages += 1
  entry.inputTokens += num(inputTokens)
  entry.outputTokens += num(outputTokens)
  entry.cachedInputTokens += num(cachedInputTokens)
  entry.costUsd += num(costUsd)
  entry.lastUsedAt = new Date().toISOString()
  if (account) entry.account = account
  data[adapterId] = entry
  write(data)
  return entry
}

function get(adapterId) {
  return { ...emptyEntry(), ...(read()[adapterId] || {}) }
}

function reset(adapterId) {
  const data = read()
  if (adapterId) {
    delete data[adapterId]
  } else {
    for (const key of Object.keys(data)) delete data[key]
  }
  write(data)
}

module.exports = { read, record, get, reset, emptyEntry }
