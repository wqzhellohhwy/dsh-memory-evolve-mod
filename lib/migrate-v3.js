/**
 * dsh-memory-evolve — 记忆目录布局 v2 → v3 迁移（纯逻辑）。
 *
 * 规范：`docs/layout-v3.md` 第 7 节。只依赖 `node:fs` / `node:path`，可在独立
 * node 进程里跑（CLI 见 `scripts/migrate-v3.mjs`），不 import 宿主任何模块。
 *
 * v2（旧）→ v3（新）：
 *   global/<id>/…                        → memory/<id>/global/…
 *   sessions/<sid>/<id>/…                → memory/<id>/session/<sid>/…
 *   projects/<proj>/<id>/…               → memory/<id>/project/<proj>/…
 *   todo/TODOS-<id>.md                   → todo/<id>/global/TODOS.md
 *   todo/<id>/<日期>.md                  → todo/<id>/global/<日期>.md
 *   sessions/<sid>/todo/TODOS-<id>.md    → todo/<id>/session/<sid>/TODOS.md
 *   sessions/<sid>/todo/<id>/<日期>.md   → todo/<id>/session/<sid>/<日期>.md
 *   projects/<proj>/todo/…               → todo/<id>/project/<proj>/…
 *   <任意类目录>/archive/<id>/…          → memory/<id>/archive/<类段>/…
 *   <任意类目录>/archive/todo-<id>/…     → todo/<id>/archive/<类段>/…
 *   projects/<proj>/PROVENANCE           → .system/projects/<proj>/PROVENANCE
 *   其余旧顶层条目                        → .system/legacy/<原名>/…
 *
 * 四条硬约束：
 *   1. 先备份：整目录冷拷贝到 `<memoryDir>..bak-<yyyyMMdd-HHmmss>`（memoryDir 的同级）。
 *   2. `dryRun` 只出计划，一个字节都不写（不建目录、不备份）。
 *   3. 幂等：每步完成后记进 `.system/migrate-v3.state`，重跑跳过已完成步骤。
 *   4. 断点：状态文件逐步落盘，失败后重跑从剩余步骤继续。
 *
 * @module dsh-memory-evolve/migrate-v3
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  rmdirSync,
  lstatSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 目标布局版本。 */
export const LAYOUT_VERSION = 3

/** 布局版本标记文件名（内容 = 版本号）。 */
export const LAYOUT_FILE = '.layout-version'

/** 系统目录 / 迁移状态文件 / 旧结构暂存区（都相对记忆根）。 */
export const SYSTEM_DIR = '.system'
export const STATE_FILE = `${SYSTEM_DIR}/migrate-v3.state`
export const LEGACY_DIR = `${SYSTEM_DIR}/legacy`

/** 新布局的两个分组根。 */
export const MEMORY_ROOT = 'memory'
export const TODO_ROOT = 'todo'

/** 迁进 `.system/` 的系统条目（规范第 1 节）。 */
export const SYSTEM_ENTRIES = [
  'groups.json',
  'tools.json',
  'plugin-state.json',
  'snapshot-presets.json',
  'SUGGESTIONS.jsonl',
  '.vault-version',
  'advisor',
]

/**
 * 模块数据（规范 §1「例外」）：这些模块仍读写记忆根顶层，
 * 迁移时**原地保留、绝不搬 legacy**（搬走等于数据消失）。
 */
export const MODULE_DATA_ENTRIES = [
  'models.json',
  'aliases.json',
  'notifications',
  'session-bookmarks.json',
  'pending-skills',
  'canvas',
  'search-docs-index.json',
  'session-orch',
  'coi',
  'logs',
  'tasks.json',
]

/** 按前缀匹配的模块数据（`broadcast*`）。 */
export const MODULE_DATA_PREFIXES = ['broadcast']

/**
 * 记忆根下的 VCS 元数据与项目溯源文件：迁移必须**原地保留**。
 *
 * 搬进 legacy 等于把整个 git 仓库搬走（同步用户一跑迁移就废掉仓库），
 * 而且新方案的 `.git` 本来就设计在记忆根下。`.git` 既可能是目录（普通仓库）
 * 也可能是文件（worktree / submodule）。
 */
export const PRESERVED_VCS_ENTRIES = ['.git', '.gitignore', '.gitattributes', '.gitmodules', 'PROVENANCE']

/** 旧布局的数据容器（其内容会被拆进 memory/ 与 todo/）。 */
const DATA_CONTAINERS = ['global', 'archive', 'sessions', 'projects', 'todo']

