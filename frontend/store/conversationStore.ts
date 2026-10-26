import { create } from 'zustand'
import * as db from '@/lib/db'
import { sidecarRequest } from '@/lib/tauri'
import { useAssistantStore } from './assistantStore'
import type { Conversation, Project, ProjectIndexJob, ProjectSync } from '@/types/assistant'

interface ConversationState {
  conversations: Conversation[]
  currentId: string | null
  channelId: string
  loading: boolean
  projects: Project[]
  job: ProjectIndexJob | null
  sync: ProjectSync | null
  sharedSupported: boolean
  projectError: string
  setSync: (sync: ProjectSync | null) => void
  /** 프로젝트 바·파일 탭이 같이 다시 불러오도록 올린다. */
  projectRev: number
  bumpProject: () => void
  load: (userId: string, channelId: string) => Promise<void>
  create: (userId: string, projectId?: string | null) => Promise<Conversation>
  select: (userId: string, id: string) => Promise<void>
  rename: (userId: string, id: string, title: string) => Promise<void>
  remove: (userId: string, id: string) => Promise<void>
  removeByChannel: (userId: string, channelId: string) => Promise<void>
  persistSessionId: (userId: string, sessionId: string | null) => Promise<void>
  touchTitle: (userId: string, title: string) => Promise<void>
  loadProjects: () => Promise<void>
  addProject: (userId: string) => Promise<Project | null>
  removeProject: (userId: string, id: string) => Promise<void>
  /** 공유 프로젝트면 서버 이름도 바뀌어 채널 사용자 모두에게 보인다. */
  renameProject: (id: string, name: string) => Promise<void>
  /** 휴지통의 공유 프로젝트를 되살린다. 숨겨 둔 이 PC 대화도 다시 보인다. */
  restoreProject: (userId: string, id: string) => Promise<void>
  /** afterId: 로그가 시작될 때의 마지막 메시지. 대화 중 그 메시지 바로 뒤에 붙인다. */
  indexLog: { projectId: string; lines: string[]; afterId: string | null; done: boolean } | null
  setJob: (job: ProjectIndexJob | null, line?: string) => void
  clearIndexLog: () => void
}

