/**
 * dsh-memory-evolve — 工具定义覆盖（2026-10-15 用户需求：工具定义可修改）。
 *
 * 用户拍板的是「可自由增删工具」，落地分两层：
 *   1. **内置工具**：可停用、可改名、可改描述（工具级 + 参数级）；
 *   2. **自建工具**：可新建，名字 + 描述 + 参数，执行绑定到内置动作
 *      （写条目 / 检索 / 读全文 / …），不能凭空造行为。
 *
 * 覆盖存在 `<memoryDir>/tools.json`：
 * ```json
 * {
 *   "version": 1,
 *   "overrides": {
 *     "memory": { "enabled": false, "name": "mem", "description": "…",
 *                 "params": { "action": "…" } }
 *   },
 *   "custom": [
 *     { "id": "t1a2b3c4", "name": "search_kb", "description": "…",
 *       "action": { "kind": "search", "fixed": { "group": "kb" } },
 *       "params": ["query"] }
 *   ]
 * }
 * ```
 * 读盘失败一律回落"没有覆盖"（内置定义永远可用），绝不因为配置文件坏掉
 * 让工具消失。
 *
 * @module dsh-memory-evolve/tool-registry
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { systemDirOf } from './groups.js'

/** tools.json 的结构版本。 */
export const TOOLS_VERSION = 1

/** 自建工具可以绑定的内置动作（UI 下拉用同一份清单）。 */
export const TOOL_ACTIONS = [
  { kind: 'search', label: '检索记忆（按元数据与摘要）' },
  { kind: 'read', label: '读取条目全文' },
  { kind: 'add', label: '写入条目（可固定分组）' },
  { kind: 'list', label: '列出条目（可按关键词/日期）' },
  { kind: 'update', label: '改写条目正文' },
  { kind: 'remove', label: '删除条目' },
  { kind: 'archive', label: '归档条目' },
  { kind: 'restore', label: '把归档条目还原回原分组' },
  { kind: 'promote', label: '把条目提升到另一类/分组' },
  { kind: 'todo', label: '待办增删改查' },
  { kind: 'suggest', label: '提交待确认记忆建议' },
]

/** 内置工具 id 全集（改名/停用/改描述的对象）。 */
export const BUILTIN_TOOL_IDS = [
  'memory', 'memory_search', 'memory_suggest', 'memory_review_status',
  'dtodo',
]

/** 工具名 / 自建工具 id 允许的字符（工具名会注册给模型，必须保守）。 */
export const TOOL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/

/** tools.json 的路径（v3：`.system/tools.json`，路径由 groups.js 统一产出）。 */
export function toolsFileOf(memoryDir) {
  return join(systemDirOf(memoryDir), 'tools.json')
}

/** 出厂（无覆盖）配置。 */
export function defaultToolsConfig() {
  return { version: TOOLS_VERSION, overrides: {}, custom: [] }
}

/** 文本或 undefined（空串归一成 undefined，表示"不覆盖"）。用于不能为空的字段（工具名）。 */
function textOrUndefined(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 文本或 undefined（**空串保留**：表示"显式置空"，与"不覆盖"区分）。
 * 用于工具描述 / 参数说明 —— 用户可以真把定义清空（2026-10-19 用户要求）。
 */
function textOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : undefined
}

/** 把磁盘上的原始配置归一成可信形状（坏数据只降级不抛）。 */
export function normalizeToolsConfig(raw) {
  const base = defaultToolsConfig()
  if (raw === null || typeof raw !== 'object') return base
  const overrides = {}
  if (raw.overrides !== null && typeof raw.overrides === 'object') {
    for (const [id, value] of Object.entries(raw.overrides)) {
      if (value === null || typeof value !== 'object') continue
      const entry = {}
      if (typeof value.enabled === 'boolean') entry.enabled = value.enabled
      const name = textOrUndefined(value.name)
      if (name !== undefined) entry.name = name
      const desc = textOrEmpty(value.description)
      if (desc !== undefined) entry.description = desc
      if (value.params !== null && typeof value.params === 'object') {
        const params = {}
        for (const [key, text] of Object.entries(value.params)) {
          const clean = textOrEmpty(text)
          if (clean !== undefined) params[key] = clean
        }
        if (Object.keys(params).length > 0) entry.params = params
      }
      if (Object.keys(entry).length > 0) overrides[id] = entry
    }
  }
  const custom = []
  if (Array.isArray(raw.custom)) {
    for (const item of raw.custom) {
      if (item === null || typeof item !== 'object') continue
      const name = textOrUndefined(item.name)
      const kind = item?.action?.kind
      if (name === undefined || !TOOL_ACTIONS.some((a) => a.kind === kind)) continue
      custom.push({
        id: typeof item.id === 'string' && item.id !== '' ? item.id : newToolId(),
        name,
        description: textOrUndefined(item.description) ?? name,
        params: Array.isArray(item.params) ? item.params.map((p) => String(p)) : null,
        action: {
          kind,
          fixed: item?.action?.fixed !== null && typeof item?.action?.fixed === 'object' ? { ...item.action.fixed } : {},
        },
      })
    }
  }
  return { version: TOOLS_VERSION, overrides, custom }
}

