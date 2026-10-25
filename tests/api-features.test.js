/**
 * tests/api-features.test.js — `GET /memory-evolve/api/features`（2026-10-23 降噪）。
 *
 * 契约（R1 定稿）：
 *   ① 始终注册、200 `{ok:true, features:{...}}`，`Cache-Control: no-store`；
 *   ② 键全 = 20 个前端约定键，值必须 boolean、键永远存在；
 *   ③ 值来自**装配层的控制器引用存在性**（deps.features provider），不是复制
 *      运行时开关 —— provider 说 false 时即使开关为 true 也必须是 false；
 *   ④ 未注入 provider（无装配的宿主）→ 全 false（诚实降级，不谎报可用）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmproot } from './_tmp.js'
import { installApi } from '../lib/api.js'

const FEATURE_KEYS = [
  'uiSettings', 'bookmarks', 'canvas', 'coi', 'broadcast', 'broadcastImage',
  'prompts', 'notify', 'channelSend', 'advisor', 'advisorPanel', 'sync',
  'session', 'models', 'memoryLibrary', 'todo', 'review', 'skillReview',
  'sessionSearch', 'searchDocs',
]

const ALL_FALSE = Object.fromEntries(FEATURE_KEYS.map((key) => [key, false]))

/** 起一个只抓路由的假 httpServer 上下文；返回 { handler, runtime }。 */
function rig({ runtime = {}, features } = {}) {
  let handler = null
  const state = { handler: null, runtime }
  const deps = {
    store: {},
    archive: {},
    queue: { read: () => [], append: () => ({ ok: true }), mutate: (fn) => fn([]), write: () => {} },
    todoStore: {},
    getRuntime: () => state.runtime,
    updateRuntime: (patch) => { state.runtime = { ...state.runtime, ...patch }; return state.runtime },
    config: { memoryDir: tmproot('dsh-api-features-'), skillDir: tmproot('dsh-api-features-skills-') },
    aliases: { all: () => ({}), set: () => ({ ok: true }), remove: () => ({ ok: true }) },
    resolveCwd: () => undefined,
  }
  if (features !== undefined) deps.features = features
  installApi({ webServer: { register: (route) => { handler = route.handler; return () => {} } } }, deps)
  state.handler = handler
  return state
}

async function getFeatures(found) {
  let status = 0
  let headers = {}
  let payload = ''
  const req = { method: 'GET', url: '/memory-evolve/api/features', headers: {} }
  const res = {
    writeHead: (code, hs) => { status = code; headers = hs ?? {} },
    end: (text) => { payload = text },
  }
  await found.handler(req, res)
  return { status, headers, body: JSON.parse(payload) }
}

test('200 + ok:true + 20 键齐全 + 全部 boolean + no-store', async () => {
  const features = { ...ALL_FALSE, coi: true, canvas: true, todo: true }
  const found = rig({ features: () => features })
  const res = await getFeatures(found)
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.body.ok, true)
  assert.deepEqual(Object.keys(res.body.features).sort(), [...FEATURE_KEYS].sort())
  for (const key of FEATURE_KEYS) {
    assert.equal(typeof res.body.features[key], 'boolean', `${key} 必须是 boolean`)
  }
  assert.equal(res.body.features.coi, true)
  assert.equal(res.body.features.canvas, true)
  assert.equal(res.body.features.todo, true)
  assert.equal(res.body.features.sync, false)
})

test('值来自安装引用（provider），不是复制运行时开关', async () => {
  const installed = { coi: false }
  const found = rig({ runtime: { coiEnabled: true }, features: () => ({ ...ALL_FALSE, coi: installed.coi }) })
  const before = await getFeatures(found)
  assert.equal(before.body.features.coi, false, '开关为 true 但模块未装 → 必须 false')

  installed.coi = true // 模拟 ctrl.sync() 把模块装上
  const after = await getFeatures(found)
  assert.equal(after.body.features.coi, true, '装上后立即反映（不缓存）')
})

test('未知键被剔除、非布尔值回落 false、缺失键补 false', async () => {
  const found = rig({ features: () => ({ canvas: 'yes', bogusKey: true, todo: 1, bookmarks: true }) })
  const res = await getFeatures(found)
  assert.equal(res.body.features.canvas, false)
  assert.equal(res.body.features.todo, false)
  assert.equal(res.body.features.bookmarks, true)
  assert.equal('bogusKey' in res.body.features, false)
  assert.equal(Object.keys(res.body.features).length, FEATURE_KEYS.length)
})

test('未注入 provider（无装配宿主）→ 全 false，不谎报可用', async () => {
  const found = rig({ runtime: { canvasEnabled: true, todoEnabled: true } })
  const res = await getFeatures(found)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.features, ALL_FALSE)
})
