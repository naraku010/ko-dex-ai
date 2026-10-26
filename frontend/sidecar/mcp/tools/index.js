const remote = require('./remote')

// 채널과 무관하게 항상 올라가는 툴. 데이터 조회 툴은 전부 채널이 제공한다.
const always = [
  require('./whoami'),
  require('./chart'),
  require('./calendar'),
  require('./followups'),
  require('./drawing3d'),
  require('./skills'),
]

function registerTools(server, channel) {
  for (const mod of always) mod.register(server, channel)
  if (channel?.url) remote.register(server, channel)
}

module.exports = { registerTools }
