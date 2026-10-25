/**
 * 布局 v3 集成验收（规范 §10）：迁移 → 幂等 → 改名 → 删除统计 → daily 拒绝。
 *
 * 只新增本文件、不改生产代码。夹具全部用 `tmproot('layout-v3-')` 现造，
 * 不碰本机真实记忆目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { LAYOUT_VERSION, migrateV3 } from '../lib/migrate-v3.js'
import {
  deleteStatsOf, findGroup, groupArchiveDirOf, groupDirOf, loadGroups,
  renameGroupId, saveGroups, todoFileOf, upsertGroup,
} from '../lib/groups.js'
import { installApi } from '../lib/api.js'
import { ArchiveStore, MemoryStore, SuggestionQueue } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'
import { tmproot } from './_tmp.js'

/** 旧结构夹具（v2 布局 + 模块数据 + 未知条目）。 */
function legacyFixture() {
  const root = tmproot('layout-v3-')
  const mem = join(root, 'memories')
  const write = (rel, text = `# ${rel}\n`) => {
    const file = join(mem, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  write('groups.json', '{"version":2,"groups":[]}\n')
  write('tools.json', '{}\n')
  write('plugin-state.json', '{"syncEnabled":false}\n')
  write('.vault-version', '2\n')
  // 全局类
  write('global/kb/【A】全局.md')
  write('global/daily/2026-10-14/【L】日志.md')
  // 会话类
  write('sessions/s1/sessionkey/【K】会话关键.md')
  write('sessions/s1/session/2026-10-15/【S】会话日志.md')
  write('sessions/s1/todo/TODOS-session.md', '# 会话待办\n')
  write('sessions/s1/archive/sessionkey/【旧】会话.md')
  // 项目类
  write('projects/p1/key/【P】项目关键.md')
  write('projects/p1/project/2026-10-14/【W】项目日志.md')
  write('projects/p1/todo/TODOS-project.md', '# 项目待办\n')
  write('projects/p1/archive/key/【旧】项目.md')
  write('projects/p1/PROVENANCE', '{"id":"p1"}\n')
  // 待办（全局）
  write('todo/TODOS-global.md', '# 全局待办\n')
  write('todo/daily/2026-10-14.md', '# 2026-10-14\n')
  // 归档（全局）
  write('archive/kb/【旧】全局.md')
  // 模块数据（原地保留）
  write('models.json', '{"models":[]}\n')
  // 未知条目（搬 legacy）
  write('backup-v1-20260101-000000/MEMORY.md')
  return { root, mem }
}

/** 目录树哈希（忽略迁移状态文件，它带时间戳）。 */
function treeHash(dir, base = dir) {
  const hash = createHash('sha256')
  const walk = (current) => {
    const items = readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const item of items) {
      const full = join(current, item.name)
      const rel = full.slice(base.length + 1).split('\\').join('/')
      if (rel === '.system/migrate-v3.state') continue
      if (item.isDirectory()) {
        hash.update(`D:${rel}\n`)
        walk(full)
      } else {
        hash.update(`F:${rel}\n${readFileSync(full, 'utf8')}\n`)
      }
    }
  }
  walk(dir)
  return hash.digest('hex')
}

/** 记忆根是否已迁移到 v3（根下只剩允许条目，模块数据除外）。 */
function assertMigratedLayout(mem) {
  assert.equal(readFileSync(join(mem, '.layout-version'), 'utf8').trim(), String(LAYOUT_VERSION))
  assert.deepEqual(readdirSync(mem).sort(), [
    '.layout-version', '.system', 'memory', 'models.json', 'todo',
  ])
}

/** 起一个真 HTTP 服务（与装配层同接线），用来验证删除链路。 */
async function bootApi(dir) {
  const store = new MemoryStore(dir)
  const todoStore = new TodoStore(dir)
  store.groupResolver = (id) => findGroup(loadGroups(dir), 'memory', id)
  todoStore.groupResolver = (id) => findGroup(loadGroups(dir), 'todo', id)
  const state = { memoryTabEnabled: true, todoEnabled: true }
  const ctx = { webServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } } }
  installApi(ctx, {
    store,
    archive: new ArchiveStore(dir),
    queue: new SuggestionQueue(join(dir, '.system', 'SUGGESTIONS.jsonl')),
    todoStore,
    getRuntime: () => ({ ...state }),
    updateRuntime: (patch) => Object.assign(state, patch),
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
    return { status: res.status, data: await res.json().catch(() => null) }
  }
  return { request, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('集成: migrate-v3 dry-run 不落盘，apply 后新路径齐全、旧路径清空', () => {
  const { mem } = legacyFixture()
  const before = treeHash(mem)
  const dry = migrateV3(mem, { dryRun: true })
  assert.equal(dry.ok, true)
  assert.equal(treeHash(mem), before, 'dry-run 不允许改盘')
  assert.equal(existsSync(join(mem, '.system')), false)
  assert.equal(existsSync(join(mem, '.layout-version')), false)

  const report = migrateV3(mem, {})
  assert.equal(report.ok, true)
  assert.deepEqual(report.errors, [])
  assertMigratedLayout(mem)
  // 记忆：三类段 + 归档
  assert.ok(existsSync(join(mem, 'memory', 'kb', 'global', '【A】全局.md')))
  assert.ok(existsSync(join(mem, 'memory', 'daily', 'global', '2026-10-14', '【L】日志.md')))
  assert.ok(existsSync(join(mem, 'memory', 'sessionkey', 'session', 's1', '【K】会话关键.md')))
  assert.ok(existsSync(join(mem, 'memory', 'session', 'session', 's1', '2026-10-15', '【S】会话日志.md')))
  assert.ok(existsSync(join(mem, 'memory', 'key', 'project', 'p1', '【P】项目关键.md')))
  assert.ok(existsSync(join(mem, 'memory', 'project', 'project', 'p1', '2026-10-14', '【W】项目日志.md')))
  assert.ok(existsSync(join(mem, 'memory', 'kb', 'archive', 'global', '【旧】全局.md')))
  assert.ok(existsSync(join(mem, 'memory', 'sessionkey', 'archive', 'session', 's1', '【旧】会话.md')))
  assert.ok(existsSync(join(mem, 'memory', 'key', 'archive', 'project', 'p1', '【旧】项目.md')))
  // 待办
  assert.equal(readFileSync(join(mem, 'todo', 'global', 'global', 'TODOS.md'), 'utf8'), '# 全局待办\n')
  assert.ok(existsSync(join(mem, 'todo', 'daily', 'global', '2026-10-14.md')))
  assert.ok(existsSync(join(mem, 'todo', 'session', 'session', 's1', 'TODOS.md')))
  assert.ok(existsSync(join(mem, 'todo', 'project', 'project', 'p1', 'TODOS.md')))
  // 项目元数据 + 系统文件
  assert.equal(readFileSync(join(mem, '.system', 'projects', 'p1', 'PROVENANCE'), 'utf8'), '{"id":"p1"}\n')
  assert.ok(existsSync(join(mem, '.system', 'groups.json')))
  assert.ok(existsSync(join(mem, '.system', 'plugin-state.json')))
  // 模块数据原地、未知条目进 legacy
  assert.equal(readFileSync(join(mem, 'models.json'), 'utf8'), '{"models":[]}\n')
  assert.equal(existsSync(join(mem, '.system', 'legacy', 'models.json')), false)
  assert.ok(existsSync(join(mem, '.system', 'legacy', 'backup-v1-20260101-000000', 'MEMORY.md')))
  // 旧路径清空（注意 `todo/daily/` 本身还在——它是新分组目录，旧文件必须离开）
  for (const old of ['global', 'sessions', 'projects', 'archive', 'todo/TODOS-global.md', 'todo/daily/2026-10-14.md']) {
    assert.equal(existsSync(join(mem, old)), false, `${old} 应已搬走`)
  }
})

test('集成: 再迁移一次幂等（文件树哈希不变）', () => {
  const { mem } = legacyFixture()
  assert.equal(migrateV3(mem, {}).ok, true)
  const after = treeHash(mem)
  const again = migrateV3(mem, {})
  assert.equal(again.ok, true)
  assert.equal(again.alreadyMigrated, true)
  assert.equal(treeHash(mem), after)
})

test('集成: 路径函数 12 组（3 类 × 2 kind × daily 两态）落在 v3 布局', () => {
  const mem = join('C:', 'mem')
  const memoryGroup = (klass, daily) => ({ kind: 'memory', id: 'g1', klass, daily })
  const todoGroup = (klass, daily) => ({ kind: 'todo', id: 'g1', klass, daily })
  const ctx = { memoryDir: mem, projectId: 'p1', sessionId: 's1' }
  const cases = [
    [memoryGroup('global', false), groupDirOf, join(mem, 'memory', 'g1', 'global')],
    [memoryGroup('global', true), groupDirOf, join(mem, 'memory', 'g1', 'global')],
    [memoryGroup('project', false), groupDirOf, join(mem, 'memory', 'g1', 'project', 'p1')],
    [memoryGroup('project', true), groupDirOf, join(mem, 'memory', 'g1', 'project', 'p1')],
    [memoryGroup('session', false), groupDirOf, join(mem, 'memory', 'g1', 'session', 's1')],
    [memoryGroup('session', true), groupDirOf, join(mem, 'memory', 'g1', 'session', 's1')],
    [memoryGroup('global', false), groupArchiveDirOf, join(mem, 'memory', 'g1', 'archive', 'global')],
    [memoryGroup('session', true), groupArchiveDirOf, join(mem, 'memory', 'g1', 'archive', 'session', 's1')],
    [todoGroup('global', false), todoFileOf, join(mem, 'todo', 'g1', 'global', 'TODOS.md')],
    [todoGroup('global', true), todoFileOf, join(mem, 'todo', 'g1', 'global', '2026-10-14.md')],
    [todoGroup('project', false), todoFileOf, join(mem, 'todo', 'g1', 'project', 'p1', 'TODOS.md')],
    [todoGroup('session', true), todoFileOf, join(mem, 'todo', 'g1', 'session', 's1', '2026-10-14.md')],
  ]
  for (const [group, fn, expected] of cases) {
    const actual = fn(group, group.daily === true && group.kind === 'todo' ? { ...ctx, date: '2026-10-14' } : ctx)
    assert.equal(actual, expected, `${group.kind}/${group.klass}/daily=${group.daily}`)
  }
  // 缺 projectId / sessionId → null
  assert.equal(groupDirOf(memoryGroup('project', false), { memoryDir: mem }), null)
  assert.equal(groupDirOf(memoryGroup('session', false), { memoryDir: mem }), null)
  assert.equal(todoFileOf(todoGroup('project', false), { memoryDir: mem }), null)
})

test('集成: 自建分组改名（目录跟随、条目仍在、配置 id 更新；重名/非法/内置拒绝）', () => {
  const { mem } = legacyFixture()
  assert.equal(migrateV3(mem, {}).ok, true)
  let data = loadGroups(mem)
  const created = upsertGroup(data, 'memory', { id: 'mynote', klass: 'global', label: '我的笔记' })
  assert.equal(created.ok, true)
  data = created.data
  saveGroups(mem, data)
  const file = join(mem, 'memory', 'mynote', 'global', '条目.md')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '# 条目\n')

  const renamed = renameGroupId(mem, 'memory', 'mynote', 'fresh', loadGroups(mem))
  assert.equal(renamed.ok, true)
  assert.equal(renamed.moved, true)
  assert.equal(existsSync(join(mem, 'memory', 'mynote')), false)
  assert.equal(readFileSync(join(mem, 'memory', 'fresh', 'global', '条目.md'), 'utf8'), '# 条目\n')
  assert.ok(findGroup(renamed.data, 'memory', 'fresh') !== null, '返回的配置里 id 已更新')
  assert.equal(findGroup(renamed.data, 'memory', 'mynote'), null)
  saveGroups(mem, renamed.data)
  assert.equal(findGroup(loadGroups(mem), 'memory', 'fresh').id, 'fresh')

  // 重名（大小写不敏感）
  const dup = renameGroupId(mem, 'memory', 'fresh', 'KB', loadGroups(mem))
  assert.equal(dup.ok, false)
  assert.equal(dup.error, 'ID_TAKEN')
  // 非法 id
  const bad = renameGroupId(mem, 'memory', 'fresh', 'Bad ID', loadGroups(mem))
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'INVALID_ID')
  // 保留字
  const reserved = renameGroupId(mem, 'memory', 'fresh', 'memory', loadGroups(mem))
  assert.equal(reserved.ok, false)
  assert.equal(reserved.error, 'RESERVED_ID')
  // 内置分组不可改名
  const builtin = renameGroupId(mem, 'memory', 'kb', 'kb2', loadGroups(mem))
  assert.equal(builtin.ok, false)
  assert.equal(builtin.error, 'BUILTIN_PROTECTED')
  // 改名后条目仍可读、目录名仍合法
  assert.ok(existsSync(join(mem, 'memory', 'fresh', 'global', '条目.md')))
})

