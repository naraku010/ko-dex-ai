function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  }
}

function fail(message) {
  return {
    content: [{ type: 'text', text: `오류: ${message}` }],
    isError: true,
  }
}

function tool(handler) {
  return async (args, extra) => {
    try {
      const result = await handler(args ?? {}, extra)
      return result?.content ? result : ok(result)
    } catch (err) {
      return fail(err?.message || '알 수 없는 오류가 발생했습니다.')
    }
  }
}

const HEAVY_KEY = /image|base64|file_data|inspection_image|thumbnail/i

function stripHeavy(value, depth = 0) {
  if (value == null || depth > 8) return value
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => stripHeavy(item, depth + 1))
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      if (HEAVY_KEY.test(key) && typeof child === 'string' && child.length > 80) {
        out[key] = `[생략 ${child.length}자]`
        continue
      }
      if (typeof child === 'string' && child.length > 4000) {
        out[key] = `${child.slice(0, 400)}…`
        continue
      }
      out[key] = stripHeavy(child, depth + 1)
    }
    return out
  }
  return value
}

module.exports = { ok, fail, tool, stripHeavy }
