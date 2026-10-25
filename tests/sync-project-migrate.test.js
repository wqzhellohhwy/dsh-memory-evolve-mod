/**
 * 项目 id 变更迁移（sync v3 方案 C 节）回归护栏。
 *
 * 覆盖：cwd-map 记录与旧 id 回查、无旧数据 no-op、5 项路径全搬且幂等、
 * 目标已存在时文件级并入不覆盖、回滚只还原旧文件且保留新数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  BACKUP_MARKER, legacyProjectIdsOf, migrateProjectId, migrationPlanOf,
  readCwdMap, rememberProjectCwd, rollbackProjectId, unclaimedProjectDirs,
} from '../lib/sync/project-migrate.js'
import { projectHash } from '../lib/store.js'
import { locateLegacyDir } from '../lib/sync/identity.js'
import { tmproot } from './_tmp.js'

const OLD = 'aaaaaaaaaaaa'
const NEW = 'bbbbbbbbbbbb'

/** 造记忆根（v3 骨架 + 可选旧项目数据）。 */
function fixture() {
  const root = tmproot('dsh-sync-project-migrate-')
  const mem = join(root, 'memories')
  mkdirSync(mem, { recursive: true })
  const write = (rel, text = `# ${rel}\n`) => {
    const file = join(mem, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  // cwd-map 只在 v3 记忆根下写
  write('.layout-version', '3\n')
  return { root, mem, write }
}

/** 造「旧 id 的 5 项数据 + 一个 .git」。 */
function legacyProjectData(write) {
  write(`memory/kb/project/${OLD}/a.md`, '# a\n')
  write(`memory/kb/archive/project/${OLD}/b.md`, '# b\n')
  write(`todo/global/project/${OLD}/TODOS.md`, '# t\n')
  write(`todo/global/archive/project/${OLD}/2026-10-01.md`, '# d\n')
  write(`.system/projects/${OLD}/PROVENANCE`, `{"projectId":"${OLD}"}\n`)
  write(`.system/projects/${OLD}/.git/HEAD`, 'ref: refs/heads/main\n')
}

/** 目录树哈希（忽略迁移状态目录，它带时间戳）。 */
function treeHash(dir, base = dir) {
  const hash = createHash('sha256')
  const walk = (current) => {
    const items = readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const item of items) {
      const full = join(current, item.name)
      const rel = full.slice(base.length + 1).split('\\').join('/')
      if (rel.startsWith('.system/sync/project-migrations')) continue
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

/** 找目录里以某前缀开头的文件名。 */
function sidecarOf(dir, prefix) {
  return readdirSync(dir).find((name) => name.startsWith(prefix)) ?? null
}

test('project-migrate: cwd-map 记录（60s 节流）与旧 id 回查', () => {
  const { mem, write } = fixture()
  const cwd = 'C:\\Work\\Proj'
  assert.equal(rememberProjectCwd(mem, cwd, OLD).written, true)
  // 同 cwd 同 id 且在 TTL 内：不重复写
  assert.equal(rememberProjectCwd(mem, cwd, OLD).written, false)
  assert.equal(readCwdMap(mem)['c:\\work\\proj'].projectId, OLD)
  // 换 id 必须立刻记下（否则旧 id 再也回查不到）
  assert.equal(rememberProjectCwd(mem, cwd, NEW).written, true)
  assert.equal(readCwdMap(mem)['c:\\work\\proj'].projectId, NEW)

  const ids = legacyProjectIdsOf(mem, cwd)
  assert.ok(ids.includes(NEW))
  assert.ok(ids.includes(projectHash(cwd)))
  // 旧布局 projects/<id> 目录名也算候选
  write('projects/cccccccccccc/MEMORY.md')
  assert.ok(legacyProjectIdsOf(mem, cwd).includes('cccccccccccc'))

  // 未被 cwd-map 认领的元数据目录 → 交给 UI 手选
  write('.system/projects/dddddddddddd/PROVENANCE', '{"projectId":"dddddddddddd"}\n')
  const unclaimed = unclaimedProjectDirs(mem)
  const ids2 = unclaimed.map((item) => item.projectId)
  assert.ok(ids2.includes('dddddddddddd'))
  assert.equal(unclaimed.find((item) => item.projectId === 'dddddddddddd').provenance.projectId, 'dddddddddddd')
})

test('project-migrate: locateLegacyDir 走 cwd-map（remote→remote 变更也能定位旧 id）', () => {
  const { mem, write } = fixture()
  const cwd = 'C:\\Work\\Proj'
  // 上次身份是 OLD，本次已变成 NEW
  assert.equal(rememberProjectCwd(mem, cwd, OLD).written, true)
  assert.equal(rememberProjectCwd(mem, cwd, NEW).written, true)
  assert.ok(readCwdMap(mem)['c:\\work\\proj'].history.includes(OLD), '旧 id 必须留在 history 里')
  write(`.system/projects/${OLD}/PROVENANCE`, `{"projectId":"${OLD}"}\n`)
  // 旧实现只算 projectHash(cwd) → 找不到 OLD；新实现从 cwd-map 回查
  assert.equal(locateLegacyDir(mem, cwd, NEW), join(mem, '.system', 'projects', OLD))
  // 身份没变时不迁移
  assert.equal(locateLegacyDir(mem, cwd, OLD), null)
})

test('project-migrate: 非 v3 记忆根不写 cwd-map（不造 .system）', () => {
  const root = tmproot('dsh-sync-project-migrate-')
  const mem = join(root, 'v2-memories')
  mkdirSync(mem, { recursive: true })
  const result = rememberProjectCwd(mem, 'C:\\Work\\Proj', OLD)
  assert.equal(result.written, false)
  assert.equal(existsSync(join(mem, '.system')), false)
})

test('project-migrate B1: 备份被删空（标记还在）→ 识别为不可用并重备，不空手回滚', () => {
  const { mem, write } = fixture()
  write(`memory/kb/project/${OLD}/a.md`, '# a\n')
  const first = migrateProjectId(mem, OLD, NEW, {})
  assert.equal(first.ok, true)
  const marker = JSON.parse(readFileSync(join(first.backup, BACKUP_MARKER), 'utf8'))
  assert.equal(marker.files, 1)

  // 造续跑场景：源重现、状态清空、备份里的文件被删掉（标记保留）
  write(`memory/kb/project/${OLD}/a.md`, '# a\n')
  rmSync(join(mem, 'memory', 'kb', 'project', NEW, 'a.md'), { force: true })
  const stateFile = join(mem, '.system', 'sync', 'project-migrations', `${OLD}-to-${NEW}.json`)
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  state.done = []
  writeFileSync(stateFile, JSON.stringify(state))
  rmSync(join(first.backup, 'memory', 'kb', 'project', OLD, 'a.md'), { force: true })
  assert.ok(existsSync(join(first.backup, BACKUP_MARKER)), '空壳备份仍带标记（旧实现会复用）')

  const second = migrateProjectId(mem, OLD, NEW, {})
  assert.equal(second.ok, true)
  assert.equal(second.backupRecreated, true, '空壳备份必须被判为不可用')
  assert.equal(JSON.parse(readFileSync(join(second.backup, BACKUP_MARKER), 'utf8')).files, 1)
  assert.equal(readFileSync(join(mem, 'memory', 'kb', 'project', NEW, 'a.md'), 'utf8'), '# a\n')
  // 可用备份能正常回滚
  const rolled = rollbackProjectId(mem, OLD, NEW)
  assert.equal(rolled.ok, true)
  assert.ok(rolled.restored >= 1)
})

test('project-migrate B4: 目标已有 .git → 整目录旁路，绝不逐文件混', () => {
  const { mem, write } = fixture()
  write(`.system/projects/${OLD}/.git/HEAD`, 'old\n')
  write(`.system/projects/${OLD}/PROVENANCE`, `{"projectId":"${OLD}"}\n`)
  write(`.system/projects/${NEW}/.git/HEAD`, 'new\n')
  const report = migrateProjectId(mem, OLD, NEW, {})
  assert.equal(report.ok, true)
  // 新仓库一点没被旧仓库污染
  assert.equal(readFileSync(join(mem, '.system', 'projects', NEW, '.git', 'HEAD'), 'utf8'), 'new\n')
  // 旧 .git 整目录旁路保留
  const side = sidecarOf(join(mem, '.system', 'projects', NEW), '.git.pre-migrate.')
  assert.ok(side !== null, '旧 .git 必须整目录旁路')
  assert.equal(readFileSync(join(mem, '.system', 'projects', NEW, side, 'HEAD'), 'utf8'), 'old\n')
  // PROVENANCE 正常并入
  assert.ok(existsSync(join(mem, '.system', 'projects', NEW, 'PROVENANCE')))
})

test('project-migrate: 无旧数据 → no-op、不落盘、不留备份', () => {
  const { mem } = fixture()
  const before = treeHash(mem)
  const report = migrateProjectId(mem, OLD, NEW, {})
  assert.equal(report.ok, true)
  assert.equal(report.noop, true)
  assert.equal(report.executed, 0)
  assert.equal(report.backup, null)
  assert.equal(treeHash(mem), before)
})

test('project-migrate: 5 项数据全搬（dry-run 不落盘、跑两次幂等、.git 不进备份）', () => {
  const { root, mem, write } = fixture()
  legacyProjectData(write)

  const before = treeHash(mem)
  const dry = migrateProjectId(mem, OLD, NEW, { dryRun: true })
  assert.equal(dry.ok, true)
  assert.equal(dry.planned, 5)
  assert.equal(dry.executed, 0)
  assert.equal(treeHash(mem), before, 'dry-run 不许改盘')
  assert.equal(existsSync(join(root, `memories..bak-pid-${OLD}`)), false)
  // 计划列出的正是 5 项
  const plannedFrom = migrationPlanOf(mem, OLD, NEW).steps.map((step) => step.from)
  assert.equal(plannedFrom.length, 5)

  const report = migrateProjectId(mem, OLD, NEW, {})
  assert.equal(report.ok, true)
  assert.deepEqual(report.errors, [])
  assert.equal(report.executed, 5)
  // 新路径齐全
  assert.equal(readFileSync(join(mem, 'memory', 'kb', 'project', NEW, 'a.md'), 'utf8'), '# a\n')
  assert.ok(existsSync(join(mem, 'memory', 'kb', 'archive', 'project', NEW, 'b.md')))
  assert.ok(existsSync(join(mem, 'todo', 'global', 'project', NEW, 'TODOS.md')))
  assert.ok(existsSync(join(mem, 'todo', 'global', 'archive', 'project', NEW, '2026-10-01.md')))
  assert.equal(
    readFileSync(join(mem, '.system', 'projects', NEW, 'PROVENANCE'), 'utf8'),
    `{"projectId":"${OLD}"}\n`,
  )
  // 旧路径清空
  assert.equal(existsSync(join(mem, 'memory', 'kb', 'project', OLD)), false)
  assert.equal(existsSync(join(mem, '.system', 'projects', OLD)), false)
  // 备份：同级、带标记、只有 md/PROVENANCE、没有 .git
  assert.ok(report.backup.startsWith(`${mem}..bak-pid-${OLD}-`))
  assert.ok(existsSync(join(report.backup, BACKUP_MARKER)))
  assert.ok(existsSync(join(report.backup, 'memory', 'kb', 'project', OLD, 'a.md')))
  assert.equal(existsSync(join(report.backup, '.system', 'projects', OLD, '.git')), false, '.git 不进备份')

  const afterFirst = treeHash(mem)
  const again = migrateProjectId(mem, OLD, NEW, {})
  assert.equal(again.ok, true)
  assert.equal(again.noop, true, '旧路径已空 → 第二次直接 no-op')
  assert.equal(again.executed, 0)
  assert.equal(treeHash(mem), afterFirst, '幂等：文件树哈希不变')
})

test('project-migrate: 目标已存在 → 文件级并入、不覆盖、旧文件旁路 .pre-migrate.*', () => {
  const { mem, write } = fixture()
  write(`memory/kb/project/${OLD}/a.md`, '# old\n')
  write(`memory/kb/project/${OLD}/only-old.md`, '# only old\n')
  write(`memory/kb/project/${NEW}/a.md`, '# new\n')

  const report = migrateProjectId(mem, OLD, NEW, {})
  assert.equal(report.ok, true)
  assert.equal(report.conflicts.length, 1)
  assert.equal(report.conflicts[0].reason, 'target-exists')
  // 新内容不被覆盖
  assert.equal(readFileSync(join(mem, 'memory', 'kb', 'project', NEW, 'a.md'), 'utf8'), '# new\n')
  // 旧同名文件旁路保留
  const side = sidecarOf(join(mem, 'memory', 'kb', 'project', NEW), 'a.md.pre-migrate.')
  assert.ok(side !== null, '旧同名文件必须旁路保留')
  assert.equal(readFileSync(join(mem, 'memory', 'kb', 'project', NEW, side), 'utf8'), '# old\n')
  // 不冲突的文件正常并入
  assert.equal(readFileSync(join(mem, 'memory', 'kb', 'project', NEW, 'only-old.md'), 'utf8'), '# only old\n')
  // 旧目录已清空
  assert.equal(existsSync(join(mem, 'memory', 'kb', 'project', OLD)), false)
})

test('project-migrate: 回滚只把备份文件写回旧位置，绝不删新数据', () => {
  const { mem, write } = fixture()
  legacyProjectData(write)
  assert.equal(migrateProjectId(mem, OLD, NEW, {}).ok, true)
  // 迁移后新 id 上又产生了新数据
  write(`memory/kb/project/${NEW}/after-migrate.md`, '# new work\n')

  const rolled = rollbackProjectId(mem, OLD, NEW)
  assert.equal(rolled.ok, true)
  assert.deepEqual(rolled.errors, [])
  assert.ok(rolled.restored >= 5)
  // 旧位置回来了
  assert.equal(readFileSync(join(mem, 'memory', 'kb', 'project', OLD, 'a.md'), 'utf8'), '# a\n')
  assert.ok(existsSync(join(mem, 'memory', 'kb', 'archive', 'project', OLD, 'b.md')))
  assert.ok(existsSync(join(mem, 'todo', 'global', 'project', OLD, 'TODOS.md')))
  assert.ok(existsSync(join(mem, '.system', 'projects', OLD, 'PROVENANCE')))
  // 新数据一律保留
  assert.equal(existsSync(join(mem, 'memory', 'kb', 'project', NEW, 'a.md')), true)
  assert.equal(readFileSync(join(mem, 'memory', 'kb', 'project', NEW, 'after-migrate.md'), 'utf8'), '# new work\n')
  // 再回滚一次：幂等（内容一致的文件跳过），不产生新的旁路
  const again = rollbackProjectId(mem, OLD, NEW)
  assert.equal(again.ok, true)
  assert.equal(again.restored, 0)
  assert.ok(again.skipped >= 5)
})
