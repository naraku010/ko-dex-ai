// docx·xlsx는 AI가 바로 못 연다. zip 안의 XML에서 글자만 꺼내 준다.

const fs = require('fs')
const zlib = require('zlib')

const MAX_CHARS = 200000

function readZip(filePath) {
  const buf = fs.readFileSync(filePath)
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('zip 형식이 아닙니다.')
  const count = buf.readUInt16LE(end + 10)
  let offset = buf.readUInt32LE(end + 16)
  const entries = new Map()
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break
    const method = buf.readUInt16LE(offset + 10)
    const compressed = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const local = buf.readUInt32LE(offset + 42)
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8')
    entries.set(name, { method, compressed, local })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const entry = entries.get(name)
      if (!entry) return ''
      const nameLen = buf.readUInt16LE(entry.local + 26)
      const extraLen = buf.readUInt16LE(entry.local + 28)
      const start = entry.local + 30 + nameLen + extraLen
      const data = buf.slice(start, start + entry.compressed)
      if (entry.method === 0) return data.toString('utf8')
      if (entry.method === 8) return zlib.inflateRawSync(data).toString('utf8')
      return ''
    },
  }
}

function decode(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

function docxText(filePath) {
  const zip = readZip(filePath)
  const xml = zip.read('word/document.xml')
  return decode(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
}

function columnIndex(ref) {
  const letters = String(ref || '').replace(/[0-9]/g, '')
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return Math.max(n - 1, 0)
}

// <ns0:row> 처럼 접두어를 붙여 저장한 파일도 있다.
function unprefix(xml) {
  return xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1')
}

function runsText(xml) {
  return decode((xml.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(''))
}

// 시트마다 행 배열을 돌려준다. 빈 칸은 ''.
function xlsxRows(filePath) {
  const zip = readZip(filePath)
  const shared = []
  const sharedXml = unprefix(zip.read('xl/sharedStrings.xml'))
  for (const si of sharedXml.match(/<si>[\s\S]*?<\/si>/g) || []) shared.push(runsText(si))
  const sheets = zip.names
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  return sheets.map((sheet) => {
    const rows = []
    for (const row of unprefix(zip.read(sheet)).match(/<row[^>]*>[\s\S]*?<\/row>/g) || []) {
      const cells = []
      for (const cell of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const ref = (cell.match(/ r="([A-Z]+\d+)"/) || [])[1]
        const type = (cell.match(/ t="([^"]+)"/) || [])[1]
        let value = ''
        if (type === 'inlineStr') {
          value = runsText(cell)
        } else {
          const raw = (cell.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || ''
          value = type === 's' ? (shared[Number(raw)] ?? '') : decode(raw)
        }
        cells[columnIndex(ref)] = value
      }
      rows.push(Array.from(cells, (value) => value ?? ''))
    }
    return { name: sheet.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, ''), rows }
  })
}

function xlsxText(filePath) {
  const out = []
  for (const sheet of xlsxRows(filePath)) {
    out.push(`# ${sheet.name}`)
    for (const cells of sheet.rows) {
      const line = cells.join('\t').trim()
      if (line) out.push(line)
    }
  }
  return out.join('\n')
}

function extractText(filePath, maxChars = MAX_CHARS) {
  const lower = filePath.toLowerCase()
  let text = ''
  if (lower.endsWith('.docx')) text = docxText(filePath)
  else if (lower.endsWith('.xlsx')) text = xlsxText(filePath)
  else text = fs.readFileSync(filePath, 'utf8')
  return text.replace(/\u0000/g, '').slice(0, maxChars)
}

module.exports = { extractText, xlsxRows }
