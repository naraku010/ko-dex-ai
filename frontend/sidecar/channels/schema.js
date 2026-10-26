// 채널 manifest의 JSON Schema → MCP registerTool이 받는 zod raw shape.
// 평면 object만 허용한다. 중첩 object는 CLI가 인자를 자주 틀리게 만들어서 규격에서 뺐다.

const { z } = require('zod')

const PRIMITIVES = new Set(['string', 'number', 'integer', 'boolean'])

function nodeType(node) {
  const raw = node?.type
  if (Array.isArray(raw)) return raw.find((t) => t !== 'null') ?? 'string'
  return typeof raw === 'string' ? raw : 'string'
}

function assertToolSchema(schema, toolName) {
  if (schema === undefined || schema === null) return
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`${toolName}: inputSchema는 object여야 합니다.`)
  }
  if (schema.type !== undefined && schema.type !== 'object') {
    throw new Error(`${toolName}: inputSchema.type은 object여야 합니다.`)
  }
  const props = schema.properties
  if (props === undefined || props === null) return
  if (typeof props !== 'object' || Array.isArray(props)) {
    throw new Error(`${toolName}: inputSchema.properties는 object여야 합니다.`)
  }
  for (const [key, node] of Object.entries(props)) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      throw new Error(`${toolName}.${key}: 속성 정의가 object가 아닙니다.`)
    }
    const type = nodeType(node)
    if (PRIMITIVES.has(type)) continue
    if (type === 'array') {
      const itemType = nodeType(node.items ?? { type: 'string' })
      if (!PRIMITIVES.has(itemType)) {
        throw new Error(`${toolName}.${key}: 배열 항목은 문자열·숫자·불린만 쓸 수 있습니다.`)
      }
      continue
    }
    throw new Error(`${toolName}.${key}: 지원하지 않는 타입입니다 (${type}). 중첩 object는 쓸 수 없습니다.`)
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    throw new Error(`${toolName}: inputSchema.required는 배열이어야 합니다.`)
  }
}

function leafField(node) {
  const enums = Array.isArray(node?.enum) ? node.enum.map((v) => String(v)).filter(Boolean) : []
  if (enums.length > 0) return z.enum(enums)

  switch (nodeType(node)) {
    // 모델이 숫자를 "5"처럼 문자열로 보내는 경우가 있다.
    case 'number':
      return z.coerce.number()
    case 'integer':
      return z.coerce.number().int()
    case 'boolean':
      return z.boolean()
    case 'array':
      return z.array(leafField(node?.items ?? { type: 'string' }))
    default:
      return z.string()
  }
}

function toRawShape(schema) {
  const props = schema?.properties
  if (!props || typeof props !== 'object') return {}
  const required = new Set(Array.isArray(schema?.required) ? schema.required.map(String) : [])

  const shape = {}
  for (const [key, node] of Object.entries(props)) {
    let field = leafField(node)
    if (node?.description) field = field.describe(String(node.description))
    // 모델이 "안 줌"을 null로 보내는 경우가 많다. 채널로 넘기기 전에 remote.js에서 걷어낸다.
    if (!required.has(key)) field = field.nullable().optional()
    shape[key] = field
  }
  return shape
}

module.exports = { assertToolSchema, toRawShape }
