const EXACT = {
  default: 'CLI 기본값 · 계정 권장 모델을 그대로 씁니다',
  sonnet: '속도와 정확도의 균형 · 일상 작업에 권장',
  opus: '가장 정확 · 느리지만 어려운 질문에 강함',
  fable: '최신 모델 · 요금제에 따라 사용하지 못할 수 있음',
  haiku: '빠르고 경제적 · 짧은 조회에 적합',
  'gpt-5.6-sol': '복잡한 코딩·분석에 강함',
  'gpt-5.6-terra': '성능과 비용의 균형 · 일상 작업에 권장',
  'gpt-5.6-luna': '빠르고 경제적 · 반복 작업용',
  'gpt-5.5': '이전 세대 검증된 모델 · 일반 작업용',
  'gpt-5.4': '일상 코딩·조회에 충분한 성능',
  'gpt-5.4-mini': '작고 빠름 · 단순한 작업용',
  'gpt-5.3-codex-spark': '초고속 코딩 프리뷰 · Pro 계정 전용',
  'gpt-6-astra': '가장 강력 · 어려운 복합 작업용',
}

const FAMILIES = [
  { test: /sonnet/i, hint: '속도와 정확도의 균형 · 일상 작업에 권장' },
  { test: /opus/i, hint: '가장 정확 · 느리지만 어려운 질문에 강함' },
  { test: /fable/i, hint: '최신 모델 · 요금제에 따라 사용하지 못할 수 있음' },
  { test: /haiku/i, hint: '빠르고 경제적 · 짧은 조회에 적합' },
  { test: /sol/i, hint: '복잡한 코딩·분석에 강함' },
  { test: /terra/i, hint: '성능과 비용의 균형 · 일상 작업에 권장' },
  { test: /luna/i, hint: '빠르고 경제적 · 반복 작업용' },
  { test: /spark/i, hint: '초고속 응답 · 일부 계정만 사용 가능' },
  { test: /astra/i, hint: '가장 어려운 복합 작업용' },
  { test: /mini/i, hint: '작고 빠름 · 단순한 작업용' },
]

function koreanHint(id, fallback) {
  const key = String(id || '').trim().toLowerCase()
  if (EXACT[key]) return EXACT[key]
  const family = FAMILIES.find((item) => item.test.test(key))
  if (family) return family.hint
  const text = String(fallback || '')
  if (/[\uac00-\ud7a3]/.test(text)) return text
  return '이 계정의 CLI에서 가져온 모델'
}

function isCurrentModel(id) {
  const key = String(id || '').trim().toLowerCase()
  if (!key) return false
  if (key === 'default' || key === 'sonnet' || key === 'opus' || key === 'fable' || key === 'haiku') return true
  if (/-\d{8}$/.test(key)) return false
  if (/claude-3\b/.test(key)) return false
  if (/gpt-5\.[0-5](?!\d)/.test(key) && !/spark/.test(key)) return false
  if (/gpt-4\b|o1\b|o3\b|o4\b/.test(key)) return false
  return true
}

function keepCurrentModels(items) {
  return (items || []).filter((item) => isCurrentModel(item?.id || item))
}

module.exports = { koreanHint, isCurrentModel, keepCurrentModels }
