/**
 * memory_library（记忆库管理工具）测试。
 *
 * 覆盖：开关关闭时拒绝、info / titles / path / read / create / update /
 * delete / archive / promote / dedupe 各 action 的行为，以及**每个 action 的
 * 真实返回都落在 output.schema 内**（additionalProperties:false 下漏声明字段
 * 会让整个工具调用被判 invalid output —— 见 tests/memory-tool-schema.test.js
 * 的同类回归）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveStore, MemoryStore } from '../lib/store.js'
import { groupArchiveDirOf, groupDirOf, listGroups, loadGroups } from '../lib/groups.js'
import { promoteArchived } from '../lib/review.js'
import { LIBRARY_DICT } from '../lib/i18n.js'
import { translate, setLocale } from '../lib/i18n.js'
import { libraryToolDefinition } from '../lib/library-tools.js'
import { tmproot } from './_tmp.js'

setLocale('zh')

/** 按 JSON Schema 子集递归校验返回值。 */
function assertFitsSchema(value, schema, path) {
  if (value === undefined || value === null) return
  if (schema.type === 'object') {
    assert.equal(typeof value, 'object', `${path}: 期望对象`)
    assert.equal(Array.isArray(value), false, `${path}: 期望对象而不是数组`)
    const props = schema.properties ?? {}
    for (const key of Object.keys(value)) {
      if (!(key in props)) {
        assert.equal(schema.additionalProperties, true, `${path}.${key} 未在 output.schema 中声明`)
        continue
      }
      assertFitsSchema(value[key], props[key], `${path}.${key}`)
    }
    for (const req of schema.required ?? []) assert.ok(req in value, `${path}.${req} 为 required 但缺失`)
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path}: 期望数组`)
    if (schema.items) value.forEach((item, i) => assertFitsSchema(item, schema.items, `${path}[${i}]`))
    return
  }
  if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${path}: 期望布尔`)
  else if (schema.type === 'string') assert.equal(typeof value, 'string', `${path}: 期望字符串`)
  else if (schema.type === 'integer') assert.ok(Number.isInteger(value), `${path}: 期望整数`)
}

/** 搭一套真实 store/archive + 装配层同款 deps。 */
function harness(enabled = true) {
  const dir = tmproot("dsh-library-test-")
  const store = new MemoryStore(dir)
  const archive = new ArchiveStore(dir)
  const todoStore = { addTodo: () => ({ ok: true, message: 'ok' }) }
  const runtime = { memoryLibraryEnabled: enabled }
  const deps = {
    config: { memoryDir: dir },
    getRuntime: () => ({ ...runtime }),
    t: (key, params) => translate(LIBRARY_DICT, key, params, 'zh'),
    projectDirOf: (cwd) => join(dir, 'projects', cwd.replace(/[^a-z0-9]/gi, '_')),
    listGroups: () => listGroups(loadGroups(dir), 'memory'),
    dirOf: (group, ctx) => groupDirOf(group, ctx),
    archiveDirOf: (group, ctx) => groupArchiveDirOf(group, ctx),
    titlesOf: (group, agent) => {
      try {
        return store.rowsOf(group.id, agent).map((row) => row.entry)
      } catch {
        return []
      }
    },
    readEntry: (group, match, agent) => {
      const peeked = store.peek(group.id, match, agent)
      if (!peeked.ok) return null
      return { group: group.id, title: peeked.entry?.title ?? null, path: peeked.entry?.file ?? null, body: peeked.entry?.body ?? '' }
    },
    // 真实装配里 createEntry 走 addOne（含确认门槛）；这里用 store.addEntry 直写，
    // 因为本测试测的是工具逻辑而不是确认队列（后者有独立测试）。
    createEntry: (group, input, agent) => store.addEntry(group.id, {
      title: input.title, summary: input.summary, keywords: input.keywords, scenario: input.scenario, body: input.body,
    }, agent),
    updateEntry: (group, match, body, agent) => {
      const peeked = store.peek(group.id, match, agent)
      if (!peeked.ok) return null
      return store.updateEntryContent(group.id, peeked.entry, body, agent)
    },
    deleteEntry: (group, match, agent) => {
      const peeked = store.peek(group.id, match, agent)
      if (!peeked.ok) return null
      return store.remove(group.id, match, agent)
    },
    archiveEntry: (group, match, agent) => {
      const peeked = store.peek(group.id, match, agent)
      if (!peeked.ok) return null
      const appended = archive.append(group.id, peeked.entry, agent?.session?.header?.cwd, agent?.session?.id)
      if (!appended.ok) return appended
      const removed = store.remove(group.id, match, agent)
      if (!removed.ok) return { ok: false, message: removed.message }
      return { ok: true, message: `已归档（现有 ${appended.total} 条）` }
    },
    promoteEntry: (group, match, agent) => promoteArchived(store, todoStore, archive, group.id, match, agent?.session?.header?.cwd, agent?.session?.id),
    normalizeTitle: (title) => String(title).toLowerCase().replace(/\s+/g, ''),
  }
  const tool = libraryToolDefinition(deps)
  const exec = { agent: { id: 's1', session: { id: 's1', header: { cwd: '/proj/x' } } } }
  return { dir, tool, exec, store, archive, runtime, clean: () => rmSync(dir, { recursive: true, force: true }) }
}

