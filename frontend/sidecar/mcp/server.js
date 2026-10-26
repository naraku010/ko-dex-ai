// 사이드카 프로세스 안에서 도는 MCP HTTP 서버.
// 127.0.0.1 바인딩 + 실행마다 새로 만드는 bearer 토큰.

const http = require('http')
const crypto = require('crypto')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')
const { registerTools } = require('./tools')
const channelStore = require('../channels/store')

const MCP_PATH = '/mcp'
const SERVER_NAME = 'kodex'
const MAX_BODY_BYTES = 4 * 1024 * 1024

let httpServer = null
let authToken = null
let boundPort = null
let starting = null

function appVersion() {
  try {
    return require('../../package.json').version
  } catch {
    return '0.0.0'
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function rpcError(res, status, message) {
  sendJson(res, status, {
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  })
}

function tokenMatches(provided) {
  if (!authToken || !provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(authToken)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('요청 본문이 너무 큽니다.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('JSON 파싱 실패'))
      }
    })
    req.on('error', reject)
  })
}

// 요청마다 새로 만든다. 활성 채널을 여기서 읽으므로 채널 전환이 바로 반영된다.
function createMcpServerInstance() {
  const server = new McpServer(
    { name: SERVER_NAME, version: appVersion() },
    { capabilities: { tools: {} } },
  )
  let channel = null
  try {
    channel = channelStore.getActive()
  } catch (err) {
    process.stderr.write(`[mcp] 활성 채널을 읽지 못했습니다: ${err?.message || err}\n`)
  }
  registerTools(server, channel)
  return server
}

async function handleMcpRequest(req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch (err) {
    rpcError(res, 400, err.message)
    return
  }

  const server = createMcpServerInstance()
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  const cleanup = () => {
    transport.close().catch(() => {})
    server.close().catch(() => {})
  }
  res.on('close', cleanup)

  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  } catch (err) {
    console.error('[mcp] 요청 처리 실패:', err?.message || err)
    if (!res.headersSent) rpcError(res, 500, '내부 오류가 발생했습니다.')
    cleanup()
  }
}

function requestListener(req, res) {
  let pathname
  try {
    pathname = new URL(req.url, 'http://127.0.0.1').pathname
  } catch {
    rpcError(res, 400, '잘못된 요청 경로입니다.')
    return
  }

  if (pathname !== MCP_PATH) {
    rpcError(res, 404, '존재하지 않는 경로입니다.')
    return
  }

  const header = req.headers.authorization || ''
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!tokenMatches(provided)) {
    rpcError(res, 401, '인증에 실패했습니다.')
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' })
    res.end()
    return
  }

  handleMcpRequest(req, res)
}

function start() {
  if (httpServer && boundPort) {
    return Promise.resolve(getEndpoint())
  }
  if (starting) return starting

  starting = new Promise((resolve, reject) => {
    authToken = crypto.randomBytes(32).toString('hex')
    const server = http.createServer(requestListener)

    server.once('error', (err) => {
      starting = null
      httpServer = null
      reject(new Error(`MCP 서버를 시작할 수 없습니다: ${err.message}`))
    })

    server.listen(0, '127.0.0.1', () => {
      httpServer = server
      boundPort = server.address().port
      starting = null
      console.log(`[mcp] 서버 시작 — 127.0.0.1:${boundPort}`)
      resolve(getEndpoint())
    })
  })

  return starting
}

function stop() {
  return new Promise((resolve) => {
    if (!httpServer) return resolve()
    const server = httpServer
    httpServer = null
    boundPort = null
    authToken = null
    server.close(() => resolve())
  })
}

function isRunning() {
  return Boolean(httpServer && boundPort)
}

function getEndpoint() {
  if (!isRunning()) return null
  return {
    serverName: SERVER_NAME,
    url: `http://127.0.0.1:${boundPort}${MCP_PATH}`,
    token: authToken,
  }
}

function buildMcpConfig() {
  const endpoint = getEndpoint()
  if (!endpoint) throw new Error('MCP 서버가 실행되지 않았습니다.')
  return {
    mcpServers: {
      [endpoint.serverName]: {
        type: 'http',
        url: endpoint.url,
        headers: { Authorization: `Bearer ${endpoint.token}` },
      },
    },
  }
}

// API 키 경로는 CLI용 HTTP 서버 대신, 같은 툴 핸들러를 프로세스 안에서 부른다.
async function openLocalClient() {
  const mcp = createMcpServerInstance()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'kodex-api', version: appVersion() })
  try {
    await mcp.connect(serverTransport)
    await client.connect(clientTransport)
  } catch (err) {
    await Promise.allSettled([client.close(), mcp.close()])
    throw err
  }
  return {
    async tools() {
      const listed = await client.listTools()
      return listed.tools || []
    },
    async call(name, args) {
      return client.callTool({ name, arguments: args || {} })
    },
    async close() {
      await Promise.allSettled([client.close(), mcp.close()])
    },
  }
}

module.exports = { start, stop, isRunning, getEndpoint, buildMcpConfig, openLocalClient, SERVER_NAME }
