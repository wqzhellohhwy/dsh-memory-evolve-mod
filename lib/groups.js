/**
 * dsh-memory-evolve — 统一「类 + 分组」模型（2026-10-15 三类改造）。
 *
 * ## 为什么有这一层
 * 记忆与待办过去都是**硬编码轨道**（记忆 `memory/user/kb/project/key/daily`，
 * 待办 `life/work/project/daily`）。2026-10-13 引入「分组」：轨道本质就是分组，
 * 用户可新建、可命名、可逐组控制注入与待确认门槛。2026-10-15 用户再拍板
 * 引入**类**：
 *
 *   - **类**只有三个，是作用域骨架：`session`（会话类）/ `project`（项目类）/
 *     `global`（全局类）。内置分组的类**锁死不可改**；自建分组创建时必选一类。
 *   - **分组**挂在类下面：会话类 = 会话日志 / 会话关键记忆，项目类 = 项目日志 /
 *     项目关键记忆，全局类 = 今日日志 / 全局关键记忆 / 用户档案 / 记忆知识库。
 *   - 「日志」与「关键记忆」**结构完全相同**，差别只在出厂默认的
 *     `confirm`（日志不确认、关键记忆要确认）与 `inject`（都默认不注入）；
 *     AI 往里写什么，由开局提示词 + 工具定义决定。
 *   - 每个类下面都有一个**归档**（不是分组，是页签）：`archive/<分组id>/`。
 *
 * 记忆与待办**共用同一套类 + 分组模型**（`kind` 区分二者）。
 *
 * ## 数据形状
 * `<memoryDir>/.system/groups.json`
 * ```json
 * {
 *   "version": 2,
 *   "groups": [
 *     { "kind": "memory", "id": "kb", "label": null, "builtin": true,
 *       "klass": "global", "daily": false, "inject": false, "prompt": null,
 *       "confirm": false, "autoApprove": false, "enabled": true, "order": 80 }
 *   ]
 * }
 * ```
 * 内置分组只在文件里存**覆盖项**；`listGroups()` 把内置默认与文件覆盖合并成
 * 完整列表（内置 id / klass 不允许改，自建分组 id 由本模块生成）。
 *
 * ## 磁盘布局 v3（以分组 id 为主目录；规范见 docs/layout-v3.md）
 * ```
 * <memoryDir>/.layout-version                  "3"
 * <memoryDir>/.system/groups.json              配置文件
 * <memoryDir>/memory/<组id>/global/[<日期>/]<标题>.md
 * <memoryDir>/memory/<组id>/project/<项目id>/[<日期>/]<标题>.md
 * <memoryDir>/memory/<组id>/session/<会话id>/[<日期>/]<标题>.md
 * <memoryDir>/memory/<组id>/archive/<类段>/[<日期>/]<标题>.md
 * <memoryDir>/todo/<组id>/<类段>/TODOS.md      或（日志型）<类段>/<日期>.md
 * <memoryDir>/todo/<组id>/archive/<类段>/…
 * ```
 * `daily: true`（日志型）的分组多一层日期：记忆是目录层，待办是文件名层。
 * 全部路径只由本模块产出，别处禁止手拼。
 *
 * @module dsh-memory-evolve/groups
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { translate, getLocale } from './i18n.js'

/** groups.json 的结构版本（2 = 引入 klass 三类模型）。 */
export const GROUPS_VERSION = 2

/** 三个类：会话类 / 项目类 / 全局类（顺序 = UI 展示顺序）。 */
export const KLASSES = ['session', 'project', 'global']

/** 归一一个类值（非法值回落 global）。 */
export function normalizeKlass(value) {
  return KLASSES.includes(value) ? value : 'global'
}

/**
 * 内置记忆分组的出厂默认。
 *
 * `klass` 是类（会话/项目/全局），`daily` 为 true 表示**日志型**（按日期目录
 * 分文件）；`confirm` 为 true 表示写入先进待确认队列。
 *
 * 出厂默认刻意保持"安静"：**所有分组 inject=false**（用户拍板 2026-10-15：
 * 默认都不注入，要用再开）；日志类 confirm=false（每轮收尾都会写，逐条确认
 * 是灾难），关键记忆类 confirm=true（值得留的东西才要确认）。
 *
 * id 沿用旧名（memory/user/key/kb/project/daily）以保持既有数据与配置覆盖
 * 的连续性；`session` / `sessionkey` 是新增的会话类分组。
 */
