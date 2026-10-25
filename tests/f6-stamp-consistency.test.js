/**
 * F-6 回归：时间戳精确到分钟之后，**写入侧 / 渲染侧 / 剥离侧必须同形**。
 *
 * 背景：F-6 最初只改了渲染出口 `timeStampOf()`，写入侧（`stampEntry`）与剥离侧
 * （`splitEntryHead`）没跟上，于是冒出三个真 bug（由测试适配时的探针实测发现）：
 *   1. `add()` 判重永不命中 —— 写入 `[YYYY-MM-DD]`、读回 `[YYYY-MM-DD HH:MM]`，
 *      `stripEntryId` 后不相等 → 同一内容真的写两条、还返回「已添加」；
 *   2. `splitEntryHead()` 剥不掉新戳 → 它被当成正文，`setEntryBranches` /
 *      `setEntryDshOnly` / `updateEntryContent` 重建条目时再盖一个戳（双时间戳），
 *      key 轨还会丢掉 `[branch:…]`；
 *   3. `add()` 文本路径写入的 created 恒为 `00:00`，"精确到分钟"其实没达成。
 *
 * 本文件把这三条钉死 —— 删掉任何一条都意味着上面某个 bug 回来了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { tmproot } from './_tmp.js'

/** `[id:xxxxxxxx] [YYYY-MM-DD HH:MM] 正文` 的完整形状。 */
const HEAD_RE = /^\[id:[0-9a-f]{8}\] \[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\](.*)$/
/** 只数时间戳出现次数（双戳检测用）。 */
const STAMP_ANY_RE = /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/g

test('F-6 回归：同内容 add 两次只落一条（写入态与读回态同形，判重才有效）', () => {
  const dir = tmproot("dsh-f6-dedup-")
  try {
    const store = new MemoryStore(dir)
    const first = store.add('memory', '同一分钟里的同一条内容')
    const second = store.add('memory', '同一分钟里的同一条内容')
    assert.equal(first.ok, true)
    // 幂等语义：不重复添加但不算失败 —— store.add 用 `duplicate: true` 表达
    // （见 probe-f6-dedup.mjs 实测：第二次返回 {ok:true, duplicate:true,
    // 「条目已存在，未重复添加」}）。判重一旦失效，这里会变成第二条真写入。
    assert.equal(second.duplicate, true, '第二次应被判重标记为 duplicate')
    assert.equal(store.entriesOf('memory').length, 1)
    assert.equal(store.entriesOf('memory')[0].includes('同一条内容'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F-6 回归：新格式条目改正文时不产生双时间戳（剥离侧必须认得新戳）', () => {
  const dir = tmproot("dsh-f6-strip-")
  try {
    const store = new MemoryStore(dir)
    const agent = { session: { id: 's1', header: { cwd: '/proj/x' } } }
    assert.equal(store.add('key', '工作区约定 A', agent).ok, true)
    const before = store.entriesOf('key', agent)[0]
    assert.match(before, HEAD_RE, `前置条件：新写入应带时分戳，实际 ${before}`)

    const peeked = store.peek('key', '工作区约定 A', agent)
    assert.equal(peeked.ok, true)
    assert.equal(store.updateEntryContent('key', peeked.entry, '工作区约定 B', agent).ok, true)

    const after = store.entriesOf('key', agent)[0]
    assert.equal(
      (after.match(STAMP_ANY_RE) ?? []).length,
      1,
      `重建后只应有一个时间戳（出现两个说明剥离侧把渲染文本当成了正文）：${after}`,
    )
    assert.ok(after.includes('工作区约定 B'), `正文应被替换：${after}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F-6 回归：add 写入的戳是真实时分，不是补出来的 00:00', () => {
  const dir = tmproot("dsh-f6-time-")
  try {
    const store = new MemoryStore(dir)
    assert.equal(store.add('user', '用户档案一条').ok, true)
    const raw = store.entriesOf('user')[0]
    const matched = HEAD_RE.exec(raw)
    assert.ok(matched, `戳形状不对：${raw}`)
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    assert.notEqual(matched[2], '00:00', '写入路径不应恒为 00:00（那是渲染时才补的假值）')
    assert.equal(matched[2], hhmm, '应精确到分钟且与写入时刻一致')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
