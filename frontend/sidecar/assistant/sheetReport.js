// 데이터시트 항목(열)별로, 다른 문서에서 찾은 지시(변경·지시·제품지정)를 모아 엑셀로 만든다.
// AI는 색인 때 이미 항목별 지시를 뽑았으므로 여기서는 이 PC에서 모으기만 한다.

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { xlsxRows } = require('./docText')
const { writeXlsx, colName, sheetRef } = require('./xlsxWrite')

const TAG_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+){2,}$/i
const EMPTY = new Set(['', '*', '-', 'N/A', 'n/a'])
// 데이터시트에서 이 항목이 해당 없는 행. 빈 칸은 아직 안 정한 값일 수 있어 넣지 않는다.
const NOT_APPLICABLE = new Set(['*', '-', 'N/A', 'n/a', 'NA'])
const KIND_ORDER = { 변경: 0, 제품지정: 1, 지시: 2 }

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function readSheetTable(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.xlsx') throw new Error('데이터시트가 엑셀(xlsx)이 아닙니다.')
  for (const sheet of xlsxRows(filePath)) {
    const headerIndex = sheet.rows.findIndex((row) => row.some((cell) => /^tag\s*no\.?$/i.test(clean(cell))))
    if (headerIndex < 0) continue
    const header = sheet.rows[headerIndex].map(clean)
    const tagCol = header.findIndex((cell) => /^tag\s*no\.?$/i.test(cell))
    const rows = []
    const notes = []
    for (const raw of sheet.rows.slice(headerIndex + 1)) {
      const row = header.map((_, i) => clean(raw[i]))
      if (TAG_RE.test(row[tagCol])) {
        rows.push(row)
        continue
      }
      const text = raw.map(clean).filter(Boolean).join(' ')
      if (rows.length && text) notes.push(text)
    }
    if (rows.length) return { sheet: sheet.name, header, tagCol, rows, notes }
  }
  throw new Error('데이터시트에서 Tag No 열이 있는 표를 찾지 못했습니다.')
}

function norm(text) {
  return String(text || '').toLowerCase().replace(/\(\d\)|[^a-z0-9가-힣]/g, '')
}

// AI가 적은 대상 열 이름을 실제 데이터시트 열에 맞춘다.
function matchColumn(header, target) {
  const key = norm(target)
  if (!key) return -1
  const keys = header.map(norm)
  let col = keys.findIndex((name) => name && name === key)
  if (col < 0) col = keys.findIndex((name) => name && (name.startsWith(key) || key.startsWith(name)))
  if (col < 0) col = keys.findIndex((name) => name && name.length > 3 && (name.includes(key) || key.includes(name)))
  return col
}

function downloadsDir() {
  const custom = String(process.env.EGI_DOWNLOAD_DIR || '').trim()
  return custom || path.join(os.homedir(), 'Downloads')
}

function outputPath(projectName, label) {
  const dir = downloadsDir()
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  const base = `${String(projectName || '프로젝트').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')} ${label} ${stamp}`
  let file = path.join(dir, `${base}.xlsx`)
  for (let i = 1; fs.existsSync(file); i += 1) file = path.join(dir, `${base} (${i}).xlsx`)
  return file
}

// 추가사항 중요도. 1·2단계는 제품을 만들기 전에 반드시 지켜야 하는 것.
const LEVELS = {
  1: { label: '재질 필수', mark: 'red' },
  2: { label: '시험 필수', mark: 'orange' },
  3: { label: '설계·제작', mark: 'yellow' },
  4: { label: '서류·승인', mark: null },
  5: { label: '포장·기타', mark: null },
}
const LEVEL_RULES = [
  [1, /material|재질|원자재|\bnace\b|\bhic\b|sour service|mr0175|mr0103|\bastm a\d|\ba\d{3}\b|ss ?316|stainless|carbon steel|alloy|steel mill|approved (manufacturer|mill|vendor|source)|승인.{0,6}(제조사|업체|밀)|mill (cert|test)|en 10204|3\.1 cert/i],
  [2, /test|시험|inspect|검사|\bpmi\b|hydro|\bnde\b|radiograph|\b(rt|ut|mt|pt)\b|impact|charpy|hardness|경도|witness|hold point|\bitp\b|\bfat\b/i],
  [3, /design|설계|weld|용접|coating|코팅|paint|도장|dimension|치수|thickness|두께|\basme\b|\bb16\.|\bb31\.|\bapi\b|heat treat|열처리|pwht|fabricat|제작|tolerance|공차|corrosion allowance/i],
  [4, /document|서류|drawing|도면|submit|제출|approv|승인|certificate|인증서|report|보고서|data ?book|\bmdr\b|\bvdr\b|manual|매뉴얼/i],
]

