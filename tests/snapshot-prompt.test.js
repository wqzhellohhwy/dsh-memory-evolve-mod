/**
 * 开局提示词（2026-10-14 用户需求）回归护栏：
 *   - GET 返回内置渲染结果 + 可用占位符；
 *   - POST 保存自定义文本 / 空串恢复内置；
 *   - renderSnapshot 在自定义时**整段替换**内置固定指导段（内置职责清单不再追加），
 *     并完成 {branch} 等占位符替换。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveStore, MemoryStore, SuggestionQueue } from '../lib/store.js'
import { installApi } from '../lib/api.js'
import { TodoStore } from '../lib/todo.js'
import { buildGuidance, renderSnapshot, validateRuntimePatch } from '../lib/index.js'
import { setLocale } from '../lib/i18n.js'
import { tmproot } from './_tmp.js'

setLocale('zh')

function tempDir() {
  return tmproot("dsh-snapshot-prompt-test-")
}

/** v2：出厂全部 `inject: false`，要断言"某分组进快照"必须先显式打开。 */
function enableInject(dir, ids) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'groups.json'), JSON.stringify({
    version: 2,
    groups: ids.map((id) => ({ kind: 'memory', id, inject: true })),
  }, null, 2))
}

/** Boot installApi over a real HTTP server（与 api.test.js 同款最小装配）。 */
async function boot(dir) {
  const store = new MemoryStore(dir)
  const todoStore = new TodoStore(dir)
  const state = { memoryTabEnabled: true, todoEnabled: true, snapshotPrompt: '' }
  const getRuntime = () => ({ ...state })
  const updateRuntime = (patch) => {
    for (const [key, value] of Object.entries(patch)) validateRuntimePatch(key, value)
    Object.assign(state, patch)
    return { ...state }
  }
  const ctx = { webServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } } }
  installApi(ctx, {
    store,
    archive: new ArchiveStore(dir),
    queue: new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl')),
    todoStore,
    getRuntime,
    updateRuntime,
    resolveRevealTarget: () => undefined,
    revealPath: () => {},
    config: { memoryDir: dir, skillDir: join(dir, 'skills') },
    resolveCwd: () => undefined,
  })
  const server = createServer((req, res) => ctx.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { data = text }
    return { status: res.status, data }
  }
  return { dir, store, state, request, close: () => new Promise((r) => server.close(r)) }
}

test('snapshot-prompt: buildGuidance 产出内置固定指导段', () => {
  const config = {
    reviewEnabled: true, reviewInterval: 5, reviewMode: 'suggest',
    perTurnDailyWrites: true, perTurnProjectWrites: true, perTurnKeyWrites: true,
    todoEnabled: true, todoCheck: true, toolName: 'memory', todoToolName: 'dtodo',
  }
  const g = buildGuidance(config, { branch: 'main' })
  assert.ok(g.fixedText.includes('memory'))
  assert.ok(g.fixedText.includes('main'))       // 分支提示（占位渲染）
  assert.ok(g.dutiesText.includes('收尾') || g.dutiesText.length > 0)
  assert.deepEqual(g.writeTargets, ['target=daily', 'target=project'])
  // 关掉每轮写入与审查 → 收尾职责段为空（只留固定说明段）
  const off = buildGuidance({ ...config, perTurnDailyWrites: false, perTurnProjectWrites: false, perTurnKeyWrites: false, reviewEnabled: false }, {})
  assert.equal(off.dutiesText, '')
})

