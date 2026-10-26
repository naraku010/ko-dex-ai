import { isTauri } from '@/lib/tauri'

export const CONTACT_EMAIL = 'naraku010@gmail.com'

// 기본 메일 앱으로 문의 메일을 연다. 앱 버전을 본문에 넣어 답변할 때 환경을 바로 알 수 있게 한다.
export async function openContactMail(): Promise<void> {
  let version = ''
  if (isTauri()) {
    const { getVersion } = await import('@tauri-apps/api/app')
    version = await getVersion().catch(() => '')
  }
  const subject = encodeURIComponent('[KODEX AI] 문의')
  const body = encodeURIComponent(`\n\n---\n앱 버전: ${version || '알 수 없음'}`)
  const url = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`

  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
    return
  }
  window.location.href = url
}
