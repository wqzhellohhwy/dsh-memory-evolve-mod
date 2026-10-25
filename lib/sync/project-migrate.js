/**
 * dsh-memory-evolve — 项目 id 变更迁移（sync v3 方案 C 节）。
 *
 * 场景：项目身份从「remote A」换成「remote B」（或 fallback hash → remote）后，
 * 项目 id 变了，而数据仍挂在旧 id 上：
 *   memory/<gid>/project/<old>/…
 *   memory/<gid>/archive/project/<old>/…
 *   todo/<gid>/project/<old>/…
 *   todo/<gid>/archive/project/<old>/…
 *   .system/projects/<old>/{PROVENANCE,.git}
 * 本模块负责：记录 cwd→项目 id（cwd-map，用来回查旧 id）、规划搬迁、执行、回滚。
 *
 * 安全约束：
 *   - 备份 `<记忆根>..bak-pid-<old>-<ts>` 只冷拷 `.md` / `.keep` / `PROVENANCE`，
 *     **跳过 `.git`**（体积大且远端可重取），带 `.backup-complete` 标记。
 *   - 目标已存在 → 文件级并入，同名文件改 `<名>.pre-migrate.<ts>`，绝不覆盖。
 *   - 回滚只把备份里的文件写回旧位置，同名冲突改 `<名>.pre-rollback.<ts>`，
 *     **绝不删任何新数据**。
 *   - 每步完成写状态（原子），崩溃可续跑；源目录不存在即跳过 → 天然幂等。
 *
 * @module dsh-memory-evolve/sync/project-migrate
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { loadGroups, listGroups } from '../groups.js'
import { projectHash } from '../store.js'

/** cwd → 项目 id 的本地态（不入仓）。 */
export const CWD_MAP_FILE = join('.system', 'projects', 'cwd-map.json')

/** 迁移状态目录（相对记忆根）。 */
export const MIGRATION_STATE_DIR = join('.system', 'sync', 'project-migrations')

/** 备份完整性标记。 */
export const BACKUP_MARKER = '.backup-complete'

/** 同一 cwd 重复记录的最小间隔（避免每次 pathOf 都写盘）。 */
export const CWD_MAP_TTL_MS = 60_000

/** 备份只收这些文件（其余跳过并记入报告）。 */
function isBackupWorthy(name) {
  return name.endsWith('.md') || name === '.keep' || name === 'PROVENANCE'
}

/** 列目录（不存在返回空）。 */
function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 列子目录名。 */
function dirNames(dir) {
  return listDir(dir).filter((item) => item.isDirectory()).map((item) => item.name)
}