export const BUILTIN_MEMORY_GROUPS = [
  // 会话类
  { id: 'session', klass: 'session', inject: false, confirm: false, daily: true, order: 10 },
  { id: 'sessionkey', klass: 'session', inject: false, confirm: true, daily: false, order: 20 },
  // 项目类
  { id: 'project', klass: 'project', inject: false, confirm: false, daily: true, order: 30 },
  { id: 'key', klass: 'project', inject: false, confirm: true, daily: false, order: 40 },
  // 全局类
  { id: 'daily', klass: 'global', inject: false, confirm: false, daily: true, order: 50 },
  { id: 'memory', klass: 'global', inject: false, confirm: false, daily: false, order: 60 },
  { id: 'user', klass: 'global', inject: false, confirm: false, daily: false, order: 70 },
  { id: 'kb', klass: 'global', inject: false, confirm: false, daily: false, order: 80 },
]

/**
 * 内置待办分组的出厂默认（与记忆同构：一套类 + 分组）。
 *
 * `life` / `work` 用户已明确「这俩不要了」（2026-10-15 访谈）——新版出厂
 * **停用**它们、改推一个合并后的 `global`「全局待办」；旧文件
 * （`TODOS-life.md` / `TODOS-work.md`）与旧配置覆盖都还在，随时可重新启用，
 * 不做破坏性删除。
 */
export const BUILTIN_TODO_GROUPS = [
  { id: 'session', klass: 'session', daily: false, inject: false, order: 10 },
  { id: 'project', klass: 'project', daily: false, inject: false, order: 20 },
  { id: 'global', klass: 'global', daily: false, inject: false, order: 30 },
  { id: 'daily', klass: 'global', daily: true, inject: false, order: 40 },
  { id: 'life', klass: 'global', daily: false, inject: false, order: 50, enabled: false },
  { id: 'work', klass: 'global', daily: false, inject: false, order: 60, enabled: false },
]

/** 分组标签字典（内置分组的默认名；用户改过 label 就用用户的）。 */
const LABEL_DICT = {
  'group.memory': ['全局关键记忆', 'Global key memory'],
  'group.user': ['用户档案', 'User profile'],
  'group.key': ['工作区关键记忆', 'Key workspace facts'],
  'group.kb': ['记忆知识库', 'Knowledge base'],
  'group.project': ['工作区日志', 'Workspace log'],
  'group.daily': ['今日日志', 'Daily log'],
  'group.session': ['会话日志', 'Session log'],
  'group.sessionkey': ['会话关键记忆', 'Session key facts'],
  'group.todo.session': ['会话待办', 'Session todos'],
  'group.todo.global': ['全局待办', 'Global todos'],
  'group.todo.life': ['生活', 'Life'],
  'group.todo.work': ['工作', 'Work'],
  'group.todo.project': ['本工作区待办', 'This workspace'],
  'group.todo.daily': ['每日待办', 'Daily'],
}

/** 类的显示名（UI 二级页签）。 */
const KLASS_DICT = {
  'klass.session': ['会话类', 'Session'],
  'klass.project': ['工作区类', 'Workspace'],
  'klass.global': ['全局类', 'Global'],
}

/** 磁盘布局版本（`.layout-version` 的内容）。 */
export const LAYOUT_VERSION = 3

/** 分组 id 形状：小写字母/数字开头，允许 `_` `-`，总长 ≤32（v3 规范 §4）。 */
export const GROUP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** 保留 id：这些名字与顶层/归档目录语义冲突，新建与改名一律拒绝。 */
export const RESERVED_IDS = new Set(['archive', 'memory', 'todo', 'system'])

/**
 * id 形状校验（纯规则，不查重）。内置 id（如 `memory`）虽是保留字，这里只判形状。
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidGroupId(id) {
  return typeof id === 'string' && GROUP_ID_RE.test(id)
}

/**
 * id 完整校验：形状 → 保留字 → 同 kind 内大小写不敏感唯一。
 * @param {unknown} id - 待校验 id。
 * @param {{kind?: 'memory'|'todo', data?: object|null, ignoreId?: string|null, allowReserved?: boolean}} [options]
 *   `data` 给出现在已有的分组表（查重）；`ignoreId` 用于改名时排除自身。
 * @returns {{ok: true} | {ok: false, error: 'INVALID_ID'|'RESERVED_ID'|'ID_TAKEN'}}
 */
