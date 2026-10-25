/**
 * lib/sync/filesets.js — 同步文件集定义（v3 布局，2026-10-19 重写）。
 *
 * 同步按「文件集」（fileset）区分范围：
 *   项目轨   `project:<项目id>`（v3）；`project` 是 v2 旧名（只读兼容）
 *   全局轨   memory-global / user-global / daily-global / todo-global
 *
 * v3 磁盘布局（规范 docs/layout-v3.md）：
 * ```
 * <记忆根>/memory/<组id>/global/…                    全局类记忆
 * <记忆根>/memory/<组id>/project/<项目id>/…           项目类记忆
 * <记忆根>/memory/<组id>/archive/<类段>/…             归档
 * <记忆根>/todo/<组id>/<类段>/TODOS.md | <日期>.md    待办
 * <记忆根>/.system/projects/<项目id>/PROVENANCE       项目元数据
 * <记忆根>/.system/sync/{PROVENANCE,ignore,attributes} 共享仓库元数据
 * ```
 * 仓库工作树 = 记忆根，一个仓库多分支；每条分支的树只含本 fileset 的文件。
 * 本模块是**权威白名单**（`stagePaths` 走 `git add -f`，`.gitignore` 只是观感）。
 *
 * 兼容：`'project'`（无项目 id）继续按 v2 路径匹配（KEY.md / key/ / project/ …），
 * 全局轨同时接受 v2 的 `global/<track>/` 与 v3 的 `memory/<组id>/global/`，
 * 便于旧仓库读取与迁移过渡。
 *
 * 纯函数零依赖（merge.js 等不引入仓库逻辑的地方可安全 import）。
 */

/** v3 项目 fileset 前缀。 */
export const PROJECT_FILESET_PREFIX = 'project:'

/** 共享仓库元数据路径（相对记忆根，都在 `.system/sync/` 下）。 */
export const SYNC_DIR = '.system/sync'
export const GLOBAL_PROVENANCE_PATH = `${SYNC_DIR}/PROVENANCE`
export const SYNC_IGNORE_PATH = `${SYNC_DIR}/ignore`
export const SYNC_ATTRIBUTES_PATH = `${SYNC_DIR}/attributes`

/** 组 id 形状（与 lib/groups.js 的 GROUP_ID_RE 同源）。 */
const GID = '[a-z0-9][a-z0-9_-]{0,31}'

/** 待办文件名：TODOS.md 或日志型 `<日期>.md`。 */
const TODO_NAME = '(?:TODOS\\.md|\\d{4}-\\d{2}-\\d{2}\\.md)'

/** 全局轨 groups 归属：`exclude`/`include` 按组 id 过滤（自定义全局组自动跟随）。 */
export const GLOBAL_TRACK_GROUPS = {
  'memory-global': { kind: 'memory', exclude: ['user', 'daily'] },
  'user-global': { kind: 'memory', include: ['user'] },
  'daily-global': { kind: 'memory', include: ['daily'] },
  'todo-global': { kind: 'todo' },
}

/** 全部全局 fileset 列表（迭代用）。 */
export const GLOBAL_FILESET_KEYS = Object.keys(GLOBAL_TRACK_GROUPS)

/** 项目元数据（PROVENANCE）在仓库里的相对路径。 */
export function projectProvenancePathOf(projectId) {
  return `.system/projects/${projectId}/PROVENANCE`
}

/** 组装项目 fileset 名。 */
export function projectFilesetOf(projectId) {
  const id = typeof projectId === 'string' ? projectId.trim() : ''
  if (id === '') throw new Error('dsh-memory-evolve: 项目 fileset 需要项目 id（project:<id>）')
  return `${PROJECT_FILESET_PREFIX}${id}`
}

/**
 * 解析 fileset 名。
 * @param {string} [fileset] - 'project'（v2 旧名）/ 'project:<id>' / 四个全局轨名。
 * @returns {{kind: 'project', projectId: string} | {kind: 'global', track: string} | {kind: 'legacy-project'}}
 */
