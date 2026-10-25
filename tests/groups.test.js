/**
 * 记忆 / 待办「分组化」回归护栏（2026-10-13）。
 *
 * 覆盖：出厂分组表、自建分组的 CRUD 与内置保护、自建记忆分组的写入与页签、
 * 注入开关（含可编辑提示词）、自建待办分组的写入/查询/注入、待确认门槛与
 * 自动通过、坏配置的归一化。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveStore, MemoryStore, SuggestionQueue } from '../lib/store.js'
import { installApi } from '../lib/api.js'
import { TodoStore } from '../lib/todo.js'
import { renderSnapshot, validateRuntimePatch } from '../lib/index.js'
import {
  deleteGroup, findGroup, groupLabel, listGroups, loadGroups, needsConfirmation,
  normalizeGroupsConfig, upsertGroup,
} from '../lib/groups.js'
import { setLocale } from '../lib/i18n.js'
import { tmproot } from './_tmp.js'

// 本套用例钉住中文输出契约（英文口径由 i18n.test.js 覆盖）。
setLocale('zh')

function tempDir() {
  return tmproot("dsh-memory-groups-test-")
}

/**
 * Boot a real HTTP server over installApi's handler, with the same wiring the
 * assembler uses: store / todoStore resolve non-builtin targets through the
 * live groups config (read from disk on every call).
 */
async function bootGroupsApi(dir) {
  const store = new MemoryStore(dir)
  const todoStore = new TodoStore(dir)
  store.groupResolver = (id) => findGroup(loadGroups(dir), 'memory', id)
  todoStore.groupResolver = (id) => findGroup(loadGroups(dir), 'todo', id)
  const state = { memoryTabEnabled: true, todoEnabled: true }
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
  return { dir, store, todoStore, request, close: () => new Promise((r) => server.close(r)) }
}