export function validateGroupId(id, options = {}) {
  if (!isValidGroupId(id)) return { ok: false, error: 'INVALID_ID' }
  if (options.allowReserved !== true && RESERVED_IDS.has(id.toLowerCase())) return { ok: false, error: 'RESERVED_ID' }
  const kind = options.kind === 'todo' ? 'todo' : options.kind === 'memory' ? 'memory' : null
  if (kind === null || options.data === null || options.data === undefined) return { ok: true }
  const ignore = typeof options.ignoreId === 'string' ? options.ignoreId.toLowerCase() : null
  const taken = listGroups(options.data, kind).some((g) => g.id.toLowerCase() === id.toLowerCase() && g.id.toLowerCase() !== ignore)
  return taken ? { ok: false, error: 'ID_TAKEN' } : { ok: true }
}

/** 内置 id 全集（不允许新建撞名，也不允许删除）。 */
export function builtinIds(kind) {
  const list = kind === 'todo' ? BUILTIN_TODO_GROUPS : BUILTIN_MEMORY_GROUPS
  return new Set(list.map((g) => g.id))
}

/** 内置默认的完整实体（补齐所有字段）。 */
function builtinEntry(kind, spec) {
  return {
    kind,
    id: spec.id,
    label: null,
    builtin: true,
    klass: normalizeKlass(spec.klass),
    // scope 是 klass 的派生视图（旧代码/旧 UI 仍在读它）：只有项目类是 'project'
    scope: normalizeKlass(spec.klass) === 'project' ? 'project' : 'global',
    daily: spec.daily === true,
    inject: spec.inject === true,
    prompt: null,
    // 待办没有"待确认门槛"（待办本身就是给人的行动项，模型自建走建议队列）
    confirm: kind === 'memory' ? spec.confirm === true : false,
    autoApprove: false,
    enabled: spec.enabled !== false,
    order: spec.order ?? 100,
    // 注入方式（2026-10-15）：'inherit' 跟随全局 / 'context' 上下文快照 /
    // 'section' 系统提示词。缺省跟随全局（全局缺省 = 上下文快照）。
    injectMode: 'inherit',
  }
}

/** 出厂默认的完整分组表（内置分组 + 空自建）。 */
export function defaultGroupsConfig() {
  return {
    version: GROUPS_VERSION,
    groups: [
      ...BUILTIN_MEMORY_GROUPS.map((spec) => builtinEntry('memory', spec)),
      ...BUILTIN_TODO_GROUPS.map((spec) => builtinEntry('todo', spec)),
    ],
  }
}

/** memoryDir 归一（缺失退化为当前目录，绝不抛错）。 */
function baseDirOf(memoryDir) {
  return typeof memoryDir === 'string' && memoryDir !== '' ? memoryDir : '.'
}

/** `<memoryDir>/.system` —— 系统文件与项目元数据的唯一落点。 */
export function systemDirOf(memoryDir) {
  return join(baseDirOf(memoryDir), '.system')
}

/** `<memoryDir>/.layout-version` —— 布局版本标记文件。 */
export function layoutVersionFileOf(memoryDir) {
  return join(baseDirOf(memoryDir), '.layout-version')
}

/** `<memoryDir>/memory` —— 记忆分组根。 */
export function memoryRootOf(memoryDir) {
  return join(baseDirOf(memoryDir), 'memory')
}

/** `<memoryDir>/todo` —— 待办分组根。 */
export function todoRootOf(memoryDir) {
  return join(baseDirOf(memoryDir), 'todo')
}

/** 分组大类根目录（memory / todo）。 */
export function kindRootOf(memoryDir, kind) {
  return kind === 'todo' ? todoRootOf(memoryDir) : memoryRootOf(memoryDir)
}

/** `<memoryDir>/.system/projects/<项目id>` —— 项目元数据（PROVENANCE）目录；缺 id 返回 null。 */
export function projectMetaDirOf(memoryDir, projectId) {
  const id = safeSegment(projectId, '')
  return id === '' ? null : join(systemDirOf(memoryDir), 'projects', id)
}

/** `<memoryDir>/.system/plugin-state.json` —— 运行时配置覆盖。 */
export function stateFileOf(memoryDir) {
  return join(systemDirOf(memoryDir), 'plugin-state.json')
}

/** `<memoryDir>/.system/SUGGESTIONS.jsonl` —— 学习建议队列。 */
export function suggestionsFileOf(memoryDir) {
  return join(systemDirOf(memoryDir), 'SUGGESTIONS.jsonl')
}

