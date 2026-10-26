import { create } from 'zustand'
import { collapseCardBlocks } from '@/lib/cards'
import { collapseReports } from '@/lib/reports'
import { openLocalFile } from '@/lib/openFile'
import { listenAssistantEvents, sidecarRequest } from '@/lib/tauri'
import * as db from '@/lib/db'
import { useConversationStore } from './conversationStore'
import { useFilesStore } from './filesStore'
import type {
  AdapterUsage,
  AssistantEvent,
  AssistantStatus,
  ChannelInfo,
  ChannelPreview,
  ChatMessage,
  DetectResult,
} from '@/types/assistant'

interface ChannelListResult {
  activeId: string
  channels: ChannelInfo[]
}

interface AssistantState {
  messages: ChatMessage[]
  status: AssistantStatus | null
  isSending: boolean
  mcpStatus: string | null
  error: string | null
  subscribed: boolean
  followups: string[]
  followupsLoading: boolean
  usage: AdapterUsage[]
  usageLoading: boolean
  setupLog: string[]
  setupLogOwner: string | null
  channels: ChannelInfo[]
  channelId: string

  fetchChannels: () => Promise<void>
  previewChannel: (url: string, apiKey: string) => Promise<ChannelPreview>
  addChannel: (url: string, apiKey: string, credentials?: Record<string, string>) => Promise<ChannelInfo>
  removeChannel: (channelId: string) => Promise<void>
  refreshChannel: (channelId: string) => Promise<void>
  refreshActiveChannel: () => Promise<void>
  setChannelCredentials: (channelId: string, credentials: Record<string, string>) => Promise<void>
  setChannel: (channelId: string) => Promise<void>
  fetchStatus: () => Promise<void>
  fetchUsage: () => Promise<void>
  resetUsage: (adapterId?: string) => Promise<void>
  detectCli: (manualPath?: string, adapterId?: string) => Promise<DetectResult>
  installCli: (adapterId?: string) => Promise<DetectResult>
  loginCli: (adapterId?: string) => Promise<void>
  clearSetupLog: () => void
  connect: (manualPath?: string, adapterId?: string, apiKey?: string) => Promise<DetectResult>
  saveApiKey: (adapterId: string, apiKey: string) => Promise<void>
  setAdapter: (adapterId: string) => Promise<void>
  setModel: (model: string) => Promise<void>
  send: (text: string, userId: string, attachments?: OutgoingAttachment[]) => Promise<void>
  pushNote: (text: string) => string
  reviseNote: (id: string, text: string) => void
  cancel: () => Promise<void>
  subscribe: () => () => void
  loadMessages: (messages: ChatMessage[]) => void
  resetMessages: () => void
  clearError: () => void
}

export type OutgoingAttachment = {
  name: string
  mime: string
  bytesBase64: string
  drawing?: boolean
  // 도면 PDF에서 이미지로 만들 쪽(1부터). 비우면 1쪽.
  pages?: number[]
  previewUrl?: string
}

let followupSeq = 0

const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

function mergeAssistantText(current: string, incoming: string): string {
  const a = current.replace(/\s+$/, '')
  const b = incoming.replace(/^\s+/, '').replace(/\s+$/, '')
  if (!b) return current
  if (!a) return incoming.replace(/^\s+/, '')
  if (a === b) return current
  if (b.includes(a)) return b
  if (a.includes(b) && b.length >= 12) return current

  const max = Math.min(a.length, b.length)
  for (let n = max; n >= 12; n--) {
    if (a.slice(-n) === b.slice(0, n)) return a + b.slice(n)
  }

  const lastPara = a.split(/\n{2,}/).pop()?.trim() ?? ''
  if (lastPara.length >= 16 && b.startsWith(lastPara)) {
    return `${a.slice(0, a.lastIndexOf(lastPara))}${b}`.replace(/\n{3,}/g, '\n\n')
  }

  return `${a}\n\n${b}`
}

function normalizeFollowups(items: unknown): string[] {
  if (!Array.isArray(items)) return []
  return items.map((item) => String(item).replace(/\s+/g, ' ').trim()).filter((item) => item.length >= 4).slice(0, 5)
}