const PACKING = /pack|포장|pallet|팔레트|crate|크레이트|skid|스키드|marking|마킹|stencil|스텐실|shipping|shipment|운송|출하|선적|preserv|보존|보관|storage|spare|예비품|nameplate|명판|lifting|인양|목재|wood|밴드|결속/i

// AI가 매긴 단계가 없으면(예전 색인) 키워드로 가늠한다.
function levelOf(item) {
  const given = Number(item.level)
  if (given >= 1 && given <= 5) return given
  if (PACKING.test(`${item.name} ${item.value}`)) return 5
  const text = [item.name, item.value, item.condition].join(' ')
  return LEVEL_RULES.find(([, re]) => re.test(text))?.[0] ?? 5
}

// 값에 단위가 이미 적혀 있으면 단위를 다시 붙이지 않는다.
function valueText(item) {
  const value = String(item.value || '').trim()
  const unit = String(item.unit || '').trim()
  if (!unit) return value
  if (!value) return unit
  const missing = unit.split(/[;,]\s*|\s+/).filter((part) => part && !value.includes(part))
  return missing.length ? `${value} ${missing.join(' ')}` : value
}

// 같은 지시가 여러 문서·조각에 되풀이되면 한 줄로 합치고 출처만 모은다.
// 색인 때 판단한 적용 범위(applies)도 모은다. 하나라도 없으면 엑셀 때 다시 판단한다.
function mergeHits(hits) {
  const byKey = new Map()
  for (const hit of hits) {
    const key = [hit.kind, hit.name, valueText(hit), hit.condition].map(norm).join('|')
    const page = String(hit.page ?? '').replace(/^p\.?\s*/i, '')
    const source = `${hit.rel}${page ? ` p.${page}` : ''}`
    const found = byKey.get(key)
    if (found) {
      if (!found.sources.includes(source)) found.sources.push(source)
      if (hit.applies) found.appliesList.push(hit.applies)
      else found.appliesMissing = true
      continue
    }
    byKey.set(key, { ...hit, sources: [source], appliesList: hit.applies ? [hit.applies] : [], appliesMissing: !hit.applies })
  }
  return [...byKey.values()]
}

const SHEET = { summary: '요약', tags: '데이터시트 (추가사항 반영)', detail: '항목별 지시', extra: '추가사항', docs: '문서 목록' }
const MAX_TOP = 10

function findCol(header, re, skip = []) {
  return header.findIndex((name, col) => name && !skip.includes(col) && re.test(name))
}

// 지시 글에 특정 태그나 배관 등급이 적혀 있으면 그 행에만 붙인다. 없으면 모든 행에 붙인다.
function scopeFinder(table) {
  if (!table) return () => null
  const classCol = findCol(table.header, /piping\s*class/i)
  const byValue = (col) => {
    const map = new Map()
    if (col < 0) return map
    table.rows.forEach((row, index) => {
      const key = String(row[col] || '').toUpperCase()
      if (key.length < 4) return
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(index)
    })
    return map
  }
  const tags = byValue(table.tagCol)
  const classes = byValue(classCol)
  const pick = (map, text) => {
    const rows = []
    for (const [key, indexes] of map) {
      const at = text.indexOf(key)
      if (at < 0) continue
      const before = text[at - 1] || ' '
      const after = text[at + key.length] || ' '
      if (/[A-Z0-9]/.test(before) || /[A-Z0-9]/.test(after)) continue
      rows.push(...indexes)
    }
    return rows.length ? new Set(rows) : null
  }
  return (hit) => {
    const text = [hit.name, hit.value, hit.condition, hit.quote].join(' ').toUpperCase()
    return pick(tags, text) || pick(classes, text)
  }
}

