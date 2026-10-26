// AI가 필요할 때만 불러 쓰는 스킬(SKILL.md 지침 묶음).
// 목록(이름·설명)은 시스템 프롬프트에 싣고, 본문은 use_skill로 그때그때 받는다.
// 출처: 활성 채널 manifest의 skills(본문은 채널 서버) + 이 PC의 <데이터 폴더>/skills/<이름>/SKILL.md.
// 같은 이름이면 이 PC 것이 이긴다. 관리자가 채널 스킬을 덮어쓸 수 있게 한다.

const fs = require('fs')
const path = require('path')
const config = require('../config')
const channelStore = require('../channels/store')
const client = require('../channels/client')

const NAME_RE = /^[a-z][a-z0-9-]{1,63}$/
const MAX_CATALOG = 40
const MAX_FILE_BYTES = 200 * 1024
const MAX_CHARS = 60000
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.yaml', '.yml'])
const CACHE_MS = 10 * 60 * 1000

const remoteCache = new Map()

function localRoot() {
  return path.join(config.dataDir(), 'skills')
}

// 맨 위 --- 사이의 name·description만 읽는다. YAML 전체를 해석하지는 않는다.
function parseSkillFile(text) {
  const match = String(text).replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: String(text).trim() }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/)
    if (pair) meta[pair[1].toLowerCase()] = pair[2].trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: match[2].trim() }
}

function localSkills() {
  let names = []
  try {
    names = fs.readdirSync(localRoot(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  const out = []
  for (const dirName of names) {
    const dir = path.join(localRoot(), dirName)
    try {
      const { meta } = parseSkillFile(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'))
      const name = String(meta.name || dirName).trim().toLowerCase()
      const description = String(meta.description || '').trim().slice(0, 300)
      if (!NAME_RE.test(name) || !description) continue
      out.push({ name, description, source: 'local', dir })
    } catch {
      // SKILL.md가 없는 폴더는 건너뛴다.
    }
  }
  return out
}

function activeChannel() {
  try {
    return channelStore.getActive()
  } catch {
    return null
  }
}

function catalog(channel = activeChannel()) {
  const merged = new Map()
  for (const skill of channel?.skills ?? []) merged.set(skill.name, { ...skill, source: 'channel' })
  for (const skill of localSkills()) merged.set(skill.name, skill)
  return [...merged.values()].slice(0, MAX_CATALOG)
}

// 시스템 프롬프트에 붙일 목록. 스킬이 없으면 빈 문자열.
function catalogPrompt(channel) {
  const list = catalog(channel)
  if (list.length === 0) return ''
  return [
    '사용할 수 있는 스킬:',
    ...list.map((skill) => `- ${skill.name}: ${skill.description}`),
    '요청이 위 스킬 설명에 맞으면 답하기 전에 use_skill로 그 스킬을 불러 지침을 따르세요. 맞는 스킬이 없으면 부르지 마세요.',
    '스킬 지침이 공통 규칙과 부딪히면 공통 규칙을 따르세요.',
  ].join('\n')
}

function insideDir(dir, rel) {
  const full = path.resolve(dir, rel)
  const root = path.resolve(dir)
  return full.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`) ? full : null
}

function listLocalFiles(dir) {
  const out = []
  const walk = (sub, depth) => {
    if (depth > 3 || out.length >= 50) return
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(rel, depth + 1)
      else if (rel !== 'SKILL.md' && TEXT_EXT.has(path.extname(entry.name).toLowerCase())) out.push(rel)
    }
  }
  try {
    walk('', 0)
  } catch {
    // 읽을 수 있는 만큼만 보여준다.
  }
  return out
}

function readLocal(skill, file) {
  if (!file) {
    const { body } = parseSkillFile(fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8'))
    return { body: body.slice(0, MAX_CHARS), files: listLocalFiles(skill.dir) }
  }
  const full = insideDir(skill.dir, file)
  if (!full || !TEXT_EXT.has(path.extname(full).toLowerCase())) throw new Error(`${skill.name} 스킬에서 열 수 없는 파일입니다: ${file}`)
  const stat = fs.statSync(full)
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`${file} 파일을 읽을 수 없습니다.`)
  return { body: fs.readFileSync(full, 'utf8').slice(0, MAX_CHARS), files: [] }
}

async function readRemote(channel, skill, file, user) {
  const key = `${channel.id}:${channel.version || ''}:${skill.name}`
  let hit = remoteCache.get(key)
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    hit = { at: Date.now(), ...(await client.fetchSkill(channel, skill.name, user)) }
    remoteCache.set(key, hit)
  }
  if (!file) return { body: hit.body, files: Object.keys(hit.files) }
  const text = hit.files[String(file).replace(/\\/g, '/')]
  if (typeof text !== 'string') throw new Error(`${skill.name} 스킬에 ${file} 파일이 없습니다.`)
  return { body: text, files: [] }
}

async function load(name, { file, user } = {}) {
  const wanted = String(name || '').trim().toLowerCase()
  const channel = activeChannel()
  const skill = catalog(channel).find((item) => item.name === wanted)
  if (!skill) throw new Error(`${wanted || '(이름 없음)'} 스킬이 없습니다. 시스템 프롬프트의 스킬 목록에 있는 이름만 쓸 수 있습니다.`)
  const read = skill.source === 'local' ? readLocal(skill, file) : await readRemote(channel, skill, file, user)
  return { name: skill.name, ...read }
}

module.exports = { catalog, catalogPrompt, load, localRoot, parseSkillFile }
