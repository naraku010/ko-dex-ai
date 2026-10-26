const { z } = require('zod')
const { tool } = require('./helpers')

function register(server) {
  server.registerTool(
    'render_drawing_3d',
    {
      description:
        '프로젝트 안의 도면 파일로 그 부품의 3D 입체 제품 이미지를 만들어 대화에 붙인다. ' +
        '사용자가 특정 모델·태그 도면의 입체 이미지나 3D 이미지를 만들어 달라고 하면 tag만 넣어 호출하라. ' +
        '툴이 그 태그가 들어 있는 파일(PDF가 아닐 수 있음)을 찾아 다시 분석한 뒤 이미지를 만든다. ' +
        '쪽을 직접 알지 못하면 file과 page를 넣지 마라. 데이터시트 색인으로 도면 쪽을 추측하지 마라. ' +
        '이미지는 화면이 따로 보여주므로 답변에는 파일 경로를 쓰지 말고 어떤 도면으로 만들었는지만 말하라.',
      inputSchema: {
        tag: z.string().min(2).describe('찾을 도면의 태그(모델) 번호'),
        file: z.string().optional().describe('이미 확인한 프로젝트 안 도면 파일의 상대 경로. 모르면 비운다'),
        page: z.number().int().positive().optional().describe('PDF에서 확인한 쪽 번호. 이미지 파일이거나 모르면 비운다'),
      },
    },
    tool(async ({ tag, file, page }) => {
      const result = await require('../../assistant/host').renderIndexedDrawing({ tag, file, page })
      return { 결과: '3D 이미지를 만들어 대화에 붙였습니다.', 태그: result.tag, 쪽: result.page, 도면: result.file }
    }),
  )
}

module.exports = { register }
