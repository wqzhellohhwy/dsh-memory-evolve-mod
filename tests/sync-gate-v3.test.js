/**
 * tests/sync-gate-v3.test.js — 同步布局门禁（v3）测试。
 *
 * 第一段（S4a）：只测 `lib/sync/layout-gate.js` 本身——
 *   `.layout-version` 缺失 / 为 2 / 为 3 / 带空白 / 为目录（不可读）/
 *   目录不存在 / 只有迁移中状态文件（无标记）/ 空 memoryDir；
 *   以及三组返回形状（reason / kind:error / ok:false,code:2）。
 * 第二段（S4b，待 S2）：ops 9 个写 op、handleCommand、worker、repo 的集成守卫。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setLocale } from '../lib/i18n.js'
import { tmproot } from './_tmp.js'
import {
  LAYOUT_GATE_CODE,
  REQUIRED_LAYOUT_VERSION,
  isLayoutV3,
  layoutBlockedMessage,
  layoutBlockedReason,
  layoutBlockedReasonSoft,
  layoutGateError,
  layoutGateErrorIfRolledBack,
  layoutGateErrorSoft,
  layoutGateFailure,
  layoutGateFailureSoft,
  layoutRollbackMessage,
} from '../lib/sync/layout-gate.js'
import { handleCommand, installMemorySync } from '../lib/sync/index.js'
import { resolveConflict, runStatus, runSync } from '../lib/sync/worker.js'
import { deviceBConnect, ensureGlobalRepo, ensureMemoryRepo } from '../lib/sync/repo.js'

// 本套件默认中文措辞；英文只在本文件内临时切换。
setLocale('zh')

const dirWithVersion = (version) => {
  const dir = tmproot('dsh-sync-gate-')
  writeFileSync(join(dir, '.layout-version'), version)
  return dir
}

test('常量：门禁码 2、目标版本 3', () => {
  assert.equal(LAYOUT_GATE_CODE, 2)
  assert.equal(REQUIRED_LAYOUT_VERSION, 3)
})

test('缺 .layout-version → 非 v3 且给出中文文案', () => {
  const dir = tmproot('dsh-sync-gate-')
  assert.equal(isLayoutV3(dir), false)
  const reason = layoutBlockedReason(dir)
  assert.equal(typeof reason, 'string')
  assert.match(reason, /布局未迁移到 v3/)
  assert.match(reason, /migrate-v3\.mjs/)
  assert.match(reason, /allow-sync/)
})

test('.layout-version=3（含换行/空白）→ 放行', () => {
  assert.equal(isLayoutV3(dirWithVersion('3')), true)
  assert.equal(isLayoutV3(dirWithVersion('3\n')), true)
  assert.equal(isLayoutV3(dirWithVersion(' 3 \n')), true)
  assert.equal(layoutBlockedReason(dirWithVersion('3')), null)
  assert.equal(layoutGateError(dirWithVersion('3')), null)
  assert.equal(layoutGateFailure(dirWithVersion('3')), null)
})

test('.layout-version=2 / 非数字 → 非 v3', () => {
  assert.equal(isLayoutV3(dirWithVersion('2')), false)
  assert.equal(isLayoutV3(dirWithVersion('')), false)
  assert.equal(isLayoutV3(dirWithVersion('v3')), false)
  assert.equal(isLayoutV3(dirWithVersion('3.0')), true)
})

test('迁移中（只有 .system/migrate-v3.state，没有标记）→ 仍然拒绝', () => {
  const dir = tmproot('dsh-sync-gate-')
  mkdirSync(join(dir, '.system'), { recursive: true })
  writeFileSync(join(dir, '.system', 'migrate-v3.state'), JSON.stringify({ version: 3, done: [] }))
  assert.equal(isLayoutV3(dir), false)
  assert.equal(typeof layoutBlockedReason(dir), 'string')
})

test('目录不存在 / 空 memoryDir / 非字符串 → 拒绝且不抛', () => {
  const missing = join(tmproot('dsh-sync-gate-'), 'nope')
  assert.equal(isLayoutV3(missing), false)
  assert.equal(isLayoutV3(''), false)
  assert.equal(isLayoutV3(undefined), false)
  assert.equal(isLayoutV3(null), false)
  assert.equal(typeof layoutBlockedReason(missing), 'string')
})

test('.layout-version 是目录（不可读）→ 拒绝且不抛', () => {
  const dir = tmproot('dsh-sync-gate-')
  mkdirSync(join(dir, '.layout-version'), { recursive: true })
  assert.equal(isLayoutV3(dir), false)
})

test('返回形状：ops 层 {kind:error,text}；worker 层 {ok:false,code:2,message}', () => {
  const dir = tmproot('dsh-sync-gate-')
  const err = layoutGateError(dir)
  assert.equal(err.kind, 'error')
  assert.equal(err.text, layoutBlockedMessage())
  const failure = layoutGateFailure(dir)
  assert.equal(failure.ok, false)
  assert.equal(failure.code, LAYOUT_GATE_CODE)
  assert.equal(failure.message, layoutBlockedMessage())
})

test('语言：getLocale()=en 时走英文文案，切回 zh 复原', () => {
  const dir = tmproot('dsh-sync-gate-')
  setLocale('en')
  try {
    const en = layoutBlockedMessage()
    assert.match(en, /not migrated to v3/)
    assert.match(en, /migrate-v3\.mjs/)
    assert.equal(layoutGateFailure(dir).message, en)
  } finally {
    setLocale('zh')
  }
  assert.match(layoutBlockedMessage(), /布局未迁移到 v3/)
})

/* ── 双层口径：strict（ops/命令）vs soft（repo/worker）────────────────── */

