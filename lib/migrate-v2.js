/**
 * dsh-memory-evolve — 存储格式 v1 → v2 迁移（2026-10-15）。
 *
 * ## v1 与 v2
 * - **v1**：一个分组 = 一个 `.md` 文件，条目用 `\n§\n` 分隔；日期是文本前缀，
 *   摘要是可选的 `[summary:…]` 标签，没有任何结构化字段。
 * - **v2**：一条记忆 = 一个 md 文件，文件名为标题，YAML frontmatter 承载
 *   id / 标题 / 摘要 / 关键词 / 使用场景 / 创建与修改时间 / 分组与类 / 归档时间；
 *   分组按「类」分目录（全局 `global/<组id>/`、项目 `<projdir>/<组id>/`、
 *   会话 `sessions/<会话id>/<组id>/`），日志型再套一层日期目录。
 *
 * ## 安全设计（用户拍板 2026-10-15：后台自动迁 + 备份 + 可回滚）
 * 1. **先全部解析进内存**：任何一个旧文件读不动，就整体中止，磁盘一个字不动。
 * 2. **先备份再搬**：旧文件复制进 `<memoryDir>/backup-v1-<时间戳>/`
 *    （记忆文件保持原相对路径），复制成功后才写新位置。
 * 3. **可重入**：目标位置已有同 `id` 的条目就跳过（不会写出重复记忆）；
 *    只有全部完成才写版本标记 `<记忆根>/.system/.vault-version`
 *    （读取兼容旧根位置 `<记忆根>/.vault-version`，只读不写）。
 * 4. **可回滚**：`rollbackVault()` 把备份目录里的文件搬回原位，并删掉版本标记
 *    （新位置的文件不动——宁可留孤儿，也不静默销毁内容）。
 *
 * 待办**不拆条目**（仍是"一组一个文件"），只按新的类目录规则搬位置。
 *
 * @module dsh-memory-evolve/migrate-v2
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'

import { findGroup, groupArchiveDirOf, groupDirOf, loadGroups, normalizeKlass, systemDirOf, todoFileOf } from './groups.js'
import { objectOf, parseEntries } from './store.js'
import { readVaultDeep, writeVaultEntry } from './vault.js'

/** 本地日期（日志型的日期目录名兜底）。 */
function todayDir() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 版本标记文件名（内容 = 格式版本号）。 */
export const VAULT_MARKER_FILE = '.vault-version'

/** 当前存储格式版本。 */
export const VAULT_FORMAT_VERSION = 2

/**
 * 版本标记的**写入**位置：`<memoryDir>/.system/.vault-version`（规范 §1：
 * 记忆根顶层只允许 `.layout-version`/`.system/`/`memory/`/`todo/`）。
 * @param {string} memoryDir - 记忆根。
 * @returns {string} 标记文件路径。
 */
export function vaultMarkerPathOf(memoryDir) {
  return join(systemDirOf(memoryDir), VAULT_MARKER_FILE)
}

/**
 * 旧位置的标记（记忆根顶层）：**只读兼容**——v3 迁移前的老安装把标记放在
 * 这里，读到它就视为已迁移，绝不在这里再写。
 * @param {string} memoryDir - 记忆根。
 * @returns {string} 旧标记文件路径。
 */
export function legacyVaultMarkerPathOf(memoryDir) {
  return join(memoryDir, VAULT_MARKER_FILE)
}

