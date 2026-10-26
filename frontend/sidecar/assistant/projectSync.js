// 공유 프로젝트를 채널 서버와 맞춘다.
// 서버가 원본이고 이 PC에는 files/ 캐시와 색인 사본을 둔다. 대화는 각자 PC에만 남는다.
// 파일은 크기·수정 시각으로 비교하고, 받은 파일에 서버의 수정 시각을 다시 찍어 색인이 그대로 맞게 한다.

const fs = require('fs')
const path = require('path')
const { client } = require('../channels')
const projects = require('./projects')

const TRANSFER_CONCURRENCY = 4
const LOCK_HEARTBEAT_MS = 60 * 1000
const SUPPORT_TTL_MS = 60 * 1000
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

const support = new Map()

const enc = encodeURIComponent

function request(channel, user, pathname, options = {}) {
  return client.projectRequest(channel, pathname, { user, ...options })
}

async function supports(channel, user) {
  const cached = support.get(channel.id)
  if (cached && Date.now() - cached.at < SUPPORT_TTL_MS) return cached.ok
  let ok = true
  try {
    await request(channel, user, '/projects')
  } catch (err) {
    if (!err.unsupported) throw err
    ok = false
  }
  support.set(channel.id, { ok, at: Date.now() })
  return ok
}

async function pool(items, worker) {
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await worker(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(TRANSFER_CONCURRENCY, items.length) }, run))
}

// 서버 목록 → 이 PC. 지워진 프로젝트는 캐시도 지운다.
async function listShared(channel, user) {
  const remote = await request(channel, user, '/projects')
  for (const item of remote) projects.upsertShared(item, channel.id)
  projects.dropMissingShared(channel.id, remote.map((item) => item.id))
  return remote
}

function setMtime(file, mtime) {
  if (!mtime) return
  const at = new Date(mtime)
  fs.utimesSync(file, at, at)
}