test('集成: 删除统计与夹具一致；删记忆分组不影响同名待办分组', async () => {
  const { mem } = legacyFixture()
  assert.equal(migrateV3(mem, {}).ok, true)
  let data = loadGroups(mem)
  const memGroup = upsertGroup(data, 'memory', { id: 'mynote', klass: 'global' })
  assert.equal(memGroup.ok, true)
  data = memGroup.data
  const todoGroup = upsertGroup(data, 'todo', { id: 'mynote', klass: 'global' })
  assert.equal(todoGroup.ok, true)
  saveGroups(mem, todoGroup.data)

  const touch = (rel, text = `# ${rel}\n`) => {
    const file = join(mem, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  touch('memory/mynote/global/a.md')
  touch('memory/mynote/global/b.md')
  touch('memory/mynote/project/p1/c.md')
  touch('memory/mynote/session/s1/e.md')
  touch('memory/mynote/archive/global/old.md')
  touch('memory/mynote/archive/session/s1/old2.md')
  touch('todo/mynote/global/TODOS.md')

  assert.deepEqual(deleteStatsOf(mem, 'memory', 'mynote'), { entries: 4, archived: 2, locations: 2 })
  assert.deepEqual(deleteStatsOf(mem, 'todo', 'mynote'), { entries: 1, archived: 0, locations: 0 })

  const api = await bootApi(mem)
  try {
    const preview = await api.request('GET', '/memory-evolve/api/groups/delete-preview?kind=memory&id=mynote')
    assert.equal(preview.status, 200)
    assert.deepEqual(preview.data.stats, { entries: 4, archived: 2, locations: 2 })
    assert.equal(preview.data.deletable, true)

    const deleted = await api.request('DELETE', '/memory-evolve/api/groups?kind=memory&id=mynote')
    assert.equal(deleted.status, 200)
    assert.equal(deleted.data.ok, true)
    assert.deepEqual(deleted.data.deleted, { entries: 4, archived: 2, locations: 2 })

    // 记忆分组没了，同名待办分组完好
    assert.equal(existsSync(join(mem, 'memory', 'mynote')), false)
    assert.equal(findGroup(loadGroups(mem), 'memory', 'mynote'), null)
    assert.ok(existsSync(join(mem, 'todo', 'mynote', 'global', 'TODOS.md')))
    assert.ok(findGroup(loadGroups(mem), 'todo', 'mynote') !== null)
    // 内置分组不可删
    const builtin = await api.request('DELETE', '/memory-evolve/api/groups?kind=memory&id=kb')
    assert.equal(builtin.status, 400)
    assert.equal(builtin.data.code, 'BUILTIN_PROTECTED')
  } finally {
    await api.close()
  }
})

test('集成: daily 一经创建不可改（upsertGroup 返回 DAILY_FIXED）', () => {
  const { mem } = legacyFixture()
  assert.equal(migrateV3(mem, {}).ok, true)
  const data = loadGroups(mem)

  // 内置日志型（memory 的 daily）拒绝改成非日志型
  assert.deepEqual(upsertGroup(data, 'memory', { id: 'daily', daily: false }), {
    ok: false, error: 'DAILY_FIXED',
  })
  // 内置非日志型拒绝改成日志型
  assert.deepEqual(upsertGroup(data, 'memory', { id: 'kb', daily: true }), {
    ok: false, error: 'DAILY_FIXED',
  })
  // 自建分组同样：建好后改 daily 一律拒绝
  const created = upsertGroup(data, 'memory', { id: 'n1', klass: 'global', daily: false })
  assert.equal(created.ok, true)
  assert.deepEqual(upsertGroup(created.data, 'memory', { id: 'n1', daily: true }), {
    ok: false, error: 'DAILY_FIXED',
  })
  // 同值传回不算变更（幂等）
  assert.equal(upsertGroup(created.data, 'memory', { id: 'n1', daily: false }).ok, true)
})
