// 외부 채널의 manifest 툴을 MCP 서버에 그대로 올린다. 실행은 채널 서버로 넘긴다.

const auth = require('../../auth')
const client = require('../../channels/client')
const { toRawShape } = require('../../channels/schema')
const { tool } = require('./helpers')

function register(server, channel) {
  for (const spec of channel.tools ?? []) {
    try {
      server.registerTool(
        spec.name,
        {
          description: spec.description,
          inputSchema: toRawShape(spec.inputSchema),
        },
        tool(async (args) => {
          const payload = Object.fromEntries(Object.entries(args ?? {}).filter(([, value]) => value !== null))
          try {
            return await client.callTool(channel, spec.name, payload, auth.getUser())
          } catch (err) {
            if (err?.code !== 'TOOL_NOT_FOUND') throw err
            await require('../../channels').ensureFresh(channel.id, { force: true })
            throw new Error(`${err.message} 채널이 갱신되어 툴 목록을 새로 받았습니다. 다음 질문부터 바뀐 툴을 씁니다.`)
          }
        }),
      )
    } catch (err) {
      process.stderr.write(`[channel] ${channel.id}/${spec.name} 등록 실패: ${err?.message || err}\n`)
    }
  }
}

module.exports = { register }