test('memory_library：开关关闭时拒绝执行（默认关）', async () => {
  const h = harness(false)
  try {
    const value = await h.tool.execute({ action: 'info' }, h.exec)
    assert.equal(value.ok, false)
    assert.match(value.message, /未启用/)
    assertFitsSchema(value, h.tool.output.schema, 'library(info,disabled)')
  } finally { h.clean() }
})

test('memory_library：每个 action 的真实返回都在 output.schema 内', async () => {
  const h = harness(true)
  try {
    assert.equal(h.store.addEntry('kb', { title: '标题一', summary: '摘要一', keywords: ['编码'], scenario: '写代码时', body: '知识库正文' }).ok, true)
    assert.equal(h.store.addEntry('kb', { title: '标题一', body: '另一个分组里的同名' }, undefined).ok, true)

    const cases = [
      { action: 'info' },
      { action: 'titles', group: 'kb' },
      { action: 'path', group: 'kb' },
      { action: 'read', match: '知识库正文' },
      { action: 'create', group: 'kb', title: '新建的', body: '新建正文' },
      { action: 'update', match: '新建正文', body: '改写后的正文' },
      { action: 'dedupe' },
      { action: 'delete', matches: ['改写后的正文'] },
    ]
    for (const args of cases) {
      const value = await h.tool.execute(args, h.exec)
      assert.ok(value && typeof value === 'object', `${args.action}: 应返回对象`)
      assertFitsSchema(value, h.tool.output.schema, `library(${args.action})`)
    }
    // 错误分支同样要合规
    for (const args of [{ action: 'read' }, { action: 'create', body: '' }, { action: 'delete' }, { action: 'nope' }]) {
      const value = await h.tool.execute(args, h.exec)
      assertFitsSchema(value, h.tool.output.schema, `library(${args.action},error)`)
    }
  } finally { h.clean() }
})

test('memory_library：info 给分组/目录/计数；path 给根目录与两类目录', async () => {
  const h = harness(true)
  try {
    h.store.addEntry('kb', { title: '库条目', body: '内容' })
    const info = await h.tool.execute({ action: 'info', group: 'kb' }, h.exec)
    assert.equal(info.ok, true)
    assert.equal(info.root, h.dir)
    assert.equal(info.groups.length, 1)
    const kb = info.groups[0]
    assert.equal(kb.id, 'kb')
    assert.equal(kb.klass, 'global')
    assert.equal(kb.count, 1)
    assert.ok(typeof kb.dir === 'string' && kb.dir.includes('kb'))
    assert.ok(typeof kb.archiveDir === 'string' && kb.archiveDir.includes('archive'))

    const paths = await h.tool.execute({ action: 'path', group: 'kb' }, h.exec)
    assert.equal(paths.path, h.dir)
    assert.match(paths.message, /kb/)
  } finally { h.clean() }
})

test('memory_library：titles 扫标题+元数据（含归档前的元数据）、dedupe 报同标题', async () => {
  const h = harness(true)
  try {
    h.store.addEntry('kb', { title: '同名标题', summary: '摘要', keywords: ['a'], body: 'A 正文' })
    const titles = await h.tool.execute({ action: 'titles', group: 'kb' }, h.exec)
    assert.equal(titles.entries.length, 1)
    assert.equal(titles.entries[0].title, '同名标题')
    assert.equal(titles.entries[0].summary, '摘要')
    assert.deepEqual(titles.entries[0].keywords, ['a'])
    assert.equal(titles.entries[0].group, 'kb')
    assert.equal(titles.entries[0].archived, false)
  } finally { h.clean() }
})

test('memory_library：archive → promote 往返（归档后不在主轨、可移回）', async () => {
  const h = harness(true)
  try {
    h.store.addEntry('kb', { title: '待归档', body: '要归档的正文' })
    const archived = await h.tool.execute({ action: 'archive', matches: ['要归档的正文'] }, h.exec)
    assert.equal(archived.ok, true)
    assert.equal(archived.results[0].ok, true)
    assert.equal(h.store.entriesOf('kb').some((text) => text.includes('要归档的正文')), false)
    assert.equal(h.archive.entriesOf('kb').length, 1)

    const promoted = await h.tool.execute({ action: 'promote', match: '要归档的正文' }, h.exec)
    assert.equal(promoted.ok, true)
    assert.equal(h.archive.entriesOf('kb').length, 0)
    assert.equal(h.store.entriesOf('kb').some((text) => text.includes('要归档的正文')), true)
  } finally { h.clean() }
})

test('memory_library：delete 批量逐条报告（命中不了的条目不影响其它条目）', async () => {
  const h = harness(true)
  try {
    h.store.addEntry('kb', { title: '甲', body: '甲正文' })
    h.store.addEntry('kb', { title: '乙', body: '乙正文' })
    const out = await h.tool.execute({ action: 'delete', matches: ['甲正文', '不存在的正文', '乙正文'] }, h.exec)
    assert.equal(out.total, 3)
    assert.equal(out.results.filter((row) => row.ok).length, 2)
    assert.equal(out.results.find((row) => row.match === '不存在的正文').ok, false)
    assert.equal(h.store.entriesOf('kb').length, 0)
  } finally { h.clean() }
})