/** `<memoryDir>/.system/advisor` —— Advisor 评审数据目录。 */
export function advisorDirOf(memoryDir) {
  return join(systemDirOf(memoryDir), 'advisor')
}

/** `<memoryDir>/.system/legacy` —— 迁移前的旧结构原样堆放处。 */
export function legacyDirOf(memoryDir) {
  return join(systemDirOf(memoryDir), 'legacy')
}

/** groups.json 的路径（`.system/groups.json`）。 */
export function groupsFileOf(memoryDir) {
  return join(systemDirOf(memoryDir), 'groups.json')
}

/** 迁移前的 groups.json 位置（`<memoryDir>/groups.json`），仅作兼容读写。 */
export function legacyGroupsFileOf(memoryDir) {
  return join(baseDirOf(memoryDir), 'groups.json')
}

/** 布尔取默认（文件缺字段时保持出厂值）。 */
function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 字符串或 null（空串归一成 null）。 */
function stringOrNull(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 注入方式归一（非法值回落 'inherit'）。 */
function injectModeOr(value, fallback = 'inherit') {
  return value === 'context' || value === 'section' || value === 'inherit' ? value : fallback
}

/**
 * 把磁盘上的原始配置归一成完整、可信的分组表。
 *
 * 规则（防御性，坏数据只降级不抛）：内置分组一定存在（文件里缺就补出厂值，
 * id 写错就忽略该条）；自建分组必须 id 合法、不与内置撞名，否则丢弃；
 * 未知 kind 丢弃；非法类回落 global。
 * @param {object|null|undefined} raw - 解析后的 groups.json（或 null）。
 * @returns {{version: number, groups: object[]}}
 */
export function normalizeGroupsConfig(raw) {
  const base = defaultGroupsConfig()
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.groups)) return base
  const byKey = new Map(base.groups.map((g) => [`${g.kind}:${g.id}`, g]))
  for (const entry of raw.groups) {
    if (entry === null || typeof entry !== 'object') continue
    const kind = entry.kind === 'todo' ? 'todo' : entry.kind === 'memory' ? 'memory' : null
    if (kind === null) continue
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (!GROUP_ID_RE.test(id)) continue
    const key = `${kind}:${id}`
    const isBuiltin = builtinIds(kind).has(id)
    // 自建分组不能占用内置 id（内置 id 由代码定义，撞名会让 locate 分不清）
    if (!isBuiltin && byKey.has(key)) continue
    const target = byKey.get(key) ?? {
      kind,
      id,
      label: null,
      builtin: false,
      klass: 'global',
      scope: 'global',
      daily: false,
      inject: false,
      prompt: null,
      confirm: kind === 'memory',
      autoApprove: false,
      enabled: true,
      order: 100,
      injectMode: 'inherit',
    }
    if (!target.builtin) {
      // 自建分组的类可改（创建时必选，之后可调整）
      target.klass = normalizeKlass(entry.klass)
      target.scope = target.klass === 'project' ? 'project' : 'global'
    }
    target.label = stringOrNull(entry.label) ?? target.label
    target.prompt = stringOrNull(entry.prompt) ?? target.prompt
    target.daily = boolOr(entry.daily, target.daily)
    target.inject = boolOr(entry.inject, target.inject)
    target.confirm = boolOr(entry.confirm, target.confirm)
    target.autoApprove = boolOr(entry.autoApprove, target.autoApprove)
    target.enabled = boolOr(entry.enabled, target.enabled)
    target.injectMode = injectModeOr(entry.injectMode, target.injectMode)
    if (Number.isFinite(Number(entry.order))) target.order = Number(entry.order)
    byKey.set(key, target)
  }
  const groups = [...byKey.values()].sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
  return { version: GROUPS_VERSION, groups }
}

/**
 * 读分组配置（文件缺失/损坏 → 出厂默认，绝不抛）。
 *
 * 迁移前兼容：`.system/groups.json` 不存在而根 `groups.json` 存在时读旧文件，
 * 返回对象带 `legacyFile: true` 标记（不污染 groups 数组）。
 */