function localFollowups(question: string, answer: string): string[] {
  const src = `${question}\n${answer}`
  const pool: string[] = []
  if (/NG|불량/i.test(src)) {
    pool.push('오늘 설비별 NG 추이도 보여줘', '이번 주 불량율 목표 대비 어때?')
  }
  if (/알람|alarm/i.test(src)) pool.push('오늘 알람이 많은 설비만 골라줘')
  if (/실적|생산|목표/i.test(src)) {
    pool.push('어제랑 오늘 실적 비교해줘', '라인별 시간대 생산량도 보여줘')
  }
  if (/설비|상태|가동/i.test(src)) {
    pool.push('지금 멈춰 있는 설비 있어?', '오늘 설비 알람 요약해줘')
  }
  if (/재공|WIP|납기/i.test(src)) pool.push('납기준수율 낮은 품목 알려줘')
  const defaults = [
    '오늘 라인별 목표 대비 실적 보여줘',
    '오늘 최근 NG 알려줘',
    '오늘 알람 요약해줘',
    '어제랑 비교하면 어때?',
    '이번 주 추이로 보여줘',
  ]
  return [...new Set([...pool, ...defaults])].slice(0, 5)
}

async function requestFollowups(question: string, assistantId: string) {
  const seq = followupSeq
  if (useAssistantStore.getState().followups.length > 0) return

  setFollowupsLoading(true)
  try {
    const answer = useAssistantStore.getState().messages.find((m) => m.id === assistantId)?.text ?? ''
    const result = await sidecarRequest<{ items?: string[] }>('suggestFollowups', { question, answer })
    if (seq !== followupSeq) return
    const items = normalizeFollowups(result?.items)
    applyFollowups(items.length > 0 ? items : localFollowups(question, answer), assistantId)
  } catch {
    if (seq !== followupSeq) return
    const answer = useAssistantStore.getState().messages.find((m) => m.id === assistantId)?.text ?? ''
    applyFollowups(localFollowups(question, answer), assistantId)
  }
}

/** 입력창 위에 띄우고, 그 답변에 붙여 대화를 다시 열어도 보이게 한다. */
function applyFollowups(items: string[], assistantId: string) {
  useAssistantStore.setState((s) => ({
    followups: items,
    followupsLoading: false,
    messages: s.messages.map((m) => (m.id === assistantId ? { ...m, followups: items } : m)),
  }))
}

function setFollowupsLoading(followupsLoading: boolean) {
  useAssistantStore.setState({ followupsLoading, followups: [] })
}

let persistChain = Promise.resolve()

function persist(userId: string, messages: ChatMessage[]) {
  const snapshot = messages.map((m) => ({
    ...m,
    tools: [...m.tools],
    charts: [...m.charts],
    cards: [...m.cards],
    reports: collapseReports(m.reports ?? []),
    excels: [...(m.excels ?? [])],
    calendars: [...(m.calendars ?? [])],
    files: (m.files ?? []).map((file) => ({ id: file.id, name: file.name, path: file.path, size: file.size })),
  }))
  persistChain = persistChain
    .catch(() => undefined)
    .then(async () => {
      const conversationId = useConversationStore.getState().currentId
      if (!conversationId) return
      await db.replaceMessages(userId, conversationId, snapshot)
      await db.updateConversation(userId, conversationId, {})
    })
  return persistChain
}

