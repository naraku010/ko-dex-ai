import type { ChatMessage, Conversation } from '@/types/assistant'
import { isTauri } from './tauri'

const CONV_KEY = (userId: string) => `kodex.conversations.${userId}`
const MSG_KEY = (conversationId: string) => `kodex.messages.${conversationId}`

let sqlite: Awaited<ReturnType<typeof loadSqlite>> | null = null
let initPromise: Promise<void> | null = null

async function loadSqlite() {
  const Database = (await import('@tauri-apps/plugin-sql')).default
  return Database.load('sqlite:chats.db')
}

async function ensureSqlite() {
  if (!isTauri()) return null
  if (sqlite) return sqlite
  if (!initPromise) {
    initPromise = (async () => {
      const db = await loadSqlite()
      await db.execute(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          channel_id TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL,
          session_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      await db.execute(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          tools TEXT NOT NULL DEFAULT '[]',
          charts TEXT NOT NULL DEFAULT '[]',
          cards TEXT NOT NULL DEFAULT '[]',
          reports TEXT NOT NULL DEFAULT '[]',
          calendars TEXT NOT NULL DEFAULT '[]',
          is_error INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )
      `)
      // 이미 만들어진 DB에는 컬럼이 없다. 있으면 실패하니 그냥 삼킨다.
      await db.execute(`ALTER TABLE messages ADD COLUMN cards TEXT NOT NULL DEFAULT '[]'`).catch(() => undefined)
      await db.execute(`ALTER TABLE messages ADD COLUMN reports TEXT NOT NULL DEFAULT '[]'`).catch(() => undefined)
      await db.execute(`ALTER TABLE messages ADD COLUMN calendars TEXT NOT NULL DEFAULT '[]'`).catch(() => undefined)
      await db.execute(`ALTER TABLE messages ADD COLUMN excels TEXT NOT NULL DEFAULT '[]'`).catch(() => undefined)
      await db.execute(`ALTER TABLE messages ADD COLUMN files TEXT NOT NULL DEFAULT '[]'`).catch(() => undefined)
      await db.execute(`ALTER TABLE messages ADD COLUMN followups TEXT NOT NULL DEFAULT '[]'`).catch(() => undefined)
      await db.execute(`ALTER TABLE conversations ADD COLUMN project_id TEXT`).catch(() => undefined)
      sqlite = db
    })()
  }
  await initPromise
  return sqlite
}

function readLocal<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeLocal(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify(value))
}

export async function listConversations(userId: string, channelId: string): Promise<Conversation[]> {
  const db = await ensureSqlite()
  if (db) {
    return db.select<Conversation[]>(
      'SELECT * FROM conversations WHERE user_id = $1 AND channel_id = $2 ORDER BY updated_at DESC',
      [userId, channelId],
    )
  }
  return readLocal<Conversation[]>(CONV_KEY(userId), [])
    .filter((c) => (c.channel_id ?? '') === channelId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

export async function createConversation(
  userId: string,
  channelId: string,
  title = '새 대화',
  projectId: string | null = null,
): Promise<Conversation> {
  const now = new Date().toISOString()
  const row: Conversation = {
    id: crypto.randomUUID(),
    user_id: userId,
    channel_id: channelId,
    project_id: projectId,
    title,
    session_id: null,
    created_at: now,
    updated_at: now,
  }
  const db = await ensureSqlite()
  if (db) {
    await db.execute(
      'INSERT INTO conversations (id, user_id, channel_id, project_id, title, session_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [row.id, row.user_id, row.channel_id, row.project_id, row.title, row.session_id, row.created_at, row.updated_at],
    )
    return row
  }
  const list = readLocal<Conversation[]>(CONV_KEY(userId), [])
  writeLocal(CONV_KEY(userId), [row, ...list])
  return row
}

export async function updateConversation(
  userId: string,
  id: string,
  patch: Partial<Pick<Conversation, 'title' | 'session_id' | 'updated_at'>>,
): Promise<void> {
  const updatedAt = patch.updated_at ?? new Date().toISOString()
  const db = await ensureSqlite()
  if (db) {
    if (patch.title !== undefined && patch.session_id !== undefined) {
      await db.execute(
        'UPDATE conversations SET title = $1, session_id = $2, updated_at = $3 WHERE id = $4 AND user_id = $5',
        [patch.title, patch.session_id, updatedAt, id, userId],
      )
    } else if (patch.title !== undefined) {
      await db.execute(
        'UPDATE conversations SET title = $1, updated_at = $2 WHERE id = $3 AND user_id = $4',
        [patch.title, updatedAt, id, userId],
      )
    } else if (patch.session_id !== undefined) {
      await db.execute(
        'UPDATE conversations SET session_id = $1, updated_at = $2 WHERE id = $3 AND user_id = $4',
        [patch.session_id, updatedAt, id, userId],
      )
    } else {
      await db.execute(
        'UPDATE conversations SET updated_at = $1 WHERE id = $2 AND user_id = $3',
        [updatedAt, id, userId],
      )
    }
    return
  }
  const list = readLocal<Conversation[]>(CONV_KEY(userId), [])
  writeLocal(
    CONV_KEY(userId),
    list.map((c) => (c.id === id ? { ...c, ...patch, updated_at: updatedAt } : c)),
  )
}

export async function deleteConversation(userId: string, id: string): Promise<void> {
  const db = await ensureSqlite()
  if (db) {
    await db.execute('DELETE FROM messages WHERE conversation_id = $1 AND user_id = $2', [id, userId])
    await db.execute('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [id, userId])
    return
  }
  writeLocal(
    CONV_KEY(userId),
    readLocal<Conversation[]>(CONV_KEY(userId), []).filter((c) => c.id !== id),
  )
  if (typeof window !== 'undefined') window.localStorage.removeItem(MSG_KEY(id))
}

export async function deleteConversationsByProject(userId: string, projectId: string): Promise<void> {
  const db = await ensureSqlite()
  if (db) {
    await db.execute(
      `DELETE FROM messages WHERE conversation_id IN (
         SELECT id FROM conversations WHERE user_id = $1 AND project_id = $2
       )`,
      [userId, projectId],
    )
    await db.execute('DELETE FROM conversations WHERE user_id = $1 AND project_id = $2', [userId, projectId])
    return
  }
  const list = readLocal<Conversation[]>(CONV_KEY(userId), [])
  const removed = list.filter((c) => c.project_id === projectId)
  writeLocal(CONV_KEY(userId), list.filter((c) => c.project_id !== projectId))
  if (typeof window !== 'undefined') {
    for (const c of removed) window.localStorage.removeItem(MSG_KEY(c.id))
  }
}

// 채널을 지울 때 그 채널의 대화와 메시지를 모두 삭제한다.
export async function deleteConversationsByChannel(userId: string, channelId: string): Promise<void> {
  const db = await ensureSqlite()
  if (db) {
    await db.execute(
      `DELETE FROM messages WHERE conversation_id IN (
         SELECT id FROM conversations WHERE user_id = $1 AND channel_id = $2
       )`,
      [userId, channelId],
    )
    await db.execute('DELETE FROM conversations WHERE user_id = $1 AND channel_id = $2', [userId, channelId])
    return
  }
  const list = readLocal<Conversation[]>(CONV_KEY(userId), [])
  const removed = list.filter((c) => (c.channel_id ?? '') === channelId)
  writeLocal(CONV_KEY(userId), list.filter((c) => (c.channel_id ?? '') !== channelId))
  if (typeof window !== 'undefined') {
    for (const c of removed) window.localStorage.removeItem(MSG_KEY(c.id))
  }
}

export async function listMessages(userId: string, conversationId: string): Promise<ChatMessage[]> {
  const db = await ensureSqlite()
  if (db) {
    const rows = await db.select<{
      id: string
      role: ChatMessage['role']
      text: string
      tools: string
      charts: string
      cards: string
      reports: string
      calendars: string
      excels: string
      files: string
      followups: string
      is_error: number
      created_at: string
    }[]>(
      'SELECT id, role, text, tools, charts, cards, reports, calendars, excels, files, followups, is_error, created_at FROM messages WHERE conversation_id = $1 AND user_id = $2 ORDER BY created_at ASC',
      [conversationId, userId],
    )
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      createdAt: row.created_at,
      text: row.text,
      tools: safeParse(row.tools, []),
      charts: safeParse(row.charts, []),
      cards: safeParse(row.cards, []),
      reports: safeParse(row.reports || '[]', []),
      excels: safeParse(row.excels || '[]', []),
      calendars: safeParse(row.calendars || '[]', []),
      files: safeParse(row.files || '[]', []),
      followups: safeParse(row.followups || '[]', []),
      isError: Boolean(row.is_error),
    }))
  }
  return readLocal<ChatMessage[]>(MSG_KEY(conversationId), []).map((msg) => ({
    ...msg,
    tools: msg.tools ?? [],
    charts: msg.charts ?? [],
    cards: msg.cards ?? [],
    reports: msg.reports ?? [],
    excels: msg.excels ?? [],
    calendars: msg.calendars ?? [],
    files: msg.files ?? [],
  }))
}

export async function replaceMessages(userId: string, conversationId: string, messages: ChatMessage[]): Promise<void> {
  const persisted = messages.map((m) => ({
    ...m,
    pending: undefined,
  }))
  const db = await ensureSqlite()
  if (db) {
    const ids = persisted.map((msg) => msg.id)
    if (ids.length > 0) {
      const placeholders = ids.map((_, i) => `$${i + 3}`).join(', ')
      await db.execute(
        `DELETE FROM messages WHERE conversation_id = $1 AND user_id = $2 AND id NOT IN (${placeholders})`,
        [conversationId, userId, ...ids],
      )
    } else {
      await db.execute('DELETE FROM messages WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId])
    }
    for (const msg of persisted) {
      await db.execute(
        `INSERT INTO messages (id, conversation_id, user_id, role, text, tools, charts, cards, reports, calendars, excels, files, followups, is_error, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT(id) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           user_id = excluded.user_id,
           role = excluded.role,
           text = excluded.text,
           tools = excluded.tools,
           charts = excluded.charts,
           cards = excluded.cards,
           reports = excluded.reports,
           calendars = excluded.calendars,
           excels = excluded.excels,
           files = excluded.files,
           followups = excluded.followups,
           is_error = excluded.is_error`,
        [
          msg.id,
          conversationId,
          userId,
          msg.role,
          msg.text,
          JSON.stringify(msg.tools ?? []),
          JSON.stringify(msg.charts ?? []),
          JSON.stringify(msg.cards ?? []),
          JSON.stringify(msg.reports ?? []),
          JSON.stringify(msg.calendars ?? []),
          JSON.stringify(msg.excels ?? []),
          JSON.stringify(msg.files ?? []),
          JSON.stringify(msg.followups ?? []),
          msg.isError ? 1 : 0,
          msg.createdAt ?? new Date().toISOString(),
        ],
      )
    }
    return
  }
  writeLocal(MSG_KEY(conversationId), persisted)
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