test('无 marker：strict 拒绝、soft 放行（v2 旧仓库/夹具继续可跑）', () => {
  const dir = tmproot('dsh-sync-gate-')
  assert.equal(isLayoutV3(dir), false)
  assert.equal(typeof layoutBlockedReason(dir), 'string')
  assert.equal(layoutBlockedReasonSoft(dir), null)
  assert.equal(layoutGateFailureSoft(dir), null)
})

test('marker=2：strict 与 soft 都拒绝', () => {
  const dir = dirWithVersion('2')
  assert.equal(typeof layoutBlockedReason(dir), 'string')
  assert.equal(typeof layoutBlockedReasonSoft(dir), 'string')
  const failure = layoutGateFailureSoft(dir)
  assert.equal(failure.ok, false)
  assert.equal(failure.code, LAYOUT_GATE_CODE)
})

test('迁移中（只有 migrate-v3.state、无 marker）：strict 与 soft 都拒绝', () => {
  const dir = tmproot('dsh-sync-gate-')
  mkdirSync(join(dir, '.system'), { recursive: true })
  writeFileSync(join(dir, '.system', 'migrate-v3.state'), JSON.stringify({ version: 3, done: [] }))
  assert.equal(typeof layoutBlockedReason(dir), 'string')
  assert.equal(typeof layoutBlockedReasonSoft(dir), 'string')
})

/* ── 第二段：接线集成（ops / 命令 / worker / repo）────────────────────── */

const BLOCKED = /布局未迁移到 v3/

/** 一个"非 v3"记忆根 + 可用的 installMemorySync 依赖。 */
const fixture = (version) => {
  const memoryDir = version === undefined ? tmproot('dsh-sync-gate-') : dirWithVersion(version)
  const cwd = tmproot('dsh-sync-gate-cwd-')
  const deps = {
    config: { memoryDir },
    getRuntime: () => ({}),
    applyRuntimePatch: () => {},
  }
  const installed = installMemorySync({}, deps)
  return { memoryDir, cwd, deps, ops: installed.ops }
}

test('ops（soft 层）：marker=2 时 9 个写 op 全部拒绝（统一 {kind:error,text}）', async () => {
  const { cwd, ops } = fixture('2')
  const calls = [
    ['setup', () => ops.setup(cwd)],
    ['sync', () => ops.sync(cwd, false)],
    ['setProjectEnabled', () => ops.setProjectEnabled(cwd, true)],
    ['setTrack', () => ops.setTrack(cwd, true)],
    ['off', () => ops.off(cwd)],
    ['resolve', () => ops.resolve(cwd, 1, 'ours')],
    ['setGlobalTrack', () => ops.setGlobalTrack('memory', true)],
    ['globalSync', () => ops.globalSync(false)],
    ['setGlobalRemote', () => ops.setGlobalRemote('https://example.invalid/m.git', true)],
  ]
  for (const [name, call] of calls) {
    const out = await call()
    assert.equal(out.kind, 'error', `${name} 应被门禁拒绝`)
    assert.match(out.text, BLOCKED, `${name} 文案应说明布局未迁移`)
    assert.equal(out.text, layoutBlockedMessage(), `${name} 文案应与门禁单源一致`)
  }
})

