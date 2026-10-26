// 의존성 없이 xlsx를 쓴다. 기본은 첫 행을 굵은 머리글로 고정하고, 칸은 줄바꿈해 보여준다.

const fs = require('fs')
const zlib = require('zlib')

function esc(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function colName(index) {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

const MARK_STYLE = { true: 3, yellow: 3, red: 4, orange: 5 }
const NAMED_STYLE = { head: 1, title: 6, section: 7, added: 8, note: 9, addedHead: 10 }

const cellText = (cell) => String((cell && typeof cell === 'object' ? cell.v : cell) ?? '')

function styleOf(cell, isHead) {
  if (cell && typeof cell === 'object') {
    if (cell.style && NAMED_STYLE[cell.style]) return NAMED_STYLE[cell.style]
    if (cell.mark && MARK_STYLE[cell.mark]) return MARK_STYLE[cell.mark]
  }
  return isHead ? 1 : 2
}

// mergeCols 순서대로 위아래로 같은 값이 이어지면 병합한다.
// 앞 열의 병합 범위를 넘어서지 않게 해서, 다른 항목의 같은 값끼리 붙지 않게 한다.
function mergeRanges(rows, mergeCols) {
  const ranges = []
  const breaks = new Set([1])
  for (const col of mergeCols) {
    const starts = []
    let start = 1
    for (let r = 2; r <= rows.length; r += 1) {
      const same = r < rows.length && !breaks.has(r) && cellText(rows[r][col]) === cellText(rows[start][col])
      if (same) continue
      if (r - start > 1 && cellText(rows[start][col])) ranges.push({ r1: start, c1: col, r2: r - 1, c2: col })
      starts.push(start)
      start = r
    }
    for (const s of starts) breaks.add(s)
  }
  return ranges
}

function cellXml(cell, ref, style) {
  if (cell && typeof cell === 'object' && cell.f) {
    return `<c r="${ref}" s="${style}"><f>${esc(String(cell.f).replace(/^=/, ''))}</f></c>`
  }
  const raw = cell && typeof cell === 'object' ? cell.v : cell
  if (typeof raw === 'number' && Number.isFinite(raw)) return `<c r="${ref}" s="${style}"><v>${raw}</v></c>`
  const text = cellText(cell).slice(0, 32000)
  if (!text) return `<c r="${ref}" s="${style}"/>`
  return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${esc(text)}</t></is></c>`
}

// headerRow: 머리글 행(0부터). null이면 머리글·고정·필터 없이 쓴다(요약처럼 구역이 여러 개인 시트).
// freezeCols: 가로로 넘겨도 고정할 왼쪽 열 수.
function sheetXml({ rows, widths = [], mergeCols = [], merges = [], headerRow = 0, freezeCols = 0 }) {
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : ''
  const ranges = [...(headerRow === 0 && rows.length > 2 ? mergeRanges(rows, mergeCols) : []), ...merges]
  const covered = new Set()
  for (const { r1, c1, r2, c2 } of ranges) {
    for (let r = r1; r <= r2; r += 1) {
      for (let c = c1; c <= c2; c += 1) if (r !== r1 || c !== c1) covered.add(`${r}:${c}`)
    }
  }
  const width = headerRow === null ? 0 : rows[headerRow]?.length || 0
  const body = rows.map((row, r) => {
    const isHead = headerRow !== null && r === headerRow
    const cells = Array.from({ length: Math.max(width, row.length) }, (_, c) => {
      const ref = `${colName(c)}${r + 1}`
      const cell = row[c]
      if (covered.has(`${r}:${c}`)) return `<c r="${ref}" s="${styleOf(cell, isHead)}"/>`
      if (cell === undefined || cell === null || cell === '') {
        return isHead || headerRow === null ? '' : `<c r="${ref}" s="2"/>`
      }
      return cellXml(cell, ref, styleOf(cell, isHead))
    }).join('')
    return `<row r="${r + 1}">${cells}</row>`
  }).join('')
  const mergeXml = ranges.length
    ? `<mergeCells count="${ranges.length}">${ranges.map(({ r1, c1, r2, c2 }) => `<mergeCell ref="${colName(c1)}${r1 + 1}:${colName(c2)}${r2 + 1}"/>`).join('')}</mergeCells>`
    : ''
  const frozen = headerRow === null
    ? '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
    : freezeCols
      ? `<sheetViews><sheetView workbookViewId="0"><pane xSplit="${freezeCols}" ySplit="${headerRow + 1}" topLeftCell="${colName(freezeCols)}${headerRow + 2}" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>`
      : `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow + 1}" topLeftCell="A${headerRow + 2}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
  const filter = headerRow !== null && rows.length > headerRow + 1 && width
    ? `<autoFilter ref="A${headerRow + 1}:${colName(width - 1)}${rows.length}"/>`
    : ''
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + frozen
    + `${cols}<sheetData>${body}</sheetData>`
    + filter
    + mergeXml
    + '</worksheet>'
}

const TOP = '<alignment wrapText="1" vertical="top"/>'
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="7"><font><sz val="10"/><name val="맑은 고딕"/></font><font><b/><sz val="10"/><name val="맑은 고딕"/></font>'
  + '<font><b/><sz val="10"/><color rgb="FF9C0006"/><name val="맑은 고딕"/></font>'
  + '<font><b/><sz val="10"/><color rgb="FF833C0B"/><name val="맑은 고딕"/></font>'
  + '<font><b/><sz val="14"/><name val="맑은 고딕"/></font>'
  + '<font><b/><sz val="11"/><color rgb="FF1F4E78"/><name val="맑은 고딕"/></font>'
  + '<font><sz val="9"/><color rgb="FF595959"/><name val="맑은 고딕"/></font></fonts>'
  + '<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFFCE4D6"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFE2EFDA"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="2"><border/><border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right>'
  + '<top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="11"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>'
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">${TOP}</xf>`
  + `<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1">${TOP}</xf>`
  + `<xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${TOP}</xf>`
  + `<xf numFmtId="0" fontId="3" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${TOP}</xf>`
  + '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + `<xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1">${TOP}</xf>`
  + '<xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="0" fontId="1" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf></cellXfs>'
  + '</styleSheet>'

function zip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8')
    const packed = zlib.deflateRawSync(data)
    const crc = zlib.crc32(data)
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, packed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + packed.length
  }
  const centralSize = centrals.reduce((sum, buf) => sum + buf.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

function sheetName(name, i) {
  return String(name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31)
}

// 수식에서 다른 시트를 가리킬 때 쓰는 이름. writeXlsx와 같은 규칙으로 자른다.
function sheetRef(name) {
  return `'${sheetName(name, 0).replace(/'/g, "''")}'`
}

// sheets: [{ name, rows, widths?, mergeCols?, merges?, headerRow? }]
// 칸: 문자열·숫자, 또는 { v, mark, style, f }
// mark: true·'yellow' 노랑, 'red' 빨강 굵게, 'orange' 주황 굵게
// style: 'head' 머리글, 'title' 제목, 'section' 구역 제목, 'added' 추가사항(연두), 'note' 작은 회색 글씨
// f: 수식. 열 때 Excel이 다시 계산한다.
function writeXlsx(filePath, sheets) {
  const names = sheets.map((sheet, i) => esc(sheetName(sheet.name, i)))
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + names.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + '</Relationships>'],
    ['xl/styles.xml', STYLES],
    ...sheets.map((sheet, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet)]),
  ]
  fs.writeFileSync(filePath, zip(files))
  return filePath
}

module.exports = { writeXlsx, colName, sheetRef }
