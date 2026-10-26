export interface ToolCall {
  id: string
  tool: string
  label: string
  status: 'running' | 'done' | 'warn' | 'error'
  preview?: string
}

export interface ChartSpec {
  id: string
  chartType: 'bar' | 'hbar' | 'line' | 'area' | 'pie' | 'funnel' | 'gauge'
  title: string
  unit: string | null
  series: { label: string; value: number }[]
  seriesName?: string | null
  compare?: { name: string; values: number[] }[]
  refLines?: { label: string; value: number }[]
  stacked?: boolean
}

export interface CardItem {
  title: string
  subtitle: string | null
  image: string | null
  badge: string | null
  fields: { label: string; value: string }[]
}

/** 채널이 툴 응답에 실어 보낸 카드 묶음. AI를 거치지 않고 바로 그린다. */
export interface CardsSpec {
  id: string
  title: string | null
  items: CardItem[]
}

/** 채널이 보낸 엑셀 시트. 메시지 안 격자 뷰어로 그린다. */
export interface ExcelMerge {
  r: number
  c: number
  rows: number
  cols: number
}

export interface ExcelSpec {
  id: string
  title: string
  sheet: string
  path?: string
  rows: string[][]
  merges: ExcelMerge[]
  styles?: string[][]
  borders?: string[][]
  heights?: number[]
  widths?: number[]
}

/** 채널이 채운 HTML 리포트. 메시지 안 iframe으로 그린다. */
export interface ReportSpec {
  id: string
  title: string
  html: string
}

export type CalendarTone = 'info' | 'ok' | 'warn' | 'danger'

export interface CalendarEvent {
  date: string
  title: string
  subtitle: string | null
  tone: CalendarTone
}

/** 내부 툴 또는 채널이 보낸 월 달력. */
export interface CalendarSpec {
  id: string
  title: string
  events: CalendarEvent[]
}

/** 채널이 만든 파일을 사용자 PC에 내려받은 결과. */
export interface FileSpec {
  id: string
  name: string
  path: string
  size: number
  previewUrl?: string
  /** 프로젝트 데이터시트 엑셀이면 그 프로젝트. 아래에 검증용 DB 저장 카드를 띄운다. */
  datasheetProjectId?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  createdAt?: string
  /** 이 답변 뒤에 보여준 예상 질문. 대화를 다시 열면 입력창 위에 그대로 나온다. */
  followups?: string[]
  text: string
  tools: ToolCall[]
  charts: ChartSpec[]
  cards: CardsSpec[]
  reports: ReportSpec[]
  excels: ExcelSpec[]
  calendars: CalendarSpec[]
  files?: FileSpec[]
  isError?: boolean
  pending?: boolean
}

export interface ModelOption {
  id: string
  label: string
  hint: string
}

export interface AdapterInfo {
  id: string
  kind?: "cli" | "api"
  label: string
  installHint: string
  loginHint: string
  canInstall: boolean
  canLogin: boolean
  models: ModelOption[]
  defaultModel: string | null
  installed?: boolean
  loggedIn?: boolean
  ready?: boolean
  hasApiKey?: boolean
  keyHint?: string | null
}

export interface DetectResult {
  installed: boolean
  loggedIn: boolean
  account?: string | null
  path: string | null
  version: string | null
  source: string | null
  message: string
  adapterId?: string
  adapterLabel?: string
  installHint?: string
  loginHint?: string
  connected?: boolean
  mcpRunning?: boolean
}

export interface CredentialField {
  key: string
  label: string
  secret: boolean
  required: boolean
  hint: string
}

export interface ChannelToolParam {
  name: string
  type: string
  description: string
  required: boolean
  enum?: string[]
}

export interface ChannelTool {
  name: string
  label: string
  description: string
  params: ChannelToolParam[]
}

export interface ChannelInfo {
  id: string
  name: string
  short: string
  description: string
  version: string | null
  type: "data" | "files"
  icon: string
  url: string | null
  toolCount: number
  toolLabels: string[]
  tools: ChannelTool[]
  hasApiKey: boolean
  credentialFields: CredentialField[]
  filledCredentialKeys: string[]
  missingCredentialKeys: string[]
  credentialsReady: boolean
  addedAt: string | null
  refreshedAt: string | null
}