// 추가사항 칸 한 건. 출처는 '항목별 지시' 시트에 있으므로 여기서는 뺀다.
function hitLine(hit) {
  const value = valueText(hit)
  return [
    `• [${hit.kind}] ${hit.name}`,
    value ? `   → ${value}` : '',
    hit.condition ? `   조건: ${hit.condition}` : '',
  ].filter(Boolean).join('\n')
}

function guessWidth(values, min = 8, max = 40) {
  const longest = values.reduce((n, v) => Math.max(n, String(v ?? '').length), 0)
  return Math.max(min, Math.min(max, Math.ceil(longest * 1.1) + 2))
}

const asNumber = (value) => (/^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value)

// 데이터시트 표를 그대로 두고, 지시가 있는 항목 열 오른쪽에 "○○ 추가사항" 열을 끼운다.
function buildTagSheet(table, columns) {
  const qtyCol = findCol(table.header, /^(q'?ty|qty|quantity|수량)/i)
  const layout = []
  const header = []
  table.header.forEach((name, col) => {
    layout.push({ col, kind: 'value' })
    header.push(name)
    const column = columns.find((c) => c.col === col)
    if (column?.merged.length) {
      layout.push({ col, kind: 'added', column })
      header.push(`${name} 추가사항`)
    }
  })
  const rows = table.rows.map((row, index) => layout.map((slot) => {
    if (slot.kind === 'value') return slot.col === qtyCol ? asNumber(row[slot.col]) : row[slot.col]
    const hits = cellHits(slot.column, row, index)
    if (!hits.length) return ''
    const changed = hits.some((hit) => hit.kind === '변경')
    return { v: hits.map(hitLine).join('\n\n'), style: changed ? undefined : 'added', mark: changed ? 'red' : undefined }
  }))
  const widths = layout.map((slot, i) => (slot.kind === 'added' ? 60 : guessWidth([header[i], ...rows.slice(0, 200).map((r) => r[i])])))
  const outCol = (col) => layout.findIndex((slot) => slot.kind === 'value' && slot.col === col)
  return { sheet: { name: SHEET.tags, rows: [header, ...rows], widths }, outCol, qtyCol }
}

function quantityBlock(table, tagSheet) {
  const tagCol = table.tagCol
  const qtyCol = tagSheet.qtyCol
  const ratingCol = findCol(table.header, /rating|압력\s*등급|^class$/i, [tagCol])
  const typeCol = findCol(table.header, /type|형식|종류/i, [tagCol, ratingCol])
  if (typeCol < 0 || ratingCol < 0) return null
  const distinct = (col) => [...new Set(table.rows.map((row) => row[col]).filter((v) => v && !EMPTY.has(v)))]
  const types = distinct(typeCol).slice(0, 30)
  const ratings = distinct(ratingCol)
    .sort((a, b) => (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0) || a.localeCompare(b))
    .slice(0, 12)
  if (!types.length || !ratings.length) return null
  const last = table.rows.length + 1
  const range = (col) => `${sheetRef(SHEET.tags)}!$${colName(tagSheet.outCol(col))}$2:$${colName(tagSheet.outCol(col))}$${last}`
  return {
    title: `수량 (${table.header[typeCol]} × ${table.header[ratingCol]}, ${qtyCol >= 0 ? '수량 합' : '태그 수'})`,
    head: [table.header[typeCol], ...ratings, '합계'],
    types,
    ratings,
    formula: (rowRef, ratingRef) => (qtyCol >= 0
      ? `SUMIFS(${range(qtyCol)},${range(typeCol)},${rowRef},${range(ratingCol)},${ratingRef})`
      : `COUNTIFS(${range(typeCol)},${rowRef},${range(ratingCol)},${ratingRef})`),
  }
}

// 샘플 수주검토 요약처럼 구역을 차례로 쌓는다. 표 머리글은 'head', 구역 제목은 'section'.
function buildSummary({ projectName, table, datasheetRel, files, columns, quantity, top }) {
  const rows = []
  const merges = []
  const add = (row) => {
    rows.push(row)
    return rows.length - 1
  }
  const box = (v) => ({ v })
  const head = (v) => ({ v, style: 'head' })
  const section = (text) => {
    if (rows.length) add([])
    add([{ v: text, style: 'section' }])
  }
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const indexed = files.filter((file) => file.state === 'ok').length
  add([{ v: `${projectName || '프로젝트'} – 데이터시트 기준 검토 요약`, style: 'title' }])
  add([{ v: `작성 기준: 연결 폴더 문서 ${files.length}개 중 색인 ${indexed}개, 데이터시트 ${datasheetRel || '미지정'}${table ? ` (태그 ${table.rows.length}개)` : ''}. 수량은 '${SHEET.tags}' 시트를 수식으로 집계.`, style: 'note' }])

  section('1. 기본 정보')
  const info = [
    ['프로젝트', projectName || ''],
    ['데이터시트', datasheetRel || '지정 안 됨'],
    ['태그 / 항목', table ? `태그 ${table.rows.length}개 × 항목 ${table.header.filter(Boolean).length}개` : '표 없음'],
    ['문서', `${files.length}개 (색인 ${indexed}개${files.length - indexed ? `, 미색인·실패 ${files.length - indexed}개` : ''})`],
    ['작성일', today],
  ]
  for (const [label, value] of info) {
    const r = add([head(label), box(value), box(''), box(''), box(''), box('')])
    merges.push({ r1: r, c1: 1, r2: r, c2: 5 })
  }

  let n = 2
  if (quantity) {
    section(`${n}. ${quantity.title}`)
    n += 1
    const headRow = add([...quantity.head.map(head)])
    const first = rows.length
    const width = quantity.head.length
    for (const type of quantity.types) {
      const r = rows.length + 1
      const cells = [box(type)]
      quantity.ratings.forEach((_, i) => {
        cells.push({ f: quantity.formula(`$A${r}`, `${colName(i + 1)}$${headRow + 1}`) })
      })
      cells.push({ f: `SUM(B${r}:${colName(width - 2)}${r})` })
      add(cells)
    }
    const lastRow = rows.length
    const total = [head('합계')]
    for (let c = 1; c < width; c += 1) total.push({ f: `SUM(${colName(c)}${first + 1}:${colName(c)}${lastRow})` })
    add(total)
  }

  section(`${n}. 데이터시트 항목별 추가사항 (다른 문서의 지시)`)
  n += 1
  add([head('항목'), head('데이터시트 값'), head('변경'), head('제품지정'), head('지시'), head('적용 태그')])
  const covered = columns.filter((c) => c.merged.length)
  if (!covered.length) add([box('지시가 붙은 항목이 없습니다.'), box(''), box(''), box(''), box(''), box('')])
  for (const column of covered) {
    const count = (kind) => column.merged.filter((hit) => hit.kind === kind).length
    const scoped = column.merged.every((hit) => hit.scope)
    const tags = scoped ? new Set(column.merged.flatMap((hit) => [...hit.scope])).size : table?.rows.length
    const changed = count('변경')
    add([
      changed ? { v: column.name, mark: 'red' } : box(column.name),
      box(column.values),
      changed ? { v: changed, mark: 'red' } : changed,
      count('제품지정'),
      count('지시'),
      tags ? (scoped ? `${tags}개` : `전체 ${tags}개`) : '',
    ])
  }

  section(`${n}. 데이터시트 밖 추가사항 (단계별)`)
  n += 1
  add([head('단계'), head('분류'), head('건수'), head('의미')])
  const meaning = {
    1: '제작 전 반드시 지켜야 하는 재질·원자재 요건',
    2: '제작 전 확정해야 하는 시험·검사 요건',
    3: '설계·제작 방법에 영향을 주는 요건',
    4: '도면·서류 제출과 승인',
    5: '포장·마킹·출하·예비품 등',
  }
  for (let level = 1; level <= 5; level += 1) {
    const { label, mark } = LEVELS[level]
    const cell = (v) => (mark ? { v, mark } : box(v))
    add([
      cell(`${level}단계`),
      cell(label),
      { f: `COUNTIF(${sheetRef(SHEET.extra)}!$A:$A,"${level}단계")` },
      box(meaning[level]),
    ])
  }

  section(`${n}. 우선 확인 항목 Top ${MAX_TOP} (변경·제품지정·재질/시험 필수)`)
  const topHead = add([head('No'), head('항목'), head('내용'), head(''), head(''), head('출처')])
  merges.push({ r1: topHead, c1: 2, r2: topHead, c2: 4 })
  if (!top.length) add([box(''), box('우선 확인할 항목이 없습니다.'), box(''), box(''), box(''), box('')])
  top.forEach((item, i) => {
    const r = add([i + 1, item.mark ? { v: item.title, mark: item.mark } : box(item.title), box(item.text), box(''), box(''), box(item.source)])
    merges.push({ r1: r, c1: 2, r2: r, c2: 4 })
  })
  return { name: SHEET.summary, rows, merges, headerRow: null, widths: [22, 30, 16, 16, 16, 34] }
}

function topItems(columns, mergedExtras) {
  const out = []
  const source = (hit) => (hit.sources.length > 1 ? `${hit.sources[0]} 외 ${hit.sources.length - 1}` : hit.sources[0])
  const text = (hit) => [valueText(hit), hit.condition ? `조건: ${hit.condition}` : ''].filter(Boolean).join(' / ')
  for (const kind of ['변경', '제품지정']) {
    for (const column of columns) {
      for (const hit of column.merged.filter((h) => h.kind === kind && !(h.scope && h.scope.size === 0))) {
        out.push({ title: `${column.name} ${kind}`, text: `${hit.name}: ${text(hit)}`, source: source(hit), mark: kind === '변경' ? 'red' : 'orange' })
      }
    }
  }
  for (const hit of mergedExtras.filter((h) => h.level <= 2)) {
    out.push({ title: `${LEVELS[hit.level].label}`, text: `${hit.name}: ${text(hit)}`, source: source(hit), mark: LEVELS[hit.level].mark })
  }
  return out.slice(0, MAX_TOP)
}

// ---------- 적용 범위: 지시가 데이터시트의 어느 행에 해당하는지 ----------
// AI는 열 이름과 값 목록만 보고 규칙을 돌려준다. 규칙을 행에 대는 일은 여기서 한다.

const DICT_VALUES = 40
const DICT_TAGS = 400

function scopeDictionary(table) {
  const lines = []
  table.header.forEach((name, col) => {
    if (!name) return
    const values = [...new Set(table.rows.map((row) => row[col]).filter((v) => v && !EMPTY.has(v)))]
    if (col === table.tagCol) {
      if (values.length <= DICT_TAGS) lines.push(`- [${name}] ${values.join(' | ')}`)
      return
    }
    if (values.length > DICT_VALUES && values.length > table.rows.length * 0.6) return
    lines.push(`- [${name}] ${values.slice(0, DICT_VALUES).map((v) => v.slice(0, 80)).join(' | ')}`)
  })
  return lines.join('\n')
}

function scopeKey(columnName, hit) {
  return crypto.createHash('sha1')
    .update([columnName, hit.kind, hit.name, valueText(hit), hit.condition, hit.quote].map(norm).join('|'))
    .digest('hex').slice(0, 20)
}

const upper = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toUpperCase()

// 1-1/2, 3/4, 12" 같은 사이즈도 숫자로 읽는다.
function numberOf(value) {
  const text = String(value ?? '').replace(/["”″]|inch|in\b/gi, '').trim()
  const mixed = text.match(/^(\d+)[-\s](\d+)\/(\d+)$/)
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3])
  const frac = text.match(/^(\d+)\/(\d+)$/)
  if (frac) return Number(frac[1]) / Number(frac[2])
  const num = text.match(/^-?\d+(\.\d+)?/)
  return num ? Number(num[0]) : NaN
}

function testCond(cond, row, header) {
  const col = matchColumn(header, cond.col)
  if (col < 0) return true
  const cell = row[col]
  if (Array.isArray(cond.in) && cond.in.length) {
    const wanted = cond.in.map(upper)
    const value = upper(cell)
    if (!wanted.includes(value) && !wanted.some((w) => w.length > 2 && value.includes(w))) return false
  }
  if (cond.min !== undefined || cond.max !== undefined) {
    const n = numberOf(cell)
    if (Number.isNaN(n)) return false
    if (cond.min !== undefined && n < Number(cond.min)) return false
    if (cond.max !== undefined && n > Number(cond.max)) return false
  }
  return true
}

// 규칙 → 해당 행 번호 집합. null이면 모든 행.
function applyRule(rule, table) {
  if (!rule || rule.all) return null
  if (rule.none) return new Set()
  const tags = Array.isArray(rule.tags) ? new Set(rule.tags.map(upper)) : null
  const groups = Array.isArray(rule.any) ? rule.any.filter((g) => Array.isArray(g) && g.length) : []
  if (!tags?.size && !groups.length) return null
  const rows = new Set()
  table.rows.forEach((row, index) => {
    if (tags?.has(upper(row[table.tagCol]))) rows.add(index)
    else if (groups.some((group) => group.every((cond) => testCond(cond, row, table.header)))) rows.add(index)
  })
  return rows
}

function describeRule(rule) {
  if (!rule || rule.all) return ''
  if (rule.none) return '데이터시트에 해당 행 없음'
  const parts = []
  if (Array.isArray(rule.tags) && rule.tags.length) parts.push(`태그 ${rule.tags.length}개 지정`)
  for (const group of Array.isArray(rule.any) ? rule.any : []) {
    const conds = (Array.isArray(group) ? group : []).map((cond) => {
      const range = [cond.min !== undefined ? `≥${cond.min}` : '', cond.max !== undefined ? `≤${cond.max}` : ''].filter(Boolean).join(' ')
      const values = Array.isArray(cond.in) && cond.in.length ? cond.in.join('/') : ''
      return `${cond.col} ${[values, range].filter(Boolean).join(' ')}`.trim()
    })
    if (conds.length) parts.push(conds.join(' & '))
  }
  return parts.join(' 또는 ')
}

// 데이터시트 열에 붙은 지시를 모은다. 표가 없으면 AI가 적은 대상 항목 이름으로 대신한다.
function collect({ table, datasheetRel, entries }) {
  const columns = table
    ? table.header
      .map((name, col) => ({ name, col }))
      .filter(({ name, col }) => name && col !== table.tagCol)
      .map(({ name, col }) => {
        const values = [...new Set(table.rows.map((row) => row[col]).filter((v) => !EMPTY.has(v)))]
        return { name, col, values: values.slice(0, 10).join(' ; ').slice(0, 400), hits: [], merged: [] }
      })
    : []
  const extras = []
  for (const entry of entries) {
    if (datasheetRel && entry.rel === datasheetRel) continue
    for (const item of entry.items || []) {
      const hit = { ...item, rel: entry.rel, docType: entry.docType || '' }
      if (!item.target || item.kind === '추가') {
        extras.push(hit)
        continue
      }
      let index = matchColumn(columns.map((c) => c.name), item.target)
      if (index < 0 && !table) {
        columns.push({ name: item.target, col: -1, values: '', hits: [], merged: [] })
        index = columns.length - 1
      }
      if (index < 0) extras.push({ ...hit, name: `${item.target} · ${item.name}` })
      else columns[index].hits.push(hit)
    }
  }
  for (const column of columns) {
    column.merged = mergeHits(column.hits)
    column.merged.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.name.localeCompare(b.name))
  }
  return { columns, extras }
}

// 여러 규칙의 합집합. 하나라도 전체면 전체(null).
function applyRules(list, table) {
  const rows = new Set()
  for (const rule of list) {
    const scope = applyRule(rule, table)
    if (!scope) return null
    for (const index of scope) rows.add(index)
  }
  return rows
}

function describeRules(list) {
  const texts = [...new Set(list.map(describeRule))]
  if (texts.includes('')) return ''
  return texts.join(' 또는 ')
}

// 엑셀 때 AI에게 적용 범위를 다시 물을 지시 목록. 색인 때 판단이 없는 지시(예전 색인)만 넣는다.
// 원본 문서는 다시 읽지 않고 색인된 지시만 쓴다.
function scopeItems({ table, datasheetRel, entries }) {
  if (!table) return { dictionary: '', items: [] }
  const { columns } = collect({ table, datasheetRel, entries })
  const items = columns.flatMap((column) => column.merged
    .filter((hit) => hit.appliesMissing)
    .map((hit) => ({ key: scopeKey(column.name, hit), column: column.name, hit })))
  return { dictionary: scopeDictionary(table), items }
}

// rules: Map(scopeKey → 규칙). 규칙이 없는 지시는 태그·배관 등급 글자로 가늠한다.
function analyze({ table, datasheetRel, entries, rules }) {
  const { columns, extras } = collect({ table, datasheetRel, entries })
  const guess = scopeFinder(table)
  let judged = 0
  for (const column of columns) {
    for (const hit of column.merged) {
      const rule = rules?.get(scopeKey(column.name, hit))
      if (table && !hit.appliesMissing) {
        judged += 1
        hit.scope = applyRules(hit.appliesList, table)
        hit.rule = describeRules(hit.appliesList)
      } else if (rule && table) {
        judged += 1
        hit.scope = applyRule(rule, table)
        hit.rule = describeRule(rule)
      } else {
        hit.scope = guess(hit)
        hit.rule = hit.scope ? '태그·배관 등급 글자로 추정' : ''
      }
    }
  }
  return { columns, extras, judged }
}

// 행 하나·항목 하나에 붙는 지시. 데이터시트에서 해당 없음(*, - 등)인 칸에는 붙이지 않는다.
function cellHits(column, row, index) {
  if (!column?.merged.length || NOT_APPLICABLE.has(row[column.col])) return []
  return column.merged.filter((hit) => !hit.scope || hit.scope.has(index))
}

// DB 검증용. 마스터는 태그 한 행, 디테일은 그 태그의 항목별 원래 값과 추가사항.
// 같은 지시가 태그마다 되풀이되므로 지시는 notes에 한 번만 두고 칸에는 번호만 적는다.
function datasheetRecords({ table, datasheetRel, entries, rules }) {
  if (!table) throw new Error('데이터시트 표가 없어 DB에 넣을 수 없습니다.')
  const { columns } = analyze({ table, datasheetRel, entries, rules })
  const byCol = new Map(columns.map((column) => [column.col, column]))
  const notes = []
  const noteId = new Map()
  const idOf = (hit) => {
    if (!noteId.has(hit)) {
      noteId.set(hit, notes.length)
      notes.push({ text: hitLine(hit), kind: hit.kind, sources: hit.sources })
    }
    return noteId.get(hit)
  }
  const fields = table.header
    .map((name, col) => ({ name, col }))
    .filter(({ name, col }) => name && col !== table.tagCol)
  const tags = table.rows.map((row, index) => ({
    rowNo: index + 1,
    tag: row[table.tagCol],
    items: fields.map(({ name, col }, seq) => ({
      seq: seq + 1,
      name,
      value: row[col],
      notes: cellHits(byCol.get(col), row, index).map(idOf),
    })),
  }))
  return { sheet: table.sheet, notes, tags }
}

function writeReport({ projectName, table, datasheetRel, files, entries, rules }) {
  const { columns, extras, judged } = analyze({ table, datasheetRel, entries, rules })
  const tagOf = (index) => table.rows[index][table.tagCol]

  const header = ['데이터시트 항목', '데이터시트 값', '구분', '지시 내용', '지시 값', '조건', '적용 범위', '적용 태그', '출처', '원문']
  const rows = [header]
  let instructions = 0
  for (const column of columns) {
    if (!column.hits.length) {
      rows.push([column.name, column.values, '', '관련 지시 없음', '', '', '', '', '', ''])
      continue
    }
    column.merged.forEach((hit) => {
      instructions += 1
      const mark = hit.kind === '변경' || hit.kind === '제품지정'
      const tags = hit.scope ? [...hit.scope].map(tagOf) : []
      rows.push([
        column.name,
        column.values,
        mark ? { v: hit.kind, mark } : hit.kind,
        mark ? { v: hit.name, mark } : hit.name,
        mark ? { v: valueText(hit), mark } : valueText(hit),
        hit.condition,
        hit.rule || '전체',
        hit.scope ? (tags.length ? `${tags.length}개: ${tags.slice(0, 12).join(', ')}${tags.length > 12 ? ' …' : ''}` : '없음') : '전체',
        hit.sources.join('\n'),
        hit.quote,
      ])
    })
  }

  const mergedExtras = mergeHits(extras)
    .map((hit) => ({ ...hit, level: levelOf(hit) }))
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name) || valueText(a).localeCompare(valueText(b)))
  const extraRows = [['단계', '분류', '내용', '값', '조건', '출처', '원문']]
  const levelCounts = [0, 0, 0, 0, 0]
  for (const hit of mergedExtras) {
    levelCounts[hit.level - 1] += 1
    const { label, mark } = LEVELS[hit.level]
    const cell = (v) => (mark ? { v, mark } : v)
    extraRows.push([cell(`${hit.level}단계`), cell(label), cell(hit.name), cell(valueText(hit)), hit.condition, hit.sources.join('\n'), hit.quote])
  }

  const byRel = new Map(entries.map((entry) => [entry.rel, entry]))
  const docRows = [['문서', '상태', '문서 종류', '요약', '항목 수', '비고']]
  for (const file of files) {
    const entry = byRel.get(file.rel)
    const state = { ok: '색인됨', failed: '실패', new: '대기', stale: '바뀜', dup: '중복 제외', skipped: '이미지 제외' }[file.state] || file.state
    const note = file.dupOf ? `같은 파일: ${file.dupOf}` : file.error || entry?.note || ''
    const ok = file.state === 'ok'
    docRows.push([file.rel, state, ok ? entry?.docType || '' : '', ok ? entry?.summary || '' : '', String(file.items || 0), note])
  }

  const tagSheet = table ? buildTagSheet(table, columns) : null
  const summary = buildSummary({
    projectName,
    table,
    datasheetRel,
    files,
    columns,
    quantity: tagSheet ? quantityBlock(table, tagSheet) : null,
    top: topItems(columns, mergedExtras),
  })
  const sheets = [
    summary,
    ...(tagSheet ? [tagSheet.sheet] : []),
    { name: SHEET.detail, rows, widths: [26, 40, 10, 34, 34, 40, 30, 30, 50, 50], mergeCols: [0, 1, 2, 3] },
    { name: SHEET.extra, rows: extraRows, widths: [8, 12, 34, 34, 40, 50, 50], mergeCols: [0, 1, 2, 3] },
    { name: SHEET.docs, rows: docRows, widths: [50, 10, 18, 60, 8, 40] },
  ]
  if (table?.notes.length) {
    sheets.push({ name: '데이터시트 비고', rows: [[`${datasheetRel} 표 아래 비고`], ...table.notes.map((note) => [note])], widths: [140] })
  }
  const file = outputPath(projectName, '데이터시트 기준 정리')
  writeXlsx(file, sheets)
  return {
    path: file,
    name: path.basename(file),
    size: fs.statSync(file).size,
    columns: columns.length,
    covered: columns.filter((c) => c.hits.length).length,
    instructions,
    judged,
    additions: mergedExtras.length,
    levels: levelCounts,
  }
}

module.exports = { readSheetTable, writeReport, datasheetRecords, scopeItems, scopeDictionary }
