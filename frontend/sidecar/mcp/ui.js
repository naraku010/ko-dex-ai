// MCP 툴 → 렌더러 단방향 UI 통로. 차트처럼 표시 전용 이벤트를 보낸다.

let emit = null

function setEmitter(fn) {
  emit = typeof fn === 'function' ? fn : null
}

function emitUi(payload) {
  if (!emit) return false
  try {
    emit(payload)
    return true
  } catch {
    return false
  }
}

module.exports = { setEmitter, emitUi }
