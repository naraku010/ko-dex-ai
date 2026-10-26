// Node 사이드카 — stdin JSON 명령, stdout JSON 응답/이벤트.
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const readline = require('readline')
const auth = require('./auth')

const OPEN_EXT = new Set(['xlsx', 'xls', 'pdf', 'csv', 'txt', 'docx', 'png', 'jpg', 'jpeg'])

function existingFile(payload) {
  const raw = String(payload?.path || '').trim().replace(/^["'`]+|["'`]+$/g, '')
  if (!raw || raw.length > 500) throw new Error('파일 경로가 올바르지 않습니다.')
  const resolved = path.resolve(raw)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error('파일을 찾지 못했습니다.')
  }
  return resolved
}

function revealFile(payload) {
  const resolved = existingFile(payload)
  const child = spawn('explorer.exe', [`/select,${resolved}`], { windowsHide: true, detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
  return { ok: true }
}

async function openFile(payload) {
  const resolved = existingFile(payload)
  const ext = path.extname(resolved).slice(1).toLowerCase()
  if (!OPEN_EXT.has(ext)) throw new Error('이 형식은 열 수 없습니다.')
  const literal = `'${resolved.replace(/'/g, "''")}'`
  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath ${literal}`],
      { windowsHide: true },
    )
    let text = ''
    child.stdout.on('data', (chunk) => { text += chunk })
    child.stderr.on('data', (chunk) => { text += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(text)
      else reject(new Error(text.trim() || '파일을 열지 못했습니다.'))
    })
  })
  return { ok: true, output: String(output || '').trim() }
}

try {
  process.stdout._handle?.setBlocking?.(true)
} catch {
  // ignore
}

function writeLine(obj) {
  fs.writeSync(1, `${JSON.stringify(obj)}\n`)
}

function reply(id, result) {
  writeLine({ id, ok: true, result })
}

function fail(id, error) {
  writeLine({ id, ok: false, error: String(error) })
}

function emit(payload) {
  writeLine({ event: true, payload })
}

let host = null
function getHost() {
  if (!host) {
    host = require('./assistant/host')
    host.setEmitter(emit)
  }
  return host
}

const handlers = {
  session: () => auth.session(),
  login: (p) => auth.login(p.name, p.password),
  logout: () => auth.logout(),
  detect: (p) => getHost().detect(p),
  installCli: (p) => getHost().installCli(p),
  loginCli: (p) => getHost().loginCli(p),
  connect: (p) => getHost().connect(p),
  saveApiKey: (p) => getHost().saveApiKey(p),
  setAdapter: (p) => getHost().setAdapter(p),
  status: () => getHost().status(),
  setModel: (p) => getHost().setModel(p.model),
  listChannels: () => getHost().listChannels(),
  previewChannel: (p) => getHost().previewChannel(p),
  addChannel: (p) => getHost().addChannel(p),
  removeChannel: (p) => getHost().removeChannel(p),
  setChannel: (p) => getHost().setChannel(p),
  refreshChannel: (p) => getHost().refreshChannel(p),
  setChannelCredentials: (p) => getHost().setChannelCredentials(p),
  listChannelFiles: (p) => getHost().listChannelFiles(p),
  uploadChannelFile: (p) => getHost().uploadChannelFile(p),
  deleteChannelFile: (p) => getHost().deleteChannelFile(p),
  openChannelFile: (p) => getHost().openChannelFile(p),
  previewImage: (p) => getHost().previewImage(p),
  drawingPages: (p) => getHost().drawingPages(p),
  pickFolder: () => getHost().pickFolder(),
  listProjects: (p) => getHost().listProjects(p),
  createProject: (p) => getHost().createProject(p),
  projectDetail: (p) => getHost().projectDetail(p),
  renameProject: (p) => getHost().renameProject(p),
  setProjectDatasheet: (p) => getHost().setProjectDatasheet(p),
  setProjectOptions: (p) => getHost().setProjectOptions(p),
  removeProject: (p) => getHost().removeProject(p),
  listProjectTrash: (p) => getHost().listProjectTrash(p),
  restoreProject: (p) => getHost().restoreProject(p),
  indexProject: (p) => getHost().indexProject(p),
  exportProjectReport: (p) => getHost().exportProjectReport(p),
  saveProjectDatasheet: (p) => getHost().saveProjectDatasheet(p),
  syncProject: (p) => getHost().syncProject(p),
  uploadProjectFolder: (p) => getHost().uploadProjectFolder(p),
  deleteProjectFile: (p) => getHost().deleteProjectFile(p),
  addProjectFiles: (p) => getHost().addProjectFiles(p),
  migrateProject: (p) => getHost().migrateProject(p),
  cancelProjectIndex: () => getHost().cancelProjectIndex(),
  send: (p) => getHost().send(p),
  cancel: () => getHost().cancel(),
  suggestFollowups: (p) => getHost().suggestFollowups(p),
  newSession: (p) => getHost().newSession(p),
  setSession: (p) => getHost().setSession(p),
  getUsage: () => getHost().getUsage(),
  resetUsage: (p) => getHost().resetUsage(p),
  exportTable: (p) => getHost().exportTable(p),
  openFile: (p) => openFile(p),
  revealFile: (p) => revealFile(p),
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', async (line) => {
  const trimmed = String(line || '').trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  const { id, cmd, payload } = msg
  const handler = handlers[cmd]
  if (!handler) {
    fail(id, `알 수 없는 명령입니다: ${cmd}`)
    return
  }
  try {
    const result = await handler(payload || {})
    reply(id, result ?? null)
  } catch (err) {
    fail(id, err?.message || err)
  }
})

process.stderr.write('[sidecar] ready\n')
