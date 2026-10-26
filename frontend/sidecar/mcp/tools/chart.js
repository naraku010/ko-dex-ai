const { z } = require('zod')
const { randomUUID } = require('crypto')
const { emitUi } = require('../ui')
const { tool } = require('./helpers')

const MAX_POINTS = 30
const MAX_COMPARE = 3
const MAX_REF_LINES = 3
const COMPARABLE = new Set(['bar', 'hbar', 'line', 'area'])

const TYPES = {
  bar: '세로 막대. 항목이 적고 이름이 짧을 때',
  hbar: '가로 막대. 이름이 길거나 순위·랭킹',
  line: '꺾은선. 날짜·월 같은 시간 추이',
  area: '영역. 누적·규모가 보이는 추이',
  pie: '원. 구성 비율(조각 2~8개)',
  funnel: '깔때기. 단계별 감소(문의→주문→결제)',
  gauge: '게이지. 목표 대비 현재값 하나. series[0]=현재, series[1]=목표(없으면 100 또는 현재의 상한)',
}

function register(server) {
  server.registerTool(
    'render_chart',
    {
      description:
        '조회·집계한 수치를 대화 안에 차트로 그린다. ' +
        '질문 성격에 맞게 종류를 바꿔라. 매번 bar만 쓰지 마라. ' +
        Object.entries(TYPES).map(([k, v]) => `${k}=${v}`).join('. ') + '. ' +
        '추이·비율·비교·단계·목표달성가 보이면 적극적으로 사용하라. ' +
        '전년·전월·목표·다른 그룹과 비교할 수 있으면 compare로 함께 그려라. 목표치·기준치가 있으면 refLines, 평균이 의미 있으면 showAverage를 켜라. ' +
        '합계·최고·증감률 같은 요약 수치는 화면이 자동으로 계산해 보여준다. ' +
        '반드시 글로 핵심 수치를 먼저 요약한 뒤, 답변의 맨 마지막에 이 툴을 호출하라. 글보다 먼저 그리면 안 된다. 화면은 글을 모두 쓴 뒤에 차트를 붙인다. ' +
        `데이터 포인트는 최대 ${MAX_POINTS}개까지만 표시된다.`,
      inputSchema: {
        chartType: z.enum(Object.keys(TYPES)).describe(
          Object.entries(TYPES).map(([k, v]) => `${k}: ${v}`).join(' / '),
        ),
        title: z.string().min(1).describe('차트 제목. 무엇을 어느 기간 기준으로 보여주는지 담아라'),
        unit: z.string().optional().describe('값의 단위. 예: 원, 개, 건, %'),
        series: z.array(z.object({
          label: z.string().describe('항목 이름 (x축 또는 조각 이름)'),
          value: z.number().describe('수치'),
        })).min(1).describe('표시할 데이터. 이름→label, 값→value'),
        seriesName: z.string().optional().describe('series의 범례 이름. compare를 쓸 때 필수. 예: 2026년, 실적'),
        compare: z.array(z.object({
          name: z.string().describe('비교 시리즈 범례 이름. 예: 2025년, 목표, 식품'),
          values: z.array(z.number()).describe('series와 같은 순서·같은 개수의 값'),
        })).max(MAX_COMPARE).optional().describe(
          `bar/hbar/line/area 전용. series와 나란히 그릴 비교 시리즈(최대 ${MAX_COMPARE}개). 막대는 묶음, 선은 여러 줄로 그린다`,
        ),
        stacked: z.boolean().optional().describe('bar/hbar에서 series와 compare를 한 막대에 쌓는다. 구성과 합계를 함께 볼 때'),
        refLines: z.array(z.object({
          label: z.string().describe('기준선 이름. 예: 목표, 손익분기'),
          value: z.number(),
        })).max(MAX_REF_LINES).optional().describe('bar/hbar/line/area에 점선으로 긋는 기준선'),
        showAverage: z.boolean().optional().describe('series 평균을 기준선으로 긋는다'),
      },
    },
    tool(async ({ chartType, title, unit, series, seriesName, compare, stacked, refLines, showAverage }) => {
      const kept = series
        .map((p, index) => ({ label: String(p.label), value: Number(p.value), index }))
        .filter((p) => Number.isFinite(p.value))

      if (kept.length === 0) throw new Error('표시할 수 있는 값이 없습니다. value는 숫자여야 합니다.')

      if ((chartType === 'pie' || chartType === 'funnel') && kept.some((p) => p.value < 0)) {
        throw new Error('원·깔때기 그래프는 음수 값을 표시할 수 없습니다. bar 또는 hbar를 사용하세요.')
      }

      if (chartType === 'gauge' && kept.length > 2) {
        kept.length = 2
      }

      const truncated = kept.length > MAX_POINTS
      const shown = truncated ? kept.slice(0, MAX_POINTS) : kept
      const comparable = COMPARABLE.has(chartType)

      const others = comparable
        ? (compare ?? []).map((c) => ({
            name: String(c.name),
            values: shown.map((p) => {
              const v = Number(c.values?.[p.index])
              return Number.isFinite(v) ? v : 0
            }),
          }))
        : []

      const hasNegative = shown.some((p) => p.value < 0) || others.some((c) => c.values.some((v) => v < 0))
      if (stacked && hasNegative) {
        throw new Error('누적 막대는 음수 값을 표시할 수 없습니다. stacked 없이 다시 그리세요.')
      }

      const lines = comparable
        ? (refLines ?? []).filter((r) => Number.isFinite(Number(r.value))).map((r) => ({ label: String(r.label), value: Number(r.value) }))
        : []
      if (comparable && showAverage) {
        const avg = shown.reduce((sum, p) => sum + p.value, 0) / shown.length
        lines.push({ label: '평균', value: Math.round(avg * 10) / 10 })
      }

      const delivered = emitUi({
        type: 'chart',
        id: randomUUID(),
        chartType,
        title,
        unit: unit ?? null,
        series: shown.map(({ label, value }) => ({ label, value })),
        seriesName: seriesName ?? null,
        compare: others,
        refLines: lines,
        stacked: Boolean(stacked && others.length > 0 && (chartType === 'bar' || chartType === 'hbar')),
      })
      if (!delivered) {
        throw new Error('차트를 표시할 화면을 찾을 수 없습니다. 에이든 대화 화면을 열어둔 상태에서 다시 시도해주세요.')
      }

      return {
        결과: '차트를 대화에 표시했습니다.',
        종류: chartType,
        제목: title,
        표시항목수: shown.length,
        ...(others.length ? { 비교시리즈: others.map((c) => c.name) } : {}),
        ...(truncated ? { 안내: `항목이 많아 상위 ${MAX_POINTS}개만 표시했습니다.` } : {}),
      }
    }),
  )
}

module.exports = { register }
