/**
 * tests/advisor-events-ended.test.js — advisor `/events` 无效会话返回 200 ended
 * （2026-10-23 降噪）：前端轮询在会话结束/刷新后是常态，不该刷 400 错误。
 *
 * 契约：
 *   - 无效/缺失 sessionId → 200 `{ok:true, ended:true, events:[], cursor:0}`；
 *   - 非法 `after` → 仍 400 `BAD_CURSOR`；
 *   - 有效会话 → 行为不变（透传 ctrl.queryEvents）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installAdvisorApi } from '../lib/advisor/api.js'

const VALID_SESSION = 'sess-ok'

function rig() {
  let handler = null
  const calls = []
  const ctrl = {
    sessionExists: (id) => id === VALID_SESSION,
    queryEvents: (sessionId, after, limit) => {
      calls.push({ sessionId, after, limit })
      return { events: [{ seq: 1, type: 'note' }], cursor: 1, gap: false }
    },
    status: () => ({ effectiveEnabled: true }),
    instructionsOf: () => [{ text: 'hi' }],
    scopesOf: () => ({ global: { text: '' } }),
  }
  installAdvisorApi({ webServer: { register: (route) => { handler = route.handler; return () => {} } } }, ctrl)
  return { getHandler: () => handler, calls }
}

async function get(found, path) {
  let status = 0
  let payload = ''
  const req = { method: 'GET', url: path, headers: {} }
  const res = { writeHead: (code) => { status = code }, end: (text) => { payload = text } }
  await found.getHandler()(req, res)
  return { status, body: JSON.parse(payload) }
}

test('无效 sessionId：200 {ok:true, ended:true, events:[], cursor:0}', async () => {
  const found = rig()
  const res = await get(found, '/memory-evolve/api/advisor/events?sessionId=nope')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true, ended: true, events: [], cursor: 0 })
  assert.equal(found.calls.length, 0, '无效会话不应触碰 queryEvents')
})

test('缺失 sessionId：同样 200 ended（不再是 400 BAD_SESSION）', async () => {
  const found = rig()
  const res = await get(found, '/memory-evolve/api/advisor/events')
  assert.equal(res.status, 200)
  assert.equal(res.body.ended, true)
  assert.deepEqual(res.body.events, [])
})

test('非法 after：即使会话无效也仍 400 BAD_CURSOR', async () => {
  const found = rig()
  for (const after of ['abc', '-1', '1.5']) {
    const invalidSession = await get(found, `/memory-evolve/api/advisor/events?sessionId=nope&after=${after}`)
    assert.equal(invalidSession.status, 400, `after=${after} 应 400`)
    assert.equal(invalidSession.body.code, 'BAD_CURSOR')
    const validSession = await get(found, `/memory-evolve/api/advisor/events?sessionId=${VALID_SESSION}&after=${after}`)
    assert.equal(validSession.status, 400)
    assert.equal(validSession.body.code, 'BAD_CURSOR')
  }
})

test('有效会话：行为不变（透传 events/cursor，不出现 ended）', async () => {
  const found = rig()
  const res = await get(found, `/memory-evolve/api/advisor/events?sessionId=${VALID_SESSION}&after=0&limit=5`)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.ended, undefined)
  assert.deepEqual(res.body.events, [{ seq: 1, type: 'note' }])
  assert.equal(res.body.cursor, 1)
  assert.deepEqual(found.calls, [{ sessionId: VALID_SESSION, after: 0, limit: 5 }])
})

test('三个读端点（events/status/instructions）无效会话全部 200 ended', async () => {
  const found = rig()
  const events = await get(found, '/memory-evolve/api/advisor/events?sessionId=nope')
  assert.equal(events.status, 200)
  assert.deepEqual(events.body, { ok: true, ended: true, events: [], cursor: 0 })

  const status = await get(found, '/memory-evolve/api/advisor/status?sessionId=nope')
  assert.equal(status.status, 200)
  assert.deepEqual(status.body, { ok: true, ended: true, status: null })

  const instructions = await get(found, '/memory-evolve/api/advisor/instructions?sessionId=nope')
  assert.equal(instructions.status, 200)
  assert.deepEqual(instructions.body, { ok: true, ended: true, pending: [] })

  // 缺口=0：无效会话明确消失时，所有读端点都必须是 200 ended
  for (const path of ['/memory-evolve/api/advisor/status', '/memory-evolve/api/advisor/instructions']) {
    const missing = await get(found, path)
    assert.equal(missing.status, 200, `${path} 缺失 sessionId 也应 200`)
    assert.equal(missing.body.ended, true)
  }
})

test('GET /scopes 无效会话同样 200 ended（读端点不留 400 噪音）', async () => {
  const found = rig()
  const res = await get(found, '/memory-evolve/api/advisor/scopes?sessionId=nope')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true, ended: true, scopes: null })
})

test('有效会话的 status / instructions 行为不变（无 ended 字段）', async () => {
  const found = rig()
  const status = await get(found, `/memory-evolve/api/advisor/status?sessionId=${VALID_SESSION}`)
  assert.equal(status.status, 200)
  assert.equal(status.body.ended, undefined)
  assert.equal(status.body.effectiveEnabled, true)
  const instructions = await get(found, `/memory-evolve/api/advisor/instructions?sessionId=${VALID_SESSION}`)
  assert.equal(instructions.status, 200)
  assert.deepEqual(instructions.body.pending, [{ text: 'hi' }])
})

test('写端点对无效会话仍 400 BAD_SESSION（只有读端点降噪）', async () => {
  const found = rig()
  let status = 0
  let payload = ''
  const body = JSON.stringify({ sessionId: 'nope', enabled: true })
  const req = {
    method: 'POST',
    url: '/memory-evolve/api/advisor/toggle',
    headers: {
      'content-type': 'application/json',
      host: 'h',
      origin: 'http://h',
    },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
  }
  const res = { writeHead: (code) => { status = code }, end: (text) => { payload = text } }
  await found.getHandler()(req, res)
  assert.equal(status, 400)
  assert.equal(JSON.parse(payload).code, 'BAD_SESSION')
})