export function loadGroups(memoryDir) {
  const file = groupsFileOf(memoryDir)
  const legacy = legacyGroupsFileOf(memoryDir)
  if (!existsSync(file)) {
    if (!existsSync(legacy)) return defaultGroupsConfig()
    try {
      return { ...normalizeGroupsConfig(JSON.parse(readFileSync(legacy, 'utf8'))), legacyFile: true }
    } catch {
      return defaultGroupsConfig()
    }
  }
  try {
    return normalizeGroupsConfig(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return defaultGroupsConfig()
  }
}

/**
 * 原子写分组配置（写盘失败只返回 false，不抛——配置写坏比丢配置更糟）。
 * 迁移前兼容：新位置还没有文件、旧位置有 → 写旧位置（保持单一来源，避免旧文件成孤儿）。
 */
export function saveGroups(memoryDir, data) {
  const file = groupsFileOf(memoryDir)
  const target = !existsSync(file) && existsSync(legacyGroupsFileOf(memoryDir)) ? legacyGroupsFileOf(memoryDir) : file
  const normalized = normalizeGroupsConfig(data)
  try {
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n')
    renameSync(tmp, target)
    return true
  } catch {
    return false
  }
}

/** 列某个 kind 的全部分组（已按 order 排序）。 */
export function listGroups(data, kind) {
  const normalized = normalizeGroupsConfig(data)
  return normalized.groups.filter((g) => g.kind === kind)
}

/** 只列启用中的分组（工具 enum / 注入 / UI 页签用）。 */
export function listEnabledGroups(data, kind) {
  return listGroups(data, kind).filter((g) => g.enabled)
}

/** 列某个 kind + 某个类的分组（UI 三级页签 / 归档页用，含停用组）。 */
export function listGroupsByClass(data, kind, klass) {
  const wanted = normalizeKlass(klass)
  return listGroups(data, kind).filter((g) => g.klass === wanted)
}

/** 按 id 找分组。 */
export function findGroup(data, kind, id) {
  return listGroups(data, kind).find((g) => g.id === id) ?? null
}

/** 该分组此刻是否应该注入上下文。 */
export function isInjected(group) {
  if (group === null || group === undefined) return false
  if (group.enabled !== true) return false
  return group.inject === true
}

/** 内置分组的默认标签（用户覆盖优先）。 */
export function groupLabel(group, locale = getLocale()) {
  if (group.label !== null && group.label !== undefined && group.label !== '') return group.label
  const key = group.kind === 'todo' ? `group.todo.${group.id}` : `group.${group.id}`
  const text = translate(LABEL_DICT, key, undefined, locale)
  return text === key ? group.id : text
}

/** 类的显示名。 */
export function klassLabel(klass, locale = getLocale()) {
  const key = `klass.${normalizeKlass(klass)}`
  const text = translate(KLASS_DICT, key, undefined, locale)
  return text === key ? key : text
}

/** 生成一个不与现有 id 冲突的自建分组 id（`g` + 8 位十六进制）。 */
export function newGroupId(data) {
  const taken = new Set(listGroups(data, 'memory').map((g) => g.id))
  for (const g of listGroups(data, 'todo')) taken.add(g.id)
  for (let i = 0; i < 64; i += 1) {
    const id = `g${randomBytes(4).toString('hex')}`
    if (!taken.has(id)) return id
  }
  // 概率上到不了这里；兜底用时间戳保证不返回 null
  return `g${Date.now().toString(16)}`
}

/**
 * 新建或更新一个分组（局部更新：patch 里出现的字段才改）。
 *
 * 内置分组的 id / builtin / klass 不可改（类决定目录位置与语义），其余字段
 * （label / inject / prompt / confirm / autoApprove / enabled / order /
 * injectMode）可改；`daily` 一经创建不可改（日志型与普通型的条目文件名形状
 * 不同，改配置会让两侧数据互相看不见）——收到变更一律返回 `DAILY_FIXED`
 * （API 层转 HTTP 400）。
 * 自建分组全部可改（含 klass），且可删除。
 * @param {object} data - 当前配置（会被返回的新对象替换，不原地改）。
 * @param {'memory'|'todo'} kind - 分组大类。
 * @param {object} patch - { id?, label?, klass?, daily?, inject?, prompt?, confirm?, autoApprove?, enabled?, order?, injectMode? }。
 * @returns {{ok: boolean, error?: string, data?: object, group?: object}}
 */
export function upsertGroup(data, kind, patch) {
  const current = normalizeGroupsConfig(data)
  const id = typeof patch?.id === 'string' ? patch.id.trim().toLowerCase() : ''
  const groups = current.groups.map((g) => ({ ...g }))
  let target = groups.find((g) => g.kind === kind && g.id === id) ?? null
  if (target === null) {
    // 新建：id 必须合法（形状 → 保留字）且不与同 kind 任何分组撞名（大小写不敏感）
    const check = validateGroupId(id, { kind, data: current })
    if (!check.ok) return { ok: false, error: check.error }
    const klass = normalizeKlass(patch?.klass)
    target = {
      kind,
      id,
      // 新建时也要吃下用户给的名字（漏掉会让 UI 一直显示 id）
      label: stringOrNull(patch?.label),
      builtin: false,
      klass,
      scope: klass === 'project' ? 'project' : 'global',
      daily: kind === 'todo' ? patch?.daily === true : patch?.daily === true,
      // 出厂默认"都不注入"（用户拍板 2026-10-15）：新建分组也默认不注入
      inject: patch?.inject === true,
      prompt: null,
      confirm: kind === 'memory' ? patch?.confirm !== false : false,
      autoApprove: patch?.autoApprove === true,
      enabled: patch?.enabled !== false,
      order: Number.isFinite(Number(patch?.order)) ? Number(patch.order) : nextOrder(groups, kind),
      injectMode: injectModeOr(patch?.injectMode, 'inherit'),
    }
    groups.push(target)
  } else {
    if (target.builtin && patch?.klass !== undefined && normalizeKlass(patch.klass) !== target.klass) {
      return { ok: false, error: 'BUILTIN_KLASS_FIXED' }
    }
    if (typeof patch?.label === 'string') target.label = stringOrNull(patch.label)
    if (!target.builtin && patch?.klass !== undefined) {
      target.klass = normalizeKlass(patch.klass)
      target.scope = target.klass === 'project' ? 'project' : 'global'
    }
    // daily 不可改（规范 §2.3）：变更一律报错，相同值视为无操作
    if (patch?.daily !== undefined && (patch.daily === true) !== target.daily) return { ok: false, error: 'DAILY_FIXED' }
    if (patch?.inject !== undefined) target.inject = patch.inject === true
    if (patch?.prompt !== undefined) target.prompt = stringOrNull(patch.prompt)
    if (patch?.confirm !== undefined && kind === 'memory') target.confirm = patch.confirm === true
    if (patch?.autoApprove !== undefined) target.autoApprove = patch.autoApprove === true
    if (patch?.enabled !== undefined) target.enabled = patch.enabled === true
    if (patch?.injectMode !== undefined) target.injectMode = injectModeOr(patch.injectMode, target.injectMode)
    if (patch?.order !== undefined && Number.isFinite(Number(patch.order))) target.order = Number(patch.order)
  }
  const next = { version: GROUPS_VERSION, groups }
  return { ok: true, data: next, group: target }
}

/** 新建分组时的默认排序值（排在同 kind 现有最大值之后）。 */
function nextOrder(groups, kind) {
  const orders = groups.filter((g) => g.kind === kind).map((g) => g.order)
  return orders.length === 0 ? 100 : Math.max(...orders) + 10
}

/**
 * 删除一个自建分组。内置分组不可删（只能停用），返回 BUILTIN_PROTECTED。
 * 数据目录不删——分组配置没了，条目文件仍在磁盘上（宁可留孤儿文件，
 * 也不静默销毁用户内容）。
 * @returns {{ok: boolean, error?: string, data?: object}}
 */
export function deleteGroup(data, kind, id) {
  const current = normalizeGroupsConfig(data)
  const target = current.groups.find((g) => g.kind === kind && g.id === id)
  if (target === undefined) return { ok: false, error: 'NOT_FOUND' }
  if (target.builtin) return { ok: false, error: 'BUILTIN_PROTECTED' }
  return {
    ok: true,
    data: { version: GROUPS_VERSION, groups: current.groups.filter((g) => !(g.kind === kind && g.id === id)) },
  }
}

/**
 * 记忆分组 → 是否要进待确认队列。
 * 自动通过（autoApprove）优先级最高；否则看 confirm 门槛。
 * @param {object} group - 分组实体。
 * @param {boolean} [forceAll] - 全局"全部自动通过"开关。
 */
export function needsConfirmation(group, forceAll = false) {
  if (group === null) return false
  if (forceAll) return false
  if (group.autoApprove === true) return false
  return group.confirm === true
}

/** 文件名清洗（目录名与文件名的公共规则）：非法字符换 `_`，去首尾点与空白。 */
export function safeSegment(text, fallback = 'group') {
  const slug = String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (slug.length > 80) return slug.slice(0, 80).trim() || fallback
  return slug === '' ? fallback : slug
}

/**
 * 项目 id 解析（v3 兼容层）。
 *
 * 上层（store / todo / api / library-tools）传的 ctx 历史上是 `projectDir`，
 * 规范里叫 `projectId`。规则：`ctx.projectId` 优先；缺则取 `basename(ctx.projectDir)`
 * （项目类分组目录的最末段永远是项目 id）；两者都缺 → 空串。
 * @param {{projectId?: string|null, projectDir?: string|null}} [ctx]
 * @returns {string} 安全化的项目 id（缺省为 ''）。
 */
export function projectIdOf(ctx) {
  const explicit = ctx?.projectId
  if (typeof explicit === 'string' && explicit.trim() !== '') return safeSegment(explicit.trim(), '')
  const dir = ctx?.projectDir
  if (typeof dir === 'string' && dir.trim() !== '') return safeSegment(basename(dir.replace(/[\\/]+$/, '')), '')
  return ''
}

/** 类段：`global` / `project/<项目id>` / `session/<会话id>`；无法定位返回 null。 */
function classSegmentOf(group, ctx) {
  const klass = normalizeKlass(group?.klass)
  if (klass === 'session') {
    const sid = safeSegment(ctx?.sessionId, '')
    return sid === '' ? null : join('session', sid)
  }
  if (klass === 'project') {
    const pid = projectIdOf(ctx)
    return pid === '' ? null : join('project', pid)
  }
  return 'global'
}

/** 分组数据基目录的公共部分：`<kind根>/<组id>`。 */
function groupBaseDirOf(memoryDir, group) {
  return join(kindRootOf(memoryDir, group?.kind), safeSegment(group?.id, 'group'))
}

/**
 * 分组的数据基目录（v3）：`<kind 根>/<组id>/<类段>`。
 *
 * - 记忆：`<memoryDir>/memory/<组id>/{global|project/<项目id>|session/<会话id>}`
 * - 待办：`<memoryDir>/todo/<组id>/{同上}`
 *
 * ctx 形状 `{ memoryDir, projectId?, projectDir?, sessionId?, date? }`：
 * 项目类缺 id 与 projectDir、会话类缺 sessionId 时返回 null（沿用旧行为）。
 * @param {object} group - 分组实体。
 * @param {{memoryDir: string, projectId?: string|null, projectDir?: string|null, sessionId?: string|null}} ctx
 * @returns {string|null} 绝对路径。
 */
export function groupDirOf(group, ctx) {
  const segment = classSegmentOf(group, ctx)
  if (segment === null) return null
  return join(groupBaseDirOf(ctx?.memoryDir, group), segment)
}

/**
 * 归档目录（v3）：`<kind 根>/<组id>/archive/<类段>`（在分组 id 目录内，改名自动跟随）。
 * @param {object} group - 分组实体。
 * @param {{memoryDir: string, projectId?: string|null, projectDir?: string|null, sessionId?: string|null}} ctx
 * @returns {string|null} 绝对路径。
 */
export function groupArchiveDirOf(group, ctx) {
  const segment = classSegmentOf(group, ctx)
  if (segment === null) return null
  return join(groupBaseDirOf(ctx?.memoryDir, group), 'archive', segment)
}

/** 本地日期（`YYYY-MM-DD`），不经过 UTC 以免跨时区差一天。 */
function localDate() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 待办分组的**文件**路径（待办一组一个文件，不拆条目文件）。
 *
 * - 非日志型：`<kind 根>/<组id>/<类段>/TODOS.md`
 * - 日志型（daily）：`<kind 根>/<组id>/<类段>/<日期>.md`
 * @param {object} group - 待办分组实体。
 * @param {{memoryDir: string, projectId?: string|null, projectDir?: string|null, sessionId?: string|null, date?: string}} ctx
 * @returns {string|null} 绝对路径。
 */
export function todoFileOf(group, ctx) {
  const segment = classSegmentOf(group, ctx)
  if (segment === null) return null
  const day = typeof ctx?.date === 'string' && ctx.date !== '' ? ctx.date : localDate()
  const name = group?.daily === true ? `${day}.md` : 'TODOS.md'
  return join(groupBaseDirOf(ctx?.memoryDir, group), segment, name)
}

/** 递归统计目录下的 `.md` 文件数（目录不存在 → 0）。 */
function countMdDeep(dir) {
  let items
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const item of items) {
    if (item.isDirectory()) total += countMdDeep(join(dir, item.name))
    else if (item.isFile() && item.name.endsWith('.md')) total += 1
  }
  return total
}

