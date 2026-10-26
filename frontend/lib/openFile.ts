import { sidecarRequest } from '@/lib/tauri'

function cleanPath(path: string) {
  return path.trim().replace(/^["'`]+|["'`]+$/g, '')
}

export async function openLocalFile(path: string): Promise<void> {
  const cleaned = cleanPath(path)
  if (!cleaned) return
  await sidecarRequest('openFile', { path: cleaned })
}

export async function revealLocalFile(path: string): Promise<void> {
  const cleaned = cleanPath(path)
  if (!cleaned) return
  await sidecarRequest('revealFile', { path: cleaned })
}