test('ops（soft 层）：无 marker 的 v2 目录放行（只挑不触网的 op 验证）', async () => {
  const { cwd, ops } = fixture(undefined)
  const gated = [
    await ops.setGlobalTrack('bogus', true),
    await ops.setGlobalRemote('', true),
    await ops.resolve(cwd, 1, 'ours'),
    await ops.setProjectEnabled(cwd, false),
    await ops.off(cwd),
  ]
  for (const out of gated) assert.doesNotMatch(String(out.text), BLOCKED)
  assert.equal(layoutGateErrorSoft(join(cwd, 'no-such-dir')), null)
})

test('非 v3：读 op 全部放行（syncStatus / conflicts / migrate / globalStatus）', () => {
  const { memoryDir, cwd, ops } = fixture(undefined)
  const status = ops.conflicts(cwd)
  assert.ok(Array.isArray(status))
  assert.equal(status.length, 0)
  assert.equal(ops.migrate(cwd), null)
  const global = ops.globalStatus()
  assert.equal(typeof global, 'object')
  const installedStatus = installMemorySync({}, { config: { memoryDir }, getRuntime: () => ({}), applyRuntimePatch: () => {} }).syncStatus(cwd)
  assert.equal(typeof installedStatus, 'object')
  assert.equal(installedStatus.enabled, false)
})

test('handleCommand（soft 层）：marker=2 写子命令拒绝、只读子命令放行；无 marker 放行', async () => {
  const blockedFixture = fixture('2')
  for (const [op, rest] of [['setup', []], ['sync', []], ['off', []], ['global', ['status']], ['conflict', ['resolve', '1', 'ours']]]) {
    const out = await handleCommand(op, rest, blockedFixture.cwd, blockedFixture.deps)
    assert.equal(out.kind, 'error', `handleCommand ${op} ${rest.join(' ')} 应被拒`)
    assert.match(out.text, BLOCKED)
  }
  const status = await handleCommand('status', [], blockedFixture.cwd, blockedFixture.deps)
  assert.equal(status.kind, 'success')
  const migrate = await handleCommand('migrate', [], blockedFixture.cwd, blockedFixture.deps)
  assert.equal(migrate.kind, 'success')
  const conflictList = await handleCommand('conflict', ['list'], blockedFixture.cwd, blockedFixture.deps)
  assert.equal(conflictList.kind, 'success')

  // 无 marker（v2 旧目录）：软口径放行——off 成功、sync 走到"未初始化"分支而非门禁文案
  const openFixture = fixture(undefined)
  const off = await handleCommand('off', [], openFixture.cwd, openFixture.deps)
  assert.doesNotMatch(String(off.text), BLOCKED)
  const sync = await handleCommand('sync', [], openFixture.cwd, openFixture.deps)
  assert.doesNotMatch(String(sync.text), BLOCKED)
})

test('soft 层（worker）：marker=2 → code:2；runStatus 放行', async () => {
  const { memoryDir } = fixture('2')
  const sync = await runSync({ dir: memoryDir, remoteBranch: 'dsh-shared/x' })
  assert.equal(sync.ok, false)
  assert.equal(sync.code, LAYOUT_GATE_CODE)
  assert.match(sync.message, BLOCKED)
  assert.equal(sync.committed, false)

  const resolved = await resolveConflict({ dir: memoryDir, index: 1, choice: 'ours' })
  assert.equal(resolved.ok, false)
  assert.equal(resolved.code, LAYOUT_GATE_CODE)
  assert.equal(resolved.remaining, 0)

  const status = await runStatus({ dir: memoryDir, remoteBranch: 'dsh-shared/x' })
  assert.notEqual(status.code, LAYOUT_GATE_CODE, 'runStatus 是只读，不得被布局门禁挡')
})

test('soft 层（worker）：无 marker 的 v2 目录放行（走既有兼容路径）', async () => {
  const { memoryDir } = fixture(undefined)
  const sync = await runSync({ dir: memoryDir, remoteBranch: 'dsh-shared/x' })
  assert.notEqual(sync.code, LAYOUT_GATE_CODE, 'soft 门禁不得拦无 marker 的 v2 目录')
  const resolved = await resolveConflict({ dir: memoryDir, index: 1, choice: 'ours' })
  assert.notEqual(resolved.code, LAYOUT_GATE_CODE)
})

