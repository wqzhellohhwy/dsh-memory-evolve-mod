/**
 * 记忆知识库（第六轨，2026-10-11）：
 *   - pathOf 落在 <memoryDir>/global/kb（v2：全局类目录，一条记忆一个 md 文件）；
 *   - add / list / replace / remove 全链路（标签化文本 + 程序日期戳）；
 *   - **永不注入上下文**（renderSnapshot 只读 memory/user/key）——这是该轨
 *     存在的全部理由：放"不想占上下文、需要时又要查得到"的资料；
 *   - 缺 cwd 也可用（全局轨，不依赖会话工作目录）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { renderSnapshot, resolveConfig } from '../lib/index.js'
import { tmproot } from './_tmp.js'

function tempDir() {
  return tmproot("dsh-memory-kb-")
}

/** v2：出厂全部 `inject: false`，要断言"某分组进快照"必须先显式打开。 */
function enableInject(dir, ids) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'groups.json'), JSON.stringify({
    version: 2,
    groups: ids.map((id) => ({ kind: 'memory', id, inject: true })),
  }, null, 2))
}

test('kb track lives in <memoryDir>/global/kb (global track, no cwd needed)', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    assert.equal(store.pathOf('kb'), join(dir, 'global', 'kb'))
    // 无 session cwd 也能定位（与 project/key 不同）
    assert.equal(store.pathOf('kb', undefined), join(dir, 'global', 'kb'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('kb add/list/replace/remove round-trips with the program date stamp', () => {
  const dir = tempDir()
  try {
    const store = new MemoryStore(dir)
    const added = store.add('kb', '某 API 的鉴权流程：先取 token 再带 Bearer 头')
    assert.equal(added.ok, true)
    // v2：落盘 = 分组目录下一个 md 文件
    assert.equal(existsSync(join(dir, 'global', 'kb')), true)
    assert.equal(readdirSync(join(dir, 'global', 'kb')).filter((n) => n.endsWith('.md')).length, 1)

    const entries = store.entriesOf('kb')
    assert.equal(entries.length, 1)
    // 身份证在最前，日期戳由程序盖（[YYYY-MM-DD] 前缀），与 memory/user 轨一致
    assert.match(entries[0], /^\[id:[0-9a-z]+\] \[\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?\] 某 API 的鉴权流程/)

    // list 走 query：filter 命中 / 不命中
    assert.equal(store.query('kb', undefined, { filter: 'Bearer' }).length, 1)
    assert.equal(store.query('kb', undefined, { filter: '不存在的关键词' }).length, 0)

    // replace：只改正文，时间戳保留
    const replaced = store.replace('kb', '鉴权流程', '某 API 的鉴权流程：先取 token 再带 Bearer 头（v2）')
    assert.equal(replaced.ok, true)
    const afterReplace = store.entriesOf('kb')
    assert.equal(afterReplace.length, 1)
    assert.match(afterReplace[0], /^\[id:[0-9a-z]+\] \[\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?\] /)
    assert.match(afterReplace[0], /（v2）$/)

    // remove
    const removed = store.remove('kb', 'v2')
    assert.equal(removed.ok, true)
    assert.equal(store.entriesOf('kb').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('kb is NEVER injected into the context snapshot (while memory/user/key are)', () => {
  const dir = tempDir()
  try {
    const config = resolveConfig({ memoryDir: join(dir, 'memories') })
    const store = new MemoryStore(config.memoryDir, config)
    const agent = { id: 'a', session: { header: { cwd: dir } } }
    // v2：memory/user 出厂不注入，对照组要显式打开；kb 保持不打开
    enableInject(config.memoryDir, ['memory', 'user'])
    store.add('memory', '全局事实：注入轨')
    store.add('user', '用户事实：注入轨')
    store.add('kb', '知识库条目：绝不注入')

    const snapshot = renderSnapshot(config, store, agent)
    // 对照组：注入轨照常出现
    assert.ok(snapshot.includes('全局事实：注入轨'))
    assert.ok(snapshot.includes('用户事实：注入轨'))
    // 待测：知识库内容一个字都不许进快照
    assert.equal(snapshot.includes('知识库条目'), false)
    assert.equal(snapshot.includes('绝不注入'), false)
    // 也不能出现知识库的段落抬头（防止将来加段落时误注入）
    assert.equal(snapshot.includes('KB.md'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