/** 读覆盖配置（文件缺失/损坏 → 无覆盖，绝不抛）。 */
export function loadToolsConfig(memoryDir) {
  const file = toolsFileOf(memoryDir)
  if (!existsSync(file)) return defaultToolsConfig()
  try {
    return normalizeToolsConfig(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return defaultToolsConfig()
  }
}

/** 原子写覆盖配置（写盘失败返回 false，不抛）。 */
export function saveToolsConfig(memoryDir, data) {
  const file = toolsFileOf(memoryDir)
  try {
    mkdirSync(memoryDir, { recursive: true })
    const tmp = `${file}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(normalizeToolsConfig(data), null, 2) + '\n')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/** 一个新自建工具的 id（`t` + 8 位十六进制）。 */
export function newToolId() {
  return `t${randomBytes(4).toString('hex')}`
}

/**
 * 取某个内置工具的覆盖项。
 * @param {object} config - `loadToolsConfig()` 的结果。
 * @param {string} id - 内置工具 id。
 * @returns {{enabled?: boolean, name?: string, description?: string, params?: object}}
 */
export function toolOverride(config, id) {
  return config?.overrides?.[id] ?? {}
}

/** 该内置工具此刻是否应该注册（被停用则 false）。 */
export function isToolEnabled(config, id) {
  const override = toolOverride(config, id)
  return override.enabled !== false
}

/** 工具的最终名字（覆盖优先）。 */
export function toolNameOf(config, id, fallback) {
  return toolOverride(config, id).name ?? fallback
}

/** 工具的最终描述（覆盖优先）。 */
export function toolDescriptionOf(config, id, fallback) {
  return toolOverride(config, id).description ?? fallback
}

/** 某个参数说明的最终文本（覆盖优先）。 */
export function paramDescriptionOf(config, id, param, fallback) {
  const params = toolOverride(config, id).params
  if (params === null || params === undefined) return fallback
  return params[param] ?? fallback
}

/**
 * 解析某工具此刻的注册名与是否注册。
 * @param {string} memoryDir - 记忆根目录（读 tools.json）。
 * @param {boolean} live - 是否启用「工具定义联动」（运行时 toolDefsLive，**默认 false**：
 *   改名/停用会改工具面，老会话的 KV 缓存会失效，所以必须显式开）。
 * @param {string} id - 工具 id。
 * @param {string} fallbackName - 未联动时的名字。
 * @returns {{name: string, enabled: boolean}}
 */
export function resolveToolDefs(memoryDir, live, id, fallbackName) {
  if (live !== true) return { name: fallbackName, enabled: true }
  const config = loadToolsConfig(memoryDir)
  return { name: toolNameOf(config, id, fallbackName), enabled: isToolEnabled(config, id) }
}

/** 只写需要改的字段（patch 语义；`null` 表示清除该项覆盖）。 */
export function upsertToolOverride(data, id, patch) {
  const current = normalizeToolsConfig(data)
  const entry = { ...(current.overrides[id] ?? {}) }
  for (const key of ['enabled', 'name', 'description']) {
    if (!(key in patch)) continue
    if (patch[key] === null) delete entry[key]
    else if (key === 'enabled') entry.enabled = patch.enabled === true
    else {
      // 名字不能为空（空串 = 恢复默认）；描述允许空串（= 显式置空）。
      const text = key === 'name' ? textOrUndefined(patch[key]) : textOrEmpty(patch[key])
      if (text === undefined) delete entry[key]
      else entry[key] = text
    }
  }
  if (patch.params !== null && typeof patch.params === 'object') {
    const params = { ...(entry.params ?? {}) }
    for (const [key, value] of Object.entries(patch.params)) {
      if (value === null) delete params[key]
      else {
        const text = textOrEmpty(value)
        if (text === undefined) delete params[key]
        else params[key] = text
      }
    }
    if (Object.keys(params).length > 0) entry.params = params
    else delete entry.params
  }
  const overrides = { ...current.overrides }
  if (Object.keys(entry).length === 0) delete overrides[id]
  else overrides[id] = entry
  return { version: TOOLS_VERSION, overrides, custom: current.custom }
}

/** 新建一个自建工具（名字重复时拒绝）。 */
export function addCustomTool(data, input) {
  const current = normalizeToolsConfig(data)
  const name = textOrUndefined(input?.name)
  if (name === undefined || !TOOL_ID_RE.test(name)) return { ok: false, error: 'INVALID_NAME' }
  const kind = input?.action?.kind
  if (!TOOL_ACTIONS.some((a) => a.kind === kind)) return { ok: false, error: 'INVALID_ACTION' }
  if (current.custom.some((tool) => tool.name === name)) return { ok: false, error: 'NAME_TAKEN' }
  // 自建工具的 id 可自定义（2026-10-16 用户要求）：给了就用，没给自动生成。
  const requestedId = textOrUndefined(input?.id)
  const id = requestedId ?? newToolId()
  if (!TOOL_ID_RE.test(id)) return { ok: false, error: 'INVALID_ID' }
  if (BUILTIN_TOOL_IDS.includes(id) || current.custom.some((tool) => tool.id === id)) {
    return { ok: false, error: 'ID_TAKEN' }
  }
  const tool = {
    id,
    name,
    description: textOrUndefined(input.description) ?? name,
    params: Array.isArray(input.params) && input.params.length > 0 ? input.params.map((p) => String(p)) : null,
    action: {
      kind,
      fixed: input?.action?.fixed !== null && typeof input?.action?.fixed === 'object' ? { ...input.action.fixed } : {},
    },
  }
  return { ok: true, tool, data: { version: TOOLS_VERSION, overrides: current.overrides, custom: [...current.custom, tool] } }
}

/** 删除一个自建工具。 */
export function removeCustomTool(data, id) {
  const current = normalizeToolsConfig(data)
  if (!current.custom.some((tool) => tool.id === id)) return { ok: false, error: 'NOT_FOUND' }
  return {
    ok: true,
    data: { version: TOOLS_VERSION, overrides: current.overrides, custom: current.custom.filter((t) => t.id !== id) },
  }
}

/** 工具清单概览（配置页「工具」页用）。 */
export function listToolCatalog(memoryDir, builtinTools) {
  const config = loadToolsConfig(memoryDir)
  return {
    version: config.version,
    file: toolsFileOf(memoryDir),
    actions: TOOL_ACTIONS,
    builtin: builtinTools.map((tool) => ({
      id: tool.id,
      name: toolNameOf(config, tool.id, tool.name),
      defaultName: tool.name,
      // description = 「通用定义」（可编辑的那一层）；merged = 当前完整注册内容（只读展示）。
      description: toolDescriptionOf(config, tool.id, tool.description),
      defaultDescription: tool.description,
      merged: typeof tool.merged === 'string' ? tool.merged : toolDescriptionOf(config, tool.id, tool.description),
      enabled: isToolEnabled(config, tool.id),
      params: (tool.params ?? []).map((param) => ({
        key: param.key,
        description: paramDescriptionOf(config, tool.id, param.key, param.description),
        defaultDescription: param.description,
      })),
    })),
    custom: config.custom,
  }
}

/** 重置范围的归一：非字符串或空串 → `'all'`，其余原样当工具名。 */
function normalizeResetScope(scope) {
  if (typeof scope !== 'string') return 'all'
  const trimmed = scope.trim()
  return trimmed === '' ? 'all' : trimmed
}

/** 读原始 tools.json（保留未来扩展字段；缺失 / 损坏 / 非对象 → `{}`）。 */
function readRawToolsConfig(memoryDir) {
  const file = toolsFileOf(memoryDir)
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/** `raw` 顶层里不是 version/overrides/custom 的键（未来扩展字段，原样带回）。 */
function extraTopLevelKeys(raw) {
  return Object.keys(raw).filter((key) => key !== 'version' && key !== 'overrides' && key !== 'custom')
}

/** `raw.overrides` 里的对象条目（原样保留，条目内的未知子字段不丢）。 */
function rawOverrideEntries(raw) {
  const overrides = raw?.overrides
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) return {}
  const out = {}
  for (const [id, value] of Object.entries(overrides)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    out[id] = value
  }
  return out
}

/** `normalizeToolsConfig` 认识的键（其余是该层级的未来扩展字段）。 */
const KNOWN_OVERRIDE_KEYS = ['enabled', 'name', 'description', 'params']
const KNOWN_CUSTOM_KEYS = ['id', 'name', 'description', 'params', 'action']

/**
 * 磁盘上是否存着 `normalizeToolsConfig` 会丢掉的字段（顶层 / overrides 条目 /
 * custom 条目的未知键）——有就说明写盘必须保真。
 */
function hasUnknownFields(raw) {
  if (extraTopLevelKeys(raw).length > 0) return true
  for (const value of Object.values(rawOverrideEntries(raw))) {
    if (Object.keys(value).some((key) => !KNOWN_OVERRIDE_KEYS.includes(key))) return true
  }
  if (!Array.isArray(raw.custom)) return false
  return raw.custom.some((item) => item !== null && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).some((key) => !KNOWN_CUSTOM_KEYS.includes(key)))
}

/**
 * 写盘：没有未来扩展字段时走 `saveToolsConfig`；有则保真写——`saveToolsConfig`
 * 内部的 `normalizeToolsConfig` 会把未知字段规范化掉，与「不要乱删未来扩展
 * 字段」冲突。两条路径都是 tmp + rename 原子写。
 */
function writeToolsConfigKeepingExtras(memoryDir, extras, data, faithful) {
  if (!faithful) return saveToolsConfig(memoryDir, data)
  const file = toolsFileOf(memoryDir)
  try {
    mkdirSync(memoryDir, { recursive: true })
    const tmp = `${file}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify({ ...extras, ...data }, null, 2) + '\n')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 恢复默认（2026-10-15 用户需求：工具定义可恢复默认）。
 *
 * `scope`：
 *   - `'all'`（缺省）：内置工具覆盖全清（恢复出厂定义）+ 自建工具全删；
 *   - `'builtin'`：只清内置工具覆盖，保留自建工具；
 *   - 具体工具名：只清该工具名对应的覆盖。
 *
 * 读走 `loadToolsConfig`（算「被清了什么」），写默认走 `saveToolsConfig`；
 * tools.json 里存在未来扩展字段时改走保真写，避免 normalize 删掉它们。
 *
 * @param {string} memoryDir
 * @param {{scope?: string}} [opts]
 * @returns {{ok: boolean, scope?: string, cleared: string[], removedCustom: string[], error?: string}}
 *   `cleared` = 被清掉覆盖的工具 id；`removedCustom` = 被删掉的自建工具名。
 */
export function resetToolsConfig(memoryDir, opts = {}) {
  const scope = normalizeResetScope(opts?.scope)
  const current = loadToolsConfig(memoryDir)
  const raw = readRawToolsConfig(memoryDir)
  const extras = Object.fromEntries(extraTopLevelKeys(raw).map((key) => [key, raw[key]]))
  let overrides = rawOverrideEntries(raw)
  let custom = Array.isArray(raw.custom) ? raw.custom : current.custom
  const cleared = []
  const removedCustom = []
  if (scope === 'all') {
    cleared.push(...Object.keys(current.overrides))
    removedCustom.push(...current.custom.map((tool) => tool.name))
    overrides = {}
    custom = []
  } else if (scope === 'builtin') {
    cleared.push(...Object.keys(current.overrides))
    overrides = {}
  } else if (Object.hasOwn(overrides, scope) || Object.hasOwn(current.overrides, scope)) {
    cleared.push(scope)
    const rest = { ...overrides }
    delete rest[scope]
    overrides = rest
  }
  const data = { version: TOOLS_VERSION, overrides, custom }
  if (!writeToolsConfigKeepingExtras(memoryDir, extras, data, hasUnknownFields(raw))) {
    return { ok: false, error: 'WRITE_FAILED', cleared: [], removedCustom: [] }
  }
  return { ok: true, scope, cleared, removedCustom }
}