const LOG_LINES = 400

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  currentId: null,
  channelId: '',
  loading: false,
  projects: [],
  job: null,
  sync: null,
  sharedSupported: false,
  projectError: '',
  indexLog: null,

  setSync: (sync) => set({ sync }),
  projectRev: 0,
  bumpProject: () => set((s) => ({ projectRev: s.projectRev + 1 })),

  // 채널마다 대화 목록이 따로다. 채널을 바꾸면 그 채널 목록으로 갈아끼운다.
  load: async (userId, channelId) => {
    set({ loading: true, channelId })
    const conversations = await db.listConversations(userId, channelId)
    set({ conversations, loading: false })
    await get().loadProjects()
    if (get().channelId !== channelId) return
    // 휴지통에 간 공유 프로젝트의 대화는 지우지 않고 숨긴다. 그런 대화는 고르지 않는다.
    const projectIds = new Set(get().projects.map((p) => p.id))
    const visible = conversations.filter((c) => !c.project_id || projectIds.has(c.project_id))
    if (visible.length === 0) {
      await get().create(userId)
      return
    }
    if (!get().currentId || !visible.some((c) => c.id === get().currentId)) {
      await get().select(userId, visible[0].id)
    }
  },

  create: async (userId, projectId = null) => {
    const row = await db.createConversation(userId, get().channelId, '새 대화', projectId)
    try {
      await sidecarRequest('newSession')
    } catch {
      // 브라우저 미리보기 등
    }
    set((s) => ({
      conversations: [row, ...s.conversations],
      currentId: row.id,
    }))
    useAssistantStore.getState().resetMessages()
    return row
  },

  select: async (userId, id) => {
    const current = get().conversations.find((c) => c.id === id)
    if (!current) return
    // 이미 보고 있는 대화면 다시 불러오지 않는다.
    // DB에는 진행 중(pending) 표시가 없어서, 응답 중에 다시 불러오면 로딩 표시가 사라진다.
    if (get().currentId === id) return
    set({ currentId: id })
    const messages = await db.listMessages(userId, id)
    useAssistantStore.getState().loadMessages(messages)
    try {
      await sidecarRequest('setSession', { sessionId: current.session_id })
    } catch {
      // ignore
    }
  },

  rename: async (userId, id, title) => {
    const trimmed = title.trim() || '새 대화'
    await db.updateConversation(userId, id, { title: trimmed })
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, title: trimmed } : c)),
    }))
  },

  remove: async (userId, id) => {
    await db.deleteConversation(userId, id)
    const next = get().conversations.filter((c) => c.id !== id)
    set({ conversations: next })
    if (get().currentId === id) {
      if (next[0]) await get().select(userId, next[0].id)
      else await get().create(userId)
    }
  },

  // 채널을 삭제할 때 그 채널의 대화를 전부 지운다. 지운 채널을 보고 있었다면 화면도 비운다.
  removeByChannel: async (userId, channelId) => {
    await db.deleteConversationsByChannel(userId, channelId)
    if (get().channelId === channelId) {
      set({ conversations: [], currentId: null, projects: [] })
      useAssistantStore.getState().resetMessages()
    }
  },

  persistSessionId: async (userId, sessionId) => {
    const id = get().currentId
    if (!id) return
    await db.updateConversation(userId, id, { session_id: sessionId })
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, session_id: sessionId } : c)),
    }))
  },

  touchTitle: async (userId, title) => {
    const id = get().currentId
    if (!id) return
    const current = get().conversations.find((c) => c.id === id)
    if (!current || current.title !== '새 대화') return
    const nextTitle = title.trim().slice(0, 32) || '새 대화'
    await get().rename(userId, id, nextTitle)
  },

  loadProjects: async () => {
    const channelId = get().channelId
    if (!channelId) return
    try {
      const res = await sidecarRequest<{ projects: Project[]; job: ProjectIndexJob | null; shared?: boolean; syncError?: string }>(
        'listProjects',
        { channelId },
      )
      if (get().channelId !== channelId) return
      set({
        projects: res.projects ?? [],
        job: res.job ?? get().job,
        sharedSupported: Boolean(res.shared),
        projectError: res.syncError ?? '',
      })
    } catch {
      set({ projects: [] })
    }
  },

  // 공유를 지원하는 채널이면 서버에 만들고 고른 폴더를 올린다(모두에게 보임).
  addProject: async (userId) => {
    const picked = await sidecarRequest<{ folder: string | null }>('pickFolder')
    if (!picked?.folder) return null
    let res: { project: Project }
    try {
      res = await sidecarRequest<{ project: Project }>('createProject', {
        channelId: get().channelId,
        folder: picked.folder,
      })
    } finally {
      set({ sync: null })
    }
    set((s) => ({ projects: [res.project, ...s.projects.filter((p) => p.id !== res.project.id)] }))
    await get().create(userId, res.project.id)
    return res.project
  },

  removeProject: async (userId, id) => {
    const shared = Boolean(get().projects.find((p) => p.id === id)?.shared)
    await sidecarRequest('removeProject', { id })
    if (!shared) await db.deleteConversationsByProject(userId, id)
    const wasCurrent = get().conversations.find((c) => c.id === get().currentId)?.project_id === id
    const next = get().conversations.filter((c) => c.project_id !== id)
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id), conversations: next }))
    if (wasCurrent) {
      set({ currentId: null })
      if (next[0]) await get().select(userId, next[0].id)
      else await get().create(userId)
    }
  },

  renameProject: async (id, name) => {
    const project = await sidecarRequest<Project>('renameProject', { id, name })
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, name: project.name } : p)) }))
    get().bumpProject()
  },

  restoreProject: async (userId, id) => {
    const channelId = get().channelId
    await sidecarRequest('restoreProject', { channelId, id })
    const conversations = await db.listConversations(userId, channelId)
    if (get().channelId !== channelId) return
    set({ conversations })
    await get().loadProjects()
  },

  setJob: (job, line) => {
    set({ job })
    if (job && line) {
      const time = new Date().toLocaleTimeString('ko-KR', { hour12: false })
      const prev = get().indexLog
      // 끝난 로그 뒤에 새 작업이 시작되면 그 시점 대화 아래에 새 로그를 연다.
      const fresh = !prev || prev.projectId !== job.projectId || line.startsWith('색인 시작') || (prev.done && job.running)
      const messages = useAssistantStore.getState().messages
      set({
        indexLog: {
          projectId: job.projectId,
          lines: [...(fresh ? [] : prev.lines), `${time} ${line}`].slice(-LOG_LINES),
          afterId: fresh ? (messages[messages.length - 1]?.id ?? null) : prev.afterId,
          done: !job.running,
        },
      })
    }
    if (job && !job.running) void get().loadProjects()
  },

  clearIndexLog: () => set({ indexLog: null }),
}))