/** v3 根下允许出现的条目（除模块数据外）。 */
const ALLOWED_ROOT = new Set([SYSTEM_DIR, MEMORY_ROOT, TODO_ROOT, LAYOUT_FILE])

/** 已被迁移逻辑接管、不按「未知顶层条目」处理的名字。 */
const KNOWN_TOP = new Set([
  SYSTEM_DIR, MEMORY_ROOT, TODO_ROOT, LAYOUT_FILE,
  ...SYSTEM_ENTRIES, ...DATA_CONTAINERS,
])

/** 是否模块数据（精确名或 `broadcast*` 前缀，大小写不敏感——Windows 上 `Models.json` 也算）。 */
export function isModuleData(name) {
  const lower = String(name).toLowerCase()
  return MODULE_DATA_ENTRIES.includes(lower)
    || MODULE_DATA_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/** 是否 VCS 元数据 / 项目溯源文件（必须原地保留，大小写不敏感）。 */
export function isPreservedVcs(name) {
  const lower = String(name).toLowerCase()
  return PRESERVED_VCS_ENTRIES.some((entry) => entry.toLowerCase() === lower)
}

/** 日志型条目文件名（`YYYY-MM-DD.md`）。 */
const DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/

/** 待办文件名 `TODOS-<id>.md`。 */
const TODO_FILE_RE = /^TODOS-(.+)\.md$/

/**
 * 记忆根规范化：转绝对路径并剥掉尾分隔符（根目录 `C:\` 保留）。
 *
 * 必须做：备份目录用 `<memoryDir>..bak-<时间戳>` 拼出，尾分隔符会让它变成
 * `<memoryDir>\\..bak-<时间戳>`——落在记忆根**内部**，冷拷贝时把自己也复制进去，
 * 指数膨胀直到吃满磁盘。
 * @param {string} memoryDir
 * @returns {string}
 */
export function normalizeMemoryDir(memoryDir) {
  const resolved = resolve(String(memoryDir ?? '.'))
  if (!resolved.endsWith(sep)) return resolved
  return dirname(resolved) === resolved ? resolved : resolved.slice(0, -sep.length)
}

/** 相对记忆根的路径（统一正斜杠，报告用）。 */function relPath(memoryDir, path) {
  return relative(memoryDir, path).split(/[\\/]/).join('/')
}

/** 旧容器里不是「分组目录」的名字（`.git` 是 v2 项目级同步仓，绝不能被当成 gid）。 */
const NOT_GROUP_DIRS = new Set(['.git', 'todo', 'archive', 'PROVENANCE'])

/** 列目录（不存在/不可读返回空数组）。 */
function dirEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 列子目录名（升序）。 */
function dirNames(dir) {
  return dirEntries(dir)
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort()
}

/** 判断条目类型（`'dir'` / `'file'` / `null`）。 */
function entryType(path) {
  try {
    return statSync(path).isDirectory() ? 'dir' : 'file'
  } catch {
    return null
  }
}

/** 目标是否已被占用（文件一律占；目录看是否非空）。 */
function isBusy(path) {
  try {
    const stat = statSync(path)
    if (!stat.isDirectory()) return true
    return readdirSync(path).length > 0
  } catch {
    return false
  }
}

/** 本地时间戳（`yyyyMMdd-HHmmss`）。 */
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 递归拷贝（文件/目录）。符号链接**不跟随**，跳过并记进 `skipped`（绝对路径）。
 * 跟随链接会复制到根外的内容，祖先里有链接时甚至造成环。
 */
function copyTree(src, dest, skipped = null) {
  const stat = lstatSync(src)
  if (stat.isSymbolicLink()) {
    if (skipped !== null) skipped.push(src)
    return
  }
  if (!stat.isDirectory()) {
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    return
  }
  mkdirSync(dest, { recursive: true })
  for (const item of dirEntries(src)) {
    copyTree(join(src, item.name), join(dest, item.name), skipped)
  }
}

/**
 * 目标路径的祖先是否被**文件**占住（Windows 上 mkdir 到文件底下会直接抛 ENOTDIR）。
 * @returns {string|null} 被占祖先的相对路径；无则 null。
 */
function blockedAncestor(memoryDir, to) {
  let dir = dirname(to)
  for (;;) {
    if (entryType(dir) === 'file') return relPath(memoryDir, dir)
    const rel = relative(memoryDir, dir)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
    dir = dirname(dir)
  }
}

/** 搬动（同盘 rename；空目录占位先清掉；跨盘回落到拷贝 + 删）。 */
function moveEntry(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  if (existsSync(dest) && !isBusy(dest)) rmdirSync(dest)
  try {
    renameSync(src, dest)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    // 符号链接跨盘无法靠"拷贝 + 删源"表达（copyTree 跳过链接会直接丢掉条目），
    // 报错并保留源：宁可这一步不搬，也不能把链接吞掉。
    if (lstatSync(src).isSymbolicLink()) {
      throw new Error(`跨盘无法搬迁符号链接（源已保留，未丢数据）：${src}`)
    }
    copyTree(src, dest)
    rmSync(src, { recursive: true, force: true })
  }
}

/**
 * 建迁移步骤表（只读，不改盘）。
 *
 * 每条步骤：
 *   - `{ key, kind: 'mkdir', dir }`
 *   - `{ key, kind: 'move', from, to, entry }`
 *   - `{ key, kind: 'keep', file }`
 *   - `{ key, kind: 'write', file, content }`
 *
 * 目标已存在且非空 → 步骤带 `conflict: true`（执行时记为冲突并跳过）。
 * @param {string} memoryDir - 记忆根目录。
 * @returns {{steps: object[], conflicts: object[]}} 步骤表与冲突预判。
 */
export function planMigration(memoryDir) {
  const steps = []
  const conflicts = []
  /** 已被某个步骤认领的源路径（防止同一条目被"残留"逻辑二次认领）。 */
  const claimed = new Set()

  const memData = (id, ...seg) => join(memoryDir, MEMORY_ROOT, id, ...seg)
  const memArchive = (id, ...seg) => memData(id, 'archive', ...seg)
  const todoData = (id, ...seg) => join(memoryDir, TODO_ROOT, id, ...seg)
  const todoArchive = (id, ...seg) => todoData(id, 'archive', ...seg)

  /** 登记一次搬迁（源不存在则静默跳过）。 */
  const move = (from, to) => {
    const entry = entryType(from)
    if (entry === null || claimed.has(from)) return
    claimed.add(from)
    const step = { key: `move:${relPath(memoryDir, from)}`, kind: 'move', from, to, entry }
    const blocked = blockedAncestor(memoryDir, to)
    if (blocked !== null) {
      step.conflict = true
      conflicts.push({ from: relPath(memoryDir, from), to: relPath(memoryDir, to), reason: `ancestor-is-file:${blocked}` })
    } else if (isBusy(to)) {
      step.conflict = true
      conflicts.push({ from: relPath(memoryDir, from), to: relPath(memoryDir, to), reason: 'target-exists' })
    }
    steps.push(step)
  }

  /** 旧条目原样搬进 `.system/legacy/`（保持相对路径）。 */
  const toLegacy = (from, toRel = relative(memoryDir, from)) => {
    move(from, join(memoryDir, LEGACY_DIR, toRel))
  }

  // ---- 1. 系统文件搬进 .system/ ----
  for (const name of SYSTEM_ENTRIES) {
    const src = join(memoryDir, name)
    if (!existsSync(src)) continue
    move(src, join(memoryDir, SYSTEM_DIR, name))
  }

  // ---- 2. 建根 ----
  for (const dir of [SYSTEM_DIR, MEMORY_ROOT, TODO_ROOT]) {
    steps.push({ key: `mkdir:${dir}`, kind: 'mkdir', dir: join(memoryDir, dir) })
  }

  // ---- 3. 记忆数据（全局 / 会话 / 项目） ----
  for (const id of dirNames(join(memoryDir, 'global'))) {
    if (NOT_GROUP_DIRS.has(id)) continue
    move(join(memoryDir, 'global', id), memData(id, 'global'))
  }
  for (const sid of dirNames(join(memoryDir, 'sessions'))) {
    const sdir = join(memoryDir, 'sessions', sid)
    for (const item of dirEntries(sdir)) {
      if (NOT_GROUP_DIRS.has(item.name)) continue
      if (!item.isDirectory()) continue
      move(join(sdir, item.name), memData(item.name, 'session', sid))
    }
  }
  for (const proj of dirNames(join(memoryDir, 'projects'))) {
    const pdir = join(memoryDir, 'projects', proj)
    for (const item of dirEntries(pdir)) {
      if (NOT_GROUP_DIRS.has(item.name)) continue
      if (!item.isDirectory()) continue
      move(join(pdir, item.name), memData(item.name, 'project', proj))
    }
  }

  // ---- 4. 待办数据（一组一个文件 / 日志型一天一个文件） ----
  // `todo/<id>/` 里除 `<日期>.md` 之外的散文件（旧 TODOS.md、`.keep`、用户手放的）
  // 无处可去：搬 `.system/legacy/<原相对路径>`，不留残渣在新分组目录里。
  const todoBase = (base, ...seg) => {
    for (const item of dirEntries(base)) {
      const full = join(base, item.name)
      const matched = TODO_FILE_RE.exec(item.name)
      if (matched !== null && item.isFile()) {
        move(full, join(todoData(matched[1], ...seg), 'TODOS.md'))
        continue
      }
      if (!item.isDirectory()) continue
      for (const child of dirEntries(full)) {
        const childPath = join(full, child.name)
        if (child.isFile() && DATE_FILE_RE.test(child.name)) {
          move(childPath, join(todoData(item.name, ...seg), child.name))
        } else if (child.isFile()) {
          toLegacy(childPath)
        }
      }
    }
  }
  todoBase(join(memoryDir, 'todo'), 'global')
  for (const sid of dirNames(join(memoryDir, 'sessions'))) {
    todoBase(join(memoryDir, 'sessions', sid, 'todo'), 'session', sid)
  }
  for (const proj of dirNames(join(memoryDir, 'projects'))) {
    todoBase(join(memoryDir, 'projects', proj, 'todo'), 'project', proj)
  }

  // ---- 5. 归档（`archive/<id>` 记忆、`archive/todo-<id>` 待办） ----
  const archiveBase = (base, ...seg) => {
    for (const name of dirNames(base)) {
      if (NOT_GROUP_DIRS.has(name)) continue
      const full = join(base, name)
      if (name.startsWith('todo-')) move(full, todoArchive(name.slice(5), ...seg))
      else move(full, memArchive(name, ...seg))
    }
  }
  archiveBase(join(memoryDir, 'archive'), 'global')
  for (const sid of dirNames(join(memoryDir, 'sessions'))) {
    archiveBase(join(memoryDir, 'sessions', sid, 'archive'), 'session', sid)
  }
  for (const proj of dirNames(join(memoryDir, 'projects'))) {
    archiveBase(join(memoryDir, 'projects', proj, 'archive'), 'project', proj)
  }

  // ---- 6. 项目元数据 ----
  for (const proj of dirNames(join(memoryDir, 'projects'))) {
    move(
      join(memoryDir, 'projects', proj, 'PROVENANCE'),
      join(memoryDir, SYSTEM_DIR, 'projects', proj, 'PROVENANCE'),
    )
  }

  // ---- 7. 旧结构残留（未被上面认领的条目）搬 .system/legacy/ ----
  // 顶层条目分四类：已认领（migrated）/ 模块数据（moduleData，原地不动）/
  // VCS 元数据（preservedVcs，原地不动）/ 未知（legacy，搬走）。
  const moduleData = []
  const preservedVcs = []
  const legacyEntries = []
  for (const item of dirEntries(memoryDir)) {
    const name = item.name
    if (KNOWN_TOP.has(name)) continue
    if (isModuleData(name)) {
      moduleData.push(name)
      continue
    }
    if (isPreservedVcs(name)) {
      preservedVcs.push(name)
      continue
    }
    legacyEntries.push(name)
    toLegacy(join(memoryDir, name))
  }
  const leftovers = [
    join(memoryDir, 'global'),
    join(memoryDir, 'archive'),
    join(memoryDir, 'sessions'),
    join(memoryDir, 'projects'),
  ]
  for (const sid of dirNames(join(memoryDir, 'sessions'))) {
    leftovers.push(join(memoryDir, 'sessions', sid), join(memoryDir, 'sessions', sid, 'todo'), join(memoryDir, 'sessions', sid, 'archive'))
  }
  for (const proj of dirNames(join(memoryDir, 'projects'))) {
    leftovers.push(join(memoryDir, 'projects', proj), join(memoryDir, 'projects', proj, 'todo'), join(memoryDir, 'projects', proj, 'archive'))
  }
  // 旧容器里剩下的**一切**（文件 + 目录，例如 v2 项目级同步仓 `.git`）都搬 legacy：
  // 只搬文件会把 `projects/<pid>/.git` 留在原地，迁移后根下残留 `projects/`，
  // 旧同步仓的 git 历史也跟着失联。
  // 顺序必须**父级在前**（数组原序）：父级整目录 rename 一次带走全部残留，
  // 子级步骤随后因源已不存在自动跳过；反过来会撞「目标父目录已被子级建出」。
  for (const dir of leftovers) {
    for (const item of dirEntries(dir)) {
      const full = join(dir, item.name)
      if (item.isDirectory() && dirEntries(full).length === 0) continue
      toLegacy(full)
    }
  }
  // `todo/` 是新布局的根，不能整搬：只搬没被认领的散文件
  for (const item of dirEntries(join(memoryDir, 'todo'))) {
    if (item.isFile()) toLegacy(join(memoryDir, 'todo', item.name))
  }

  // ---- 8. 归档目录放 .keep（只给真正搬进去的归档目录建壳） ----
  const keepDirs = new Set()
  for (const step of steps) {
    if (step.kind !== 'move' || step.conflict === true) continue
    const target = step.entry === 'dir' ? step.to : dirname(step.to)
    const rel = relative(memoryDir, target).split(/[\\/]/)
    if (!rel.includes('archive')) continue
    keepDirs.add(target)
  }
  for (const dir of [...keepDirs].sort()) {
    const file = join(dir, '.keep')
    if (blockedAncestor(memoryDir, file) !== null) continue
    steps.push({ key: `keep:${relPath(memoryDir, dir)}`, kind: 'keep', file })
  }

  // ---- 9. 写版本标记 ----
  const versionFile = join(memoryDir, LAYOUT_FILE)
  steps.push({ key: 'write:layout-version', kind: 'write', file: versionFile, content: `${LAYOUT_VERSION}\n` })

  return { steps, conflicts, moduleData, preservedVcs, legacyEntries }
}

/** 统计步骤数量（按搬迁目标是否落在 `.system/legacy/` 归类）。 */
function countPlan(memoryDir, steps) {
  const counts = { directories: 0, files: 0, legacy: 0, keep: 0, mkdir: 0, total: steps.length }
  const legacyRoot = join(memoryDir, LEGACY_DIR)
  for (const step of steps) {
    if (step.kind === 'mkdir') counts.mkdir += 1
    else if (step.kind === 'keep') counts.keep += 1
    else if (step.kind === 'move') {
      if (step.entry === 'dir') counts.directories += 1
      else counts.files += 1
      if (step.to.startsWith(legacyRoot)) counts.legacy += 1
    }
  }
  return counts
}

/** 读布局版本（缺失/不可读返回 null）。 */
export function layoutVersionOf(memoryDir) {
  try {
    const value = Number(readFileSync(join(memoryDir, LAYOUT_FILE), 'utf8').trim())
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/**
 * 读记忆同步开关（`plugin-state.json` 的 `syncEnabled`）。
 *
 * 迁移期间 `lib/sync/*` 仍会写/拉记忆文件，与迁移互踩会造出半迁移数据；
 * 迁移器不改 sync 代码，只做**门禁**：开着就要求显式承担风险。
 * 迁移前后两个位置都看（迁移前在根，迁移后在 `.system/`）。
 * @param {string} memoryDir
 * @returns {{enabled: boolean, source: string|null}}
 */
export function syncGate(memoryDir) {
  const dir = normalizeMemoryDir(memoryDir)
  for (const file of [join(dir, SYSTEM_DIR, 'plugin-state.json'), join(dir, 'plugin-state.json')]) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (data !== null && typeof data === 'object' && data.syncEnabled === true) {
        return { enabled: true, source: file }
      }
    } catch { /* 不存在/坏 JSON：看下一个位置 */ }
  }
  return { enabled: false, source: null }
}

/** 读迁移状态（缺失/坏文件返回 null）。 */
export function readMigrationState(memoryDir) {
  try {
    const data = JSON.parse(readFileSync(join(memoryDir, STATE_FILE), 'utf8'))
    if (data === null || typeof data !== 'object') return null
    return { ...data, done: Array.isArray(data.done) ? data.done : [] }
  } catch {
    return null
  }
}

/** 写迁移状态（先临时文件再 rename，避免半截写）。 */
function writeState(memoryDir, state) {
  const file = join(memoryDir, STATE_FILE)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  try {
    renameSync(tmp, file)
  } catch {
    rmSync(file, { force: true })
    renameSync(tmp, file)
  }
}

/** 递归删除空目录（深先）；根目录本身为空也不删。 */
function pruneEmptyDirs(dir, keepRoot = true) {
  const items = dirEntries(dir)
  for (const item of items) {
    if (!item.isDirectory()) continue
    pruneEmptyDirs(join(dir, item.name), false)
  }
  if (keepRoot) return
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir)
  } catch {
    /* 占用中：留着 */
  }
}

