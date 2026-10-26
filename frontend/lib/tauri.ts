import type { AssistantEvent } from '@/types/assistant'

export function isTauri(): boolean {
  return typeof window !== 'undefined' && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

function invokeErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err.trim()) return err
  if (err && typeof err === 'object') {
    const record = err as { message?: unknown; error?: unknown }
    if (typeof record.message === 'string' && record.message.trim()) return record.message
    if (typeof record.error === 'string' && record.error.trim()) return record.error
  }
  return '사이드카 요청에 실패했습니다.'
}

export async function sidecarRequest<T = unknown>(cmd: string, payload: unknown = {}): Promise<T> {
  if (!isTauri()) {
    throw new Error('데스크톱 앱에서만 사용할 수 있습니다.')
  }
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    return await invoke<T>('sidecar_request', { cmd, payload })
  } catch (err) {
    throw new Error(invokeErrorMessage(err))
  }
}

export async function listenAssistantEvents(handler: (evt: AssistantEvent) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<AssistantEvent>('assistant-event', (event) => {
    handler(event.payload)
  })
  return unlisten
}