export function parseFileset(fileset = 'project') {
  if (fileset === 'project') return { kind: 'legacy-project' }
  if (typeof fileset === 'string' && fileset.startsWith(PROJECT_FILESET_PREFIX)) {
    const projectId = fileset.slice(PROJECT_FILESET_PREFIX.length).trim()
    if (projectId === '') throw new Error(`dsh-memory-evolve: 项目 fileset 缺少项目 id（"${fileset}"）`)
    return { kind: 'project', projectId }
  }
  if (typeof fileset === 'string' && Object.hasOwn(GLOBAL_TRACK_GROUPS, fileset)) {
    return { kind: 'global', track: fileset }
  }
  throw new Error(`dsh-memory-evolve: 未知同步文件集 "${fileset}"`)
}

/** 转义正则元字符（项目 id 可能含 `.`）。 */
function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 组 id 是否属于某全局轨。
 * `kind` 必须匹配轨道所属大类（memory / todo）——记忆组与待办组的 id 可以同名
 * （`global` 是待办的内置组），不判 kind 会把 todo 文件算进记忆轨。
 */
function groupInTrack(gid, track, kind) {
  const rule = GLOBAL_TRACK_GROUPS[track]
  if (rule === undefined || rule.kind !== kind) return false
  if (Array.isArray(rule.include)) return rule.include.includes(gid)
  if (Array.isArray(rule.exclude)) return !rule.exclude.includes(gid)
  return true
}

/* ---------------- v3 路径正则（懒构造 + 缓存） ---------------- */

const reCache = new Map()
function cached(key, make) {
  let re = reCache.get(key)
  if (re === undefined) {
    re = make()
    reCache.set(key, re)
  }
  return re
}

/** 项目类：`memory/<组id>/{project,archive/project}/<项目id>/…`。 */
function projectMemoryRe(projectId) {
  return cached(`pm:${projectId}`, () => new RegExp(`^memory/(${GID})/(?:project|archive/project)/${escapeRe(projectId)}/.+\\.md$`))
}
/** 项目类待办：`todo/<组id>/{project,archive/project}/<项目id>/{TODOS.md,<日期>.md}`。 */
function projectTodoRe(projectId) {
  return cached(`pt:${projectId}`, () => new RegExp(`^todo/(${GID})/(?:project|archive/project)/${escapeRe(projectId)}/${TODO_NAME}$`))
}
/** 项目类 `.keep`（归档目录占位）。 */
function projectKeepRe(projectId) {
  return cached(`pk:${projectId}`, () => new RegExp(`^(?:memory|todo)/(${GID})/(?:project|archive/project)/${escapeRe(projectId)}/\\.keep$`))
}
/** 全局类记忆：`memory/<组id>/{global,archive/global}/…`。 */
const GLOBAL_MEMORY_RE = cached('gm', () => new RegExp(`^memory/(${GID})/(?:global|archive/global)/.+\\.md$`))
/** 全局类待办：`todo/<组id>/{global,archive/global}/{TODOS.md,<日期>.md}`。 */
const GLOBAL_TODO_RE = cached('gt', () => new RegExp(`^todo/(${GID})/(?:global|archive/global)/${TODO_NAME}$`))
/** 全局类 `.keep`。 */
const GLOBAL_KEEP_RE = cached('gk', () => new RegExp(`^(?:memory|todo)/(${GID})/(?:global|archive/global)/\\.keep$`))

/* ---------------- v2 兼容路径（旧仓库 / 旧名 fileset） ---------------- */

/** v2 项目级白名单（2026-10-15 形态）：精确文件名 + 目录前缀。 */
export const LEGACY_PROJECT_SPEC = {
  memory: ['KEY.md', 'KEY-archive.md', 'MEMORY.md'],
  todo: ['TODOS.md'],
  dirs: ['key/', 'project/', 'archive/', 'todo/'],
  logs: true,
}

/** v2 全局轨目录前缀（迁移前旧仓库；与 2026-10-15 的规格逐字一致）。 */
const LEGACY_GLOBAL_DIRS = {
  'memory-global': ['global/memory/', 'global/kb/', 'archive/memory/', 'archive/kb/'],
  'user-global': ['global/user/', 'archive/user/'],
  'daily-global': ['global/daily/'],
  'todo-global': ['todo/'],
}

/** v2 全局轨精确文件名。 */
const LEGACY_GLOBAL_FILES = {
  'memory-global': ['MEMORY.md', 'MEMORY-archive.md', 'KB.md'],
  'user-global': ['USER.md', 'USER-archive.md'],
  'daily-global': [],
  'todo-global': ['TODOS-life.md', 'TODOS-work.md'],
}