/**
 * 执行单条步骤。
 * @returns {boolean} 是否真的改动了磁盘（已达成目标状态时返回 false，便于统计与幂等）。
 */
function runStep(step) {
  if (step.kind === 'mkdir') {
    if (entryType(step.dir) === 'dir') return false
    mkdirSync(step.dir, { recursive: true })
    return true
  }
  if (step.kind === 'keep') {
    if (existsSync(step.file)) return false
    mkdirSync(dirname(step.file), { recursive: true })
    writeFileSync(step.file, '')
    return true
  }
  if (step.kind === 'write') {
    try {
      if (readFileSync(step.file, 'utf8') === step.content) return false
    } catch { /* 文件缺失：下面重写 */ }
    mkdirSync(dirname(step.file), { recursive: true })
    writeFileSync(step.file, step.content)
    return true
  }
  if (step.kind === 'move') {
    if (!existsSync(step.from)) return false
    moveEntry(step.from, step.to)
    return true
  }
  throw new Error(`未知步骤类型：${step.kind}`)
}

/**
 * 执行迁移（`dryRun` 时只出计划）。
 * @param {string} memoryDir - 记忆根目录。
 * @param {{dryRun?: boolean, allowSync?: boolean, now?: Date}} [options]
 *   `allowSync: true` 才允许在同步开启时继续（CLI 的 `--allow-sync`）。
 * @returns {object} 迁移报告。
 */