export const useAssistantStore = create<AssistantState>((set, get) => ({
  messages: [],
  status: null,
  isSending: false,
  mcpStatus: null,
  error: null,
  subscribed: false,
  followups: [],
  followupsLoading: false,
  usage: [],
  usageLoading: false,
  setupLog: [],
  setupLogOwner: null,
  channels: [],
  channelId: '',

  clearError: () => set({ error: null }),
  loadMessages: (messages) => {
    const saved = [...messages].reverse().find((m) => m.role === 'assistant' && (m.followups?.length ?? 0) > 0)
    set({ messages, error: null, followups: saved?.followups ?? [], followupsLoading: false })
  },
  resetMessages: () => set({ messages: [], error: null, followups: [], followupsLoading: false }),

  fetchStatus: async () => {
    try {
      const status = await sidecarRequest<AssistantStatus>('status')
      set({
        status,
        channels: status.channels ?? get().channels,
        channelId: status.channelId ?? get().channelId,
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  fetchChannels: async () => {
    try {
      const result = await sidecarRequest<ChannelListResult>('listChannels')
      set({ channels: result?.channels ?? [], channelId: result?.activeId ?? get().channelId })
    } catch {
      // 브라우저 미리보기 등
    }
  },

  previewChannel: async (url, apiKey) =>
    sidecarRequest<ChannelPreview>('previewChannel', { url, apiKey: apiKey || null }),

  addChannel: async (url, apiKey, credentials) => {
    const result = await sidecarRequest<ChannelListResult & { channel: ChannelInfo }>('addChannel', {
      url,
      apiKey: apiKey || null,
      credentials: credentials ?? null,
    })
    set({ channels: result.channels ?? [], channelId: result.activeId ?? get().channelId })
    return result.channel
  },

  setChannelCredentials: async (channelId, credentials) => {
    const result = await sidecarRequest<ChannelListResult>('setChannelCredentials', {
      channelId,
      credentials,
    })
    set({ channels: result.channels ?? [], channelId: result.activeId ?? get().channelId })
  },

  removeChannel: async (channelId) => {
    const result = await sidecarRequest<ChannelListResult>('removeChannel', { channelId })
    set({ channels: result.channels ?? [], channelId: result.activeId ?? get().channelId })
    await get().fetchStatus()
  },

  refreshChannel: async (channelId) => {
    const result = await sidecarRequest<ChannelListResult>('refreshChannel', { channelId })
    set({ channels: result.channels ?? [], channelId: result.activeId ?? get().channelId })
  },

  refreshActiveChannel: async () => {
    const channelId = get().channelId
    if (!channelId) return
    try {
      await get().refreshChannel(channelId)
    } catch {
      // 채널 서버가 잠깐 안 되면 저장된 정보로 채팅을 이어간다.
    }
  },

  // 채널이 바뀌면 툴과 시스템 프롬프트가 달라지고 CLI 세션도 새로 시작된다.
  setChannel: async (channelId) => {
    if (get().channelId === channelId) return
    if (get().isSending || get().status?.busy) return
    try {
      const result = await sidecarRequest<ChannelListResult>('setChannel', { channelId })
      set({
        channels: result.channels ?? [],
        channelId: result.activeId ?? channelId,
        error: null,
      })
      get().resetMessages()
      await get().refreshActiveChannel()
      await get().fetchStatus()
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  fetchUsage: async () => {
    set({ usageLoading: true })
    try {
      const result = await sidecarRequest<{ adapters: AdapterUsage[] }>('getUsage')
      set({ usage: result?.adapters ?? [], usageLoading: false })
    } catch (err) {
      set({ usageLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  resetUsage: async (adapterId) => {
    await sidecarRequest('resetUsage', { adapterId: adapterId ?? null })
    await get().fetchUsage()
  },

  detectCli: async (manualPath, adapterId) => {
    const result = await sidecarRequest<DetectResult>('detect', {
      manualPath: manualPath ?? null,
      adapterId: adapterId ?? null,
    })
    await get().fetchStatus()
    return result
  },

  connect: async (manualPath, adapterId, apiKey) => {
    const result = await sidecarRequest<DetectResult>('connect', {
      manualPath: manualPath ?? null,
      adapterId: adapterId ?? null,
      apiKey: apiKey ?? null,
    })
    await get().fetchStatus()
    return result
  },

  saveApiKey: async (adapterId, apiKey) => {
    await sidecarRequest('saveApiKey', { adapterId, apiKey })
    await get().fetchStatus()
  },

  installCli: async (adapterId) => {
    const owner = adapterId || get().status?.adapterId || 'chat'
    set({ setupLog: [], setupLogOwner: owner })
    const result = await sidecarRequest<DetectResult>('installCli', {
      adapterId: adapterId ?? null,
    })
    await get().fetchStatus()
    return result
  },

  loginCli: async (adapterId) => {
    await sidecarRequest('loginCli', { adapterId: adapterId ?? null })
  },

  clearSetupLog: () => set({ setupLog: [], setupLogOwner: null }),

  setAdapter: async (adapterId) => {
    const previous = get().status
    if (previous?.busy) return
    try {
      const status = await sidecarRequest<AssistantStatus>('setAdapter', { adapterId })
      set({ status, error: null })
      const conv = useConversationStore.getState()
      const current = conv.conversations.find((c) => c.id === conv.currentId)
      if (current?.user_id) await conv.persistSessionId(current.user_id, null)
    } catch (err) {
      if (previous) set({ status: previous })
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  setModel: async (model) => {
    const previous = get().status
    if (previous) set({ status: { ...previous, model } })
    try {
      await sidecarRequest('setModel', { model })
    } catch (err) {
      if (previous) set({ status: previous })
      set({ error: err instanceof Error ? err.message : String(err) })
      return
    }
    await get().fetchStatus()
  },

  pushNote: (text) => {
    const id = newId()
    const note: ChatMessage = {
      id,
      role: 'assistant',
      createdAt: new Date().toISOString(),
      text,
      tools: [],
      charts: [],
      cards: [],
      reports: [],
      excels: [],
      calendars: [],
    }
    set((s) => ({ messages: [...s.messages, note] }))
    return id
  },

  reviseNote: (id, text) => {
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, text } : m)),
    }))
  },

  send: async (text, userId, attachments) => {
    const trimmed = text.trim()
    const files = attachments ?? []
    if ((!trimmed && files.length === 0) || get().isSending) return
    const display = trimmed || '첨부한 파일을 읽어 주세요.'

    set({ isSending: true, error: null, followups: [], followupsLoading: false })
    await get().refreshActiveChannel()

    const conversation = useConversationStore.getState()
    const current = conversation.conversations.find((c) => c.id === conversation.currentId)

    const userMsg: ChatMessage = {
      id: newId(),
      role: 'user',
      createdAt: new Date().toISOString(),
      text: display,
      tools: [],
      charts: [],
      cards: [],
      reports: [],
      excels: [],
      calendars: [],
      files: files.map((file) => ({
        id: newId(),
        name: file.name,
        path: '',
        size: 0,
        previewUrl: file.previewUrl,
      })),
    }
    const assistantMsg: ChatMessage = { id: newId(), role: 'assistant', createdAt: new Date().toISOString(), text: '', tools: [], charts: [], cards: [], reports: [], excels: [], calendars: [], pending: true }

    followupSeq += 1
    set((s) => ({
      messages: [...s.messages, userMsg, assistantMsg],
    }))

    void conversation.touchTitle(userId, display)
    void persist(userId, get().messages)

    try {
      const result = await sidecarRequest<{ sessionId?: string; saved?: { name: string; path: string; size: number }[] }>('send', {
        text: display,
        sessionId: current?.session_id ?? null,
        conversationId: current?.id ?? null,
        projectId: current?.project_id ?? null,
        attachments: files.map((file) => ({
          name: file.name,
          mime: file.mime,
          bytesBase64: file.bytesBase64 || '',
          drawing: Boolean(file.drawing),
          pages: file.pages ?? [],
        })),
      })
      if (result?.saved?.length) {
        set((s) => ({
          messages: s.messages.map((m) => {
            if (m.id !== userMsg.id) return m
            const nextFiles = (m.files ?? []).map((file) => {
              const match = result.saved?.find((item) => item.name === file.name)
              return match ? { ...file, path: match.path, size: match.size } : file
            })
            return { ...m, files: nextFiles }
          }),
        }))
      }
      if (result?.sessionId) {
        await conversation.persistSessionId(userId, result.sessionId)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, pending: false, isError: true, text: m.text || message }
            : m,
        ),
        error: message,
      }))
    } finally {
      set((s) => ({
        isSending: false,
        messages: s.messages.map((m) => (m.pending ? { ...m, pending: false } : m)),
      }))
      void persist(userId, get().messages)
      void get().fetchStatus()
    }

    const failed = get().messages.some((m) => m.id === assistantMsg.id && m.isError)
    if (!failed) void requestFollowups(display, assistantMsg.id)
  },

  cancel: async () => {
    try {
      await sidecarRequest('cancel')
    } catch {
      // 이미 끝난 경우는 무시
    } finally {
      // busy 상태가 남아 입력이 계속 막히지 않도록 다시 확인한다.
      await get().fetchStatus()
    }
  },

  subscribe: () => {
    if (get().subscribed) return () => {}
    set({ subscribed: true })

    const patchLast = (patch: (m: ChatMessage) => ChatMessage) =>
      set((s) => {
        const idx = [...s.messages].reverse().findIndex((m) => m.role === 'assistant')
        if (idx === -1) return s
        const target = s.messages.length - 1 - idx
        const next = [...s.messages]
        next[target] = patch(next[target])
        return { messages: next }
      })

    let pendingDelta = ''
    let blockBase = ''
    let blockAcc = ''
    let flushHandle: number | null = null

    const flushDelta = () => {
      flushHandle = null
      if (!pendingDelta) return
      blockAcc += pendingDelta
      pendingDelta = ''
      patchLast((m) => ({ ...m, text: mergeAssistantText(blockBase, blockAcc) }))
    }

    const scheduleFlush = () => {
      if (flushHandle === null) flushHandle = requestAnimationFrame(flushDelta)
    }

    const flushNow = () => {
      if (flushHandle !== null) {
        cancelAnimationFrame(flushHandle)
        flushHandle = null
      }
      flushDelta()
    }

    let cancelled = false
    let unlisten: (() => void) | null = null
    void listenAssistantEvents((evt: AssistantEvent) => {
      if (cancelled) return
      switch (evt.type) {
        case 'session':
          set({ mcpStatus: evt.mcpStatus })
          if (evt.sessionId) {
            const userId = useConversationStore.getState().conversations.find(
              (c) => c.id === useConversationStore.getState().currentId,
            )?.user_id
            if (userId) void useConversationStore.getState().persistSessionId(userId, evt.sessionId)
          }
          break

        case 'text-start':
          flushNow()
          blockBase = [...get().messages].reverse().find((m) => m.role === 'assistant')?.text.replace(/\n+$/, '') ?? ''
          blockAcc = ''
          pendingDelta = ''
          break

        case 'text-delta':
          pendingDelta += evt.text
          scheduleFlush()
          break

        case 'text':
          flushNow()
          patchLast((m) => ({
            ...m,
            text: mergeAssistantText(blockBase || m.text, evt.text),
          }))
          break

        case 'tool-start':
          if (evt.tool === 'propose_followups') break
          patchLast((m) => ({
            ...m,
            tools: m.tools.some((t) => t.id === evt.id)
              ? m.tools
              : [...m.tools, { id: evt.id, tool: evt.tool, label: evt.label, status: 'running' }],
          }))
          break

        case 'tool-end':
          patchLast((m) => ({
            ...m,
            tools: m.tools.map((t) =>
              t.id === evt.id
                ? { ...t, status: evt.isError ? 'error' : evt.warn ? 'warn' : 'done', preview: evt.preview }
                : t,
            ),
          }))
          {
            const tool = get().messages.flatMap((m) => m.tools).find((t) => t.id === evt.id)?.tool
            if (tool === 'classify_document' || tool === 'list_documents') {
              void useFilesStore.getState().reload()
            }
          }
          break

        case 'turn-end':
          flushNow()
          patchLast((m) => ({
            ...m,
            pending: false,
            isError: evt.isError,
            text: m.text.trim()
              ? (evt.text && evt.text.includes(m.text.trim()) ? evt.text : m.text)
              : (evt.text || m.text),
          }))
          break

        case 'chart':
          flushNow()
          patchLast((m) => ({
            ...m,
            charts: m.charts.some((c) => c.id === evt.id)
              ? m.charts
              : [...m.charts, {
                  id: evt.id,
                  chartType: evt.chartType,
                  title: evt.title,
                  unit: evt.unit,
                  series: evt.series,
                  seriesName: evt.seriesName ?? null,
                  compare: evt.compare ?? [],
                  refLines: evt.refLines ?? [],
                  stacked: Boolean(evt.stacked),
                }],
          }))
          break

        case 'cards':
          flushNow()
          patchLast((m) => ({
            ...m,
            cards: m.cards.some((c) => c.id === evt.id)
              ? m.cards
              : collapseCardBlocks([...m.cards, { id: evt.id, title: evt.title, items: evt.items }]),
          }))
          break

        case 'report':
          flushNow()
          patchLast((m) => ({
            ...m,
            reports: collapseReports([
              ...(m.reports ?? []),
              { id: evt.id, title: evt.title, html: evt.html },
            ]),
          }))
          break

        case 'excel': {
          flushNow()
          const filePath = (evt.path || '').trim()
          let arrived = false
          patchLast((m) => {
            if ((m.excels ?? []).some((item) => item.id === evt.id)) return m
            arrived = true
            return {
              ...m,
              excels: [...(m.excels ?? []), { id: evt.id, title: evt.title, sheet: evt.sheet, path: filePath, rows: evt.rows, merges: evt.merges, styles: evt.styles, borders: evt.borders, heights: evt.heights, widths: evt.widths }],
            }
          })
          if (arrived && filePath) void openLocalFile(filePath).catch(() => undefined)
          break
        }

        case 'file': {
          flushNow()
          let arrived = false
          patchLast((m) => {
            if ((m.files ?? []).some((item) => item.id === evt.id)) return m
            arrived = true
            return { ...m, files: [...(m.files ?? []), { id: evt.id, name: evt.name, path: evt.path, size: evt.size }] }
          })
          const ext = evt.name.split('.').pop()?.toLowerCase() ?? ''
          const image = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)
          if (arrived && !image) void openLocalFile(evt.path).catch(() => undefined)
          break
        }

        case 'calendar':
          flushNow()
          patchLast((m) => ({
            ...m,
            calendars: (m.calendars ?? []).some((item) => item.id === evt.id)
              ? (m.calendars ?? [])
              : [...(m.calendars ?? []), { id: evt.id, title: evt.title, events: evt.events }],
          }))
          break

        case 'followups': {
          const items = normalizeFollowups(evt.items)
          set({ followups: items, followupsLoading: false })
          patchLast((m) => (m.role === 'assistant' ? { ...m, followups: items } : m))
          break
        }

        case 'setup-log':
          set((s) => ({ setupLog: [...s.setupLog, evt.text].slice(-80) }))
          break

        case 'channels-changed':
          void get().fetchChannels()
          break

        case 'project-sync': {
          const { type: _type, ...sync } = evt
          useConversationStore.getState().setSync(sync.done < sync.total ? sync : null)
          break
        }

        case 'project-index': {
          const { type: _type, log, result, ...job } = evt
          const conversations = useConversationStore.getState()
          conversations.setJob(job, log)
          const current = conversations.conversations.find((c) => c.id === conversations.currentId)
          if (!result || current?.project_id !== job.projectId) break
          const note: ChatMessage = {
            id: newId(),
            role: 'assistant',
            createdAt: new Date().toISOString(),
            text: [
              `데이터시트 기준 정리를 엑셀로 만들었습니다.`,
              `- "요약": 기본 정보, 수량(Type × Rating), 항목별 추가사항 현황, 우선 확인 항목 Top 10`,
              `- "데이터시트 (추가사항 반영)": 항목 ${result.columns}개 중 ${result.covered}개 열 오른쪽에 "추가사항" 열을 붙였습니다. 지시 ${result.instructions}개 중 ${result.judged ?? 0}개는 AI가 해당 태그를 판단해 그 행에만 넣었습니다.`,
              `- "항목별 지시": 지시마다 적용 범위·적용 태그·출처·원문`,
              `- "추가사항": 데이터시트 항목에 없는 특이사항 ${result.additions}개를 중요도 5단계로 나눴습니다.`,
              `  1단계 재질 필수 ${result.levels[0]}개(빨강) · 2단계 시험 필수 ${result.levels[1]}개(주황) · 3단계 설계·제작 ${result.levels[2]}개(노랑) · 4단계 서류·승인 ${result.levels[3]}개 · 5단계 포장·기타 ${result.levels[4]}개`,
              `- "문서 목록": 문서마다 색인 상태와 요약`,
            ].join('\n'),
            tools: [],
            charts: [],
            cards: [],
            reports: [],
            excels: [],
            calendars: [],
            files: [{ id: newId(), name: result.name, path: result.path, size: result.size, datasheetProjectId: job.projectId }],
          }
          set((s) => {
            const last = s.messages[s.messages.length - 1]
            if (!last?.pending) return { messages: [...s.messages, note] }
            return { messages: [...s.messages.slice(0, -1), note, last] }
          })
          if (current.user_id) void persist(current.user_id, get().messages)
          break
        }

        case 'error':
          flushNow()
          set({ error: evt.message })
          patchLast((m) => ({ ...m, pending: false, isError: true, text: m.text || evt.message }))
          break
      }
    }).then((fn) => {
      if (cancelled) {
        fn()
        return
      }
      unlisten = fn
    })

    return () => {
      cancelled = true
      if (flushHandle !== null) cancelAnimationFrame(flushHandle)
      set({ subscribed: false })
      unlisten?.()
      unlisten = null
    }
  },
}))