/** daily 日志文件路径模式（记忆格式，v2）。 */
const DAILY_LOG_RE = /^daily\/\d{4}-\d{2}-\d{2}\.md$/
/** daily 待办文件路径模式（TODO 格式，v2）。 */
const DAILY_TODO_RE = /^daily\/\d{4}-\d{2}-\d{2}\.todo\.md$/
/** v2 待办文件路径（2026-10-15）：`todo/TODOS-<组id>.md` 与 `todo/<组id>/<日期>.md`。 */
const V2_TODO_FILE_RE = /^todo\/TODOS-[a-z0-9][a-z0-9._-]*\.md$/
const V2_TODO_DAILY_RE = /^todo\/[a-z0-9][a-z0-9._-]*\/\d{4}-\d{2}-\d{2}\.md$/

/** `.keep` 占位文件（入白名单、不参与合并）。 */
export function isKeepPath(path) {
  return typeof path === 'string' && path.endsWith('/.keep')
}

/** v3 形状（`memory|todo/<组id>/<类段>`）：用于把旧仓库兼容分支挡在 v3 路径之外。 */
const V3_SHAPE_RE = new RegExp(`^(?:memory|todo)/${GID}/(?:global|project|session|archive)(?:/|$)`)
function isV3Shape(path) {
  return V3_SHAPE_RE.test(path)
}

/**
 * 判断路径是否属于某 fileset 的同步文件（纯路径判断，不要求文件存在）。
 * @param {string} path - 相对记忆根的路径（正斜杠）。
 * @param {string} [fileset='project'] - 文件集（v2 旧名 'project' 仍可用）。
 * @returns {boolean}
 */
export function isMemoryFile(path, fileset = 'project') {
  if (typeof path !== 'string' || path === '') return false
  const parsed = parseFileset(fileset)
  if (parsed.kind === 'project') {
    if (projectKeepRe(parsed.projectId).test(path)) return true
    return projectMemoryRe(parsed.projectId).test(path) || projectTodoRe(parsed.projectId).test(path)
  }
  if (parsed.kind === 'global') {
    const memory = GLOBAL_MEMORY_RE.exec(path)
    if (memory !== null) return groupInTrack(memory[1], parsed.track, 'memory')
    const todo = GLOBAL_TODO_RE.exec(path)
    if (todo !== null) return groupInTrack(todo[1], parsed.track, 'todo')
    const keep = GLOBAL_KEEP_RE.exec(path)
    if (keep !== null) return groupInTrack(keep[1], parsed.track, path.startsWith('memory/') ? 'memory' : 'todo')
    // v2 旧仓库兼容（迁移前远端分支）：v3 形状的路径已由上面判定，不再按旧前缀泛匹配
    if (!isV3Shape(path)) {
      if (LEGACY_GLOBAL_FILES[parsed.track].includes(path)) return true
      const dirs = LEGACY_GLOBAL_DIRS[parsed.track] ?? []
      if (path.endsWith('.md') && dirs.some((prefix) => path.startsWith(prefix))) return true
      if (parsed.track === 'daily-global' && DAILY_LOG_RE.test(path)) return true
      if (parsed.track === 'todo-global' && (DAILY_TODO_RE.test(path) || isTodoPath(path))) return true
    }
    return false
  }
  // v2 旧名 'project'：沿用 2026-10-15 的目录前缀规则
  const spec = LEGACY_PROJECT_SPEC
  if (spec.memory.includes(path) || spec.todo.includes(path)) return true
  if (spec.logs && path.startsWith('logs/') && path.endsWith('.md')) return true
  return spec.dirs.some((prefix) => path.startsWith(prefix) && path.endsWith('.md'))
}

/**
 * 判断路径是否是 TODO 格式文件（合并器按文件分流：TODO 用 tag id、不补发行首身份证）。
 * v3：顶层 `todo/` 下的文件；v2 旧名规则保留（旧树读取）。
 * @param {string} path - 相对路径。
 * @returns {boolean}
 */