test('snapshot-prompt: GET 返回内置文案与占位符，POST 保存/恢复', async () => {
  const dir = tempDir()
  const api = await boot(dir)
  try {
    const initial = await api.request('GET', '/memory-evolve/api/snapshot-prompt')
    assert.equal(initial.status, 200)
    assert.equal(initial.data.custom, '')
    assert.equal(initial.data.effective, initial.data.default)
    assert.ok(initial.data.vars.includes('{branch}'))

    const saved = await api.request('POST', '/memory-evolve/api/snapshot-prompt', { text: '自定义：分支={branch}，工具={memoryTool}' })
    assert.equal(saved.status, 200)
    const after = await api.request('GET', '/memory-evolve/api/snapshot-prompt')
    assert.equal(after.data.custom, '自定义：分支={branch}，工具={memoryTool}')
    assert.equal(after.data.effective, after.data.custom)

    // 空串恢复内置
    await api.request('POST', '/memory-evolve/api/snapshot-prompt', { text: '' })
    const restored = await api.request('GET', '/memory-evolve/api/snapshot-prompt')
    assert.equal(restored.data.custom, '')
    assert.equal(restored.data.effective, restored.data.default)

    // 限长校验
    const tooLong = await api.request('POST', '/memory-evolve/api/snapshot-prompt', { text: 'x'.repeat(20001) })
    assert.equal(tooLong.status, 400)
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('snapshot-prompt: renderSnapshot 用自定义文本整段替换内置指导段', () => {
  const dir = tempDir()
  try {
    const config = {
      memoryDir: dir, reviewEnabled: true, reviewInterval: 5, reviewMode: 'suggest',
      perTurnDailyWrites: true, perTurnProjectWrites: true, perTurnKeyWrites: true,
      todoEnabled: true, todoCheck: true, toolName: 'memory', todoToolName: 'dtodo',
    }
    const store = new MemoryStore(dir)
    const agent = { id: 'a', session: { header: { cwd: dir } } }
    const builtin = renderSnapshot(config, store, agent)
    assert.ok(builtin.includes('memory'))       // 内置指导段在

    const custom = renderSnapshot({ ...config, snapshotPrompt: '我的规则：分支={branch}，用 {memoryTool} 记东西。' }, store, agent)
    assert.ok(custom.includes('我的规则'))
    assert.ok(custom.includes('分支='))          // 无 git → {branch} 渲染为空串
    // 内置的收尾职责段让位（不再追加）
    const builtinDuties = buildGuidance(config, {}).dutiesText
    if (builtinDuties !== '') assert.equal(custom.includes(builtinDuties), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('snapshot-prompt: builtinGuidance=false 关掉内置文案，分组内容照常注入', () => {
  const dir = tempDir()
  try {
    const config = {
      memoryDir: dir, reviewEnabled: true, reviewInterval: 5, reviewMode: 'suggest',
      perTurnDailyWrites: true, perTurnProjectWrites: true, perTurnKeyWrites: true,
      todoEnabled: true, todoCheck: true, toolName: 'memory', todoToolName: 'dtodo',
    }
    const store = new MemoryStore(dir)
    // v2：出厂 memory 分组 inject=false，要观察"分组内容照常注入"必须先打开
    enableInject(dir, ['memory'])
    store.add('memory', '内置开关自检事实')
    const agent = { id: 'a', session: { header: { cwd: dir } } }
    const builtin = renderSnapshot(config, store, agent)
    const guidance = buildGuidance(config, {})
    assert.ok(builtin.includes(guidance.fixedText))          // 默认注入内置指导段
    assert.ok(builtin.includes('内置开关自检事实'))           // 分组内容

    const off = renderSnapshot({ ...config, builtinGuidance: false }, store, agent)
    assert.equal(off.includes(guidance.fixedText), false)    // 内置文案已关
    assert.equal(off.includes('内置开关自检事实'), true)      // 分组内容不受影响

    // 自定义「开局提示词」优先于内置开关（关掉内置也仍然注入自定义）
    const custom = renderSnapshot({ ...config, builtinGuidance: false, snapshotPrompt: '只保留我的规则' }, store, agent)
    assert.ok(custom.includes('只保留我的规则'))
    assert.equal(custom.includes(guidance.fixedText), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('snapshot-prompt: 注入方式（injectMode）校验与读写', async () => {
  const dir = tempDir()
  const api = await boot(dir)
  try {
    const initial = await api.request('GET', '/memory-evolve/api/snapshot-prompt')
    assert.equal(initial.data.injectMode, 'context')  // 默认：运行时上下文快照
    assert.equal(initial.data.builtinGuidance, true)

    const saved = await api.request('POST', '/memory-evolve/api/snapshot-prompt', { injectMode: 'section', builtinGuidance: false })
    assert.equal(saved.status, 200)
    const after = await api.request('GET', '/memory-evolve/api/snapshot-prompt')
    assert.equal(after.data.injectMode, 'section')
    assert.equal(after.data.builtinGuidance, false)

    // 非法注入方式被拒
    const bad = await api.request('POST', '/memory-evolve/api/snapshot-prompt', { injectMode: 'nope' })
    assert.equal(bad.status, 400)

    // 恢复默认
    await api.request('POST', '/memory-evolve/api/snapshot-prompt', { injectMode: 'context', builtinGuidance: true })
    const restored = await api.request('GET', '/memory-evolve/api/snapshot-prompt')
    assert.equal(restored.data.injectMode, 'context')
    assert.equal(restored.data.builtinGuidance, true)
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