/** 是否目录。 */
function isDir(path) {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 本地时间戳（`yyyyMMdd-HHmmss`）。 */
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** cwd 归一（Windows 大小写与尾分隔符不敏感）。 */
function normalizeCwd(cwd) {
  const text = String(cwd ?? '').trim().replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? text.toLowerCase() : text
}

/** 原子写 JSON（tmp + rename）。 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  try {
    renameSync(tmp, file)
  } catch {
    rmSync(file, { force: true })
    renameSync(tmp, file)
  }
}

/** 读 JSON（缺失/坏文件返回 null）。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/* ---------------- cwd-map ---------------- */

/** 读 cwd-map（容错为空对象）。 */
export function readCwdMap(memoryDir) {
  const data = readJson(join(memoryDir, CWD_MAP_FILE))
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

/** 进程内节流缓存（resolver 是热路径：避免每次 pathOf 都读盘）。 */
const cwdMemo = new Map()

/**
 * 记住「这个 cwd 对应哪个项目 id」。
 *
 * 身份从 remote A 切到 remote B 后，旧 id 只能从这里回查（A 的哈希本机别处没记）。
 * 同 cwd 同 id 且 60s 内重复调用不写盘（调用点在路径解析热路径上）；
 * 只在 v3 记忆根（有 `.layout-version`）下写，避免在 v2/未迁移目录里造 `.system/`。
 * @param {string} memoryDir - 记忆根。
 * @param {string} cwd - 会话工作目录。
 * @param {string} projectId - 当前项目 id。
 * @param {{ttlMs?: number, now?: number}} [options]
 * @returns {{ok: boolean, written: boolean}}
 */
export function rememberProjectCwd(memoryDir, cwd, projectId, options = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return { ok: false, written: false }
  if (typeof projectId !== 'string' || projectId.trim() === '') return { ok: false, written: false }
  if (!existsSync(join(memoryDir, '.layout-version'))) return { ok: false, written: false }
  const key = normalizeCwd(cwd)
  const memoKey = `${memoryDir}|${key}`
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : CWD_MAP_TTL_MS
  const memo = cwdMemo.get(memoKey)
  if (memo !== undefined && memo.projectId === projectId && now - memo.at < ttl) {
    return { ok: true, written: false }
  }
  const map = readCwdMap(memoryDir)
  const prev = map[key]
  if (prev !== null && typeof prev === 'object' && prev.projectId === projectId) {
    const at = Date.parse(prev.updatedAt ?? '')
    if (Number.isFinite(at) && now - at < ttl) {
      cwdMemo.set(memoKey, { projectId, at })
      return { ok: true, written: false }
    }
  }
  // 身份变更时把上一个 id 存进 history：不这么做的话「记录当前 id」会把旧 id
  // 直接覆盖掉，remote→remote 变更后再也回查不到旧数据挂在哪。
  const history = []
  if (prev !== null && typeof prev === 'object') {
    for (const id of [prev.projectId, ...(Array.isArray(prev.history) ? prev.history : [])]) {
      if (typeof id === 'string' && id !== '' && id !== projectId && !history.includes(id)) history.push(id)
    }
  }
  map[key] = { projectId, updatedAt: new Date(now).toISOString(), history: history.slice(0, 8) }
  try {
    writeJsonAtomic(join(memoryDir, CWD_MAP_FILE), map)
  } catch {
    return { ok: false, written: false }
  }
  cwdMemo.set(memoKey, { projectId, at: now })
  return { ok: true, written: true }
}

/**
 * 这个 cwd 可能用过的全部项目 id：cwd-map 记录 ∪ `projectHash(cwd)` ∪ 旧布局
 * `projects/<id>` 目录名（v2 残留）。调用方逐个尝试迁移，无数据的 id 是 no-op。
 * @param {string} memoryDir - 记忆根。
 * @param {string} cwd - 会话工作目录。
 * @returns {string[]}
 */
export function legacyProjectIdsOf(memoryDir, cwd) {
  const ids = new Set()
  const hit = readCwdMap(memoryDir)[normalizeCwd(cwd)]
  if (hit !== null && typeof hit === 'object') {
    if (typeof hit.projectId === 'string') ids.add(hit.projectId)
    for (const id of Array.isArray(hit.history) ? hit.history : []) {
      if (typeof id === 'string') ids.add(id)
    }
  }
  if (typeof cwd === 'string' && cwd.trim() !== '') ids.add(projectHash(cwd))
  for (const name of dirNames(join(memoryDir, 'projects'))) ids.add(name)
  return [...ids]
}

/**
 * `.system/projects/*` 里没有被 cwd-map 认领的目录（供 UI 让用户手选旧 id）。
 * @param {string} memoryDir
 * @returns {Array<{projectId: string, entries: number, provenance: object|null}>}
 */
export function unclaimedProjectDirs(memoryDir) {
  const owned = new Set()
  for (const item of Object.values(readCwdMap(memoryDir))) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.projectId === 'string') owned.add(item.projectId)
    for (const id of Array.isArray(item.history) ? item.history : []) {
      if (typeof id === 'string') owned.add(id)
    }
  }
  const out = []
  for (const id of dirNames(join(memoryDir, '.system', 'projects'))) {
    if (owned.has(id)) continue
    const dir = join(memoryDir, '.system', 'projects', id)
    out.push({
      projectId: id,
      entries: countMd(dir),
      provenance: readJson(join(dir, 'PROVENANCE')),
    })
  }
  return out
}

/** 递归数 `.md`（诊断用）。 */
function countMd(dir) {
  let total = 0
  for (const item of listDir(dir)) {
    const full = join(dir, item.name)
    if (item.isDirectory()) total += countMd(full)
    else if (item.name.endsWith('.md')) total += 1
  }
  return total
}

/* ---------------- 迁移计划 ---------------- */

/** 记忆/待办两侧的全部分组 id（内置 + 自建）。 */
function allGroupIds(memoryDir) {
  const data = loadGroups(memoryDir)
  const ids = new Set()
  for (const group of listGroups(data, 'memory')) ids.add(group.id)
  for (const group of listGroups(data, 'todo')) ids.add(group.id)
  return [...ids].sort()
}