export function migrateV3(inputDir, options = {}) {
  const dryRun = options.dryRun === true
  const memoryDir = realDir(normalizeMemoryDir(inputDir))
  const sync = syncGate(memoryDir)
  const report = {
    ok: true,
    dryRun,
    memoryDir,
    sync,
    layoutVersion: layoutVersionOf(memoryDir),
    alreadyMigrated: false,
    backup: null,
    backupRecreated: false,
    planned: null,
    pending: 0,
    executed: 0,
    skipped: 0,
    conflicts: [],
    errors: [],
    rootExtras: [],
    moduleData: [],
    legacyEntries: [],
    preservedVcs: [],
    skippedSymlinks: [],
    notes: [],
    steps: [],
  }
  if (isFileSystemRoot(memoryDir)) {
    report.ok = false
    report.errors.push(`记忆根不能是文件系统根（备份无处安放，且会自递归）：${memoryDir}`)
    return report
  }
  if (report.layoutVersion !== null && report.layoutVersion >= LAYOUT_VERSION) {
    report.alreadyMigrated = true
    return report
  }

  const plan = planMigration(memoryDir)
  const state = readMigrationState(memoryDir)
  const done = new Set(state === null ? [] : state.done)
  const pending = plan.steps.filter((step) => !done.has(step.key))

  report.planned = countPlan(memoryDir, plan.steps)
  report.planned.moduleData = plan.moduleData.length
  report.planned.legacyEntries = plan.legacyEntries.length
  report.planned.preservedVcs = plan.preservedVcs.length
  report.pending = pending.length
  report.conflicts = plan.conflicts
  report.moduleData = plan.moduleData
  report.legacyEntries = plan.legacyEntries
  report.preservedVcs = plan.preservedVcs
  report.steps = pending.map((step) => ({
    key: step.key,
    kind: step.kind,
    from: step.from === undefined ? null : relPath(memoryDir, step.from),
    to: step.to === undefined ? null : relPath(memoryDir, step.to),
    dir: step.dir === undefined ? null : relPath(memoryDir, step.dir),
    file: step.file === undefined ? null : relPath(memoryDir, step.file),
    conflict: step.conflict === true,
  }))
  report.skipped = plan.steps.length - pending.length
  if (dryRun) return report

  // ---- 门禁：记忆同步开着时拒绝写盘（同步与迁移互踩会造半迁移数据） ----
  if (sync.enabled && options.allowSync !== true) {
    report.ok = false
    report.syncBlocked = true
    report.errors.push(
      `检测到记忆同步已开启（${sync.source}）：迁移期间同步可能与本操作互相覆盖；`
      + '请先关闭同步，或加 --allow-sync 明确承担风险',
    )
    return report
  }

  // ---- 备份（整目录冷拷贝；续跑复用已记录的备份） ----
  let backup = state !== null && typeof state.backup === 'string' ? state.backup : null
  // 复用前双重校验：必须是目录，且带完整性标记（被外部删一半的备份不能用）
  if (backup !== null && !backupUsable(backup)) {
    report.backupRecreated = true
    report.notes.push(`原备份不可用（${backup}），已重新备份`)
    backup = null
  }
  if (backup === null) {
    backup = `${memoryDir}..bak-${stamp()}`
    // 硬校验：备份必须落在记忆根同级的兄弟路径，绝不许在根内部（否则自我递归复制）
    if (isInside(memoryDir, backup)) {
      report.ok = false
      report.errors.push(`备份目录会落在记忆根内部，拒绝执行：${backup}`)
      return report
    }
    try {
      copyTree(memoryDir, backup, report.skippedSymlinks)
    } catch (error) {
      rmSync(backup, { recursive: true, force: true })
      report.ok = false
      report.errors.push(`备份失败，迁移中止（磁盘未改动）：${error.message}`)
      return report
    }
    // 完整性校验：拷贝"成功"不等于备份真的落盘（源被整体跳过时 copyTree 会静默什么都不做）
    const sourceEmpty = dirEntries(memoryDir).length === 0
    const copyOk = entryType(backup) === 'dir'
      && (sourceEmpty || dirEntries(backup).length > 0)
    if (!copyOk) {
      rmSync(backup, { recursive: true, force: true })
      report.ok = false
      report.errors.push('备份没有真正生成（目录缺失或为空），迁移中止（磁盘未改动）')
      return report
    }
    try {
      writeFileSync(join(backup, BACKUP_MARKER), `${new Date().toISOString()}\n`)
    } catch (error) {
      report.ok = false
      report.errors.push(`写备份完整性标记失败，迁移中止（磁盘未改动）：${error.message}`)
      return report
    }
  }
  report.backup = backup

  const nextState = {
    version: LAYOUT_VERSION,
    memoryDir,
    backup,
    startedAt: state !== null && typeof state.startedAt === 'string' ? state.startedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    done: [...done],
    conflicts: plan.conflicts,
  }
  try {
    writeState(memoryDir, nextState)
  } catch (error) {
    report.ok = false
    report.errors.push(`写状态文件失败：${error.message}`)
    return report
  }

  // ---- 逐条执行（每条完成后落盘状态，供断点续跑） ----
  // 标记完成 = 记进 state 并落盘（每条一步，崩溃后重跑从剩余步骤继续）。
  const record = (key) => {
    if (done.has(key)) return
    done.add(key)
    nextState.done.push(key)
    nextState.updatedAt = new Date().toISOString()
    try {
      writeState(memoryDir, nextState)
    } catch (error) {
      report.errors.push(`写状态文件失败（搬迁已生效）：${error.message}`)
    }
  }
  for (const step of plan.steps) {
    // 版本标记不做 done 短路：内容不一致（被外部删掉/改坏）就地自愈
    if (done.has(step.key) && step.kind !== 'write') continue
    if (step.conflict === true) {
      record(step.key)
      continue
    }
    try {
      if (runStep(step)) report.executed += 1
    } catch (error) {
      report.ok = false
      report.errors.push(`步骤失败 ${step.key}：${error.message}`)
      continue
    }
    record(step.key)
  }

  if (report.ok) {
    for (const name of ['global', 'archive', 'sessions', 'projects']) {
      pruneEmptyDirs(join(memoryDir, name), false)
    }
    // 新 `todo/` 根只清空一层（旧日志型分组目录搬空后留下的空壳），不深入新结构
    for (const item of dirEntries(join(memoryDir, TODO_ROOT))) {
      if (!item.isDirectory()) continue
      const dir = join(memoryDir, TODO_ROOT, item.name)
      try {
        if (readdirSync(dir).length === 0) rmdirSync(dir)
      } catch { /* 占用中：留着 */ }
    }
  }
  report.layoutVersion = layoutVersionOf(memoryDir)
  for (const item of dirEntries(memoryDir)) {
    if (ALLOWED_ROOT.has(item.name) || isModuleData(item.name) || isPreservedVcs(item.name)) continue
    report.rootExtras.push(item.name)
  }
  return report
}