// 서버 → 이 PC. 열 때마다 부른다. 색인 중인 프로젝트는 색인 사본을 덮지 않는다.
async function pull(channel, user, id, { onProgress = () => {}, keepIndex = false } = {}) {
  const detail = await request(channel, user, `/projects/${enc(id)}`)
  const project = projects.upsertShared(detail.project, channel.id)
  const folder = project.folder
  const local = new Map(projects.walk(folder).map((file) => [file.rel.toLowerCase(), file]))
  const wanted = new Set()
  const todo = []
  for (const remote of detail.files) {
    const rel = projects.toLocalRel(remote.rel)
    wanted.add(rel.toLowerCase())
    const have = local.get(rel.toLowerCase())
    if (!have || have.size !== remote.size || have.mtime !== remote.mtime) todo.push({ ...remote, rel })
  }
  let removed = 0
  for (const [key, file] of local) {
    if (wanted.has(key)) continue
    fs.rmSync(path.join(folder, file.rel), { force: true })
    removed += 1
  }
  let done = 0
  const locked = []
  const bytes = todo.reduce((sum, file) => sum + file.size, 0)
  onProgress({ done, total: todo.length, bytes })
  await pool(todo, async (file) => {
    const got = await request(channel, user, `/projects/${enc(id)}/files?rel=${enc(projects.toServerRel(file.rel))}`, {
      download: true,
      timeoutMs: 10 * 60 * 1000,
    })
    const dest = path.join(folder, file.rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const temp = `${dest}.part`
    fs.writeFileSync(temp, got.bytes)
    // Excel 등이 기존 파일을 열어 두면 이름 바꾸기가 거부된다. 그 파일만 남기고 나머지는 받는다.
    try {
      fs.renameSync(temp, dest)
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EBUSY') throw err
      fs.rmSync(temp, { force: true })
      locked.push(file.rel)
      done += 1
      onProgress({ done, total: todo.length, bytes, current: file.rel })
      return
    }
    setMtime(dest, got.mtime || file.mtime)
    done += 1
    onProgress({ done, total: todo.length, bytes, current: file.rel })
  })
  if (!keepIndex) {
    projects.replaceIndex(id, await request(channel, user, `/projects/${enc(id)}/index`))
    projects.writeScope(id, await request(channel, user, `/projects/${enc(id)}/state/scope`))
  }
  return { downloaded: todo.length - locked.length, locked, removed, files: detail.files.length, lock: detail.project.lock }
}

async function uploadOne(channel, user, id, folder, file) {
  const full = path.join(folder, file.rel)
  const data = fs.readFileSync(full)
  if (data.length > MAX_UPLOAD_BYTES) throw new Error(`'${file.rel}' 은 50MB를 넘어 올릴 수 없습니다.`)
  await request(channel, user, `/projects/${enc(id)}/files?rel=${enc(projects.toServerRel(file.rel))}&mtime=${file.mtime}`, {
    method: 'PUT',
    bytes: data,
    timeoutMs: 10 * 60 * 1000,
  })
  const cache = projects.cacheDir(id)
  if (path.resolve(folder) !== path.resolve(cache)) {
    const dest = path.join(cache, file.rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(full, dest)
    setMtime(dest, file.mtime)
  }
}

// PC 폴더 → 서버. 새로 생기거나 크기·수정 시각이 다른 파일만 올린다. 서버에만 있는 파일은 지우지 않는다.
async function uploadFolder(channel, user, id, folder, { onProgress = () => {} } = {}) {
  const detail = await request(channel, user, `/projects/${enc(id)}`)
  const remote = new Map(detail.files.map((file) => [projects.toLocalRel(file.rel).toLowerCase(), file]))
  const files = projects.walk(folder).slice(0, 500)
  const todo = files.filter((file) => {
    const have = remote.get(file.rel.toLowerCase())
    return !have || have.size !== file.size || have.mtime !== file.mtime
  })
  const failed = []
  let done = 0
  onProgress({ done, total: todo.length })
  await pool(todo, async (file) => {
    try {
      await uploadOne(channel, user, id, folder, file)
    } catch (err) {
      failed.push(`${file.rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
    done += 1
    onProgress({ done, total: todo.length, current: file.rel })
  })
  return { uploaded: todo.length - failed.length, skipped: files.length - todo.length, failed }
}

async function create(channel, user, { name, folder }, { onProgress } = {}) {
  const remote = await request(channel, user, '/projects', { method: 'POST', json: { name } })
  projects.upsertShared(remote, channel.id)
  const result = await uploadFolder(channel, user, remote.id, folder, { onProgress })
  return { id: remote.id, ...result }
}

// 이 PC에만 있던 프로젝트를 서버로 옮긴다. id를 그대로 써서 대화가 이어지고, 색인도 같이 올려 다시 색인하지 않는다.
async function migrate(channel, user, id, { onProgress } = {}) {
  const project = projects.readProject(id)
  if (project.shared) throw new Error('이미 공유 프로젝트입니다.')
  if (!project.folder || !fs.existsSync(project.folder)) throw new Error('연결한 폴더를 찾을 수 없어 옮길 수 없습니다.')
  const source = project.folder
  await request(channel, user, '/projects', {
    method: 'POST',
    json: {
      id: project.id,
      name: project.name,
      datasheet: project.datasheet ? projects.toServerRel(project.datasheet) : null,
      skipImages: Boolean(project.skipImages),
    },
  })
  const result = await uploadFolder(channel, user, id, source, { onProgress })
  const entries = projects.readIndexEntries(id)
  await pool(Object.entries(entries), ([key, entry]) => request(channel, user, `/projects/${enc(id)}/index/${enc(key)}`, { method: 'PUT', json: entry }))
  const scope = projects.readScope(id)
  if (scope) await request(channel, user, `/projects/${enc(id)}/state/scope`, { method: 'PUT', json: scope })
  project.shared = true
  project.folder = projects.cacheDir(id)
  project.sourceFolder = source
  projects.saveProject(project)
  return { ...result, entries: Object.keys(entries).length }
}

function patch(channel, user, id, body) {
  const json = { ...body }
  if ('datasheet' in json) json.datasheet = json.datasheet ? projects.toServerRel(json.datasheet) : null
  return request(channel, user, `/projects/${enc(id)}`, { method: 'PATCH', json })
}

function remove(channel, user, id) {
  return request(channel, user, `/projects/${enc(id)}`, { method: 'DELETE' })
}

function listTrash(channel, user) {
  return request(channel, user, '/projects/trash')
}

// 되살린 프로젝트는 목록을 다시 받아 이 PC에도 만든다. 파일은 열 때 받는다.
async function restore(channel, user, id) {
  const project = await request(channel, user, `/projects/${enc(id)}/restore`, { method: 'POST' })
  await listShared(channel, user)
  return project
}

// 서버에서 지우고 이 PC 캐시·색인도 지운다. 데이터시트였으면 지정도 푼다.
async function deleteFile(channel, user, id, rel) {
  await request(channel, user, `/projects/${enc(id)}/files?rel=${enc(projects.toServerRel(rel))}`, { method: 'DELETE' })
  fs.rmSync(path.join(projects.cacheDir(id), rel), { force: true })
  const project = projects.readProject(id)
  const wasSheet = project.datasheet && project.datasheet.toLowerCase() === rel.toLowerCase()
  projects.dropIndex(project, rel)
  if (wasSheet) await patch(channel, user, id, { datasheet: null })
}

// 고른 파일들을 프로젝트 맨 위에 올린다. 같은 이름이 서버에 있으면 새 내용으로 바꾼다.
async function uploadFiles(channel, user, id, files, { onProgress = () => {} } = {}) {
  const failed = []
  let done = 0
  onProgress({ done, total: files.length })
  await pool(files, async (full) => {
    const rel = path.basename(full)
    try {
      const stat = fs.statSync(full)
      await uploadOne(channel, user, id, path.dirname(full), { rel, size: stat.size, mtime: Math.floor(stat.mtimeMs) })
    } catch (err) {
      failed.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
    done += 1
    onProgress({ done, total: files.length, current: rel })
  })
  return { uploaded: files.length - failed.length, skipped: 0, failed }
}

function putEntry(channel, user, id, key, entry) {
  return request(channel, user, `/projects/${enc(id)}/index/${enc(key)}`, { method: 'PUT', json: entry })
}

function deleteEntry(channel, user, id, key) {
  return request(channel, user, `/projects/${enc(id)}/index/${enc(key)}`, { method: 'DELETE' })
}

function putScope(channel, user, id, scope) {
  return request(channel, user, `/projects/${enc(id)}/state/scope`, { method: 'PUT', json: scope })
}

// 색인·엑셀 동안 다른 사람이 같이 돌리지 못하게 잠근다. release()를 꼭 부른다.
async function lock(channel, user, id, purpose) {
  await request(channel, user, `/projects/${enc(id)}/lock`, { method: 'POST', json: { purpose } })
  const timer = setInterval(() => {
    request(channel, user, `/projects/${enc(id)}/lock`, { method: 'POST', json: { purpose } }).catch(() => {})
  }, LOCK_HEARTBEAT_MS)
  let released = false
  return async () => {
    if (released) return
    released = true
    clearInterval(timer)
    await request(channel, user, `/projects/${enc(id)}/lock`, { method: 'DELETE' }).catch(() => {})
  }
}

module.exports = {
  supports,
  listShared,
  pull,
  uploadFolder,
  create,
  migrate,
  patch,
  remove,
  listTrash,
  restore,
  deleteFile,
  uploadFiles,
  putEntry,
  deleteEntry,
  putScope,
  lock,
}
