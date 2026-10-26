const { z } = require('zod')
const { randomUUID } = require('crypto')
const { emitUi } = require('../ui')
const { tool } = require('./helpers')

const MAX_EVENTS = 90
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TONES = ['info', 'ok', 'warn', 'danger']

function toEokMan(amount) {
  const sign = amount < 0 ? '-' : ''
  const abs = Math.round(Math.abs(amount))
  const eok = Math.floor(abs / 100000000)
  const man = Math.floor((abs % 100000000) / 10000)
  if (eok && man) return `${sign}${eok.toLocaleString('ko-KR')}억 ${man.toLocaleString('ko-KR')}만`
  if (eok) return `${sign}${eok.toLocaleString('ko-KR')}억`
  if (man) return `${sign}${man.toLocaleString('ko-KR')}만`
  return `${sign}${abs.toLocaleString('ko-KR')}원`
}

function wonText(value) {
  return String(value || '')
    .replace(/(-?[\d,.]+)\s*백만\s*원?/g, (match, raw) => {
      const n = Number(String(raw).replace(/,/g, ''))
      return Number.isFinite(n) ? toEokMan(n * 1000000) : match
    })
    .replace(/(-?[\d,]+)\s*원/g, (match, raw) => {
      const n = Number(String(raw).replace(/,/g, ''))
      return Number.isFinite(n) && Math.abs(n) >= 10000 ? toEokMan(n) : match
    })
}

function register(server) {
  server.registerTool(
    'render_calendar',
    {
      description:
        '납기·출고·생산·점검처럼 날짜에 점이 찍히는 일정을 대화 안 달력으로 그린다. ' +
        '추이·비율·비교는 render_chart를 쓰고, 날짜 배치는 이 툴을 쓴다. ' +
        '반드시 글로 핵심 일정을 먼저 요약한 뒤, 답변의 맨 마지막(차트보다 뒤)에 호출하라. 글보다 먼저 그리면 안 된다. 화면은 글을 모두 쓴 뒤에 달력을 붙인다. ' +
        '채널이 이미 calendar UI를 보냈으면 다시 호출하지 마라. ' +
        `일정은 최대 ${MAX_EVENTS}개. date는 YYYY-MM-DD. ` +
        'tone: info=일반, ok=완료, warn=임박, danger=초과·위험. ' +
        '금액은 억·만으로 써라. 예: 1억 2,300만, 850만. 백만원·백만 단위는 쓰지 마라.',
      inputSchema: {
        title: z.string().min(1).describe('달력 제목. 무엇을 어느 기간 기준으로 보여주는지 담아라'),
        events: z.array(z.object({
          date: z.string().regex(DATE_RE).describe('일정 날짜 YYYY-MM-DD'),
          title: z.string().min(1).describe('일정 제목. 수주번호·품명·작업명. 금액이 있으면 억·만'),
          subtitle: z.string().optional().describe('보조 설명. 거래처·호선·금액. 금액은 억·만(1억 2,300만). 백만원 금지'),
          tone: z.enum(TONES).optional().describe('info=일반, ok=완료, warn=임박, danger=초과·위험'),
        })).min(1).describe('표시할 일정'),
      },
    },
    tool(async ({ title, events }) => {
      const items = []
      for (const event of events) {
        const date = String(event.date || '').trim()
        const name = String(event.title || '').trim()
        if (!DATE_RE.test(date) || !name) continue
        const tone = TONES.includes(event.tone) ? event.tone : 'info'
        items.push({
          date,
          title: wonText(name).slice(0, 120),
          subtitle: event.subtitle ? wonText(String(event.subtitle).trim()).slice(0, 120) : null,
          tone,
        })
      }
      if (items.length === 0) throw new Error('표시할 일정이 없습니다. date는 YYYY-MM-DD여야 합니다.')

      const truncated = items.length > MAX_EVENTS
      const shown = truncated ? items.slice(0, MAX_EVENTS) : items

      const delivered = emitUi({
        type: 'calendar',
        id: randomUUID(),
        title: wonText(title),
        events: shown,
      })
      if (!delivered) {
        throw new Error('달력을 표시할 화면을 찾을 수 없습니다. 에이든 대화 화면을 열어둔 상태에서 다시 시도해주세요.')
      }

      return {
        결과: '달력을 대화에 표시했습니다.',
        제목: title,
        표시일정수: shown.length,
        시작일: shown.reduce((min, item) => (item.date < min ? item.date : min), shown[0].date),
        종료일: shown.reduce((max, item) => (item.date > max ? item.date : max), shown[0].date),
        ...(truncated ? { 안내: `일정이 많아 앞 ${MAX_EVENTS}개만 표시했습니다.` } : {}),
      }
    }),
  )
}

module.exports = { register }
