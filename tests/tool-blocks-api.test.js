/**
 * 工具定义分块的 API 级实测（2026-10-16）：真的走 `installApi` 注册的 HTTP handler，
 * 验证 GET 返回块表与启用状态、POST 切换单块、未知块被拒。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { setLocale } from '../lib/i18n.js'
import { installApi } from '../lib/api.js'
import { TOOL_BLOCKS } from '../lib/tool-blocks.js'
import { tmproot } from './_tmp.js'

setLocale('zh')

/** 抓住 installApi 注册的路由 handler。 */
function fakeCtx() {
  let handler = null
  const ctx = {
    webServer: { register: (route) => { handler = route.handler; return () => {} } },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return { ctx, getHandler: () => handler }
}

/**
 * 发一个请求给 handler（body 给对象时按 JSON 发送）。
 * @returns {Promise<{status: number, json: object}>} 状态码与解析后的 JSON。
 */
async function call(handler, method, path, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(payload === '' ? [] : [Buffer.from(payload, 'utf8')])
  req.method = method
  req.url = path
  req.headers = {
    'content-type': 'application/json',
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
  }
  let status = 0
  let text = ''
  const res = {
    writeHead(code) { status = code },
    end(chunk) { if (chunk !== undefined) text += String(chunk) },
  }
  await handler(req, res)
  return { status, json: text === '' ? {} : JSON.parse(text) }
}

test('API：GET /api/tools 返回块表；POST 切换单块；未知块被拒', async () => {
  const dir = tmproot('dsh-tool-blocks-api-')
  const state = { toolBlocks: {} }
  const deps = {
    config: { memoryDir: dir, stateFile: join(dir, 'plugin-state.json') },
    getRuntime: () => state,
    updateRuntime: (patch) => { Object.assign(state, patch); return { ...state } },
    listBuiltinTools: () => [],
  }
  const { ctx, getHandler } = fakeCtx()
  installApi(ctx, deps)
  const handler = getHandler()
  assert.equal(typeof handler, 'function', '路由已注册')

  const before = await call(handler, 'GET', '/memory-evolve/api/tools')
  assert.equal(before.status, 200, `GET /api/tools 应 200，实际 ${before.status}：${JSON.stringify(before.json).slice(0, 300)}`)
  assert.ok(before.json.blocks.definitions.length >= TOOL_BLOCKS.length, '块表至少含全部静态块')
  assert.ok(before.json.blocks.definitions.some((block) => block.tool === 'memory'))
  // 分组块（动态）：每个启用中的分组一块，内置与自建平等
  assert.ok(
    before.json.blocks.definitions.some((block) => block.id === 'group.kb'),
    '分组块应出现在块表里',
  )
  assert.equal(before.json.blocks.enabled['memory.group.project'], undefined, '缺省：没写过就是启用')

  const off = await call(handler, 'POST', '/memory-evolve/api/tools', {
    block: 'memory.group.project',
    enabled: false,
  })
  assert.equal(off.status, 200)
  assert.equal(off.json.blocks['memory.group.project'], false)
  assert.equal(state.toolBlocks['memory.group.project'], false, '写进了运行时配置')

  const list = await call(handler, 'GET', '/memory-evolve/api/tools')
  assert.equal(list.json.blocks.enabled['memory.group.project'], false, '再读仍是关的')

  const on = await call(handler, 'POST', '/memory-evolve/api/tools', {
    block: 'memory.group.project',
    enabled: true,
  })
  assert.equal(on.json.blocks['memory.group.project'], true, '可以再打开')

  const bad = await call(handler, 'POST', '/memory-evolve/api/tools', { block: 'nope.x', enabled: false })
  assert.notEqual(bad.status, 200, '未知块必须报错')
})
