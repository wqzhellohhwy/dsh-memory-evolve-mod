/**
 * 记忆页签数据面（lib/memory-tab.js）的回归护栏。
 *
 * v2（2026-10-15）：一条记忆一个 md，分组按「类」组织，所以 buildMemoryFiles
 * 返回 `{ files, classes }`——`files` 是扁平兼容行（每个记忆分组一行 + 一类归档
 * 各一行 + 全局规则 AGENTS.md），`classes` 是三级页签用的类树。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { buildMemoryFiles } from '../lib/memory-tab.js'
import { setLocale, getLocale } from '../lib/i18n.js'
import { tmproot } from './_tmp.js'

function tempDir() {
  return tmproot("dsh-memory-tab-test-")
}

function setup(overrides = {}) {
  const dir = tempDir()
  const config = {
    memoryDir: dir,
    skillDir: join(dir, 'skills'),
    ...overrides,
  }
  const store = new MemoryStore(dir)
  return { dir, config, store }
}

/** 会话 agent（项目类要 cwd、会话类要 session id）。 */
const SESSION_AGENT = { session: { id: 's1', header: { cwd: '/work/p' } } }

/** 内置八组的出厂顺序（三类）。 */
const BUILTIN_ORDER = ['session', 'sessionkey', 'project', 'key', 'daily', 'memory', 'user', 'kb']

test('buildMemoryFiles lists every memory group with content (three classes)', () => {
  const { dir, config, store } = setup()
  store.add('memory', '环境事实')
  store.add('user', '用户偏好')
  store.add('kb', '参考知识')
  store.add('project', '项目约定', SESSION_AGENT)
  store.add('key', '项目关键事实', SESSION_AGENT)
  store.add('daily', '今天做了事')
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '全局规则')
    const { files, classes } = buildMemoryFiles(config, store, SESSION_AGENT)
    const byKey = Object.fromEntries(files.map((f) => [f.key, f]))
    // 内置八组 + 全局规则一行（没有归档条目 → 不出现 archive-* 行）
    assert.deepEqual(files.map((f) => f.key), [...BUILTIN_ORDER, 'agents'])
    assert.equal(byKey.agents.content, '全局规则')
    assert.equal(byKey.memory.content.includes('环境事实'), true)
    assert.equal(byKey.user.content.includes('用户偏好'), true)
    assert.equal(byKey.project.content.includes('项目约定'), true)
    assert.equal(byKey.key.content.includes('项目关键事实'), true)
    assert.equal(byKey.daily.content.includes('今天做了事'), true)
    assert.equal(byKey.kb.content.includes('参考知识'), true)
    // path 是**分组目录**（v2）；展示内容剥掉了 [id:…] 前缀
    assert.equal(byKey.memory.path, join(dir, 'global', 'memory'))
    assert.equal(byKey.memory.exists, true)
    assert.equal(byKey.memory.count, 1)
    assert.ok(!byKey.memory.content.includes('[id:'))
    // 三类树：会话类 2 组 / 项目类 2 组 / 全局类 4 组
    assert.deepEqual(classes.map((c) => c.klass), ['session', 'project', 'global'])
    assert.deepEqual(classes.map((c) => c.groups.length), [2, 2, 4])
    assert.deepEqual(classes[2].groups.map((g) => g.id), ['daily', 'memory', 'user', 'kb'])
  } finally {
    process.env.DSH_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildMemoryFiles localizes group titles with the active locale', () => {
  const { dir, config, store } = setup()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const prevLocale = getLocale()
  try {
    // English：分组标题走英文口径（不再是旧的中文串）
    setLocale('en')
    let byKey = Object.fromEntries(buildMemoryFiles(config, store, SESSION_AGENT).files.map((f) => [f.key, f]))
    assert.equal(byKey.memory.title, 'Global key memory')
    assert.equal(byKey.user.title, 'User profile')
    assert.equal(byKey.key.title, 'Key workspace facts')
    assert.equal(byKey.kb.title, 'Knowledge base')
    assert.equal(byKey.project.title, 'Workspace log')
    assert.equal(byKey.daily.title, 'Daily log')
    assert.equal(byKey.session.title, 'Session log')
    assert.equal(byKey.sessionkey.title, 'Session key facts')
    // Chinese：出厂名
    setLocale('zh')
    byKey = Object.fromEntries(buildMemoryFiles(config, store, SESSION_AGENT).files.map((f) => [f.key, f]))
    assert.equal(byKey.memory.title, '全局关键记忆')
    assert.equal(byKey.user.title, '用户档案')
    assert.equal(byKey.project.title, '工作区日志')
    assert.equal(byKey.daily.title, '今日日志')
    assert.equal(byKey.kb.title, '记忆知识库')
    assert.equal(byKey.session.title, '会话日志')
    // 全局规则行始终存在（标题随语言，但 key 固定）
    assert.equal(byKey.agents !== undefined, true)
  } finally {
    setLocale(prevLocale)
    process.env.DSH_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildMemoryFiles handles missing files and missing cwd', () => {
  const { dir, config, store } = setup()
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir // isolate AGENTS.md from the real dsh home
  try {
    const { files } = buildMemoryFiles(config, store, undefined)
    const byKey = Object.fromEntries(files.map((f) => [f.key, f]))
    assert.equal(byKey.agents.exists, false)
    assert.equal(byKey.agents.content, '')
    // 全局类：路径可算但目录还不存在 → 列为空分组
    assert.equal(byKey.memory.exists, false)
    assert.equal(byKey.memory.available, true)
    assert.equal(byKey.memory.path, join(dir, 'global', 'memory'))
    // 项目类缺 cwd → 不可用但仍列出
    assert.equal(byKey.project.available, false)
    assert.equal(byKey.project.path, undefined)
    assert.equal(byKey.key.available, false)
    assert.equal(byKey.key.path, undefined)
    // 会话类缺 session id → 同样不可用
    assert.equal(byKey.session.available, false)
    assert.equal(byKey.session.path, undefined)
  } finally {
    process.env.DSH_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})