export interface ChannelPreview {
  url: string
  replaces: boolean
  channel: {
    id: string
    name: string
    short: string
    description: string
    version: string | null
    type: "data" | "files"
    icon: string
    toolCount: number
    requiresApiKey: boolean
  }
  credentialFields: CredentialField[]
  tools: { name: string; label: string | null; description: string }[]
}

export interface ImageGenStatus {
  connected: boolean
}

export interface AssistantStatus {
  adapterId: string
  adapterLabel: string
  installHint: string
  loginHint: string
  models: ModelOption[]
  model: string
  manualPath: string | null
  connected: boolean
  mcpRunning: boolean
  busy: boolean
  hasSession: boolean
  sessionId?: string | null
  loggedInUser: boolean
  lastDetect: DetectResult | null
  adapters: AdapterInfo[]
  channelId: string
  channels: ChannelInfo[]
  imageGen?: ImageGenStatus
}

export interface UsageAppTotals {
  account: string | null
  messages: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  costUsd: number
  lastUsedAt: string | null
}

export interface UsageWindow {
  usedPercent: number | null
  windowMinutes: number | null
  resetsAt: number | null
}

export interface UsagePlan {
  primary: UsageWindow | null
  secondary: UsageWindow | null
}

export interface AdapterUsage {
  id: string
  label: string
  installed: boolean
  loggedIn: boolean
  account: string | null
  app: UsageAppTotals
  plan: UsagePlan | null
}

export interface AuthUser {
  user_id: string
  user_name: string
  role: string
}

export interface Project {
  id: string
  channelId: string
  name: string
  folder: string
  datasheet: string | null
  skipImages?: boolean
  shared?: boolean
  createdBy?: string
  createdAt: string
  total: number
  indexed: number
  failed: number
  pending: number
}

export interface ProjectFile {
  rel: string
  size: number
  state: 'ok' | 'failed' | 'new' | 'stale' | 'dup' | 'skipped'
  items: number
  error: string
  docType: string
  dupOf?: string
}

export interface ProjectIndexJob {
  projectId: string
  total: number
  done: number
  failed: number
  current: string
  running: boolean
  cancelling?: boolean
  error: string
}

export interface ProjectSync {
  projectId: string | null
  phase: 'download' | 'upload'
  done: number
  total: number
  current?: string
}

export interface ProjectReport {
  path: string
  name: string
  size: number
  columns: number
  covered: number
  instructions: number
  judged?: number
  additions: number
  levels: number[]
}

export interface ProjectDetail {
  project: Project
  folderMissing: boolean
  truncated: boolean
  total: number
  indexed: number
  failed: number
  pending: number
  duplicates?: number
  skipped?: number
  sheetCandidates?: { rel: string; tags: number }[]
  files: ProjectFile[]
  job?: ProjectIndexJob | null
}

export interface Conversation {
  id: string
  user_id: string
  channel_id: string
  project_id?: string | null
  title: string
  session_id: string | null
  created_at: string
  updated_at: string
}

export type AssistantEvent =
  | { type: 'session'; sessionId?: string; mcpConnected?: boolean; mcpStatus: string; model?: string | null }
  | { type: 'text-start' }
  | { type: 'text-delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool-start'; id: string; tool: string; label: string }
  | { type: 'tool-end'; id: string; isError: boolean; warn?: boolean; preview?: string }
  | { type: 'turn-end'; sessionId?: string; isError: boolean; text?: string; costUsd?: number | null; durationMs?: number | null }
  | ({ type: 'chart' } & ChartSpec)
  | { type: 'cards'; id: string; title: string | null; items: CardItem[] }
  | { type: 'report'; id: string; title: string; html: string }
  | { type: 'excel'; id: string; title: string; sheet: string; path?: string; rows: string[][]; merges: ExcelMerge[]; styles?: string[][]; borders?: string[][]; heights?: number[]; widths?: number[] }
  | { type: 'calendar'; id: string; title: string; events: CalendarEvent[] }
  | ({ type: 'file' } & FileSpec)
  | { type: 'followups'; items: string[] }
  | { type: 'setup-log'; text: string }
  | { type: 'channels-changed' }
  | ({ type: 'project-index'; log?: string; result?: ProjectReport } & ProjectIndexJob)
  | ({ type: 'project-sync' } & ProjectSync)
  | { type: 'error'; message: string }
