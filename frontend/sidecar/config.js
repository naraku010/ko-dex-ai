const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  adapterId: 'claude',
  manualPath: null,
  connected: false,
  model: null,
  modelsByAdapter: {},
  apiKeys: {},
}

function dataDir() {
  return process.env.SIDECAR_DATA_DIR || path.join(__dirname, '.data')
}

function ensureDir() {
  fs.mkdirSync(dataDir(), { recursive: true })
}

function configPath() {
  return path.join(dataDir(), 'assistant-config.json')
}

function workDir() {
  const dir = path.join(dataDir(), 'assistant')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function read() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

function write(patch) {
  ensureDir()
  const next = { ...read(), ...patch }
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

module.exports = { dataDir, ensureDir, read, write, workDir, DEFAULTS }