/**
 * 改名：`<kind 根>/<oldId>` → `<kind 根>/<newId>`（原子 rename，归档自动跟随）。
 *
 * 拒绝：内置分组 / 旧 id 形状非法 / 新 id 形状非法或保留字 / 同 kind 撞名 /
 * 目标目录已存在。**配置里有、磁盘还没建目录的空分组**视为改名成功
 * （`moved: false`，只改配置）。
 * 本函数**不写 groups.json**：成功时返回改好 id 的新配置 `data`，调用方
 * 自行 `saveGroups`。
 * @param {string} memoryDir - 记忆根。
 * @param {'memory'|'todo'} kind - 分组大类。
 * @param {string} oldId - 现 id。
 * @param {string} newId - 新 id。
 * @param {object|null} [data] - 当前分组配置；缺省从盘上 `loadGroups`。
 * @returns {{ok: true, from: string, to: string, id: string, moved: boolean, data: object}
 *   | {ok: false, error: string, message?: string}}
 */
export function renameGroupId(memoryDir, kind, oldId, newId, data = null) {
  const from = typeof oldId === 'string' ? oldId.trim() : ''
  const to = typeof newId === 'string' ? newId.trim().toLowerCase() : ''
  const k = kind === 'todo' ? 'todo' : 'memory'
  if (!isValidGroupId(from)) return { ok: false, error: 'INVALID_ID' }
  if (builtinIds(k).has(from.toLowerCase())) return { ok: false, error: 'BUILTIN_PROTECTED' }
  const current = data === null || data === undefined ? loadGroups(memoryDir) : data
  const check = validateGroupId(to, { kind: k, data: current, ignoreId: from })
  if (!check.ok) return { ok: false, error: check.error }
  const root = kindRootOf(memoryDir, kind)
  const src = join(root, from)
  const dst = join(root, to)
  const renameInConfig = () => ({
    version: GROUPS_VERSION,
    groups: normalizeGroupsConfig(current).groups.map((g) => (g.kind === k && g.id.toLowerCase() === from.toLowerCase() ? { ...g, id: to } : g)),
  })
  if (from.toLowerCase() === to) {
    return { ok: true, from: src, to: dst, id: to, moved: false, data: current }
  }
  if (existsSync(dst)) return { ok: false, error: 'TARGET_EXISTS' }
  const hasConfig = listGroups(current, k).some((g) => g.id.toLowerCase() === from.toLowerCase())
  if (existsSync(src)) {
    try {
      renameSync(src, dst)
    } catch (error) {
      return { ok: false, error: 'RENAME_FAILED', message: String(error?.message ?? error) }
    }
    return { ok: true, from: src, to: dst, id: to, moved: true, data: renameInConfig() }
  }
  if (!hasConfig) return { ok: false, error: 'NOT_FOUND' }
  // 空分组：目录还没建，只改配置
  return { ok: true, from: src, to: dst, id: to, moved: false, data: renameInConfig() }
}

/**
 * 删除前统计（规范 §6）：只统计 `<kind 根>/<id>` 内部，不删任何东西。
 * @param {string} memoryDir - 记忆根。
 * @param {'memory'|'todo'} kind - 分组大类。
 * @param {string} id - 分组 id。
 * @returns {{entries: number, archived: number, locations: number}}
 *   `entries` = global + 各 project/<id> + 各 session/<id> 下的 `.md` 数；
 *   `archived` = archive/ 下同口径；`locations` = 有内容的 project/session 目录数。
 */
export function deleteStatsOf(memoryDir, kind, id) {
  const base = groupBaseDirOf(memoryDir, { kind, id })
  let entries = countMdDeep(join(base, 'global'))
  let locations = 0
  for (const cls of ['project', 'session']) {
    let names = []
    try {
      names = readdirSync(join(base, cls), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      names = []
    }
    for (const name of names) {
      const n = countMdDeep(join(base, cls, name))
      if (n > 0) {
        entries += n
        locations += 1
      }
    }
  }
  return { entries, archived: countMdDeep(join(base, 'archive')), locations }
}