export function isTodoPath(path) {
  if (typeof path !== 'string' || path === '') return false
  if (path.startsWith('todo/')) return true
  if (path === 'TODOS.md' || path === 'TODOS-life.md' || path === 'TODOS-work.md') return true
  if (DAILY_TODO_RE.test(path)) return true
  if (V2_TODO_FILE_RE.test(path) || V2_TODO_DAILY_RE.test(path)) return true
  return false
}

/** v2 兼容：旧的 isTodoPath 只认文件名（供读旧树时区分格式）。 */
export function isLegacyTodoName(path) {
  if (path === 'TODOS.md' || path === 'TODOS-life.md' || path === 'TODOS-work.md') return true
  if (DAILY_TODO_RE.test(path)) return true
  return V2_TODO_FILE_RE.test(path) || V2_TODO_DAILY_RE.test(path)
}

/** 旧 spec 形状（兼容 `filesetSpec()` 调用方；v3 不再用它取路径前缀）。 */
export const PROJECT_SPEC = LEGACY_PROJECT_SPEC
export const GLOBAL_FILESETS = Object.fromEntries(GLOBAL_FILESET_KEYS.map((track) => [
  track,
  { memory: LEGACY_GLOBAL_FILES[track], todo: [], dirs: LEGACY_GLOBAL_DIRS[track], logs: false },
]))

/** 取 fileset 的 v2 规格对象（未知 fileset 抛错）。 */
export function filesetSpec(fileset) {
  if (fileset === 'project') return LEGACY_PROJECT_SPEC
  if (Object.hasOwn(GLOBAL_FILESETS, fileset)) return GLOBAL_FILESETS[fileset]
  throw new Error(`dsh-memory-evolve: 未知同步文件集 "${fileset}"`)
}

/** 全局轨远端分支名（dsh-shared/<轨>）。 */
export function globalBranchFor(fileset) {
  const name = {
    'memory-global': 'memory-global',
    'user-global': 'user',
    'daily-global': 'daily',
    'todo-global': 'todo-global',
  }[fileset]
  return `dsh-shared/${name ?? fileset}`
}

/** 全局轨本地分支名（refs/heads/<fileset>，与远端分支解耦）。 */
export function globalLocalBranchFor(fileset) {
  return fileset
}

/**
 * 冲突侧车文件名（每 fileset 独立；多轨共享同一 .git 时互不覆盖）。
 * 项目轨带项目 id；文件名不能含 `:`（Windows），故 `project:<id>` → `project-<id>`。
 * @param {string} [fileset='project']
 * @returns {string}
 */
export function conflictsFileFor(fileset = 'project') {
  const parsed = parseFileset(fileset)
  if (parsed.kind === 'legacy-project') return 'CONFLICTS.md'
  if (parsed.kind === 'project') return `CONFLICTS-project-${parsed.projectId}.md`
  return `CONFLICTS-${parsed.track}.md`
}

/**
 * 本 fileset 的仓库元数据（stage 用，相对仓库工作树）。
 *
 * 返回**候选并集**：v3 位置（`.system/...`）与 v2 旧位置（根下）都列出，
 * 调用方按 `existsSync` 过滤——迁移前旧仓库、迁移后 v3 仓库都能正确 stage。
 * @param {string} [fileset='project']
 * @returns {string[]}
 */
export function stageMetaOf(fileset = 'project') {
  const parsed = parseFileset(fileset)
  const shared = [SYNC_IGNORE_PATH, '.gitignore', SYNC_ATTRIBUTES_PATH, '.gitattributes']
  if (parsed.kind === 'legacy-project') return ['PROVENANCE', ...shared, 'CONFLICTS.md']
  const provenance = parsed.kind === 'project'
    ? projectProvenancePathOf(parsed.projectId)
    : GLOBAL_PROVENANCE_PATH
  // 项目轨额外容忍根 PROVENANCE（共享仓库根只有全局身份，不会误取）
  return [provenance, 'PROVENANCE', ...shared]
}

/** 项目轨的本地分支名（v3：每项目一条，共享仓库里互不覆盖）。 */
export function projectLocalBranchOf(projectId) {
  return `project/${projectId}`
}

/** v3 项目轨的远端分支名（与 v2 的 dsh-shared/<id> 分开，避免 non-FF 冲历史）。 */
export function projectV3BranchOf(projectId) {
  return `dsh-shared/v3-${projectId}`
}
