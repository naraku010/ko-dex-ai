const { z } = require('zod')
const auth = require('../../auth')
const skills = require('../../assistant/skills')
const { tool } = require('./helpers')

// 스킬이 하나라도 있을 때만 올린다. 목록은 시스템 프롬프트에 있다.
function register(server, channel) {
  if (skills.catalog(channel).length === 0) return
  server.registerTool(
    'use_skill',
    {
      description:
        '시스템 프롬프트의 스킬 목록에서 요청에 맞는 스킬을 불러 지침 본문을 받는다. ' +
        '받은 지침대로 답하되, 공통 규칙과 부딪히면 공통 규칙을 따른다. ' +
        '지침이 참고 파일을 가리키면 file에 그 이름을 넣어 다시 호출한다.',
      inputSchema: {
        name: z.string().min(2).max(64).describe('스킬 이름 (목록에 있는 이름 그대로)'),
        file: z.string().max(200).nullable().optional().describe('스킬에 딸린 참고 파일 이름. 본문을 받을 때는 비운다.'),
      },
    },
    tool(async ({ name, file }) => {
      const loaded = await skills.load(name, { file: file || null, user: auth.getUser() })
      return {
        스킬: loaded.name,
        ...(file ? { 파일: file } : {}),
        지침: loaded.body,
        ...(loaded.files.length ? { 참고파일: loaded.files } : {}),
      }
    }),
  )
}

module.exports = { register }