/**
 * 规划一次项目 id 迁移（只读）。
 * @param {string} memoryDir - 记忆根。
 * @param {string} oldId - 旧项目 id。
 * @param {string} newId - 新项目 id。
 * @returns {{steps: object[], conflicts: object[]}}
 */
export function migrationPlanOf(memoryDir, oldId, newId) {
  const steps = []
  const conflicts = []
  const add = (from, to) => {
    if (!existsSync(from)) return
    const rel = relative(memoryDir, from).split(/[\\/]/).join('/')
    const step = { key: `move:${rel}`, from, to, entry: isDir(from) ? 'dir' : 'file' }
    if (existsSync(to)) {
      step.merge = true
      conflicts.push({ key: step.key, from: rel, to: relative(memoryDir, to).split(/[\\/]/).join('/'), reason: 'target-exists' })
    }
    steps.push(step)
  }
  for (const gid of allGroupIds(memoryDir)) {
    add(join(memoryDir, 'memory', gid, 'project', oldId), join(memoryDir, 'memory', gid, 'project', newId))
    add(join(memoryDir, 'memory', gid, 'archive', 'project', oldId), join(memoryDir, 'memory', gid, 'archive', 'project', newId))
    add(join(memoryDir, 'todo', gid, 'project', oldId), join(memoryDir, 'todo', gid, 'project', newId))
    add(join(memoryDir, 'todo', gid, 'archive', 'project', oldId), join(memoryDir, 'todo', gid, 'archive', 'project', newId))
  }
  add(join(memoryDir, '.system', 'projects', oldId), join(memoryDir, '.system', 'projects', newId))
  return { steps, conflicts }
}

/* ---------------- 备份 ---------------- */

/**
 * 冷拷（只收 `.md` / `.keep` / `PROVENANCE`，跳过任何 `.git`）。
 * 单个文件失败记进 `errors` 继续（不让一个坏文件毁掉整次备份）。
 * @returns {number} 拷贝文件数
 */
function copyBackupTree(src, dest, skipped, copied, errors) {
  let stat
  try {
    stat = lstatSync(src)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) {
    skipped.push(src)
    return
  }
  const name = src.split(/[\\/]/).pop()
  if (stat.isDirectory()) {
    if (name === '.git') {
      skipped.push(src)
      return
    }
    mkdirSync(dest, { recursive: true })
    for (const item of listDir(src)) copyBackupTree(join(src, item.name), join(dest, item.name), skipped, copied, errors)
    return
  }
  if (!isBackupWorthy(name)) {
    skipped.push(src)
    return
  }
  try {
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    copied.push(src)
  } catch (error) {
    errors.push(`${src}：${error.message}`)
  }
}

/** 数一棵树里「应该被备份」的文件数（跳过 `.git` 与符号链接）。 */
function countBackupWorthy(src) {
  let stat
  try {
    stat = lstatSync(src)
  } catch {
    return 0
  }
  if (stat.isSymbolicLink()) return 0
  const name = src.split(/[\\/]/).pop()
  if (stat.isDirectory()) {
    if (name === '.git') return 0
    let total = 0
    for (const item of listDir(src)) total += countBackupWorthy(join(src, item.name))
    return total
  }
  return isBackupWorthy(name) ? 1 : 0
}

/** 数备份目录里实际的文件数（不含完整性标记）。 */
function countBackupFiles(dir) {
  let total = 0
  for (const item of listDir(dir)) {
    const full = join(dir, item.name)
    if (item.isDirectory()) total += countBackupFiles(full)
    else if (item.name !== BACKUP_MARKER) total += 1
  }
  return total
}

/**
 * 备份是否可复用：目录 + 完整性标记 + 文件数与标记里记录的一致。
 *
 * 只验标记存在不够——文件被删空/删一半的备份仍然"存在"，回滚会报 ok 却
 * 一个文件都还原不了。
 */
function backupUsable(backup) {
  if (!isDir(backup)) return false
  const marker = readJson(join(backup, BACKUP_MARKER))
  if (marker === null || typeof marker !== 'object' || !Number.isFinite(marker.files)) return false
  return countBackupFiles(backup) === marker.files
}

/* ---------------- 并入 ---------------- */

/**
 * 把 `from` 并进已存在的 `to`：同名文件改 `<名>.pre-migrate.<ts>` 保留双份。
 * `.git` 整目录旁路（两个仓库逐文件混进一个 `.git` 必坏）。
 */
