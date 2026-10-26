// shop 채널을 앱 경로로 붙여본다. manifest 검증 → 툴 호출 → 카드 UI 이벤트까지 확인.
// 사용법: egi-channel에서 shop-channel을 띄운 뒤 node scripts/shop-check.js

const client = require('../sidecar/channels/client')
const mcpUi = require('../sidecar/mcp/ui')

const URL = process.env.SHOP_URL || '127.0.0.1:8803'
const KEY = process.env.SHOP_KEY || 'demo-key-1234'
const USER = { user_id: '1', user_name: '김대리', role: 'manager' }

let failed = 0

function check(label, condition, detail = '') {
  if (!condition) failed += 1
  console.log(`[${condition ? 'ok' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const { url, manifest } = await client.fetchManifest(URL, KEY)
  const channel = { ...manifest, url, apiKey: KEY, credentials: {} }

  check('URL 스킴 자동 판정', url === 'http://127.0.0.1:8803', url)
  check('manifest 검증 통과', manifest.id === 'shop', `${manifest.name} / 툴 ${manifest.tools.length}개`)
  check('자격증명 요구 없음', (manifest.credentialFields ?? []).length === 0)
  check('시스템 프롬프트 존재', (manifest.systemPrompt || '').includes('쇼핑몰'))

  const events = []
  mcpUi.setEmitter((payload) => events.push(payload))

  const top = await client.callTool(channel, 'get_top_products', { metric: 'revenue', limit: 4 }, USER)
  check('툴 결과 수신', Array.isArray(top['순위']) && top['순위'].length === 4)
  check('카드 이벤트 발생', events.length === 1, `${events.length}건`)

  const block = events[0] || {}
  check('이벤트 타입', block.type === 'cards')
  check('이벤트 id 부여', typeof block.id === 'string' && block.id.length > 20)
  check('카드 4장', (block.items ?? []).length === 4)
  check(
    '모든 카드에 이미지 URL',
    (block.items ?? []).every((item) => /^http:\/\/127\.0\.0\.1:8803\/images\/.+\.jpg$/.test(item.image || '')),
  )
  check(
    '카드 필드 정리됨',
    (block.items ?? []).every((item) => item.title && item.badge && item.fields.length >= 2),
    JSON.stringify(block.items?.[0] ?? {}),
  )

  // 이미지가 실제로 받아지는지 (앱 webview가 같은 방식으로 가져간다)
  const image = await fetch(block.items[0].image)
  const bytes = (await image.arrayBuffer()).byteLength
  check('이미지 다운로드', image.ok && bytes > 5000, `HTTP ${image.status} ${image.headers.get('content-type')} ${bytes}바이트`)

  // 카드가 없는 툴은 UI 이벤트를 만들지 않아야 한다
  events.length = 0
  const brief = await client.callTool(channel, 'get_daily_briefing', {}, USER)
  check('브리핑 조회', typeof brief['매출'] === 'number')
  check('카드 없는 툴은 이벤트 없음', events.length === 0)

  // 툴 오류는 사용자 문구로 전달되어야 한다
  events.length = 0
  let message = ''
  try {
    await client.callTool(channel, 'get_product_detail', { sku: 'NOPE-99' }, USER)
  } catch (err) {
    message = err.message
  }
  check('툴 오류 문구 전달', message.includes('찾을 수 없습니다'), message)
  check('오류 시 카드 없음', events.length === 0)

  // 헤더 없이 부르면 채널이 막아야 한다
  message = ''
  try {
    await client.callTool({ ...channel, apiKey: 'wrong-key' }, 'get_data_range', {}, USER)
  } catch (err) {
    message = err.message
  }
  check('잘못된 키 거부', message.length > 0, message)

  mcpUi.setEmitter(null)
  console.log(failed === 0 ? '\n전부 통과' : `\n실패 ${failed}건`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('실행 실패:', err?.message || err)
  process.exit(1)
})
