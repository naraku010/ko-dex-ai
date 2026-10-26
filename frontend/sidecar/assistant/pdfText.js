// PDF 글자 층을 이 PC에서 꺼낸다. 스캔본이면 글자가 거의 안 나온다.

const fs = require('fs')
const pdfParse = require('pdf-parse/lib/pdf-parse.js')

const MIN_CHARS_PER_PAGE = 40

function renderPage(pageData) {
  return pageData.getTextContent({ normalizeWhitespace: true }).then((content) => {
    let lastY = null
    let text = ''
    for (const item of content.items) {
      const y = item.transform[5]
      if (lastY !== null && Math.abs(y - lastY) > 2) text += '\n'
      else if (text && !text.endsWith(' ')) text += ' '
      text += item.str
      lastY = y
    }
    return `\n[p.${pageData.pageIndex + 1}]\n${text}`
  })
}

// pdf.js 1.x는 경고를 console.log로 찍는다. 사이드카 stdout을 더럽히지 않게 막는다.
async function pdfText(filePath) {
  const log = console.log
  console.log = () => {}
  try {
    const result = await pdfParse(fs.readFileSync(filePath), { pagerender: renderPage })
    const text = String(result.text || '').replace(/\u0000/g, '')
    const pages = result.numpages || 1
    const chars = text.replace(/\[p\.\d+\]|\s/g, '').length
    return { text, pages, scanned: chars / pages < MIN_CHARS_PER_PAGE }
  } finally {
    console.log = log
  }
}

const TAG_RE = /\b\d{3}-\d{3}-[A-Z]{1,4}-\d{2,6}\b/g
const PMI_RE = /\bPMI\s*[:：]?\s*(Yes|No|N\/?A|-)(?![A-Za-z])/i
const LIST_TAGS = 4

// 한 파일에 도면이 여러 장일 때 고를 수 있게 쪽마다 태그와 PMI 값을 뽑는다.
// 태그가 여럿 나열된 쪽은 도면 목록으로 본다.
async function drawingPages(filePath) {
  const { text, pages } = await pdfText(filePath)
  const parts = text.split(/\n\[p\.(\d+)\]\n/)
  const items = []
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1] || ''
    const tags = [...new Set(body.match(TAG_RE) || [])]
    const pmi = (body.match(PMI_RE) || [])[1] || ''
    items.push({
      page: Number(parts[i]),
      tag: tags.length && tags.length < LIST_TAGS ? tags[0] : '',
      list: tags.length >= LIST_TAGS,
      pmi: pmi.toLowerCase() === 'yes' ? 'Yes' : pmi,
    })
  }
  return { pages, items }
}

module.exports = { pdfText, drawingPages }
