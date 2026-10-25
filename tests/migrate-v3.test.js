/**
 * 记忆目录布局 v2 → v3 迁移回归护栏（`docs/layout-v3.md` 第 7 节）。
 *
 * 覆盖：dry-run 不落盘、真迁移后每条映射路径正确、跑两次幂等（文件树哈希不变）、
 * 断点续跑、冲突不覆盖、回滚整体还原、CLI 入口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LAYOUT_VERSION, migrateV3, planMigration, rollbackV3 } from '../lib/migrate-v3.js'
import { tmproot } from './_tmp.js'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'migrate-v3.mjs')

/** 建一个 v2 旧布局的记忆根（返回 {root, mem, backup-v1 名字}）。 */
function legacyFixture() {
  const root = tmproot('dsh-migrate-v3-')
  const mem = join(root, 'memories')
  const write = (rel, text = `# ${rel}\n`) => {
    const file = join(mem, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  write('groups.json', '{"version":2,"groups":[]}\n')
  write('tools.json', '{}\n')
  write('plugin-state.json', '{}\n')
  write('snapshot-presets.json', '{}\n')
  write('SUGGESTIONS.jsonl', '')
  write('.vault-version', '2\n')
  write('advisor/state.json', '{}\n')
  // 全局类记忆（含日志型日期层）
  write('global/kb/【A】条目.md')
  write('global/daily/2026-10-14/【B】日志.md')
  write('global/memory/【C】全局.md')
  // 全局归档
  write('archive/kb/【旧】A.md')
  write('archive/user/【旧】U.md')
  // 全局待办（单文件 + 日志型日期文件）
  write('todo/TODOS-global.md', '# 全局待办\n')
  write('todo/daily/2026-10-14.md', '# 2026-10-14\n')
  // 会话类
  write('sessions/s1/session/2026-10-15/【S】日志.md')
  write('sessions/s1/sessionkey/【S】关键.md')
  write('sessions/s1/todo/TODOS-session.md', '# 会话待办\n')
  write('sessions/s1/archive/sessionkey/【旧】S.md')
  // 项目类
  write('projects/p1/project/2026-10-14/【P】日志.md')
  write('projects/p1/key/【P】关键.md')
  write('projects/p1/todo/TODOS-project.md', '# 项目待办\n')
  write('projects/p1/archive/key/【旧】P.md')
  write('projects/p1/PROVENANCE', '{"id":"p1"}\n')
  // 旧结构残留（v1 时代的目录 + 旧备份）
  write('daily/2026-10-10.md')
  write('groups/x.md')
  write('backup-v1-20261015-031621/MEMORY.md')
  // 模块数据（规范 §1 例外：仍在用，迁移必须原地保留）
  write('models.json', '{"models":[]}\n')
  write('aliases.json', '{"aliases":[]}\n')
  write('notifications/2026-10-10.jsonl', '{}\n')
  write('broadcast-queue.json', '[]\n')
  write('logs/memory.log', 'x\n')
  // VCS 元数据与溯源文件（搬 legacy 等于把整个 git 仓库搬走）
  write('.git/HEAD', 'ref: refs/heads/main\n')
  write('.git/config', '[core]\n')
  write('.gitignore', '.tmp/\n')
  write('.gitattributes', '* text=auto\n')
  write('PROVENANCE', '{"repo":"memory"}\n')
  return { root, mem }
}

/** 夹具里的 VCS / 溯源顶层条目（迁移后必须原地存在）。 */
const PRESERVED_VCS = ['.git', '.gitattributes', '.gitignore', 'PROVENANCE']

/** 夹具里的模块数据顶层条目（迁移后必须原地存在）。 */
const MODULE_DATA = ['models.json', 'aliases.json', 'notifications', 'broadcast-queue.json', 'logs']

/** 目录树哈希（相对路径 + 内容；忽略迁移状态文件，它带时间戳）。 */
function treeHash(dir, base = dir) {
  const hash = createHash('sha256')
  const walk = (current) => {
    const items = readdirSync(current, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const item of items) {
      const full = join(current, item.name)
      const rel = relative(base, full).split('\\').join('/')
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

/** 列出根下条目名（升序）。 */
function rootEntries(dir) {
  return readdirSync(dir).sort()
}

test('planMigration: 只读——算出完整步骤表且不动盘', () => {
  const { mem } = legacyFixture()
  const before = treeHash(mem)
  const plan = planMigration(mem)
  assert.equal(treeHash(mem), before)
  assert.equal(existsSync(join(mem, '.system')), false)
  assert.equal(existsSync(join(mem, '.layout-version')), false)
  const targets = plan.steps.filter((s) => s.kind === 'move').map((s) => relative(mem, s.to).split('\\').join('/'))
  assert.ok(targets.includes('memory/kb/global'))
  assert.ok(targets.includes('memory/daily/global'))
  assert.ok(targets.includes('memory/kb/archive/global'))
  assert.ok(targets.includes('memory/session/session/s1'))
  assert.ok(targets.includes('todo/global/global/TODOS.md'))
  assert.ok(targets.includes('todo/daily/global/2026-10-14.md'))
  assert.ok(targets.includes('todo/session/session/s1/TODOS.md'))
  assert.ok(targets.includes('memory/key/project/p1'))
  assert.ok(targets.includes('memory/key/archive/project/p1'))
  assert.ok(targets.includes('.system/projects/p1/PROVENANCE'))
  assert.ok(targets.includes('.system/legacy/daily'))
  assert.equal(plan.conflicts.length, 0)
})

test('migrate-v3: dry-run 只出计划、绝不落盘', () => {
  const { root, mem } = legacyFixture()
  const before = treeHash(mem)
  const report = migrateV3(mem, { dryRun: true })
  assert.equal(report.ok, true)
  assert.equal(report.dryRun, true)
  assert.equal(treeHash(mem), before)
  assert.equal(existsSync(join(mem, '.system')), false)
  assert.equal(existsSync(join(mem, '.layout-version')), false)
  assert.equal(readdirSync(root).some((name) => name.includes('..bak-')), false)
  assert.equal(report.backup, null)
  assert.ok(report.planned.directories >= 6)
  assert.ok(report.planned.files >= 3)
  assert.ok(report.planned.legacy >= 2)
  assert.equal(report.executed, 0)
})

test('migrate-v3: 真迁移——每条映射路径正确、先备份、最后写版本 3', () => {
  const { root, mem } = legacyFixture()
  const report = migrateV3(mem, {})
  assert.deepEqual(report.errors, [])
  assert.equal(report.ok, true)
  // 备份是记忆根的同级目录，内容 = 迁移前的旧树
  assert.ok(report.backup.startsWith(`${mem}..bak-`))
  assert.ok(existsSync(join(report.backup, 'global', 'kb', '【A】条目.md')))
  assert.ok(existsSync(join(report.backup, 'todo', 'TODOS-global.md')))
  // 记忆
  assert.ok(existsSync(join(mem, 'memory', 'kb', 'global', '【A】条目.md')))
  assert.ok(existsSync(join(mem, 'memory', 'daily', 'global', '2026-10-14', '【B】日志.md')))
  assert.ok(existsSync(join(mem, 'memory', 'memory', 'global', '【C】全局.md')))
  assert.ok(existsSync(join(mem, 'memory', 'session', 'session', 's1', '2026-10-15', '【S】日志.md')))
  assert.ok(existsSync(join(mem, 'memory', 'sessionkey', 'session', 's1', '【S】关键.md')))
  assert.ok(existsSync(join(mem, 'memory', 'project', 'project', 'p1', '2026-10-14', '【P】日志.md')))
  assert.ok(existsSync(join(mem, 'memory', 'key', 'project', 'p1', '【P】关键.md')))
  // 归档（+ .keep）
  assert.ok(existsSync(join(mem, 'memory', 'kb', 'archive', 'global', '【旧】A.md')))
  assert.ok(existsSync(join(mem, 'memory', 'kb', 'archive', 'global', '.keep')))
  assert.ok(existsSync(join(mem, 'memory', 'user', 'archive', 'global', '【旧】U.md')))
  assert.ok(existsSync(join(mem, 'memory', 'sessionkey', 'archive', 'session', 's1', '【旧】S.md')))
  assert.ok(existsSync(join(mem, 'memory', 'key', 'archive', 'project', 'p1', '【旧】P.md')))
  // 待办
  assert.ok(existsSync(join(mem, 'todo', 'global', 'global', 'TODOS.md')))
  assert.equal(readFileSync(join(mem, 'todo', 'global', 'global', 'TODOS.md'), 'utf8'), '# 全局待办\n')
  assert.ok(existsSync(join(mem, 'todo', 'daily', 'global', '2026-10-14.md')))
  assert.ok(existsSync(join(mem, 'todo', 'session', 'session', 's1', 'TODOS.md')))
  assert.ok(existsSync(join(mem, 'todo', 'project', 'project', 'p1', 'TODOS.md')))
  // 项目元数据 + 系统文件
  assert.ok(existsSync(join(mem, '.system', 'projects', 'p1', 'PROVENANCE')))
  for (const name of ['groups.json', 'tools.json', 'plugin-state.json', 'snapshot-presets.json', 'SUGGESTIONS.jsonl', '.vault-version']) {
    assert.ok(existsSync(join(mem, '.system', name)), `${name} 应搬进 .system/`)
  }
  assert.ok(existsSync(join(mem, '.system', 'advisor', 'state.json')))
  // 旧结构原样进 legacy
  assert.ok(existsSync(join(mem, '.system', 'legacy', 'daily', '2026-10-10.md')))
  assert.ok(existsSync(join(mem, '.system', 'legacy', 'groups', 'x.md')))
  assert.ok(existsSync(join(mem, '.system', 'legacy', 'backup-v1-20261015-031621', 'MEMORY.md')))
  // 版本标记 + 根下只剩三类（模块数据 / VCS 元数据原地保留，不算多余条目）
  assert.equal(readFileSync(join(mem, '.layout-version'), 'utf8').trim(), String(LAYOUT_VERSION))
  assert.deepEqual(rootEntries(mem), [
    '.git', '.gitattributes', '.gitignore', '.layout-version', '.system', 'PROVENANCE',
    'aliases.json', 'broadcast-queue.json', 'logs', 'memory', 'models.json', 'notifications', 'todo',
  ])
  for (const name of MODULE_DATA) {
    assert.ok(existsSync(join(mem, name)), `模块数据 ${name} 必须原地保留`)
    assert.equal(existsSync(join(mem, '.system', 'legacy', name)), false, `模块数据 ${name} 不许进 legacy`)
  }
  assert.deepEqual(report.rootExtras, [])
  // 旧路径全没了
  for (const old of ['global', 'archive', 'sessions', 'projects', 'daily', 'groups']) {
    assert.equal(existsSync(join(mem, old)), false, `${old} 应已搬走`)
  }
  assert.equal(existsSync(join(mem, 'todo', 'TODOS-global.md')), false)
  // 备份目录在 root 下（同级）
  assert.ok(readdirSync(root).some((name) => name.startsWith('memories..bak-')))
})

test('migrate-v3: 跑两次幂等——文件树哈希不变，第二次直接跳过', () => {
  const { mem } = legacyFixture()
  const first = migrateV3(mem, {})
  assert.equal(first.ok, true)
  const after = treeHash(mem)
  const second = migrateV3(mem, {})
  assert.equal(second.ok, true)
  assert.equal(second.alreadyMigrated, true)
  assert.equal(second.executed, 0)
  assert.equal(treeHash(mem), after)
  // 备份只建了一次
  assert.equal(second.backup, null)
})

test('migrate-v3: 断点续跑——撤掉最后一步后重跑只补那一步', () => {
  const { mem } = legacyFixture()
  const first = migrateV3(mem, {})
  const after = treeHash(mem)
  // 模拟"写完 .layout-version 前崩了"：撤掉待办那一步的磁盘效果 + 状态记录 + 版本标记
  const todoFile = join(mem, 'todo', 'global', 'global', 'TODOS.md')
  writeFileSync(join(mem, 'todo', 'TODOS-global.md'), readFileSync(todoFile, 'utf8'))
  rmSync(todoFile, { force: true })
  rmSync(join(mem, '.layout-version'), { force: true })
  const stateFile = join(mem, '.system', 'migrate-v3.state')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  state.done = state.done.filter((key) => key !== 'move:todo/TODOS-global.md' && key !== 'write:layout-version')
  writeFileSync(stateFile, JSON.stringify(state))
  // 续跑：只补那一步 + 版本标记，其它不重复搬
  const second = migrateV3(mem, {})
  assert.equal(second.ok, true)
  assert.equal(second.alreadyMigrated, false)
  assert.equal(second.executed, 2)
  assert.equal(second.backup, first.backup, '续跑应复用已有备份，不再新建')
  assert.equal(readFileSync(todoFile, 'utf8'), '# 全局待办\n')
  assert.equal(treeHash(mem), after)
})

test('migrate-v3: 模块数据（models.json/aliases.json/notifications/…）原地保留、绝不进 legacy', () => {
  const { mem } = legacyFixture()
  const dry = migrateV3(mem, { dryRun: true })
  assert.equal(dry.planned.moduleData, MODULE_DATA.length)
  assert.deepEqual(dry.moduleData.slice().sort(), MODULE_DATA.slice().sort())
  assert.equal(dry.planned.legacyEntries, 3)
  assert.deepEqual(dry.legacyEntries.slice().sort(), ['backup-v1-20261015-031621', 'daily', 'groups'])

  const report = migrateV3(mem, {})
  assert.equal(report.ok, true)
  assert.deepEqual(report.errors, [])
  // 原地还在、内容没动
  assert.equal(readFileSync(join(mem, 'models.json'), 'utf8'), '{"models":[]}\n')
  assert.equal(readFileSync(join(mem, 'aliases.json'), 'utf8'), '{"aliases":[]}\n')
  assert.ok(existsSync(join(mem, 'notifications', '2026-10-10.jsonl')))
  assert.ok(existsSync(join(mem, 'broadcast-queue.json')), 'broadcast* 前缀匹配必须生效')
  assert.ok(existsSync(join(mem, 'logs', 'memory.log')))
  // legacy 里没有它们，且没有被搬走
  assert.equal(existsSync(join(mem, '.system', 'legacy', 'models.json')), false)
  assert.equal(existsSync(join(mem, '.system', 'legacy', 'notifications')), false)
  assert.equal(existsSync(join(mem, '.system', 'legacy', 'logs')), false)
  // 未知条目照常搬 legacy
  assert.ok(existsSync(join(mem, '.system', 'legacy', 'daily', '2026-10-10.md')))
  assert.ok(existsSync(join(mem, '.system', 'legacy', 'backup-v1-20261015-031621', 'MEMORY.md')))
  // 备份里也有模块数据（整目录冷拷贝）
  assert.ok(existsSync(join(report.backup, 'models.json')))
})

test('migrate-v3: 冲突①目标是非空目录——不覆盖、源保留、状态可续', () => {
  const { mem } = legacyFixture()
  const occupied = join(mem, 'memory', 'kb', 'global')
  mkdirSync(occupied, { recursive: true })
  writeFileSync(join(occupied, 'existing.md'), '# 已在位\n')
  const report = migrateV3(mem, {})
  assert.equal(report.ok, true)
  assert.deepEqual(report.errors, [])
  assert.equal(report.conflicts.length, 1)
  assert.equal(report.conflicts[0].from, 'global/kb')
  assert.equal(report.conflicts[0].reason, 'target-exists')
  // 不覆盖：目标内容原样、源目录原样（连带里面的条目）
  assert.equal(readFileSync(join(occupied, 'existing.md'), 'utf8'), '# 已在位\n')
  assert.equal(readdirSync(occupied).length, 1)
  assert.ok(existsSync(join(mem, 'global', 'kb', '【A】条目.md')))
  assert.deepEqual(report.rootExtras, ['global'])
  // 状态可续：该步已记 done，删掉版本标记重跑不会重试（源仍在、目标仍不被覆盖）
  const state = JSON.parse(readFileSync(join(mem, '.system', 'migrate-v3.state'), 'utf8'))
  assert.ok(state.done.includes('move:global/kb'))
  rmSync(join(mem, '.layout-version'), { force: true })
  const again = migrateV3(mem, {})
  assert.equal(again.ok, true)
  assert.deepEqual(again.errors, [])
  assert.equal(again.executed, 1, '只剩写 .layout-version 一步（按内容自愈）；冲突项已在 done 里，不重搬')
  assert.equal(again.pending, 0)
  assert.equal(readFileSync(join(mem, '.layout-version'), 'utf8').trim(), '3')
  assert.equal(readFileSync(join(occupied, 'existing.md'), 'utf8'), '# 已在位\n')
  assert.ok(existsSync(join(mem, 'global', 'kb', '【A】条目.md')))
})

test('migrate-v3: 冲突②目标是文件 / 祖先被文件占用——记为冲突而非报错', () => {
  const { mem } = legacyFixture()
  // 文件级目标被占：todo/global/global/TODOS.md 预置成文件
  const todoTarget = join(mem, 'todo', 'global', 'global', 'TODOS.md')
  mkdirSync(dirname(todoTarget), { recursive: true })
  writeFileSync(todoTarget, '# 占位\n')
  // 目录级目标父链被文件占：memory/kb 预置成文件
  const kbFile = join(mem, 'memory', 'kb')
  mkdirSync(join(mem, 'memory'), { recursive: true })
  writeFileSync(kbFile, 'blocked\n')
  const report = migrateV3(mem, {})
  assert.equal(report.ok, true)
  assert.deepEqual(report.errors, [])
  const byFrom = new Map(report.conflicts.map((item) => [item.from, item]))
  assert.equal(byFrom.get('todo/TODOS-global.md').reason, 'target-exists')
  assert.equal(byFrom.get('global/kb').reason, 'ancestor-is-file:memory/kb')
  // 不覆盖、源保留、源可读
  assert.equal(readFileSync(todoTarget, 'utf8'), '# 占位\n')
  assert.equal(readFileSync(kbFile, 'utf8'), 'blocked\n')
  assert.ok(existsSync(join(mem, 'todo', 'TODOS-global.md')))
  assert.ok(existsSync(join(mem, 'global', 'kb', '【A】条目.md')))
  // 其余数据照常迁完，版本仍写 3（冲突是待人工处理的显式记录）
  assert.equal(readFileSync(join(mem, '.layout-version'), 'utf8').trim(), '3')
  assert.ok(existsSync(join(mem, 'memory', 'daily', 'global', '2026-10-14', '【B】日志.md')))
})

test('migrate-v3: 目标目录存在但为空 → 正常搬入，不算冲突', () => {
  const { mem } = legacyFixture()
  mkdirSync(join(mem, 'memory', 'kb', 'global'), { recursive: true })
  const report = migrateV3(mem, {})
  assert.deepEqual(report.conflicts, [])
  assert.ok(existsSync(join(mem, 'memory', 'kb', 'global', '【A】条目.md')))
  assert.deepEqual(report.rootExtras, [])
})

test('migrate-v3: rollback 用备份整体还原（原目录留后路，备份保留）', () => {
  const { root, mem } = legacyFixture()
  const before = treeHash(mem)
  const report = migrateV3(mem, {})
  assert.notEqual(treeHash(mem), before)
  const rolled = rollbackV3(mem, report.backup)
  assert.equal(rolled.ok, true)
  assert.deepEqual(rolled.errors, [])
  assert.equal(treeHash(mem), before)
  assert.equal(existsSync(join(mem, '.layout-version')), false)
  assert.ok(existsSync(join(mem, 'global', 'kb', '【A】条目.md')))
  assert.equal(existsSync(join(mem, 'memory')), false)
  // 迁移后的那份被挪到同级 pre-rollback 目录，备份还在
  assert.ok(rolled.movedTo.startsWith(`${mem}..pre-rollback-`))
  assert.ok(existsSync(join(rolled.movedTo, 'memory')))
  assert.ok(existsSync(report.backup))
  // 回滚后可以再迁一次
  const again = migrateV3(mem, {})
  assert.equal(again.ok, true)
  assert.equal(readFileSync(join(mem, '.layout-version'), 'utf8').trim(), '3')
  assert.equal(readdirSync(root).length >= 3, true)
})

test('migrate-v3 S1: --memory-dir 带尾分隔符 → 规范化，备份落在同级、绝不递归', () => {
  const { mem } = legacyFixture()
  // 库层入口也防御
  const dry = migrateV3(`${mem}\\`, { dryRun: true })
  assert.equal(dry.memoryDir, mem, 'memoryDir 必须被规范化（无尾分隔符）')

  const run = spawnSync(process.execPath, [CLI, '--memory-dir', `${mem}\\`, '--apply'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const backup = /备份：(.*)/.exec(run.stdout)[1].trim()
  assert.ok(backup.startsWith(`${mem}..bak-`), `备份必须是同级兄弟目录：${backup}`)
  // 记忆根里没有 `.bak` 目录（尾分隔符缺陷下会出现 <根>\..bak-<ts>）
  assert.equal(existsSync(join(mem, '..bak')), false)
  assert.equal(readdirSync(mem).some((name) => name.startsWith('.') && name.includes('bak')), false)
  // 备份本身是单层冷拷贝，没把自己再套进去
  assert.equal(existsSync(join(backup, '..bak')), false)
  assert.ok(existsSync(join(backup, 'global', 'kb', '【A】条目.md')))
  assert.equal(readFileSync(join(mem, '.layout-version'), 'utf8').trim(), '3')
})

test('migrate-v3 M1: todo/<id>/ 里非 <日期>.md 的文件搬 legacy，不留残渣', () => {
  const { mem } = legacyFixture()
  writeFileSync(join(mem, 'todo', 'daily', 'notes.txt'), '手放\n')
  writeFileSync(join(mem, 'todo', 'daily', '.keep'), '')
  writeFileSync(join(mem, 'todo', 'daily', 'TODOS.md'), '# 旧\n')
  const report = migrateV3(mem, {})
  assert.equal(report.ok, true)
  assert.ok(existsSync(join(mem, 'todo', 'daily', 'global', '2026-10-14.md')))
  for (const name of ['notes.txt', '.keep', 'TODOS.md']) {
    assert.ok(existsSync(join(mem, '.system', 'legacy', 'todo', 'daily', name)), `${name} 应搬 legacy`)
  }
  assert.deepEqual(readdirSync(join(mem, 'todo', 'daily')).sort(), ['global'])
})

test('migrate-v3 CLI: --rollback 缺参数=2、非备份目录拒绝、目标不像记忆根=2', () => {
  const { root, mem } = legacyFixture()
  const noArg = spawnSync(process.execPath, [CLI, '--memory-dir', mem, '--rollback'], { encoding: 'utf8' })
  assert.equal(noArg.status, 2)
  assert.match(noArg.stderr, /--rollback 需要路径参数/)

  const plain = join(root, 'plain')
  mkdirSync(plain)
  const bad = spawnSync(process.execPath, [CLI, '--memory-dir', mem, '--rollback', plain], { encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /不像本迁移器产出的备份/)

  const nowhere = join(root, 'nowhere')
  mkdirSync(nowhere)
  const wrong = spawnSync(process.execPath, [CLI, '--memory-dir', nowhere, '--apply'], { encoding: 'utf8' })
  assert.equal(wrong.status, 2)
  assert.match(wrong.stderr, /不像记忆根/)
  assert.deepEqual(readdirSync(nowhere), [], '打错路径不许静默建出空 v3')
})

test('migrate-v3 CLI: 有冲突时给出"不会自动重试"提示', () => {
  const { mem } = legacyFixture()
  mkdirSync(join(mem, 'memory', 'kb', 'global'), { recursive: true })
  writeFileSync(join(mem, 'memory', 'kb', 'global', 'x.md'), 'x\n')
  const run = spawnSync(process.execPath, [CLI, '--memory-dir', mem, '--dry-run'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /不会自动重试/)
})

test('migrate-v3 A5: syncEnabled=true → 无 --allow-sync 退出 2 且不落盘；加参数才继续', () => {
  const { root, mem } = legacyFixture()
  writeFileSync(join(mem, 'plugin-state.json'), '{"syncEnabled":true}\n')
  const before = treeHash(mem)

  // 库层同样拦（不只 CLI）
  const lib = migrateV3(mem, {})
  assert.equal(lib.ok, false)
  assert.equal(lib.syncBlocked, true)
  assert.equal(treeHash(mem), before)

  const blocked = spawnSync(process.execPath, [CLI, '--memory-dir', mem, '--apply'], { encoding: 'utf8' })
  assert.equal(blocked.status, 2)
  assert.match(blocked.stderr, /记忆同步已开启/)
  assert.match(blocked.stderr, /--allow-sync/)
  assert.equal(treeHash(mem), before, '被拦时不许有任何写盘')
  assert.equal(existsSync(join(mem, '.layout-version')), false)
  assert.equal(readdirSync(root).some((name) => name.includes('..bak-')), false)

  // dry-run：只警告、不阻塞
  const dry = spawnSync(process.execPath, [CLI, '--memory-dir', mem], { encoding: 'utf8' })
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /记忆同步已开启/)
  assert.equal(treeHash(mem), before)

  // 显式承担风险才继续
  const forced = spawnSync(process.execPath, [CLI, '--memory-dir', mem, '--apply', '--allow-sync'], { encoding: 'utf8' })
  assert.equal(forced.status, 0, forced.stderr)
  assert.match(forced.stdout, /已用 --allow-sync 明确承担风险/)
  assert.equal(readFileSync(join(mem, '.layout-version'), 'utf8').trim(), '3')
  assert.ok(existsSync(join(mem, 'memory', 'kb', 'global', '【A】条目.md')))
  assert.ok(existsSync(join(mem, '.system', 'plugin-state.json')))
})

test('migrate-v3 S1-A: 记忆根=文件系统根 → 拒绝且零写盘（不自我递归）', () => {
  const fsRoot = resolve('/')
  const before = readdirSync(fsRoot).sort()
  const report = migrateV3(fsRoot, {})
  assert.equal(report.ok, false)
  assert.match(report.errors[0], /文件系统根/)
  assert.deepEqual(readdirSync(fsRoot).sort(), before, '拒绝时不许在根下建任何东西')
  const rolled = rollbackV3(fsRoot, `${fsRoot}..bak-20260101-000000`)
  assert.equal(rolled.ok, false)
  assert.match(rolled.errors[0], /文件系统根/)
})

test('migrate-v3 S1-B: 备份目录被删后重跑 → 重新备份并正常迁移（不裸奔）', () => {
  const { mem } = legacyFixture()
  const first = migrateV3(mem, {})
  assert.equal(first.ok, true)
  // 模拟"迁移中断 + 备份被人删掉"：撤掉最后一步的磁盘效果、清版本标记与状态记录
  const todoFile = join(mem, 'todo', 'global', 'global', 'TODOS.md')
  writeFileSync(join(mem, 'todo', 'TODOS-global.md'), readFileSync(todoFile, 'utf8'))
  rmSync(todoFile, { force: true })
  rmSync(join(mem, '.layout-version'), { force: true })
  const stateFile = join(mem, '.system', 'migrate-v3.state')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  state.done = state.done.filter((key) => key !== 'move:todo/TODOS-global.md' && key !== 'write:layout-version')
  writeFileSync(stateFile, JSON.stringify(state))
  rmSync(first.backup, { recursive: true, force: true })

  const second = migrateV3(mem, {})
  assert.equal(second.ok, true)
  assert.equal(second.backupRecreated, true, '必须标记"备份已重建"')
  assert.ok(second.notes.some((note) => note.includes('重新备份')))
  assert.ok(existsSync(second.backup), '新备份必须落在磁盘上')
  // 第二次备份的是"当前整树"（groups.json 此时在 .system/ 下）
  assert.ok(existsSync(join(second.backup, '.system', 'groups.json')), '新备份必须是当前整树的冷拷贝')
  assert.ok(existsSync(todoFile), '重跑要把撤掉的那步搬回去')
  assert.equal(readFileSync(join(mem, '.layout-version'), 'utf8').trim(), '3')
})

test('migrate-v3 S1-C: 记忆根是目录链接（junction）→ 备份真实内容，绝不 ok=true 而备份不存在', () => {
  const root = tmproot('dsh-migrate-v3-')
  const real = join(root, 'real-memories')
  const link = join(root, 'memories')
  mkdirSync(join(real, 'global', 'kb'), { recursive: true })
  writeFileSync(join(real, 'groups.json'), '{"version":2,"groups":[]}\n')
  writeFileSync(join(real, 'global', 'kb', '【A】.md'), '# A\n')
  symlinkSync(real, link, 'junction')

  const report = migrateV3(link, {})
  assert.equal(report.ok, true)
  // 布尔不变式：报"成功"就必须真有备份
  assert.ok(existsSync(report.backup), `报了 ok=true 却没有备份：${report.backup}`)
  assert.equal(statSync(report.backup).isDirectory(), true)
  assert.ok(existsSync(join(report.backup, '.backup-complete')), '备份必须带完整性标记')
  assert.ok(existsSync(join(report.backup, 'groups.json')), '备份必须是真实内容，不是空壳')
  // 迁移落在真实目录上
  assert.equal(readFileSync(join(real, '.layout-version'), 'utf8').trim(), '3')
  assert.ok(existsSync(join(real, 'memory', 'kb', 'global', '【A】.md')))
  assert.equal(existsSync(join(real, 'global')), false)
})

test('migrate-v3 S0: .git/.gitignore/PROVENANCE 原地保留，绝不搬进 legacy', () => {
  const { mem } = legacyFixture()
  const report = migrateV3(mem, {})
  assert.equal(report.ok, true)
  assert.deepEqual(report.preservedVcs.slice().sort(), PRESERVED_VCS)
  // 原地还在（.git 整个目录含 HEAD/config）
  assert.ok(existsSync(join(mem, '.git', 'HEAD')))
  assert.ok(existsSync(join(mem, '.git', 'config')))
  assert.equal(readFileSync(join(mem, '.gitignore'), 'utf8'), '.tmp/\n')
  assert.equal(readFileSync(join(mem, 'PROVENANCE'), 'utf8'), '{"repo":"memory"}\n')
  // legacy 里一个都没有
  for (const name of PRESERVED_VCS) {
    assert.equal(existsSync(join(mem, '.system', 'legacy', name)), false, `${name} 不许进 legacy`)
  }
  // 不算"未知条目"，也不算根下多余条目
  assert.deepEqual(report.legacyEntries.slice().sort(), ['backup-v1-20261015-031621', 'daily', 'groups'])
  assert.deepEqual(report.rootExtras, [])
  // 备份是整树冷拷贝，git 元数据也在里面
  assert.ok(existsSync(join(report.backup, '.git', 'HEAD')))
})

test('migrate-v3 B2: v2 项目级 .git 整目录搬 legacy，迁移后根下不留 projects/', () => {
  const { mem } = legacyFixture()
  mkdirSync(join(mem, 'projects', 'p1', '.git'), { recursive: true })
  writeFileSync(join(mem, 'projects', 'p1', '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(mem, 'projects', 'p1', '.git', 'config'), '[core]\n')
  const report = migrateV3(mem, {})
  assert.equal(report.ok, true)
  assert.deepEqual(report.errors, [])
  // 旧同步仓整目录进 legacy（历史不丢）
  assert.ok(existsSync(join(mem, '.system', 'legacy', 'projects', 'p1', '.git', 'HEAD')))
  assert.ok(existsSync(join(mem, '.system', 'legacy', 'projects', 'p1', '.git', 'config')))
  // 根下不再残留 projects/
  assert.equal(existsSync(join(mem, 'projects')), false)
  assert.deepEqual(report.rootExtras, [])
})

test('migrate-v3: rollback 拒绝不像备份的目录', () => {
  const { mem } = legacyFixture()
  migrateV3(mem, {})
  const bogus = join(mem, 'memory')
  const report = rollbackV3(mem, bogus)
  assert.equal(report.ok, false)
  assert.match(report.errors[0], /备份/)
})

test('migrate-v3 CLI: dry-run 报告样例（打印出来供人工核对）', () => {
  const { mem } = legacyFixture()
  const run = spawnSync(process.execPath, [CLI, '--memory-dir', mem, '--dry-run'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  console.log(run.stdout)
  assert.match(run.stdout, /搬迁目录/)
  assert.match(run.stdout, /合计步骤/)
})

test('migrate-v3 CLI: --dry-run 不落盘、--apply 落盘、--rollback 还原', () => {
  const { mem } = legacyFixture()
  const before = treeHash(mem)
  const dry = spawnSync(process.execPath, [CLI, '--memory-dir', mem], { encoding: 'utf8' })
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /dry-run（只出计划，不落盘）/)
  assert.match(dry.stdout, /未写入任何文件/)
  assert.equal(treeHash(mem), before)
  assert.equal(existsSync(join(mem, '.layout-version')), false)

  const apply = spawnSync(process.execPath, [CLI, '--memory-dir', mem, '--apply'], { encoding: 'utf8' })
  assert.equal(apply.status, 0, apply.stderr)
  assert.match(apply.stdout, /布局版本：3/)
  assert.equal(readFileSync(join(mem, '.layout-version'), 'utf8').trim(), '3')
  const backupLine = /备份：(.*)/.exec(apply.stdout)
  assert.ok(backupLine !== null)
  const backup = backupLine[1].trim()
  assert.ok(existsSync(backup))

  const rollback = spawnSync(process.execPath, [CLI, '--memory-dir', mem, '--rollback', backup], { encoding: 'utf8' })
  assert.equal(rollback.status, 0, rollback.stderr)
  assert.equal(treeHash(mem), before)
})