/** 读标记文件的内容（`Number`）；文件缺失/坏内容返回 null。 */
function readMarkerValue(file) {
  try {
    const value = Number(readFileSync(file, 'utf8').trim())
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

/** 写版本标记（只写 `.system/`；顺手清掉旧位置的根下标记）。 */
function writeVaultMarker(memoryDir) {
  const file = vaultMarkerPathOf(memoryDir)
  mkdirSync(systemDirOf(memoryDir), { recursive: true })
  writeFileSync(file, `${VAULT_FORMAT_VERSION}\n`)
  // 旧位置残留（迁移后被打回过根下的脏文件）：删掉，避免两份标记并存。
  try {
    rmSync(legacyVaultMarkerPathOf(memoryDir), { force: true })
  } catch { /* 删不掉就留着：读取以 .system/ 优先，不会误判 */ }
}

/** 删版本标记（新旧位置都删）。 */
function removeVaultMarker(memoryDir) {
  try {
    rmSync(vaultMarkerPathOf(memoryDir), { force: true })
  } catch { /* 删不掉不影响回滚结果（下次启动读到它仍视为已迁移） */ }
  try {
    rmSync(legacyVaultMarkerPathOf(memoryDir), { force: true })
  } catch { /* 旧位置删不掉不影响回滚结果 */ }
}

/** 读磁盘上的存储格式版本（没有标记 = v1；`.system/` 优先，兼容根下旧位置）。 */
export function vaultVersionOf(memoryDir) {
  return readMarkerValue(vaultMarkerPathOf(memoryDir))
    ?? readMarkerValue(legacyVaultMarkerPathOf(memoryDir))
    ?? 1
}

/** 是否需要迁移（v1 且磁盘上确实有旧格式内容）。 */
export function needsMigration(memoryDir) {
  if (vaultVersionOf(memoryDir) >= VAULT_FORMAT_VERSION) return false
  return collectLegacyFiles(memoryDir).length > 0
}

/** 列出所有的备份目录（时间戳倒序）。 */
export function listBackups(memoryDir) {
  try {
    return readdirSync(memoryDir)
      .filter((name) => /^backup-v1-\d{8}-\d{6}$/.test(name))
      .sort()
      .reverse()
      .map((name) => join(memoryDir, name))
  } catch {
    return []
  }
}

/** 迁移时的时间戳目录名（本地时间，精确到秒）。 */
function backupStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `backup-v1-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 安全读文件（读不动返回 null）。 */
function readFileOrNull(file) {
  try {
    if (!statSync(file).isFile()) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 列目录（不存在返回空数组）。 */
function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 扫描磁盘上的全部 v1 文件，生成迁移任务。
 *
 * 任务分两类：
 *   - `memory`：需要拆成一条一 md 的旧记忆文件；
 *   - `todo`：只需按新类目录规则搬位置的待办文件（不拆条目）。
 * @param {string} memoryDir - 记忆根目录。
 * @returns {object[]} 任务列表。
 */
export function collectLegacyFiles(memoryDir) {
  const jobs = []
  const push = (job) => {
    if (existsSync(job.src)) jobs.push(job)
  }
  const projectsDir = join(memoryDir, 'projects')

  // ---- 全局类（记忆） ----
  push({ kind: 'memory', target: 'memory', src: join(memoryDir, 'MEMORY.md') })
  push({ kind: 'memory', target: 'user', src: join(memoryDir, 'USER.md') })
  push({ kind: 'memory', target: 'kb', src: join(memoryDir, 'KB.md') })
  push({ kind: 'memory', target: 'memory', archive: true, src: join(memoryDir, 'MEMORY-archive.md') })
  push({ kind: 'memory', target: 'user', archive: true, src: join(memoryDir, 'USER-archive.md') })

  // ---- 今日日志（一天一个文件 → 一天一个目录） ----
  for (const item of listDir(join(memoryDir, 'daily'))) {
    if (!item.isFile()) continue
    const match = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(item.name)
    if (match === null) continue
    push({
      kind: 'memory', target: 'daily', date: match[1],
      src: join(memoryDir, 'daily', item.name),
    })
  }

  // ---- 自建记忆分组（<memoryDir>/groups/<id>.md） ----
  const groups = loadGroups(memoryDir)
  for (const item of listDir(join(memoryDir, 'groups'))) {
    if (!item.isFile() || !item.name.endsWith('.md')) continue
    const id = item.name.slice(0, -3)
    const group = findGroup(groups, 'memory', id)
    if (group === null) continue
    // 自建分组只可能是全局类或项目类（会话类在旧格式下不存在）
    if (group.klass === 'project') continue
    push({ kind: 'memory', target: id, src: join(memoryDir, 'groups', item.name) })
  }

  // ---- 项目类（projects/<hash>/…） ----
  for (const item of listDir(projectsDir)) {
    if (!item.isDirectory()) continue
    const projectDir = join(projectsDir, item.name)
    push({ kind: 'memory', target: 'project', projectDir, src: join(projectDir, 'MEMORY.md') })
    push({ kind: 'memory', target: 'key', projectDir, src: join(projectDir, 'KEY.md') })
    push({ kind: 'memory', target: 'key', archive: true, projectDir, src: join(projectDir, 'KEY-archive.md') })
    // 项目级自建记忆分组（<projectDir>/<id>.md）
    for (const file of listDir(projectDir)) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue
      const id = file.name.slice(0, -3)
      if (['MEMORY', 'KEY', 'MEMORY-archive', 'KEY-archive', 'TODOS'].includes(id)) continue
      const group = findGroup(groups, 'memory', id)
      if (group === null || group.klass !== 'project') continue
      push({ kind: 'memory', target: id, projectDir, src: join(projectDir, file.name) })
    }
    // 项目待办（不拆，只搬）
    push({ kind: 'todo', target: 'project', projectDir, src: join(projectDir, 'TODOS.md') })
  }

  // ---- 待办（不拆条目，只搬位置） ----
  push({ kind: 'todo', target: 'life', src: join(memoryDir, 'TODOS-life.md') })
  push({ kind: 'todo', target: 'work', src: join(memoryDir, 'TODOS-work.md') })
  for (const item of listDir(join(memoryDir, 'daily'))) {
    if (!item.isFile()) continue
    const match = /^(\d{4}-\d{2}-\d{2})\.todo\.md$/.exec(item.name)
    if (match === null) continue
    push({ kind: 'todo', target: 'daily', date: match[1], src: join(memoryDir, 'daily', item.name) })
  }
  for (const item of listDir(join(memoryDir, 'todos'))) {
    if (!item.isFile() || !item.name.endsWith('.md')) continue
    const id = item.name.slice(0, -3)
    const group = findGroup(groups, 'todo', id)
    if (group === null) continue
    push({ kind: 'todo', target: id, src: join(memoryDir, 'todos', item.name) })
  }

  return jobs
}

/** 一个任务的上下文（分组实体 + 目录）。 */
function contextOf(memoryDir, job, groups) {
  const group = findGroup(groups, 'memory', job.target)
  if (group === null) return null
  const ctx = { memoryDir, projectDir: job.projectDir ?? null, sessionId: null }
  const dir = job.archive === true ? groupArchiveDirOf(group, ctx) : groupDirOf(group, ctx)
  if (dir === null) return null
  return { group, dir }
}

/**
 * 标记位置归一（只动标记文件，不动数据）：旧位置有、`.system/` 没有 → 搬进
 * `.system/`；两边都有 → 删掉旧位置那份。已迁移的目录下次启动就会自愈。
 * @param {string} memoryDir - 记忆根。
 * @returns {boolean} 是否发生了改动。
 */
export function normalizeVaultMarkerLocation(memoryDir) {
  const legacy = legacyVaultMarkerPathOf(memoryDir)
  if (!existsSync(legacy)) return false
  try {
    if (existsSync(vaultMarkerPathOf(memoryDir))) {
      rmSync(legacy, { force: true })
    } else {
      writeVaultMarker(memoryDir)
    }
    return true
  } catch {
    return false
  }
}

/**
 * 执行迁移。
 * @param {string} memoryDir - 记忆根目录。
 * @param {{dryRun?: boolean, today?: string}} [options]
 * @returns {{ok: boolean, version: number, files: number, entries: number, todos: number,
 *   backup: string|null, skipped: number, errors: string[], dryRun: boolean}}
 */
export function migrateToVault(memoryDir, options = {}) {
  const dryRun = options.dryRun === true
  const report = {
    ok: true, version: vaultVersionOf(memoryDir), files: 0, entries: 0, todos: 0,
    backup: null, skipped: 0, errors: [], dryRun,
  }
  if (report.version >= VAULT_FORMAT_VERSION) {
    // 已迁移：顺手把「被打回根下」的旧标记归一进 `.system/`（规范 §1）。
    if (!dryRun) normalizeVaultMarkerLocation(memoryDir)
    report.skipped = 1
    return report
  }
  const jobs = collectLegacyFiles(memoryDir)
  if (jobs.length === 0) {
    // 没有旧内容：直接标成新版本，免得每次启动都扫描
    if (!dryRun) {
      try {
        writeVaultMarker(memoryDir)
      } catch (error) {
        report.ok = false
        report.errors.push(`写版本标记失败：${error.message}`)
      }
    }
    return report
  }

  const groups = loadGroups(memoryDir)

  // ---- 阶段 1：全部解析进内存（失败则整体中止，磁盘一字不动） ----
  const memoryPlans = []
  const todoPlans = []
  for (const job of jobs) {
    if (job.kind === 'todo') {
      todoPlans.push(job)
      continue
    }
    const ctx = contextOf(memoryDir, job, groups)
    if (ctx === null) {
      report.errors.push(`无法定位 ${relative(memoryDir, job.src)}（分组 ${job.target} 不存在或缺项目目录）`)
      report.ok = false
      continue
    }
    const text = readFileOrNull(job.src)
    if (text === null) {
      report.errors.push(`读不到 ${relative(memoryDir, job.src)}`)
      report.ok = false
      continue
    }
    const entries = parseEntries(text)
    const loc = { dir: ctx.dir, group: ctx.group }
    const byId = new Map()
    const objs = []
    entries.forEach((raw, index) => {
      // 今日日志的日期来自文件名，条目文本里只有 [HH:MM]
      const hints = job.date !== undefined ? { today: job.date } : {}
      const obj = objectOf(raw, job.target, loc, byId, index + 1, hints)
      if (job.archive === true) obj.archivedAt = obj.updated || obj.created
      objs.push(obj)
    })
    memoryPlans.push({ job, dir: ctx.dir, group: ctx.group, objs })
  }
  if (!report.ok) return report

  report.files = jobs.length
  report.entries = memoryPlans.reduce((sum, plan) => sum + plan.objs.length, 0)
  report.todos = todoPlans.length
  if (dryRun) return report

  // ---- 阶段 2：备份（复制旧文件，保持相对路径） ----
  const backupDir = join(memoryDir, backupStamp())
  try {
    mkdirSync(backupDir, { recursive: true })
    for (const job of jobs) {
      const rel = relative(memoryDir, job.src)
      const target = join(backupDir, rel)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(job.src, target)
    }
    report.backup = backupDir
  } catch (error) {
    report.ok = false
    report.errors.push(`备份失败，迁移中止：${error.message}`)
    return report
  }

  // ---- 阶段 3：写新位置 ----
  const written = new Set()
  for (const plan of memoryPlans) {
    const existing = new Set(readVaultDeep(plan.dir).map((entry) => entry.id))
    for (const obj of plan.objs) {
      // 日志型多一层日期目录（与运行期 persist() 的规则一致）
      const dir = plan.group.daily === true
        ? join(plan.dir, String(obj.created ?? '').slice(0, 10) || todayDir())
        : plan.dir
      const key = `${dir}|${obj.id}`
      if (existing.has(obj.id) || written.has(key)) {
        report.skipped += 1
        continue
      }
      try {
        writeVaultEntry(dir, obj)
        written.add(key)
      } catch (error) {
        report.errors.push(`写入失败 ${dir}：${error.message}`)
        report.ok = false
      }
    }
  }
  for (const job of todoPlans) {
    const group = findGroup(groups, 'todo', job.target)
    if (group === null) continue
    const dest = todoFileOf(group, {
      memoryDir,
      projectDir: job.projectDir ?? null,
      sessionId: null,
      date: job.date,
    })
    if (dest === null) {
      report.errors.push(`无法定位待办 ${relative(memoryDir, job.src)}`)
      report.ok = false
      continue
    }
    try {
      if (existsSync(dest)) {
        report.skipped += 1
        continue
      }
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(job.src, dest)
    } catch (error) {
      report.errors.push(`待办搬迁失败 ${relative(memoryDir, job.src)}：${error.message}`)
      report.ok = false
    }
  }

  // ---- 阶段 4：删掉旧文件（数据已在备份里） + 写版本标记 ----
  if (report.ok) {
    for (const job of jobs) {
      try {
        rmSync(job.src, { force: true })
      } catch {
        // 删不掉不影响正确性：下次启动会因为版本标记已写而不再迁
      }
    }
    // 清理被搬空的旧目录（只删**空**目录；有任何残留就原样留着）
    for (const stale of ['daily', 'groups', 'todos']) {
      const dir = join(memoryDir, stale)
      try {
        if (existsSync(dir) && listDir(dir).length === 0) rmSync(dir, { recursive: false, force: true })
      } catch {
        // 非空或占用中：留着
      }
    }
    try {
      writeVaultMarker(memoryDir)
    } catch (error) {
      report.errors.push(`写版本标记失败：${error.message}`)
    }
  }
  return report
}

/**
 * 从备份回滚：把备份目录里的文件搬回原位。
 *
 * 新位置的文件**不动**（宁可留孤儿也不静默销毁），版本标记被删掉，于是
 * 下一次启动会重新触发迁移（这次以备份恢复出来的旧文件为准）。
 * @param {string} memoryDir - 记忆根目录。
 * @param {string} backupDir - `listBackups()` 给出的备份目录。
 * @returns {{ok: boolean, restored: number, errors: string[]}}
 */
export function rollbackVault(memoryDir, backupDir) {
  const report = { ok: true, restored: 0, errors: [] }
  if (!existsSync(backupDir)) {
    report.ok = false
    report.errors.push(`备份目录不存在：${backupDir}`)
    return report
  }
  const walk = (dir) => {
    for (const item of listDir(dir)) {
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        walk(full)
        continue
      }
      const rel = relative(backupDir, full)
      const dest = join(memoryDir, rel)
      try {
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(full, dest)
        report.restored += 1
      } catch (error) {
        report.errors.push(`恢复失败 ${rel}：${error.message}`)
        report.ok = false
      }
    }
  }
  walk(backupDir)
  try {
    removeVaultMarker(memoryDir)
  } catch {
    // 标记删不掉时下一次迁移会被"目标已存在同 id"挡住，不会写重复内容
  }
  return report
}

/** 迁移状态快照（配置页「数据」页展示用）。 */
export function vaultStatus(memoryDir) {
  const version = vaultVersionOf(memoryDir)
  const legacy = collectLegacyFiles(memoryDir)
  return {
    version,
    needsMigration: version < VAULT_FORMAT_VERSION && legacy.length > 0,
    legacyFiles: legacy.length,
    backups: listBackups(memoryDir),
  }
}