function mergeInto(from, to, suffix, report) {
  if (!existsSync(from)) return
  if (!isDir(from)) {
    const target = to
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true })
      renameSync(from, target)
      return
    }
    const side = `${target}${suffix}`
    rmSync(side, { recursive: true, force: true })
    renameSync(from, side)
    report.sidecars.push(side)
    return
  }
  if (from.split(/[\\/]/).pop() === '.git') {
    const side = `${to}${suffix}`
    mkdirSync(dirname(side), { recursive: true })
    rmSync(side, { recursive: true, force: true })
    renameSync(from, side)
    report.sidecars.push(side)
    return
  }
  mkdirSync(to, { recursive: true })
  for (const item of listDir(from)) mergeInto(join(from, item.name), join(to, item.name), suffix, report)
  try {
    if (readdirSync(from).length === 0) rmdirSync(from)
  } catch {
    /* 占用中：留着 */
  }
}

/* ---------------- 状态 ---------------- */

/** 状态文件路径。 */
export function migrationStateFileOf(memoryDir, oldId, newId) {
  return join(memoryDir, MIGRATION_STATE_DIR, `${oldId}-to-${newId}.json`)
}

/** 读状态（缺失/坏文件返回 null）。 */
export function readMigrationState(memoryDir, oldId, newId) {
  const data = readJson(migrationStateFileOf(memoryDir, oldId, newId))
  if (data === null || typeof data !== 'object') return null
  return { ...data, done: Array.isArray(data.done) ? data.done : [] }
}

/* ---------------- 执行 ---------------- */

/**
 * 执行一次项目 id 迁移。
 * @param {string} memoryDir - 记忆根。
 * @param {string} oldId - 旧项目 id。
 * @param {string} newId - 新项目 id。
 * @param {{dryRun?: boolean, now?: Date}} [options]
 * @returns {object} 报告
 */
export function migrateProjectId(memoryDir, oldId, newId, options = {}) {
  const dryRun = options.dryRun === true
  const report = {
    ok: true,
    dryRun,
    memoryDir,
    fromId: oldId,
    toId: newId,
    backup: null,
    backupRecreated: false,
    planned: 0,
    executed: 0,
    skipped: 0,
    conflicts: [],
    skippedBackupFiles: [],
    sidecars: [],
    errors: [],
    noop: false,
    steps: [],
  }
  if (typeof oldId !== 'string' || oldId === '' || typeof newId !== 'string' || newId === '') {
    report.ok = false
    report.errors.push('oldId / newId 不能为空')
    return report
  }
  if (oldId === newId) {
    report.noop = true
    return report
  }

  const plan = migrationPlanOf(memoryDir, oldId, newId)
  report.planned = plan.steps.length
  report.conflicts = plan.conflicts
  report.steps = plan.steps.map((step) => ({
    key: step.key,
    from: relative(memoryDir, step.from).split(/[\\/]/).join('/'),
    to: relative(memoryDir, step.to).split(/[\\/]/).join('/'),
  }))
  if (plan.steps.length === 0) {
    report.noop = true
    return report
  }
  if (dryRun) return report

  const stateFile = migrationStateFileOf(memoryDir, oldId, newId)
  const state = readMigrationState(memoryDir, oldId, newId) ?? {
    version: 1,
    fromId: oldId,
    toId: newId,
    backup: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    done: [],
  }
  const done = new Set(state.done)

  // ---- 备份（缺了/被删了就重做，绝不无备份裸迁） ----
  let backup = typeof state.backup === 'string' && backupUsable(state.backup) ? state.backup : null
  if (backup === null) {
    if (typeof state.backup === 'string' && state.backup !== '') report.backupRecreated = true
    backup = `${memoryDir}..bak-pid-${oldId}-${stamp(options.now)}`
    const copied = []
    const copyErrors = []
    let expected = 0
    for (const step of plan.steps) {
      if (!existsSync(step.from)) continue
      expected += countBackupWorthy(step.from)
      const rel = relative(memoryDir, step.from)
      copyBackupTree(step.from, join(backup, rel), report.skippedBackupFiles, copied, copyErrors)
    }
    // 完整性校验：实拷数必须等于应备份数。`mkdirSync` 会把空壳目录也建出来，
    // 只判"备份目录非空"会被空壳骗过，之后写出一个谎称完整的标记。
    if (copyErrors.length > 0 || !isDir(backup) || copied.length !== expected) {
      report.ok = false
      report.errors.push(
        `备份不完整（应备份 ${expected} 个文件，实拷 ${copied.length} 个，失败 ${copyErrors.length} 个），迁移中止（磁盘未改动）`,
      )
      for (const error of copyErrors.slice(0, 10)) report.errors.push(`备份文件失败：${error}`)
      rmSync(backup, { recursive: true, force: true })
      return report
    }
    try {
      writeFileSync(
        join(backup, BACKUP_MARKER),
        `${JSON.stringify({ finishedAt: new Date().toISOString(), files: copied.length })}\n`,
      )
    } catch (error) {
      report.ok = false
      report.errors.push(`写备份完整性标记失败，迁移中止：${error.message}`)
      rmSync(backup, { recursive: true, force: true })
      return report
    }
    state.backup = backup
    state.updatedAt = new Date().toISOString()
    writeJsonAtomic(stateFile, state)
  }
  report.backup = backup

  // ---- 逐项搬迁（目标已存在则文件级并入） ----
  const suffix = `.pre-migrate.${stamp(options.now)}`
  for (const step of plan.steps) {
    if (done.has(step.key)) continue
    if (!existsSync(step.from)) {
      report.skipped += 1
      done.add(step.key)
      state.done.push(step.key)
      continue
    }
    try {
      if (!existsSync(step.to)) {
        mkdirSync(dirname(step.to), { recursive: true })
        renameSync(step.from, step.to)
      } else {
        mergeInto(step.from, step.to, suffix, report)
      }
      report.executed += 1
    } catch (error) {
      report.ok = false
      report.errors.push(`搬迁失败 ${step.key}：${error.message}`)
      continue
    }
    done.add(step.key)
    state.done.push(step.key)
    state.updatedAt = new Date().toISOString()
    try {
      writeJsonAtomic(stateFile, state)
    } catch (error) {
      report.errors.push(`写状态失败（搬迁已生效）：${error.message}`)
    }
  }
  if (report.ok) {
    state.updatedAt = new Date().toISOString()
    try {
      writeJsonAtomic(stateFile, state)
    } catch { /* 状态写失败不影响结果 */ }
  }
  return report
}

