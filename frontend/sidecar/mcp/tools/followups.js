const { z } = require('zod')
const { emitUi } = require('../ui')
const { tool } = require('./helpers')

function cleanItems(items) {
  return (items ?? [])
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter((item) => item.length >= 4 && item.length <= 80)
    .slice(0, 5)
}

function register(server) {
  server.registerTool(
    'propose_followups',
    {
      description:
        '답변을 모두 마친 뒤 맨 마지막에 호출한다. ' +
        '사용자가 입력창에서 바로 보낼 후속 질문 5개를 칩으로 보여준다. ' +
        '질문 문구는 말풍선 본문에 쓰지 말고 이 툴로만 보내라. ' +
        '차트(render_chart)·달력(render_calendar)이 필요하면 그 다음에 이 툴을 호출하라. ' +
        '이미 답한 내용을 반복하지 말고, 오늘/어제/이번 주처럼 바로 조회에 쓸 짧은 한국어 질문으로 만들어라. ' +
        '설비·라인 코드(M0058, HS-16 등)는 쓰지 말고 한글명만 쓴다.',
      inputSchema: {
        items: z.array(z.string().min(4).max(80)).min(5).max(5)
          .describe('바로 보낼 수 있는 후속 질문 5개'),
      },
    },
    tool(async ({ items }) => {
      const shown = cleanItems(items)
      if (shown.length === 0) throw new Error('후속 질문 5개를 보내주세요.')

      const delivered = emitUi({ type: 'followups', items: shown })
      if (!delivered) {
        throw new Error('후속 질문을 표시할 화면을 찾을 수 없습니다.')
      }

      return { 결과: '후속 질문을 입력창 위에 표시했습니다.', 질문: shown }
    }),
  )
}

module.exports = { register }
