const auth = require('../../auth')
const channelStore = require('../../channels/store')
const { tool } = require('./helpers')

function register(server) {
  server.registerTool(
    'whoami',
    {
      description:
        '현재 로그인한 사용자(본인) 정보와 접속 중인 채널을 반환한다. ' +
        '새 대화의 첫 응답 전에 반드시 한 번 호출한다. 인사만 해도 호출한다.',
      inputSchema: {},
    },
    tool(async () => {
      const me = auth.getUser()
      if (!me?.user_id) throw new Error('로그인 정보가 없습니다. 다시 로그인해주세요.')
      const isAdmin = me.role === 'admin'
      let channel = null
      try {
        channel = channelStore.getActive()
      } catch {
        channel = null
      }
      return {
        이름: me.user_name,
        소속: [me.department, me.position].filter(Boolean).join(' ') || '-',
        역할: isAdmin ? '관리자' : '매니저',
        채널: channel?.name ?? '연결된 채널 없음',
        채널설명: channel?.description || '-',
        권한: isAdmin
          ? '관리자 — 이 채널이 제공하는 모든 조회 툴을 사용할 수 있다.'
          : '매니저 — 이 채널이 제공하는 조회 툴을 사용할 수 있다.',
      }
    }),
  )
}

module.exports = { register }
