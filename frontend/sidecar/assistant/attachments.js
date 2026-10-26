// 채팅에 붙여 넣은 이미지·파일을 작업 폴더에 두고, 비서가 읽을 경로를 만든다.

const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')

const MAX_FILES = 6
const MAX_BYTES = 20 * 1024 * 1024
const EXCERPT_CHARS = 8000
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.log'])

function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return (base || 'file').slice(0, 120)
}

function isImage(filePath) {
  return IMAGE_EXT.has(path.extname(filePath).toLowerCase())
}

function excerpt(filePath) {
  if (!TEXT_EXT.has(path.extname(filePath).toLowerCase())) return ''
  try {
    const text = fs.readFileSync(filePath, 'utf8').replace(/\u0000/g, '').trim()
    if (!text) return ''
    const cut = text.length > EXCERPT_CHARS
    return `내용${cut ? ' 일부' : ''}:\n${text.slice(0, EXCERPT_CHARS)}`
  } catch {
    return ''
  }
}

// 이미지 한 장이 1~2분 걸리고 Codex 사용량을 쓰므로 한 번에 만들 수 있는 장수를 막는다.
const MAX_RENDERS = 4

function pickPages(raw) {
  if (!Array.isArray(raw)) return []
  const pages = raw.map(Number).filter((page) => Number.isInteger(page) && page > 0)
  return [...new Set(pages)].slice(0, MAX_RENDERS)
}

function save(workDir, items) {
  const list = Array.isArray(items) ? items.slice(0, MAX_FILES) : []
  if (!list.length) return { dir: null, files: [] }
  const dir = path.join(workDir, 'inbox', randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  const files = []
  for (const item of list) {
    const name = safeName(item?.name)
    const raw = String(item?.bytesBase64 || '').replace(/\s/g, '')
    if (!raw) continue
    const bytes = Buffer.from(raw, 'base64')
    if (!bytes.length || bytes.length > MAX_BYTES) {
      throw new Error(`'${name}' 은 20MB 이하만 붙일 수 있습니다.`)
    }
    const dest = path.join(dir, name)
    fs.writeFileSync(dest, bytes)
    files.push({
      name,
      path: dest,
      size: bytes.length,
      mime: String(item?.mime || ''),
      drawing: Boolean(item?.drawing),
      pages: pickPages(item?.pages),
      excerpt: excerpt(dest),
    })
  }
  return { dir, files }
}

// renders: [{ page, tag, pagePath, path?, error? }]
function describe(files, renders = []) {
  if (!files.length && !renders.length) return ''
  const lines = []
  if (files.length) {
    lines.push('사용자가 파일을 첨부했습니다. 답하기 전에 아래 경로만 읽으세요.')
    for (const file of files) {
      lines.push(`- ${file.name}${file.drawing ? ' (도면)' : ''}: ${file.path}`)
      if (file.excerpt) lines.push(file.excerpt)
    }
  }
  const done = renders.filter((item) => item.path)
  const failed = renders.filter((item) => item.error)
  if (renders.length) lines.push(`사용자가 이미지로 만들 도면으로 ${renders.map(pageLabel).join(', ')}를 골랐습니다.`)
  for (const item of renders) {
    if (item.pagePath) lines.push(`${pageLabel(item)} 원본 이미지: ${item.pagePath}`)
    if (item.path) lines.push(`${pageLabel(item)} 3D 제품 이미지: ${item.path}`)
  }
  if (failed.length) {
    lines.push(`도면 이미지 생성 실패: ${failed.map((item) => `${pageLabel(item)} ${item.error}`).join(' / ')}`)
  }
  if (done.length) {
    lines.push('도면을 설명하거나 보여줄 때는 이 생성 이미지를 우선하세요. 표나 엑셀을 요청한 경우에만 pmi_grid를 호출하세요.')
  } else if (failed.length) {
    lines.push('도면 파일을 직접 읽고 답하세요. 표나 엑셀을 요청한 경우에만 pmi_grid를 호출하세요.')
  } else if (files.some((file) => file.drawing)) {
    lines.push('첨부한 도면을 읽고 답하세요. 표나 엑셀을 요청한 경우에만 pmi_grid를 호출하세요.')
  }
  return lines.join('\n')
}

function pageLabel(item) {
  return item.tag ? `${item.page}쪽(${item.tag})` : `${item.page}쪽`
}

module.exports = { save, describe, isImage, MAX_RENDERS }