/* ---------------- 回滚 ---------------- */

/** 递归列出备份里的文件（相对备份根）。 */
function backupFiles(dir, base = dir, out = []) {
  for (const item of listDir(dir)) {
    const full = join(dir, item.name)
    if (item.isDirectory()) backupFiles(full, base, out)
    else if (item.name !== BACKUP_MARKER) out.push(relative(base, full))
  }
  return out
}

/**
 * 回滚：只把备份里的文件写回旧位置，同名冲突改 `<名>.pre-rollback.<ts>`。
 * **绝不删除新数据**；内容已一致的文件跳过（可重复回滚）。
 * @param {string} memoryDir - 记忆根。
 * @param {string} oldId - 旧项目 id。
 * @param {string} newId - 新项目 id。
 * @param {{now?: Date}} [options]
 * @returns {object} 报告
 */
export function rollbackProjectId(memoryDir, oldId, newId, options = {}) {
  const report = {
    ok: true, memoryDir, fromId: oldId, toId: newId,
    backup: null, restored: 0, skipped: 0, sidecars: [], errors: [],
  }
  const state = readMigrationState(memoryDir, oldId, newId)
  if (state === null || typeof state.backup !== 'string' || !backupUsable(state.backup)) {
    report.ok = false
    report.errors.push('找不到可用的迁移备份（先跑一次迁移）')
    return report
  }
  report.backup = state.backup
  const suffix = `.pre-rollback.${stamp(options.now)}`
  for (const rel of backupFiles(state.backup)) {
    const from = join(state.backup, rel)
    const to = join(memoryDir, rel)
    if (existsSync(to)) {
      let same = false
      try {
        same = readFileSync(from).equals(readFileSync(to))
      } catch {
        same = false
      }
      if (same) {
        report.skipped += 1
        continue
      }
      const side = `${to}${suffix}`
      rmSync(side, { force: true })
      renameSync(to, side)
      report.sidecars.push(side)
    }
    try {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      report.restored += 1
    } catch (error) {
      report.ok = false
      report.errors.push(`还原失败 ${rel}：${error.message}`)
    }
  }
  try {
    state.rolledBackAt = new Date().toISOString()
    state.updatedAt = state.rolledBackAt
    writeJsonAtomic(migrationStateFileOf(memoryDir, oldId, newId), state)
  } catch { /* 状态写失败不影响结果 */ }
  return report
}
