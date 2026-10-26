// MCP 툴 이름 → 한글 라벨. 어댑터가 CLI 이벤트를 UI 이벤트로 옮길 때 공통으로 쓴다.
// 조회 툴 라벨은 채널 manifest에서 오고, 여기에는 항상 올라가는 툴만 둔다.

const TOOL_LABEL = {
  whoami: '내 정보 확인',
  render_chart: '차트 그리기',
  render_calendar: '달력 그리기',
  propose_followups: '다음 질문',
  render_drawing_3d: '도면 3D 이미지',
  use_skill: '스킬 불러오기',
}

// 활성 채널이 manifest로 알려준 라벨. 채널이 바뀔 때마다 갈아끼운다.
let channelLabels = {}

function setChannelLabels(tools) {
  const next = {}
  for (const spec of tools ?? []) {
    if (spec?.name && spec?.label) next[spec.name] = String(spec.label)
  }
  channelLabels = next
}

// rawName 예: "mcp__kodex__whoami"(Claude) 또는 "whoami"(Codex). 서버 접두어를 떼고 라벨을 찾는다.
function toolLabel(rawName, serverName) {
  let short = String(rawName || '')
  if (serverName) short = short.replace(new RegExp(`^mcp__${serverName}__`), '')
  short = short.replace(/^mcp__[^_]+__/, '')
  return { short, label: TOOL_LABEL[short] ?? channelLabels[short] ?? short }
}

module.exports = { TOOL_LABEL, toolLabel, setChannelLabels }