test('soft 层（repo）：marker=2 → code:2（ensureMemoryRepo / ensureGlobalRepo / deviceBConnect）', async () => {
  const { memoryDir } = fixture('2')
  const ensure = await ensureMemoryRepo({
    memoryDir, dir: memoryDir, cwd: memoryDir, projectId: 'abc123abc123',
    displayName: 'x', remoteUrl: 'https://example.invalid/m.git',
  })
  assert.equal(ensure.ok, false)
  assert.equal(ensure.code, LAYOUT_GATE_CODE)
  assert.match(ensure.message, BLOCKED)
  assert.equal(ensure.committed, false)

  const global = await ensureGlobalRepo({ dir: memoryDir, url: 'https://example.invalid/m.git' })
  assert.equal(global.ok, false)
  assert.equal(global.code, LAYOUT_GATE_CODE)

  const connect = await deviceBConnect({
    dir: memoryDir, memoryDir, remoteUrl: 'https://example.invalid/m.git',
    remoteBranch: 'main', expectedProjectId: 'abc123abc123',
  })
  assert.equal(connect.ok, false)
  assert.equal(connect.code, LAYOUT_GATE_CODE)
  assert.equal(connect.mode, 'error')
})

test('soft 层（repo）：无 marker 的 v2 目录不被布局门禁挡', async () => {
  const { memoryDir } = fixture(undefined)
  const ensure = await ensureMemoryRepo({
    memoryDir, dir: join(memoryDir, 'projects', 'abc123abc123'), cwd: memoryDir,
    projectId: 'abc123abc123', displayName: 'x', remoteUrl: 'https://example.invalid/m.git',
  })
  assert.notEqual(ensure.code, LAYOUT_GATE_CODE, 'soft 门禁不得拦无 marker 的 v2 仓库')
})

test('装配后回退：装配时 v3 → 标记消失 → ops/命令拒绝且文案是"已回退"', async () => {
  const { cwd, ops, deps, memoryDir } = fixture('3\n')
  // 模拟 `--rollback` 未重启 / 运行中手删 `.layout-version`
  rmSync(join(memoryDir, '.layout-version'), { force: true })
  assert.equal(isLayoutV3(memoryDir), false)

  const viaOps = await ops.sync(cwd, false)
  assert.equal(viaOps.kind, 'error')
  assert.equal(viaOps.text, layoutRollbackMessage())
  assert.match(viaOps.text, /已回退到旧布局/)

  const viaCommand = await handleCommand('sync', [], cwd, { ...deps, assembledV3: true })
  assert.equal(viaCommand.kind, 'error')
  assert.equal(viaCommand.text, layoutRollbackMessage())

  const viaOff = await ops.off(cwd)
  assert.equal(viaOff.text, layoutRollbackMessage())

  // 只读命令仍放行
  const status = await handleCommand('status', [], cwd, { ...deps, assembledV3: true })
  assert.equal(status.kind, 'success')
})

test('v3 之后门禁放行（写入 .layout-version=3）', async () => {
  const { cwd, ops, deps, memoryDir } = fixture('3\n')
  // 写 op 不再返回布局文案，而是走各自既有逻辑（这些路径都不碰网络）：
  const sync = await ops.sync(cwd, false)
  assert.doesNotMatch(String(sync.text), BLOCKED)
  const globalSync = await ops.globalSync(false)
  assert.doesNotMatch(String(globalSync.text), BLOCKED)
  const globalRemote = await ops.setGlobalRemote('', true)
  assert.doesNotMatch(String(globalRemote.text), BLOCKED)
  const track = await ops.setGlobalTrack('bogus', true)
  assert.doesNotMatch(String(track.text), BLOCKED)
  const off = await ops.off(cwd)
  assert.doesNotMatch(String(off.text), BLOCKED)
  const status = await handleCommand('status', [], cwd, deps)
  assert.equal(status.kind, 'success')
  const run = await runSync({ dir: memoryDir, remoteBranch: 'dsh-shared/x' })
  assert.notEqual(run.code, LAYOUT_GATE_CODE, 'v3 下不得再被布局门禁挡')
})