/**
 * 判断目录是不是本迁移器产出的备份：只认名字
 * `<记忆根>..bak-<yyyyMMdd-HHmmss>`。
 *
 * 不再接受"含 `.system/migrate-v3.state`"——那等于任意一个已迁移的记忆根，
 * `--rollback` 指错就会把活数据整根换掉。
 */
function looksLikeBackup(dir) {
  return /\.\.bak-\d{8}-\d{6}$/.test(dir.replace(/[\\/]+$/, ''))
}

/**
 * child 是否在 parent 内部（含相等）。
 *
 * 注意 `relative('C:\\', 'C:\\..bak-x')` = `'..bak-x'`——以 `..` 开头但其实是
 * **同级文件名**；只看 startsWith('..') 会把备份判成"在根内"的反面（放行），
 * 于是 `copyTree('C:\\','C:\\..bak')` 自我递归。必须只把 `..` 与 `..<sep>…`
 * 当作"在外"。
 */
function isInside(parent, child) {
  const rel = relative(parent, child)
  if (rel === '' || isAbsolute(rel)) return rel === ''
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** 备份完整性标记（写完整个冷拷贝才落盘）。 */
export const BACKUP_MARKER = '.backup-complete'

/** 备份是否可复用：是目录且带完整性标记。 */
function backupUsable(backup) {
  return entryType(backup) === 'dir' && existsSync(join(backup, BACKUP_MARKER))
}

/**
 * 解析真实目录（记忆根本身可能是符号链接 / junction，如把 `~/.dsh/memories`
 * `mklink /J` 到别的盘）。解析失败（路径不存在）回落原值。
 *
 * 必须做：不解析就让 `copyTree` 走进「源是链接 → 跳过」分支，备份被整棵跳过，
 * 而迁移照常改盘——用户拿到一个不存在的备份路径还以为有后路。
 * @param {string} dir
 * @returns {string}
 */
function realDir(dir) {
  try {
    const resolved = realpathSync(dir)
    return resolved.startsWith('\\\\?\\') ? resolved.slice(4) : resolved
  } catch {
    return dir
  }
}

/** 记忆根是否是文件系统根（盘符根 / `/`）——备份无处可放，直接拒绝。 */
function isFileSystemRoot(dir) {
  return dirname(dir) === dir
}

/**
 * 从备份整体还原记忆根。
 *
 * 安全策略：当前目录**不删**，改名成 `<memoryDir>..pre-rollback-<时间戳>` 留在同级
 * （留后路），再把备份整目录拷回原位（备份本身保留，可反复回滚）。
 * @param {string} memoryDir - 记忆根目录。
 * @param {string} backupDir - 备份目录（`<memoryDir>..bak-<时间戳>`）。
 * @param {{dryRun?: boolean}} [options]
 * @returns {object} 回滚报告。
 */
export function rollbackV3(inputDir, backupDir, options = {}) {
  const dryRun = options.dryRun === true
  const memoryDir = realDir(normalizeMemoryDir(inputDir))
  const backup = typeof backupDir === 'string' && backupDir !== ''
    ? realDir(resolve(backupDir))
    : backupDir
  const report = {
    ok: true, dryRun, memoryDir, backup: backup,
    movedTo: null, restored: 0, errors: [], skippedSymlinks: [],
  }
  if (isFileSystemRoot(memoryDir)) {
    report.ok = false
    report.errors.push(`记忆根不能是文件系统根：${memoryDir}`)
    return report
  }
  if (typeof backup !== 'string' || backup === '') {
    report.ok = false
    report.errors.push('未指定备份目录')
    return report
  }
  if (entryType(backup) !== 'dir') {
    report.ok = false
    report.errors.push(`备份目录不存在：${backup}`)
    return report
  }
  if (isInside(memoryDir, backup)) {
    report.ok = false
    report.errors.push(`备份目录不能在记忆根内部：${backup}`)
    return report
  }
  if (!looksLikeBackup(backup)) {
    report.ok = false
    report.errors.push(`目标不像本迁移器产出的备份（名字须为 <记忆根>..bak-<yyyyMMdd-HHmmss>）：${backup}`)
    return report
  }
  const movedTo = `${memoryDir}..pre-rollback-${stamp()}`
  if (isInside(memoryDir, movedTo)) {
    report.ok = false
    report.errors.push(`回滚暂存目录会落在记忆根内部，拒绝执行：${movedTo}`)
    return report
  }
  report.movedTo = movedTo
  if (dryRun) return report
  try {
    if (existsSync(memoryDir)) moveEntry(memoryDir, movedTo)
    copyTree(backup, memoryDir, report.skippedSymlinks)
    // 备份标记属于备份目录，不该跟着还原进记忆根
    rmSync(join(memoryDir, BACKUP_MARKER), { force: true })
    report.restored = 1
  } catch (error) {
    report.ok = false
    report.errors.push(`回滚失败：${error.message}`)
  }
  return report
}