test('groups: 出厂分组表（内置记忆八组 + 待办六组，三类模型）与内置保护', async () => {
  const dir = tempDir()
  try {
    const data = loadGroups(dir)
    // 记忆：会话类 2 + 项目类 2 + 全局类 4（顺序 = order）
    assert.deepEqual(
      listGroups(data, 'memory').map((g) => g.id),
      ['session', 'sessionkey', 'project', 'key', 'daily', 'memory', 'user', 'kb'],
    )
    assert.deepEqual(
      listGroups(data, 'memory').map((g) => g.klass),
      ['session', 'session', 'project', 'project', 'global', 'global', 'global', 'global'],
    )
    // 待办：会话/项目/全局/每日 + 已弃用的 life/work（出厂停用，配置保留）
    assert.deepEqual(
      listGroups(data, 'todo').map((g) => g.id),
      ['session', 'project', 'global', 'daily', 'life', 'work'],
    )
    assert.equal(findGroup(data, 'todo', 'life').enabled, false)
    assert.equal(findGroup(data, 'todo', 'work').enabled, false)
    // 出厂默认（2026-10-15 用户拍板）：所有记忆分组都不注入
    assert.deepEqual(listGroups(data, 'memory').map((g) => g.inject), Array(8).fill(false))
    // 待确认门槛：关键记忆要确认，日志不要
    assert.equal(findGroup(data, 'memory', 'memory').confirm, false)
    assert.equal(findGroup(data, 'memory', 'session').confirm, false)
    assert.equal(findGroup(data, 'memory', 'key').confirm, true)
    assert.equal(findGroup(data, 'memory', 'sessionkey').confirm, true)
    assert.equal(findGroup(data, 'memory', 'daily').confirm, false)
    assert.equal(findGroup(data, 'memory', 'kb').inject, false)
    // 内置分组：可改开关、不可删、类不可改
    const renamed = upsertGroup(data, 'memory', { id: 'kb', label: '我的资料库', inject: true })
    assert.equal(renamed.ok, true)
    assert.equal(renamed.group.label, '我的资料库')
    assert.equal(groupLabel(renamed.group), '我的资料库')
    assert.equal(upsertGroup(data, 'memory', { id: 'key', klass: 'global' }).error, 'BUILTIN_KLASS_FIXED')
    assert.equal(deleteGroup(data, 'memory', 'memory').error, 'BUILTIN_PROTECTED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('groups: 待确认门槛与自动通过（含全局自动通过）', () => {
  const dir = tempDir()
  try {
    const data = loadGroups(dir)
    const custom = upsertGroup(data, 'memory', { id: 'gtest0001', label: '自建', klass: 'global' })
    assert.equal(custom.ok, true)
    // 自建分组出厂即需要确认（用户拍板 2026-10-13）
    assert.equal(needsConfirmation(custom.group, false), true)
    // autoApprove 优先
    const auto = upsertGroup(data, 'memory', { id: 'gtest0001', autoApprove: true })
    assert.equal(needsConfirmation(auto.group, false), false)
    // 全局自动通过压过单组设置（key 出厂即"需要确认"）
    const strict = upsertGroup(data, 'memory', { id: 'key' })
    assert.equal(needsConfirmation(findGroup(strict.data, 'memory', 'key'), false), true)
    assert.equal(needsConfirmation(findGroup(strict.data, 'memory', 'key'), true), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('groups: 坏配置归一化（不抛、不丢内置轨）', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'groups.json'), JSON.stringify({
      version: 99,
      groups: [
        { kind: 'memory', id: 'kb', inject: true },              // 内置覆盖
        { kind: 'memory', id: 'memory' },                        // 内置（无覆盖字段）
        { kind: 'bogus', id: 'x' },                              // 未知 kind → 丢
        { kind: 'memory', id: 'BAD ID!' },                       // 非法 id → 丢
        { kind: 'todo', id: 'gcustom01', label: '自定义待办', daily: true, inject: true },
      ],
    }))
    const data = loadGroups(dir)
    assert.equal(data.version, 2)
    assert.equal(listGroups(data, 'memory').length, 8) // 内置一个不少
    assert.equal(findGroup(data, 'memory', 'kb').inject, true)
    const todo = findGroup(data, 'todo', 'gcustom01')
    assert.equal(todo.label, '自定义待办')
    assert.equal(todo.daily, true)
    assert.equal(todo.builtin, false)
    // 再坏一点：整文件不可解析 → 出厂默认
    writeFileSync(join(dir, 'groups.json'), '{ not json')
    assert.equal(listGroups(loadGroups(dir), 'memory').length, 8)
    // 出厂默认 = 8 个记忆分组 + 6 个待办分组
    assert.equal(normalizeGroupsConfig(null).groups.length, 14)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('groups: 自建记忆分组 — 手动写入 / 页签 / 注入开关与抬头', async () => {
  const dir = tempDir()
  const api = await bootGroupsApi(dir)
  try {
    const created = await api.request('POST', '/memory-evolve/api/groups', {
      kind: 'memory', label: '验证分组', klass: 'global', inject: false, confirm: false,
    })
    assert.equal(created.status, 200)
    const gid = created.data.group.id
    assert.match(gid, /^g[0-9a-f]{8}$/)

    const wrote = await api.request('POST', '/memory-evolve/api/memory/group', { id: gid, content: '自建分组的条目' })
    assert.equal(wrote.status, 200)
    assert.equal(wrote.data.ok, true)

    // 记忆 Tab 页签（标题 = 分组名，路径落在 <memoryDir>/global/<id>——v2 的
    // pathOf 给的是分组目录，一条记忆一个 md）
    const files = await api.request('GET', '/memory-evolve/api/memory-files')
    const row = files.data.files.find((f) => f.key === gid)
    assert.equal(row.title, '验证分组')
    assert.equal(row.exists, true)
    assert.equal(row.path, join(dir, 'global', gid))

    const agent = { id: 'a', session: { header: { cwd: dir } } }
    // 默认不注入
    assert.equal(renderSnapshot({ memoryDir: dir }, api.store, agent).includes('自建分组的条目'), false)
    // 打开 inject → 内容进快照，抬头用分组名
    const toggled = await api.request('POST', '/memory-evolve/api/groups', { kind: 'memory', id: gid, inject: true })
    assert.equal(toggled.data.group.inject, true)
    const snapshot = renderSnapshot({ memoryDir: dir }, api.store, agent)
    assert.ok(snapshot.includes('自建分组的条目'))
    assert.ok(snapshot.includes('## 验证分组'))

    // 编辑与删除（自建分组走与内置轨同一套 store 路径）
    const entry = api.store.entriesOf(gid)[0]
    const edited = await api.request('POST', '/memory-evolve/api/memory/update', { target: gid, match: entry, content: '改过的条目' })
    assert.equal(edited.status, 200)
    assert.ok(api.store.entriesOf(gid)[0].includes('改过的条目'))

    const refused = await api.request('DELETE', '/memory-evolve/api/groups?kind=memory&id=memory')
    assert.equal(refused.status, 400)
    const removed = await api.request('DELETE', `/memory-evolve/api/groups?kind=memory&id=${gid}`)
    assert.equal(removed.status, 200)
    assert.equal(loadGroups(dir).groups.some((g) => g.kind === 'memory' && g.id === gid), false)
    // 配置删了、条目文件仍在磁盘上（绝不静默销毁内容）
    const left = readdirSync(join(dir, 'global', gid)).filter((name) => name.endsWith('.md'))
    assert.equal(left.length, 1)
    assert.ok(readFileSync(join(dir, 'global', gid, left[0]), 'utf8').includes('改过的条目'))
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('groups: 自建待办分组 — 写入 / 查询 / 注入', async () => {
  const dir = tempDir()
  const api = await bootGroupsApi(dir)
  try {
    const created = await api.request('POST', '/memory-evolve/api/groups', {
      kind: 'todo', label: '验证待办', scope: 'global', daily: false, inject: true,
    })
    assert.equal(created.status, 200)
    const tid = created.data.group.id

    const added = api.todoStore.addTodo(tid, '自建分组的待办', { quadrant: 'q2' }, undefined)
    assert.equal(added.ok, true)
    const listed = api.todoStore.listTodos([tid], {}, undefined)
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0].target, tid)

    // 注入：todoInject 总开关 + 分组 inject
    const agent = { id: 'a', session: { header: { cwd: dir } } }
    const off = renderSnapshot({ memoryDir: dir, todoEnabled: true }, api.store, agent, undefined, null, null, api.todoStore)
    assert.equal(off.includes('自建分组的待办'), false)
    const on = renderSnapshot({ memoryDir: dir, todoEnabled: true, todoInject: true }, api.store, agent, undefined, null, null, api.todoStore)
    assert.ok(on.includes('自建分组的待办'))

    // /api/todo 默认覆盖全部启用分组（不传 target 也能查到自建分组）
    const viaApi = await api.request('GET', '/memory-evolve/api/todo')
    assert.ok(viaApi.data.items.some((item) => item.target === tid))
  } finally {
    await api.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
