/**
 * dsh-memory-evolve — Web GUI API.
 *
 * Serves the settings-panel data for the web half: the pending suggestion
 * queue (with approve/reject operations), the runtime-config view/update,
 * and the badge count. Registered dynamically through `ctx.inject` on the
 * `httpServer` service, so the plugin loads harmlessly on surfaces without
 * it (e.g. the TUI).
 *
 * Routes (prefix `/memory-evolve`):
 *   GET  /api/badge                       → { count }
 *   GET  /api/suggestions                 → { entries }
 *   POST /api/suggestions/approve         { indices }    → report
 *   POST /api/suggestions/reject          { indices }    → report
 *   POST /api/suggestions/archive         { indices }    → report
 *   GET  /api/archive                     → { entries }
 *   POST /api/archive/promote            { target, match } → outcome
 *   POST /api/archive/delete             { target, match } → outcome
 *   POST /api/memory/key   { sessionId, content } → key-track add outcome
 *   POST /api/memory/delete { sessionId, target, match } → exact per-entry delete outcome
 *   POST /api/memory/archive { target, match } → main-track entry → archive file (memory/user)
 *   POST /api/suggestions/approve-all                     → report
 *   POST /api/suggestions/reject-all                      → report
 *   GET  /api/config                      → { config }
 *   POST /api/config                      { patch }      → { config }
 *   GET  /api/groups                      → { memory, todo, layoutVersion, layout }
 *   POST /api/groups                      { kind, id?, …patch }
 *   POST /api/groups/rename               { kind, id, newId }
 *   GET  /api/groups/delete-preview?kind=&id= → { stats }
 *   DELETE /api/groups?kind=&id=          → { deleted: { entries, archived, locations } }
 *
 * Zero runtime dependencies (node:http only).
 *
 * @module dsh-memory-evolve/api
 */

import { URL } from 'node:url'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { translate, getLocale, MISC2_DICT } from './i18n.js'

/** Translate through MISC2_DICT in the active host locale. */
const apit = (key, params) => translate(MISC2_DICT, key, params, getLocale())
import { approveSuggestions, archiveSuggestions, promoteArchived, rejectSuggestions } from './review.js'
import { RUNTIME_KEYS, buildGuidance, gitBranch, gitBranchList } from './index.js'
import { AliasStore } from './aliases.js'
import { buildMemoryFiles } from './memory-tab.js'
import {
  GROUPS_VERSION, KLASSES, deleteGroup, deleteStatsOf, findGroup, groupArchiveDirOf, groupDirOf, groupLabel,
  groupsFileOf, kindRootOf, klassLabel, listEnabledGroups, listGroups, listGroupsByClass, loadGroups,
  memoryRootOf, newGroupId, normalizeGroupsConfig, projectIdOf, renameGroupId, saveGroups, todoRootOf,
  upsertGroup, validateGroupId,
} from './groups.js'
import { vaultCount } from './vault.js'
import { projectHash } from './store.js'
import { listBackups, migrateToVault, rollbackVault, vaultStatus } from './migrate-v2.js'
import { searchMemory } from './memory-search.js'
import {
  addCustomTool, listToolCatalog, loadToolsConfig, removeCustomTool, resetToolsConfig,
  saveToolsConfig, toolNameOf, upsertToolOverride, TOOL_ID_RE,
} from './tool-registry.js'
import { TOOL_BLOCKS, blockKeyOf, groupBlockId, isGroupBlockKey, normalizeToolBlocks, normalizeToolBlockTexts } from './tool-blocks.js'
// 开局提示词的储备文案（2026-10-19）：多份文案存文件，启用 = 写运行时 snapshotPrompt。
import { findPreset, loadPresets, removePreset, savePresets, upsertPreset } from './snapshot-presets.js'
import { approvePendingSkill, listPendingSkills, rejectPendingSkill } from './skills.js'
import { normalizeModelsPatch } from './models.js'

/**
 * 动态「分组块」定义（2026-10-16 用户：工具定义细化到每一个分组）。
 *
 * 每个启用中的记忆 / 待办分组一块，内置分组与用户自建分组**完全平等** ——
 * 没有「必须存在」的分组，插件自带分组只是不能删、不能改 id。
 * @param {string} memoryDir - 记忆根目录（读 groups.json）。
 * @returns {Array<{tool: string, id: string, label: string}>} 块定义（供配置页渲染）。
 */
function groupBlockDefinitions(memoryDir) {
  const data = loadGroups(memoryDir)
  const out = []
  for (const kind of ['memory', 'todo']) {
    const tool = kind === 'memory' ? 'memory' : 'dtodo'
    const prefix = kind === 'memory' ? '写入目标' : '待办目标'
    for (const group of listEnabledGroups(data, kind)) {
      out.push({
        tool,
        id: groupBlockId(group.id),
        label: `${prefix}：${groupLabel(group)}`,
      })
    }
  }
  return out
}

/** The pending-skill queue directory (under the memory dir). */
function pendingSkillDir(deps) {  return join(deps.config.memoryDir, 'pending-skills')
}

/**
 * 能力表的**键全集**与缺省值（全部 false）。
 *
 * 值不在这里推导：由装配层（`lib/index.js` 的 `installedFeatures`）按**控制器
 * 引用是否存在**给出（与各模块 install 条件同一来源），避免"features 说 true
 * 但路由 404"。未注入 provider 时（无装配的宿主/单测）一律 false —— 诚实降级。
 */
const FEATURE_DEFAULTS = Object.freeze({
  uiSettings: false,
  bookmarks: false,
  canvas: false,
  coi: false,
  broadcast: false,
  broadcastImage: false,
  prompts: false,
  notify: false,
  channelSend: false,
  advisor: false,
  advisorPanel: false,
  sync: false,
  session: false,
  models: false,
  memoryLibrary: false,
  todo: false,
  review: false,
  skillReview: false,
  sessionSearch: false,
  searchDocs: false,
})

/**
 * 归一能力表：只保留已知键、值强制 boolean。
 * @param {unknown} raw - 装配层给出的能力表（可为空）。
 * @returns {Record<string, boolean>} 完整能力表。
 */
function normalizeFeatures(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const [key, fallback] of Object.entries(FEATURE_DEFAULTS)) {
    out[key] = typeof source[key] === 'boolean' ? source[key] : fallback
  }
  return out
}

/** 分组 id / 改名相关错误码 → 明确中文（v3 规则见 docs/layout-v3.md §4）。 */
const GROUP_ERROR_TEXT = {
  INVALID_ID: '分组 id 非法：只允许小写字母、数字、下划线、连字符；必须以小写字母或数字开头，最长 32 字符，不能含点号',
  RESERVED_ID: '分组 id 是保留字（archive / memory / todo / system），不能使用',
  ID_TAKEN: '分组 id 已被同类的另一个分组占用（大小写不敏感）',
  TARGET_EXISTS: '目标目录已存在，改名会覆盖既有数据，已拒绝；请换一个 id',
  BUILTIN_PROTECTED: '内置分组不可改名、不可删除（可以停用，或新建一个自建分组）',
  NOT_FOUND: '分组不存在',
  DAILY_FIXED: '日志型（daily）在创建后不可更改',
  RENAME_FAILED: '分组目录改名失败（可能被占用），未改动任何配置',
  BUILTIN_KLASS_FIXED: '内置分组所属的类不可修改',
}

/** 错误码 → 中文；未知码回落调用方给的兜底文案。 */
function groupErrorText(code, fallback = '分组操作失败') {
  return GROUP_ERROR_TEXT[code] ?? fallback
}

/**
 * 布局门禁查询：未迁移 v3 时返回拒绝文案，就绪（或未注入门禁）返回 null。
 * @param {object} deps - installApi 的依赖（writesBlocked 由装配层注入）。
 * @returns {string|null} 拒绝文案。
 */
function writesBlockedMessage(deps) {
  if (typeof deps?.writesBlocked !== 'function') return null
  const blocked = deps.writesBlocked()
  return typeof blocked === 'string' && blocked !== '' ? blocked : null
}

/**
 * 写记忆 / 待办数据的路由前缀（v3 布局未就绪时统一拒绝）。
 * 除分组与记忆/待办本体外，**迁移与同步**类接口也会搬动记忆目录，必须一起拦：
 * 迁移期间点一下它们就会把半迁移的目录写坏。
 */
const MEMORY_WRITE_PREFIXES = [
  '/memory-evolve/api/groups',
  '/memory-evolve/api/memory',
  '/memory-evolve/api/archive',
  '/memory-evolve/api/suggestions',
  '/memory-evolve/api/todo',
  '/memory-evolve/api/vault',
  '/memory-evolve/memory-sync',
]

/**
 * 分组的磁盘布局信息（v3）：主轨目录 + 归档目录 + 是否日志型。
 *
 * `dir` / `archiveDir` 是**展示用**路径：缺会话 id / 项目 id 时 `groupDirOf`
 * 返回 null（无法算出具体类段），这里回退到组级路径（`<分组根>/<id>/<类段>`），
 * 让面板不至于显示空目录。读写一律走 `groupDirOf` / `groupArchiveDirOf` 的
 * 返回值，**绝不能**把兜底路径当可读写目录。
 * @param {object} group - 分组实体。
 * @param {{memoryDir: string, projectId?: string|null, sessionId?: string|null}} ctx - 路径上下文（只传 id）。
 * @returns {{dir: string|null, archiveDir: string|null, daily: boolean, klass: string, kind: string, displayOnly: boolean}}
 */
function layoutOfGroup(group, ctx) {
  const base = baseDirOfGroup(ctx?.memoryDir, group.kind ?? 'memory', group.id)
  const klass = group.klass === 'session' || group.klass === 'project' ? group.klass : 'global'
  const realDir = groupDirOf(group, ctx)
  const realArchiveDir = groupArchiveDirOf(group, ctx)
  return {
    dir: realDir ?? join(base, klass),
    archiveDir: realArchiveDir ?? join(base, 'archive', klass),
    daily: group.daily === true,
    klass: group.klass,
    kind: group.kind,
    // true = 目录只是组级兜底展示路径，不是可定位的具体目录。
    displayOnly: realDir === null,
  }
}

/**
 * 分组基目录（`<kind 根>/<id>`）：改名/删除/建骨架都以它为操作单位。
 * @param {string} memoryDir - 记忆根。
 * @param {'memory'|'todo'} kind - 分组大类。
 * @param {string} id - 分组 id。
 * @returns {string} 绝对路径。
 */
function baseDirOfGroup(memoryDir, kind, id) {
  return join(kindRootOf(memoryDir, kind), id)
}

/** 本地时间戳标签（`yyyyMMdd-HHmmss`，用于 orphan/trash 改名后缀）。 */
function stampTag() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 保证分组目录骨架存在：`<kind 根>/<id>/{global,project,session,archive}`，
 * 每个目录放一个 `.keep`（同步/打包不会丢空目录；规范 §2.3）。
 * @param {string} memoryDir - 记忆根。
 * @param {'memory'|'todo'} kind - 分组大类。
 * @param {string} id - 分组 id。
 * @returns {string} 分组基目录。
 */
function ensureGroupLayout(memoryDir, kind, id) {
  const base = join(kindRootOf(memoryDir, kind), id)
  for (const name of ['global', 'project', 'session', 'archive']) {
    const dir = join(base, name)
    mkdirSync(dir, { recursive: true })
    const keep = join(dir, '.keep')
    try {
      writeFileSync(keep, '', { flag: 'wx' })
    } catch { /* 已存在：不动 */ }
  }
  return base
}

/** Read the JSON request body (capped). */
async function readBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid JSON body')
  }
}

/**
 * 同源校验（保护本地更新端点）：要求 Content-Type 精确为 JSON 媒体类型
 * （子串匹配会放过 text/plain;charset=json 之类，CodeX 复审 P1-5）；
 * 写操作强制要求 Origin 头存在且 host 与 Host 一致——跨站表单/脚本
 * 无法构造 JSON 体、且同源 fetch 必然携带 Origin。返回错误文案或 null。
 */
function sameOriginGuard(req, body) {
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    return '请求必须为 application/json'
  }
  const host = String(req.headers.host ?? '')
  const origin = String(req.headers.origin ?? '')
  if (origin === '') return '缺少 Origin 头，已拒绝（更新必须由 Web UI 发起）'
  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch {
    return '跨站请求已拒绝'
  }
  if (originHost !== host) return '跨站请求已拒绝'
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return '请求体必须是 JSON 对象'
  }
  return null
}

/** Send a JSON response with the given status. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/** Parse `indices` from a request body; throws on invalid shapes. */
function parseIndices(body) {
  const raw = body?.indices
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new Error('indices must be a non-empty array of positive integers')
  }
  return raw
}

/** Resolve the session cwd from a request body (required for key-track ops). */
function resolveSessionCwd(body, deps) {
  const sessionId = String(body?.sessionId ?? '')
  const cwd = deps.resolveCwd?.(sessionId)
  if (!cwd) throw new Error('无法定位项目记忆：会话没有工作目录')
  return cwd
}

/**
 * Install the web API.
 * @param {object} ctx - a context with the `httpServer` service.
 * @param {object} deps - { store, archive, queue, getRuntime, updateRuntime }.
 * @returns {() => void} the httpServer registration disposer.
 */
export function installApi(ctx, deps) {
  const { store, archive, queue, todoStore, getRuntime, updateRuntime, syncToolDefs } = deps
  // 待办能力开关（todoEnabled）守卫：关闭时待办相关端点返回 503
  // TODO_DISABLED（机器可判定的错误码），数据文件不受影响。
  const todoDisabled = () => getRuntime().todoEnabled === false
  const sendTodoDisabled = (res) => sendJson(res, 503, {
    ok: false,
    code: 'TODO_DISABLED',
    error: '待办功能未启用',
  })
  // 会话别名（友好名称）：全局属性，不挂任何模块开关（随时可用）。
  // 优先用主插件共享实例（de_session rename 也写同一文件/内存缓存），
  // 未提供时自建（兼容测试等直接调用场景）
  const aliases = deps.aliases ?? new AliasStore(deps.config.memoryDir)

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const segments = path.split('/').filter(Boolean)
    try {
      // 布局门禁（v3）：迁移未完成时拒绝写记忆 / 待办数据的请求（读接口照常，
      // 界面因此能显示「需要迁移」）。配置类写接口（工具定义、运行时设置、
      // 别名）不碰记忆目录，不拦。
      if (req.method !== 'GET'
        && MEMORY_WRITE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
        const blocked = writesBlockedMessage(deps)
        if (blocked !== null) {
          sendJson(res, 409, { ok: false, code: 'LAYOUT_NOT_V3', error: blocked })
          return
        }
      }
      // 能力探测（2026-10-23 降噪）：前端启动只拉一次，按布尔值决定注册哪些
      // Tab / 按钮。**始终注册**（不受任何模块开关影响）；值来自装配层的控制器
      // 引用存在性（deps.features），带 no-store 防缓存。
      if (req.method === 'GET' && path === '/memory-evolve/api/features') {
        const features = normalizeFeatures(typeof deps.features === 'function' ? deps.features() : null)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({ ok: true, features }))
        return
      }
      // 会话别名：GET 全量（面板渲染用）/ PUT 设置 / DELETE 清除
      if (req.method === 'GET' && path === '/memory-evolve/api/aliases') {
        sendJson(res, 200, { aliases: aliases.all() })
        return
      }
      if (req.method === 'PUT' && segments.length === 4 && segments[0] === 'memory-evolve' && segments[1] === 'api' && segments[2] === 'aliases') {
        const sessionId = decodeURIComponent(segments[3])
        const body = await readBody(req)
        const result = aliases.set(sessionId, body?.name)
        sendJson(res, result.ok ? 200 : 400, result)
        return
      }
      if (req.method === 'DELETE' && segments.length === 4 && segments[0] === 'memory-evolve' && segments[1] === 'api' && segments[2] === 'aliases') {
        const sessionId = decodeURIComponent(segments[3])
        sendJson(res, 200, aliases.remove(sessionId))
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/badge') {
        // 建议计数按类拆分：suggestions=记忆类（memory/user），
        // todoSuggestions=待办类（todo-*）——两个独立的待确认 tab。
        const all = queue.read()
        const suggestions = all.filter((entry) => !entry.target.startsWith('todo-')).length
        const todoSuggestions = all.length - suggestions
        const skills = listPendingSkills(pendingSkillDir(deps)).length
        // update：版本检测模块的独立红点字段（0/1）。只读缓存状态，
        // 绝不在此执行 git 检测（30s 轮询不能触发网络操作）。
        const update = deps.updateOps ? await deps.updateOps.badgeUpdate() : 0
        // 红点开关（2026-10-13 用户需求 pendingBadge）：关掉后计数一律报 0，
        // 但**队列数据与 API 不变**（处理入口照常可用，只是不打扰用户）。
        const badgeOn = getRuntime().pendingBadge !== false
        sendJson(res, 200, {
          count: badgeOn ? suggestions + todoSuggestions + skills : 0,
          suggestions: badgeOn ? suggestions : 0,
          todoSuggestions: badgeOn ? todoSuggestions : 0,
          skills: badgeOn ? skills : 0,
          update,
          pendingBadge: badgeOn,
        })
        return
      }
      // —— 版本检测与更新（lib/update.js，一期）——
      if (req.method === 'GET' && path === '/memory-evolve/api/update/status') {
        // 状态查询：?force=1 强制重检（「检查更新」按钮）；普通调用走
        // 24h 缓存/30min 失败退避（Web UI 挂载时触发）。
        if (!deps.updateOps) { sendJson(res, 422, { ok: false, code: 'unsupported', error: '版本检测模块未装配' }); return }
        try {
          const force = url.searchParams.get('force') === '1'
          const state = await deps.updateOps.status(force)
          // DTO 白名单：内部字段（repoPath/remoteUrl/headSha/latestSha 等）
          // 不外发（CodeX 复审 P1-5）。
          sendJson(res, 200, {
            ok: true,
            status: state.status,
            latestTag: state.latestTag ?? null,
            localTag: state.localTag ?? null,
            noteCode: state.noteCode ?? '',
            lastSuccessAt: state.lastSuccessAt ?? null,
            lastAttemptAt: state.lastAttemptAt ?? null,
            lastError: state.lastError ? { kind: state.lastError.kind, message: state.lastError.message } : null,
            restartRequired: state.restartRequired === true,
            lastUpdated: state.lastUpdated ? { tag: state.lastUpdated.tag, at: state.lastUpdated.at, notes: state.lastUpdated.notes ?? '' } : null,
          })
        } catch {
          sendJson(res, 503, { ok: false, code: 'error', error: '版本检测服务内部错误' })
        }
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/update') {
        // 手动更新：必须携带用户看到的 expectedTag；JSON 体 + 同源校验
        // 防跨站表单/脚本触发本地 git 写操作。
        if (!deps.updateOps) { sendJson(res, 422, { ok: false, code: 'unsupported', error: '版本检测模块未装配' }); return }
        let body
        try {
          body = await readBody(req)
        } catch {
          sendJson(res, 400, { ok: false, code: 'bad-request', error: '请求体不是合法 JSON' })
          return
        }
        const guard = sameOriginGuard(req, body)
        if (guard) { sendJson(res, 400, { ok: false, code: 'bad-request', error: guard }); return }
        const expectedTag = String(body?.expectedTag ?? '')
        try {
          const outcome = await deps.updateOps.update(expectedTag)
          if (!outcome.ok) {
            const statusMap = { 'bad-request': 400, dirty: 409, busy: 409, 'target-changed': 409, untrusted: 422, unsupported: 422, error: 503 }
            sendJson(res, statusMap[outcome.code] ?? 500, { ok: false, code: outcome.code, error: outcome.error })
            return
          }
          sendJson(res, 200, { ok: true, tag: outcome.tag, sha: outcome.sha, releaseNotes: outcome.releaseNotes, restartRequired: outcome.restartRequired })
        } catch {
          sendJson(res, 503, { ok: false, code: 'error', error: '更新服务内部错误' })
        }
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/suggestions') {
        sendJson(res, 200, { entries: queue.read() })
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/config') {
        // Only the runtime-changeable keys are exposed (the panel echoes this
        // object back as a patch, and static config keys such as memoryDir are
        // not valid patch keys). `memoryTabEnabled` is read-only here: it is
        // NOT a runtime key anymore (the tab hosts the config panel itself, so
        // switching it off in the UI would be a self-hiding trap — it can only
        // be set through config.yaml), but the client still needs to know it
        // to decide whether to register the tab.
        const runtime = getRuntime()
        sendJson(res, 200, {
          config: {
            ...Object.fromEntries(RUNTIME_KEYS.map((key) => [key, runtime[key]])),
            memoryTabEnabled: runtime.memoryTabEnabled,
          },
        })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/config') {
        const body = await readBody(req)
        const patch = body?.patch
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new Error('patch must be an object')
        }
        sendJson(res, 200, { config: updateRuntime(patch) })
        return
      }
      // ── 开局提示词（2026-10-14 用户需求）──────────────────────────────
      // 记忆插件每轮注入的那段「固定指导文案」在设置面板里显示并可改写：
      //   GET  → { default: 内置渲染结果, custom: 用户文本, effective: 实际生效, vars: 可用占位符 }
      //   POST { text } → 保存（空串 = 恢复内置文案）
      if (req.method === 'GET' && path === '/memory-evolve/api/snapshot-prompt') {
        const runtime = getRuntime()
        const guidance = buildGuidance(runtime, {})
        const defaultText = guidance.dutiesText === ''
          ? guidance.fixedText
          : `${guidance.fixedText}\n\n${guidance.dutiesText}`
        const custom = typeof runtime.snapshotPrompt === 'string' ? runtime.snapshotPrompt : ''
        const presetsData = loadPresets(deps.config.memoryDir)
        sendJson(res, 200, {
          default: defaultText,
          custom,
          effective: custom.trim() === '' ? defaultText : custom,
          vars: ['{branch}', '{memoryTool}', '{todoTool}', '{targets}', '{reviewInterval}', '{sessionId}'],
          // 注入方式与内置文案开关（2026-10-14）：与文案同一面板读写
          injectMode: runtime.injectMode === 'section' ? 'section' : 'context',
          builtinGuidance: runtime.builtinGuidance !== false,
          // 储备文案（2026-10-19）：列表 + 当前生效的那份（按文案内容是否相同判断）
          presets: presetsData.items,
          activePresetId: presetsData.items.find((item) => item.text === custom)?.id ?? null,
        })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/snapshot-prompt') {
        const body = await readBody(req)
        // 储备文案的增改 / 删除 / 启用（2026-10-19 用户需求：多份文案作为储备配置）
        if (body?.preset !== undefined) {
          const outcome = upsertPreset(loadPresets(deps.config.memoryDir), body.preset)
          if (!outcome.ok) throw new Error(outcome.error === 'TEXT_TOO_LONG' ? '储备文案太长（≤20000 字符）' : '储备文案不存在')
          if (!savePresets(deps.config.memoryDir, outcome.data)) throw new Error('储备文案写入失败')
          sendJson(res, 200, { ok: true, presets: outcome.data.items })
          return
        }
        if (typeof body?.removePreset === 'string') {
          const outcome = removePreset(loadPresets(deps.config.memoryDir), body.removePreset)
          if (!outcome.ok) throw new Error('储备文案不存在')
          if (!savePresets(deps.config.memoryDir, outcome.data)) throw new Error('储备文案写入失败')
          sendJson(res, 200, { ok: true, presets: outcome.data.items })
          return
        }
        if (typeof body?.activatePreset === 'string') {
          const item = findPreset(loadPresets(deps.config.memoryDir), body.activatePreset)
          if (item === null) throw new Error('储备文案不存在')
          sendJson(res, 200, { config: updateRuntime({ snapshotPrompt: item.text }) })
          return
        }
        const patch = {}
        if (body?.text !== undefined) patch.snapshotPrompt = typeof body.text === 'string' ? body.text : ''
        if (body?.injectMode !== undefined) patch.injectMode = body.injectMode
        if (body?.builtinGuidance !== undefined) patch.builtinGuidance = body.builtinGuidance === true
        sendJson(res, 200, { config: updateRuntime(patch) })
        return
      }
      // ── 记忆 / 待办分组（2026-10-13 分组化；2026-10-19 磁盘布局 v3）──────
      // GET    /api/groups                       → { memory:[…], todo:[…], file, layoutVersion, layout }
      // POST   /api/groups { kind, id?, …patch }  → 新建（无 id）或更新一个分组
      // POST   /api/groups/rename { kind, id, newId } → 自建分组改名（目录 + 配置一次完成）
      // GET    /api/groups/delete-preview?kind=&id=   → { stats } 删除前统计
      // DELETE /api/groups?kind=&id=              → 删除一个**自建**分组（含目录）
      // 内置分组只能停用不能删（它们的文件与工具语义是代码约定）；自建分组删除
      // 会连同 `<kind 根>/<id>` 整目录一起删（含 archive），删除前必须看过统计。
      if (req.method === 'GET' && path === '/memory-evolve/api/groups') {
        const memoryDir = deps.config.memoryDir
        const data = loadGroups(memoryDir)
        const layout = typeof deps.layoutStatus === 'function' ? deps.layoutStatus() : null
        const sessionId = url.searchParams.get('sessionId') ?? null
        const cwd = deps.resolveCwd?.(sessionId ?? '') ?? undefined
        const projectId = cwd
          ? projectIdOf({ projectDir: deps.projectDirResolver ? deps.projectDirResolver(cwd) : projectHash(cwd) })
          : null
        const decorate = (group) => ({
          ...group,
          label: groupLabel(group),
          layout: layoutOfGroup(group, { memoryDir, projectId, sessionId }),
        })
        const memory = listGroups(data, 'memory').map(decorate)
        const todo = listGroups(data, 'todo').map(decorate)
        sendJson(res, 200, {
          memory,
          todo,
          file: groupsFileOf(memoryDir),
          // 路径字段语义（UI 用 memoryDir）：
          //   memoryDir  = 记忆根（插件全部数据的根，`.system/`、`memory/`、`todo/` 都在它下面）
          //   memoryRoot = `<记忆根>/memory`（记忆分组根，各组目录 = `memoryRoot/<分组id>/...`）
          //   todoRoot   = `<记忆根>/todo`（待办分组根）
          memoryDir,
          memoryRoot: memoryRootOf(memoryDir),
          todoRoot: todoRootOf(memoryDir),
          layoutVersion: layout === null ? null : layout.version,
          layout: layout === null
            ? null
            : {
              state: layout.state,
              expected: layout.expected,
              needsMigration: layout.needsMigration,
              migrating: layout.migrating,
              writesBlocked: layout.writesBlocked,
            },
        })
        return
      }
      // 三类分组树（2026-10-15 三类改造）：记忆 / 待办两个 kind，每个 kind 按
      // 「类」分组。每项带上该分组的目录、条目数与归档目录，供记忆页签的
      // 三级页签与配置页直接渲染（不再让前端拼路径）。
      if (req.method === 'GET' && path === '/memory-evolve/api/classes') {
        const kind = url.searchParams.get('kind') === 'todo' ? 'todo' : 'memory'
        const data = loadGroups(deps.config.memoryDir)
        const cwd = deps.resolveCwd?.() ?? undefined
        const sessionId = url.searchParams.get('sessionId') ?? undefined
        // v3：项目类只需要**项目 id**，不给任何路径（路径由 groups.js 产出）。
        const projectId = cwd
          ? projectIdOf({ projectDir: deps.projectDirResolver ? deps.projectDirResolver(cwd) : projectHash(cwd) })
          : undefined
        const tree = KLASSES.map((klass) => ({
          klass,
          label: klassLabel(klass),
          groups: listGroupsByClass(data, kind, klass).map((group) => {
            const ctx = { memoryDir: deps.config.memoryDir, projectId: projectId ?? null, sessionId: sessionId ?? null }
            const dir = groupDirOf(group, ctx)
            const archiveDir = groupArchiveDirOf(group, ctx)
            return {
              ...group,
              label: groupLabel(group),
              dir: dir ?? null,
              archiveDir: archiveDir ?? null,
              count: dir !== null ? vaultCount(dir) : 0,
              archivedCount: archiveDir !== null ? vaultCount(archiveDir) : 0,
            }
          }),
        }))
        sendJson(res, 200, { kind, tree, file: groupsFileOf(deps.config.memoryDir) })
        return
      }
      // 工具定义（2026-10-15 用户需求：工具定义可修改）——内置工具可停用 /
      // 改名 / 改描述（工具级与参数级），并可新建绑定到内置动作的自建工具。
      // 覆盖存在 <memoryDir>/tools.json，读盘失败一律回落内置定义。
      if (req.method === 'GET' && path === '/memory-evolve/api/tools') {
        const builtin = typeof deps.listBuiltinTools === 'function' ? deps.listBuiltinTools() : []
        // 工具定义分块（2026-10-16 用户）：返回块表（**分组块在前** —— 定义细化到
        // 每一个分组，内置与自建一视同仁）与当前启用状态，配置页据此渲染勾选。
        const blocks = normalizeToolBlocks(getRuntime().toolBlocks)
        const blockTexts = normalizeToolBlockTexts(getRuntime().toolBlockTexts)
        sendJson(res, 200, {
          ...listToolCatalog(deps.config.memoryDir, builtin),
          // 工具定义联动开关（2026-10-19）：开着时改名/停用才作用于模型侧工具面。
          toolDefsLive: getRuntime().toolDefsLive === true,
          blocks: {
            // 有 listToolBlocks（带默认文案与当前覆盖）就用它，否则退回裸块表。
            definitions: typeof deps.listToolBlocks === 'function'
              ? deps.listToolBlocks()
              : [...groupBlockDefinitions(deps.config.memoryDir), ...TOOL_BLOCKS],
            enabled: blocks,
            texts: blockTexts,
          },
        })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/tools') {
        const body = await readBody(req)
        const isKnownBlock = (key) => TOOL_BLOCKS.some((block) => blockKeyOf(block.tool, block.id) === key)
          || isGroupBlockKey(key)
        // ① 分块启停 + 块文案（2026-10-17 用户需求：配置页点「保存」时一次性提交，
        //    平时勾选/编辑只暂存在前端，避免"改一下就立刻换掉模型看到的定义"）。
        const runtimePatch = {}
        if (body?.blocks !== undefined) {
          if (body.blocks === null || typeof body.blocks !== 'object' || Array.isArray(body.blocks)) {
            throw new Error('blocks 必须是对象')
          }
          const next = { ...normalizeToolBlocks(getRuntime().toolBlocks) }
          for (const [key, enabled] of Object.entries(body.blocks)) {
            if (!isKnownBlock(key)) throw new Error(`未知的工具定义块 "${key}"`)
            if (typeof enabled !== 'boolean') throw new Error(`blocks["${key}"] 必须是布尔值`)
            next[key] = enabled
          }
          runtimePatch.toolBlocks = next
        }
        if (body?.blockTexts !== undefined) {
          if (body.blockTexts === null || typeof body.blockTexts !== 'object' || Array.isArray(body.blockTexts)) {
            throw new Error('blockTexts 必须是对象')
          }
          const next = { ...normalizeToolBlockTexts(getRuntime().toolBlockTexts) }
          for (const [key, text] of Object.entries(body.blockTexts)) {
            if (!isKnownBlock(key)) throw new Error(`未知的工具定义块 "${key}"`)
            if (typeof text !== 'string') throw new Error(`blockTexts["${key}"] 必须是字符串`)
            // 空串 = 恢复默认（删掉覆盖）。
            if (text.trim() === '') delete next[key]
            else next[key] = text.trim()
          }
          runtimePatch.toolBlockTexts = next
        }
        // 旧形式：单块启停（兼容仍按单块提交的调用方）。
        if (typeof body?.block === 'string' && body.block !== '') {
          const key = String(body.block)
          if (!isKnownBlock(key)) throw new Error(`未知的工具定义块 "${key}"`)
          runtimePatch.toolBlocks = {
            ...normalizeToolBlocks(runtimePatch.toolBlocks ?? getRuntime().toolBlocks),
            [key]: body.enabled !== false,
          }
        }
        if (Object.keys(runtimePatch).length > 0) updateRuntime(runtimePatch)
        // 只改块、没带工具 id：到此为止。
        if (typeof body?.id !== 'string' || body.id === '') {
          if (Object.keys(runtimePatch).length === 0) throw new Error('id 不能为空')
          sendJson(res, 200, {
            ok: true,
            blocks: normalizeToolBlocks(getRuntime().toolBlocks),
            texts: normalizeToolBlockTexts(getRuntime().toolBlockTexts),
          })
          return
        }
        const current = loadToolsConfig(deps.config.memoryDir)
        if (body?.mode === 'custom') {
          const outcome = addCustomTool(current, body.tool ?? {})
          if (!outcome.ok) {
            const why = outcome.error === 'NAME_TAKEN' ? '工具名已被占用'
              : outcome.error === 'ID_TAKEN' ? '工具 id 已被占用'
                : outcome.error === 'INVALID_ID' ? '工具 id 非法（小写字母/数字/._-，最长 40 字符）'
                  : '工具名非法（小写字母/数字/._-，最长 40 字符）或动作未选择'
            throw new Error(why)
          }
          if (!saveToolsConfig(deps.config.memoryDir, outcome.data)) throw new Error('工具配置写入失败')
          sendJson(res, 200, { ok: true, tool: outcome.tool })
          return
        }
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') throw new Error('id 不能为空')
        // 改名先挡两道：格式（模型调用标识，只允许 a-z 0-9 . _ -）与撞名
        // （重名会让工具注册抛错，可能留下半套工具面；2026-10-19 核实员指出）。
        const requestedName = typeof body?.patch?.name === 'string' ? body.patch.name.trim() : ''
        if (requestedName !== '') {
          if (!TOOL_ID_RE.test(requestedName)) throw new Error('工具名只能用 a-z 0-9 . _ -（≤40 字符）')
          // 比的是"其它工具在联动开启时实际会用的名字"（tools.json 覆盖优先），
          // 否则两个覆盖名互撞检测不到，只会在注册时抛错。
          const toolsConfig = loadToolsConfig(deps.config.memoryDir)
          const others = typeof deps.listBuiltinTools === 'function' ? deps.listBuiltinTools() : []
          const clash = others.find((tool) => tool.id !== id && toolNameOf(toolsConfig, tool.id, tool.name) === requestedName)
          if (clash !== undefined) throw new Error(`工具名「${requestedName}」已被 ${clash.id} 占用`)
        }
        const next = upsertToolOverride(current, id, body?.patch ?? {})
        if (!saveToolsConfig(deps.config.memoryDir, next)) throw new Error('工具配置写入失败')
        // 工具定义联动开启时，改名/停用要立刻作用到工具面（否则保存了也没效果）。
        if (typeof syncToolDefs === 'function') syncToolDefs()
        sendJson(res, 200, { ok: true, overrides: next.overrides })
        return
      }
      if (req.method === 'DELETE' && path === '/memory-evolve/api/tools') {
        const id = url.searchParams.get('id') ?? ''
        const current = loadToolsConfig(deps.config.memoryDir)
        const outcome = removeCustomTool(current, id)
        if (!outcome.ok) throw new Error('自建工具不存在')
        if (!saveToolsConfig(deps.config.memoryDir, outcome.data)) throw new Error('工具配置写入失败')
        sendJson(res, 200, { ok: true })
        return
      }
      // 恢复默认（2026-10-15 用户需求：工具定义可恢复默认）——scope 缺省 'all'
      // 把内置工具恢复出厂定义并删掉全部自建工具；'builtin' 只清内置覆盖、
      // 保留自建工具；给具体工具名则只清该工具的覆盖。返回被清的清单，
      // 前端据此提示用户丢了什么。
      if (req.method === 'POST' && path === '/memory-evolve/api/tools/reset') {
        const body = await readBody(req)
        const outcome = resetToolsConfig(deps.config.memoryDir, { scope: body?.scope })
        if (!outcome.ok) throw new Error('工具配置写入失败')
        if (typeof syncToolDefs === 'function') syncToolDefs()
        sendJson(res, 200, outcome)
        return
      }
      // 存储格式迁移状态（配置页「数据」页）：当前版本、待迁文件数、已有备份。
      if (req.method === 'GET' && path === '/memory-evolve/api/vault/status') {
        const status = vaultStatus(deps.config.memoryDir)
        sendJson(res, 200, { ...status, memoryDir: deps.config.memoryDir })
        return
      }
      // 执行迁移（后台自动跑的同一入口，配置页也可手动触发）。
      if (req.method === 'POST' && path === '/memory-evolve/api/vault/migrate') {
        // 双重门禁：前缀门禁之外，这里再查一次（vault 迁移会搬动记忆目录，最危险）。
        const blocked = writesBlockedMessage(deps)
        if (blocked !== null) { sendJson(res, 409, { ok: false, code: 'LAYOUT_NOT_V3', error: blocked }); return }
        const body = await readBody(req)
        const report = migrateToVault(deps.config.memoryDir, { dryRun: body?.dryRun === true })
        sendJson(res, 200, report)
        return
      }
      // 回滚到某个备份（新位置的文件不动，只把备份搬回原位并清版本标记）。
      if (req.method === 'POST' && path === '/memory-evolve/api/vault/rollback') {
        const blocked = writesBlockedMessage(deps)
        if (blocked !== null) { sendJson(res, 409, { ok: false, code: 'LAYOUT_NOT_V3', error: blocked }); return }
        const body = await readBody(req)
        const backups = listBackups(deps.config.memoryDir)
        const target = typeof body?.backup === 'string' && body.backup !== '' ? body.backup : backups[0]
        if (!target) throw new Error('没有可用的备份')
        if (!backups.includes(target)) throw new Error('备份目录不在清单里（只允许回滚本插件创建的备份）')
        sendJson(res, 200, rollbackVault(deps.config.memoryDir, target))
        return
      }
      // 记忆检索（网页端搜索框直接复用工具侧同一套加权检索）。
      if (req.method === 'GET' && path === '/memory-evolve/api/search') {
        const payload = searchMemory({
          store: deps.store,
          memoryDir: deps.config.memoryDir,
          groupsData: loadGroups(deps.config.memoryDir),
          query: url.searchParams.get('q') ?? '',
          groupId: url.searchParams.get('group') ?? undefined,
          klass: url.searchParams.get('klass') ?? undefined,
          includeArchived: url.searchParams.get('archived') === '1',
          limit: Number(url.searchParams.get('limit') ?? 20),
        })
        sendJson(res, 200, payload)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/groups') {
        const body = await readBody(req)
        const kind = body?.kind === 'todo' ? 'todo' : body?.kind === 'memory' ? 'memory' : null
        if (kind === null) throw new Error('kind 必须是 memory 或 todo')
        const memoryDir = deps.config.memoryDir
        const current = loadGroups(memoryDir)
        const patch = { ...body }
        // 新建时 id 可省略（自动分配）；给了就必须符合 v3 规则（形状 + 保留字 + 撞名）。
        // 同 id 已存在 = 走更新（历史语义不变）——更新的 id 不变，不再校验
        // （内置 id 本身就是保留字，重校验会把「改内置分组开关」全挡掉）。
        const idGiven = typeof patch.id === 'string' && patch.id.trim() !== ''
        if (idGiven) {
          patch.id = patch.id.trim().toLowerCase()
          if (findGroup(current, kind, patch.id) === null) {
            const check = validateGroupId(patch.id, { kind, data: current })
            if (!check.ok) {
              sendJson(res, 400, { ok: false, code: check.error, error: groupErrorText(check.error) })
              return
            }
          }
        } else {
          patch.id = newGroupId(current) // 新建：分配一个不冲突的 id
        }
        const created = findGroup(current, kind, patch.id) === null
        const outcome = upsertGroup(current, kind, patch)
        if (!outcome.ok) {
          sendJson(res, 400, { ok: false, code: outcome.error, error: groupErrorText(outcome.error) })
          return
        }
        let orphanDir = null
        if (!created) {
          // 更新：只改配置（目录已存在或按需在写入时创建）。
          if (!saveGroups(memoryDir, outcome.data)) throw new Error('分组配置写入失败')
        } else {
          // 新建（M5 顺序）：隔离同名孤儿目录 → 建骨架 → 最后写配置。
          // 任一步失败都保持"配置与目录同进退"（配置绝不先落盘）。
          const base = baseDirOfGroup(memoryDir, kind, outcome.group.id)
          if (existsSync(base)) {
            let entries = []
            try { entries = readdirSync(base) } catch { entries = [] }
            if (entries.length > 0) {
              // 孤儿目录（同 id 的旧数据）：改名隔离，新分组从空目录开始。
              const aside = `${base}..orphan-${stampTag()}`
              try {
                renameSync(base, aside)
                orphanDir = aside
              } catch (error) {
                sendJson(res, 500, {
                  ok: false,
                  code: 'ORPHAN_MOVE_FAILED',
                  error: `同名目录已存在且非空，隔离失败（配置未写入）：${error?.message ?? error}`,
                })
                return
              }
            } else {
              try { rmSync(base, { recursive: true, force: true }) } catch { /* 空目录删不掉：骨架会复用 */ }
            }
          }
          try {
            ensureGroupLayout(memoryDir, kind, outcome.group.id)
          } catch (error) {
            let orphanNote = ''
            if (orphanDir !== null) {
              let restored = false
              try {
                renameSync(orphanDir, base)
                restored = true
              } catch {
                restored = false
              }
              orphanNote = restored
                ? `；同名目录已复原为 ${base}`
                : `；同名目录仍名为 ${orphanDir}，请手工改回 ${base}`
            }
            sendJson(res, 500, {
              ok: false,
              code: 'LAYOUT_CREATE_FAILED',
              error: `分组目录创建失败（配置未写入）：${error?.message ?? error}${orphanNote}`,
            })
            return
          }
          if (!saveGroups(memoryDir, outcome.data)) {
            // 配置写失败：撤掉刚建的骨架，把隔离的孤儿改回去（复原结果如实写进文案）。
            let skeletonRemoved = true
            try { rmSync(base, { recursive: true, force: true }) } catch { skeletonRemoved = false }
            let orphanNote = ''
            if (orphanDir !== null) {
              let restored = false
              try {
                renameSync(orphanDir, base)
                restored = true
              } catch {
                restored = false
              }
              orphanNote = restored
                ? `；同名目录已复原为 ${base}`
                : `；同名目录仍名为 ${orphanDir}，请手工改回 ${base}`
            }
            throw new Error(`分组配置写入失败（${skeletonRemoved ? '已删除新建的空骨架' : `空骨架删不掉，仍留在 ${base}`}${orphanNote}）`)
          }
        }
        sendJson(res, 200, {
          ok: true,
          group: outcome.group,
          orphanDir,
          message: orphanDir === null
            ? undefined
            : `同名目录已有内容，已改名为 ${orphanDir}，新分组从空目录开始`,
          memory: listGroups(outcome.data, 'memory'),
          todo: listGroups(outcome.data, 'todo'),
        })
        return
      }
      // 自建分组改名（v3）：目录一次 rename，配置随之改 id；归档在 id 目录内自动跟随。
      if (req.method === 'POST' && path === '/memory-evolve/api/groups/rename') {
        const body = await readBody(req)
        const kind = body?.kind === 'todo' ? 'todo' : body?.kind === 'memory' ? 'memory' : null
        if (kind === null) throw new Error('kind 必须是 memory 或 todo')
        const id = String(body?.id ?? '').trim()
        const newId = String(body?.newId ?? '').trim().toLowerCase()
        if (id === '') throw new Error('id 不能为空')
        if (newId === '') throw new Error('newId 不能为空')
        const memoryDir = deps.config.memoryDir
        const current = loadGroups(memoryDir)
        const target = findGroup(current, kind, id)
        if (target === null) {
          sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: groupErrorText('NOT_FOUND') })
          return
        }
        if (target.builtin) {
          sendJson(res, 400, { ok: false, code: 'BUILTIN_PROTECTED', error: groupErrorText('BUILTIN_PROTECTED') })
          return
        }
        // 配置里有、目录还没建（老数据）：先把骨架补上，改名才不会白跑一次。
        try {
          ensureGroupLayout(memoryDir, kind, id)
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'LAYOUT_CREATE_FAILED', error: `分组目录准备失败（未改名）：${error?.message ?? error}` })
          return
        }
        const outcome = renameGroupId(memoryDir, kind, id, newId, current)
        if (!outcome.ok) {
          const status = outcome.error === 'NOT_FOUND' ? 404 : 400
          sendJson(res, status, { ok: false, code: outcome.error, error: groupErrorText(outcome.error) })
          return
        }
        // renameGroupId 可能已带回新配置（paths-core 版本）；没有就按新 id 重写配置。
        const nextData = outcome.data ?? {
          version: GROUPS_VERSION,
          groups: current.groups.map((group) => (group.kind === kind && group.id === id ? { ...group, id: newId } : group)),
        }
        if (!saveGroups(memoryDir, nextData)) {
          // A3：目录已改成 newId 而配置仍是 oldId → 分组会在界面"消失"。
          // 反向 rename 回 oldId（配置此刻仍认 oldId，所以不能经 renameGroupId 的
          // 撞名校验，直接改目录）；回滚也失败就把手工恢复路径写进错误文案。
          let rolledBack = false
          if (outcome.moved === true) {
            try {
              renameSync(baseDirOfGroup(memoryDir, kind, newId), baseDirOfGroup(memoryDir, kind, id))
              rolledBack = true
            } catch {
              rolledBack = false
            }
          }
          throw new Error(rolledBack
            ? '分组配置写入失败（目录已回滚到原 id，未改名）'
            : `分组配置写入失败且目录回滚失败：磁盘目录现为 ${baseDirOfGroup(memoryDir, kind, newId)}，配置仍为 ${id}，请手工把该目录改名回 ${id}`)
        }
        if (outcome.moved === true) ensureGroupLayout(memoryDir, kind, newId)
        const saved = loadGroups(memoryDir)
        sendJson(res, 200, {
          ok: true,
          from: id,
          to: newId,
          moved: outcome.moved === true,
          group: findGroup(saved, kind, newId),
          memory: listGroups(saved, 'memory'),
          todo: listGroups(saved, 'todo'),
        })
        return
      }
      // 删除前统计（v3 规范 §6）：entries / archived / locations。
      if (req.method === 'GET' && path === '/memory-evolve/api/groups/delete-preview') {
        const kind = url.searchParams.get('kind') === 'todo' ? 'todo' : 'memory'
        const id = url.searchParams.get('id') ?? ''
        if (id === '') throw new Error('id 不能为空')
        const memoryDir = deps.config.memoryDir
        const group = findGroup(loadGroups(memoryDir), kind, id)
        if (group === null) {
          sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: groupErrorText('NOT_FOUND') })
          return
        }
        sendJson(res, 200, {
          ok: true,
          kind,
          id,
          builtin: group.builtin === true,
          deletable: group.builtin !== true,
          stats: deleteStatsOf(memoryDir, kind, id),
          layout: layoutOfGroup(group, { memoryDir }),
        })
        return
      }
      if (req.method === 'DELETE' && path === '/memory-evolve/api/groups') {
        const kind = url.searchParams.get('kind') === 'todo' ? 'todo' : 'memory'
        const id = url.searchParams.get('id') ?? ''
        if (id === '') throw new Error('id 不能为空')
        const memoryDir = deps.config.memoryDir
        const current = loadGroups(memoryDir)
        const target = findGroup(current, kind, id)
        if (target === null) {
          sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: groupErrorText('NOT_FOUND') })
          return
        }
        if (target.builtin) {
          sendJson(res, 400, { ok: false, code: 'BUILTIN_PROTECTED', error: groupErrorText('BUILTIN_PROTECTED') })
          return
        }
        // 先取统计（返回给调用方核验），再走"配置与目录同进退"：
        // ① 目录先改名进垃圾桶（原子、可逆）② 写配置 ③ 配置失败则把目录改回来
        // ④ 都成功才真删垃圾桶。任一步失败都不会出现"配置没了、目录还在"。
        const stats = deleteStatsOf(memoryDir, kind, id)
        const outcome = deleteGroup(current, kind, id)
        if (!outcome.ok) {
          sendJson(res, 400, { ok: false, code: outcome.error, error: groupErrorText(outcome.error) })
          return
        }
        const base = baseDirOfGroup(memoryDir, kind, id)
        const trash = `${base}..deleting-${stampTag()}`
        let parked = false
        if (existsSync(base)) {
          try {
            renameSync(base, trash)
            parked = true
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              code: 'DELETE_DIR_BUSY',
              error: `分组目录被占用，未删除（配置未改）：${error?.message ?? error}`,
            })
            return
          }
        }
        if (!saveGroups(memoryDir, outcome.data)) {
          // 配置写失败：把目录从垃圾桶改回原 id（复原结果如实写进文案）。
          let restored = !parked
          if (parked) {
            try {
              renameSync(trash, base)
              restored = true
            } catch {
              restored = false
            }
          }
          throw new Error(restored
            ? '分组配置写入失败（目录已还原，未删除）'
            : `分组配置写入失败且目录复原失败：目录现名为 ${trash}，请手工改回 ${base}`)
        }
        if (parked) {
          try { rmSync(trash, { recursive: true, force: true }) } catch { /* 删不掉：留 trash 目录 */ }
        }
        sendJson(res, 200, {
          ok: true,
          kind,
          id,
          deleted: stats,
          memory: listGroups(outcome.data, 'memory'),
          todo: listGroups(outcome.data, 'todo'),
        })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/suggestions/approve') {
        const body = await readBody(req)
        const indices = parseIndices(body)
        const rawEdits = body?.contents
        let edits
        if (rawEdits !== undefined) {
          if (!Array.isArray(rawEdits) || rawEdits.length !== indices.length
            || rawEdits.some((c) => typeof c !== 'string')) {
            throw new Error('contents must be a string array aligned with indices')
          }
          edits = new Map(indices.map((index, i) => [index, rawEdits[i]]))
        }
        // Per-index target override: { "1": "key", "2": "user" } — re-classify
        // a fact into one of the three memory tracks; absent = the recommended
        // target. (Todo suggestions keep their track; the panel offers the
        // memory trio only.)
        const VALID_TARGETS = new Set(listEnabledGroups(loadGroups(deps.config.memoryDir), 'memory').map((g) => g.id))
        const rawTargets = body?.targets
        let targets
        if (rawTargets !== undefined) {
          if (rawTargets === null || typeof rawTargets !== 'object' || Array.isArray(rawTargets)) {
            throw new Error('targets must be an object of index → target')
          }
          targets = new Map()
          for (const [key, value] of Object.entries(rawTargets)) {
            const index = Number(key)
            const target = String(value)
            if (!Number.isInteger(index) || index < 1) throw new Error(`无效的建议序号 "${key}"`)
            if (!VALID_TARGETS.has(target)) throw new Error(`无效的采纳目标 "${target}"`)
            targets.set(index, target)
          }
        }
        const report = approveSuggestions(store, todoStore, queue, indices, undefined, edits, targets, { isTodoEnabled: () => !todoDisabled() })
        sendJson(res, 200, report)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/suggestions/reject') {
        const body = await readBody(req)
        const report = rejectSuggestions(queue, parseIndices(body))
        sendJson(res, 200, report)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/suggestions/archive') {
        const body = await readBody(req)
        const report = archiveSuggestions(archive, queue, parseIndices(body))
        sendJson(res, 200, report)
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/archive') {
        const sessionId = url.searchParams.get('sessionId')
        const cwd = deps.resolveCwd?.(sessionId)
        // 展示剥离：归档条目含身份证 [id:…]（跨设备合并锚点），Tab 展示一律
        // 剥掉（施工图 §4.7；转正操作走原文匹配，不受影响）
        const strip = (content) => content.replace(/^\[id:[0-9a-f]{8}\]\s*/, '')
        // 归档页要覆盖**所有记忆分组**（kb / project / daily / session 与用户自建分组）——
        // 此前只列 memory / user / key 三轨，kb 之类分组归档后在这一页根本看不到。
        // 会话类需要会话 id、项目类需要工作目录，条件不足的分组跳过（不报错、不影响别人）。
        const entries = []
        for (const group of listGroups(loadGroups(deps.config.memoryDir), 'memory')) {
          const needsSession = group.klass === 'project' || group.klass === 'session'
          if (group.klass === 'project' && !cwd) continue
          if (group.klass === 'session' && (sessionId === null || sessionId === '')) continue
          try {
            for (const content of archive.entriesOf(group.id, needsSession ? cwd : undefined, sessionId ?? undefined)) {
              entries.push({ target: group.id, content: strip(content) })
            }
          } catch {
            // 该分组没有归档目录 / 无法定位：跳过它，不影响其它分组
          }
        }
        // 待办归档（2026-10-15 与记忆同一套目录模型）：按待办分组逐个读，
        // 归档轨写作 `todo-<组id>`。会话类需要会话 id、项目类需要工作目录，
        // 条件不足的分组跳过（不影响别人）。
        for (const group of listGroups(loadGroups(deps.config.memoryDir), 'todo')) {
          const needsSession = group.klass === 'project' || group.klass === 'session'
          if (group.klass === 'project' && !cwd) continue
          if (group.klass === 'session' && (sessionId === null || sessionId === '')) continue
          try {
            for (const content of archive.entriesOf(`todo-${group.id}`, needsSession ? cwd : undefined, sessionId ?? undefined)) {
              entries.push({ target: `todo-${group.id}`, content: strip(content) })
            }
          } catch {
            // 该分组没有归档目录 / 无法定位：跳过
          }
        }
        // 旧的单文件轨 TODO-archive.md：保留只读兼容（新归档一律进目录模型）
        for (const content of archive.entriesOf('todo-archive')) {
          entries.push({ target: 'todo-archive', content: strip(content) })
        }
        sendJson(res, 200, { entries })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/archive/promote') {
        const body = await readBody(req)
        const target = String(body?.target ?? '')
        const match = String(body?.match ?? '').trim()
        const isTodo = target.startsWith('todo-')
        if (isTodo && todoDisabled()) {
          sendTodoDisabled(res)
          return
        }
        // 任意记忆分组都能转正（含 kb / 自建分组）；todo-* 走建议队列的归档文件。
        const promoteGroup = isTodo ? null : findGroup(loadGroups(deps.config.memoryDir), 'memory', target)
        if (!isTodo && promoteGroup === null) throw new Error(`无效的归档轨 "${target}"（记忆分组 id 或 todo-*）`)
        if (!match) throw new Error('match 不能为空')
        // 待办分组同样按类解析：项目类待办要工作目录（会话类由 sessionId 定位，
        // 两者都不需要的全局类不用解析）。
        const promoteTodoGroup = isTodo && target !== 'todo-archive'
          ? findGroup(loadGroups(deps.config.memoryDir), 'todo', target.slice(5))
          : null
        const needsCwd = (promoteGroup !== null && (promoteGroup.klass === 'project' || promoteGroup.klass === 'session'))
          || (promoteTodoGroup !== null && promoteTodoGroup.klass === 'project')
        const cwd = needsCwd ? resolveSessionCwd(body, deps) : undefined
        const sid = String(body?.sessionId ?? '')
        const outcome = promoteArchived(store, todoStore, archive, target, match, cwd, sid || undefined)
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/archive/delete') {
        const body = await readBody(req)
        const target = String(body?.target ?? '')
        const match = String(body?.match ?? '').trim()
        const isTodo = target.startsWith('todo-')
        if (isTodo && todoDisabled()) {
          sendTodoDisabled(res)
          return
        }
        // 任意记忆分组都能删归档条目（含 kb / 自建分组）；待办归档同样放开
        // （`todo-<组id>` 进该分组自己的归档目录，`todo-archive` 是旧单文件轨）。
        const deleteGroupEntry = isTodo ? null : findGroup(loadGroups(deps.config.memoryDir), 'memory', target)
        if (!isTodo && deleteGroupEntry === null) throw new Error(`无效的归档轨 "${target}"（记忆分组 id 或 todo-*）`)
        if (!match) throw new Error('match 不能为空')
        const deleteTodoGroup = isTodo && target !== 'todo-archive'
          ? findGroup(loadGroups(deps.config.memoryDir), 'todo', target.slice(5))
          : null
        if (isTodo && target !== 'todo-archive' && deleteTodoGroup === null) {
          throw new Error(`无效的待办归档轨 "${target}"`)
        }
        const deleteNeedsCwd = (deleteGroupEntry !== null && (deleteGroupEntry.klass === 'project' || deleteGroupEntry.klass === 'session'))
          || (deleteTodoGroup !== null && deleteTodoGroup.klass === 'project')
        const cwd = deleteNeedsCwd ? resolveSessionCwd(body, deps) : undefined
        const outcome = archive.remove(target, match, cwd, String(body?.sessionId ?? '') || undefined)
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/suggestions/approve-all') {
        const all = Array.from({ length: queue.read().length }, (_, i) => i + 1)
        sendJson(res, 200, approveSuggestions(store, todoStore, queue, all, undefined, undefined, undefined, { isTodoEnabled: () => !todoDisabled() }))
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/suggestions/reject-all') {
        const all = Array.from({ length: queue.read().length }, (_, i) => i + 1)
        sendJson(res, 200, rejectSuggestions(queue, all))
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/reveal') {
        const body = await readBody(req)
        const target = body?.target
        const resolved = deps.resolveRevealTarget?.(target)
        if (resolved === undefined) {
          throw new Error(`未知的打开目标 "${target}"`)
        }
        // revealPath rejects when no open command is available (e.g. WSL
        // without xdg-utils): surface that to the panel instead of silently
        // swallowing the click.
        await deps.revealPath(resolved)
        sendJson(res, 200, { ok: true, path: resolved })
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/memory-sync/status') {
        // 记忆同步状态（施工图 §6）：syncEnabled 时返回项目同步状态
        // （initialized/uncommitted/behind/conflicts/remoteBranch），
        // 未启用/未初始化如实返回（前端据此显示最小状态行）。
        const sessionId = url.searchParams.get('sessionId')
        const cwd = deps.resolveCwd?.(sessionId)
        const status = deps.syncStatus ? deps.syncStatus(cwd) : { enabled: false, initialized: false }
        // 附加迁移提示（旧目录可见性，migrate 命令的 UI 数据面）
        if (status.enabled && cwd && deps.syncOps) {
          status.migrateFrom = deps.syncOps.migrate(cwd) // null = 无旧目录
        }
        sendJson(res, 200, status)
        return
      }
      if (path === '/memory-evolve/memory-sync/setup') {
        // 初始化（记忆同步 Tab）：POST { sessionId, url? }——无 url=模式 A
        // （复用主仓库 remote）；url=模式 B 私有记忆仓库
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) { sendJson(res, 400, { ok: false, error: '无法定位会话工作目录' }); return }
        const url = typeof body?.url === 'string' && body.url.trim() !== '' ? body.url.trim() : undefined
        const outcome = await deps.syncOps.setup(cwd, url)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (path === '/memory-evolve/memory-sync/sync') {
        // 同步（记忆同步 Tab）：POST { sessionId, push? }——push=true 即用户
        // 显式同意推送（需求 #12：push 永远需用户同意，UI 点击即同意）
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) { sendJson(res, 400, { ok: false, error: '无法定位会话工作目录' }); return }
        const outcome = await deps.syncOps.sync(cwd, body?.push === true)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (path === '/memory-evolve/memory-sync/off') {
        // 停用同步（记忆同步 Tab）：POST { sessionId }——**项目级停用**
        // （三层开关第 2 层：PROVENANCE.enabled=false，记忆全保留），
        // 不影响全局模块开关与其他项目
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) { sendJson(res, 400, { ok: false, error: '无法定位会话工作目录' }); return }
        const outcome = await deps.syncOps.off(cwd)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (path === '/memory-evolve/memory-sync/project-enabled') {
        // 项目级同步开关（三层开关第 2 层）：POST { sessionId, enabled }
        //   enabled=true → 未初始化走 setup；已初始化写 PROVENANCE.enabled=true
        //   enabled=false → 项目停用（记忆保留）
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) { sendJson(res, 400, { ok: false, error: '无法定位会话工作目录' }); return }
        const outcome = await deps.syncOps.setProjectEnabled(cwd, body?.enabled === true)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (path === '/memory-evolve/memory-sync/track') {
        // 轨级开关（三层开关第 3 层）：POST { sessionId, on }——一期唯一轨=
        // 项目记忆（KEY/日志/归档）；全局轨二期独立开关
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) { sendJson(res, 400, { ok: false, error: '无法定位会话工作目录' }); return }
        const outcome = deps.syncOps.setTrack(cwd, body?.on === true)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (path === '/memory-evolve/memory-sync/conflicts') {
        // 冲突列表（记忆同步 Tab）：GET ?sessionId=&fileset=
        // fileset 可选（2026-08-11 用户反馈：全局轨冲突也要能查/解决）：
        //   缺省 = project（项目轨）；memory-global/user-global/daily-global/
        //   todo-global = 全局各轨
        const sessionId = url.searchParams.get('sessionId')
        const cwd = deps.resolveCwd?.(sessionId)
        const fileset = url.searchParams.get('fileset') ?? undefined
        sendJson(res, 200, { conflicts: cwd ? deps.syncOps.conflicts(cwd, fileset) : [] })
        return
      }
      if (path === '/memory-evolve/memory-sync/resolve') {
        // 解决冲突（记忆同步 Tab）：POST { sessionId, index, choice, fileset? }
        // fileset 语义同 /conflicts（缺省 project；全局轨传 *-global）
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) { sendJson(res, 400, { ok: false, error: '无法定位会话工作目录' }); return }
        const index = Number(body?.index)
        const choice = String(body?.choice ?? '')
        const fileset = typeof body?.fileset === 'string' && body.fileset.trim() !== '' ? body.fileset.trim() : undefined
        if (!Number.isInteger(index) || index < 1 || !['ours', 'theirs', 'both'].includes(choice)) {
          sendJson(res, 400, { ok: false, error: 'index 必须为正整数，choice 必须为 ours/theirs/both' })
          return
        }
        const outcome = await deps.syncOps.resolve(cwd, index, choice, fileset)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '', remaining: outcome.remaining ?? 0 })
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/memory-sync/global-status') {
        // 全局轨状态（记忆同步 Tab「全局记忆同步」区）：设备级（全局记忆
        // 仓库 = 记忆根目录 .git），返回 initialized/url/tracks/uncommitted
        const status = deps.syncOps ? deps.syncOps.globalStatus() : { initialized: false, url: '', tracks: {}, uncommitted: 0 }
        sendJson(res, 200, status)
        return
      }
      if (path === '/memory-evolve/memory-sync/global-track') {
        // 全局轨开关：POST { sessionId, track, on }——track ∈ memory/user/daily/todo
        const body = await readBody(req)
        const track = String(body?.track ?? '')
        const outcome = deps.syncOps ? deps.syncOps.setGlobalTrack(track, body?.on === true) : { kind: 'error', text: apit('api.syncNotAssembled') }
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (path === '/memory-evolve/memory-sync/global-sync') {
        // 全局轨同步：POST { sessionId, push? }——push=true 即用户显式同意推送
        const body = await readBody(req)
        if (!deps.syncOps) { sendJson(res, 400, { ok: false, error: '同步模块未装配' }); return }
        const outcome = await deps.syncOps.globalSync(body?.push === true)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (path === '/memory-evolve/memory-sync/global-remote') {
        // 启用/停用共享记忆库（设备级，「共享记忆库」子 Tab）：POST
        // { url?, enabled? }——enabled=false 停用（数据保留）；enabled=true
        // 保存地址并启用（只初始化/绑定全局记忆仓库，不碰当前项目，
        // 2026-08-11 用户拍板）
        const body = await readBody(req)
        if (!deps.syncOps) { sendJson(res, 400, { ok: false, error: '同步模块未装配' }); return }
        const outcome = await deps.syncOps.setGlobalRemote(String(body?.url ?? ''), body?.enabled !== false)
        sendJson(res, 200, { ok: outcome.kind === 'success', text: outcome.text ?? '' })
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/memory-files') {
        const sessionId = url.searchParams.get('sessionId')
        const cwd = deps.resolveCwd?.(sessionId)
        // buildMemoryFiles 返回 { files, classes }（2026-10-15 三类改造）：
        // files 是旧版扁平行（向后兼容），classes 是三类树（记忆页签的
        // 一级+二级页签按它渲染）。这里**展开**成顶层字段，前端拿到的形状
        // 最直接；同时保留 files 为数组，老代码路径不受影响。
        //
        // 第三参传 **agent 对象**（不是裸 cwd）：会话类分组的目录带会话 id，
        // 只传 cwd 会让会话类整类"不可用"（path=undefined）。
        const built = buildMemoryFiles(
          deps.config,
          deps.store,
          sessionId !== null && sessionId !== ''
            ? { session: { id: sessionId, header: cwd === undefined ? {} : { cwd } } }
            : cwd,
        )
        sendJson(res, 200, {
          files: Array.isArray(built?.files) ? built.files : [],
          classes: Array.isArray(built?.classes) ? built.classes : [],
          cwd: cwd ?? null,
          // Branch scope for the KEY tab: current branch + all local branches
          // ([] / null outside git — the tab then hides branch controls).
          branch: cwd ? gitBranch(cwd) ?? null : null,
          branches: cwd ? gitBranchList(cwd) : [],
        })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/key/scope') {
        // Set the branch scope of one KEY entry from the memory tab. An
        // empty `branches` array means "全部" (the tag is removed — 全部
        // wins over any branch selection).
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) throw new Error('无法定位项目关键记忆：会话没有工作目录')
        const match = String(body?.match ?? '').trim()
        if (!match) throw new Error('match 不能为空')
        const rawBranches = body?.branches
        if (rawBranches !== undefined && !Array.isArray(rawBranches)) throw new Error('branches 必须是字符串数组')
        const branches = (rawBranches ?? []).map((b) => String(b).trim()).filter((b) => b.length > 0)
        const outcome = store.setEntryBranches('key', match, branches, { session: { header: { cwd } } })
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && (path === '/memory-evolve/api/memory/memory' || path === '/memory-evolve/api/memory/user' || path === '/memory-evolve/api/memory/kb')) {
        // 记忆 Tab 的手动全局轨写入（issue #30，2026-09-04）：用户在
        // MEMORY.md（全局事实）、USER.md（用户档案）或 KB.md（记忆知识库，
        // 第六轨，2026-10-11）页签顶部输入一条内容，宿主端盖戳追加到对应
        // 文件；memory/user 下一次快照渲染即全局注入，kb 永不注入（只供
        // 模型按需查询，故写入无需确认）。与 KEY 端点不同：三者都是全局轨，
        // 不依赖会话工作目录（cwd），因此不需要 sessionId / branches / dshOnly。
        const body = await readBody(req)
        const content = String(body?.content ?? '').trim()
        if (!content) throw new Error('内容不能为空')
        const target = path.endsWith('/user') ? 'user' : path.endsWith('/kb') ? 'kb' : 'memory'
        const outcome = store.add(target, content, {})
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/memory/group') {
        // 自建记忆分组的手动写入（2026-10-13 分组化）：记忆 Tab 里用户给某个
        // **自建**分组手写一条内容。分组必须存在且启用；作用域由分组配置决定
        // （全局组不需要 cwd，项目级组需要 sessionId 解析会话工作目录）。
        // 待确认门槛只约束 AI 写入——用户手写就是明确意图，直接落盘。
        const body = await readBody(req)
        const content = String(body?.content ?? '').trim()
        if (!content) throw new Error('内容不能为空')
        const id = String(body?.id ?? '').trim()
        const group = findGroup(loadGroups(deps.config.memoryDir), 'memory', id)
        if (group === null || group.enabled !== true) throw new Error(`未知或已停用的记忆分组 "${id}"`)
        // 三类改造（2026-10-15）：目录位置由「类」决定——项目类要工作目录，
        // 会话类要会话 id。此前只传 cwd，会话类分组一律写入失败。
        const cwd = group.klass === 'project' ? resolveSessionCwd(body, deps) : undefined
        if (group.klass === 'project' && !cwd) throw new Error('该项目类分组需要会话工作目录')
        const sessionId = group.klass === 'session' ? String(body?.sessionId ?? '').trim() : ''
        if (group.klass === 'session' && sessionId === '') throw new Error('该会话类分组需要会话 id（请带 sessionId 参数）')
        const agent = (cwd !== undefined || sessionId !== '')
          ? { session: { id: sessionId === '' ? undefined : sessionId, header: cwd === undefined ? {} : { cwd } } }
          : undefined
        const outcome = store.add(id, content, agent)
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/memory/key') {
        // Manual project-KEY write from the memory tab: the user types a
        // durable project fact and the host stamps + appends it to the
        // project's KEY.md. The next snapshot render picks it up (the key
        // track is injected with live reads), so the fact reaches the model
        // context automatically. Optional `branches` (string[]; [] = 全部)
        // scopes the entry to specific git branches; optional `dshOnly`
        // (boolean) tags it with [dsh-only] — the entry then only reaches
        // DSH sessions, external executors (COI injection) skip it.
        const body = await readBody(req)
        const content = String(body?.content ?? '').trim()
        if (!content) throw new Error('内容不能为空')
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        if (!cwd) throw new Error('无法定位项目关键记忆：会话没有工作目录')
        const rawBranches = body?.branches
        if (rawBranches !== undefined && !Array.isArray(rawBranches)) throw new Error('branches 必须是字符串数组')
        const branches = (rawBranches ?? []).map((b) => String(b).trim()).filter((b) => b.length > 0)
        // 前缀顺序与 setEntryDshOnly 的插入规则一致：branch 在前、[dsh-only] 在后
        const dshOnly = body?.dshOnly === true
        let finalContent = content
        if (branches.length > 0) finalContent = `[branch:${branches.join(',')}] ${finalContent}`
        if (dshOnly) finalContent = `[dsh-only] ${finalContent}`
        const outcome = store.add('key', finalContent, { session: { header: { cwd } } })
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/memory/delete') {
        // Per-entry delete from the memory tab's pretty view. The UI sends
        // the FULL entry text (with its stamp) as `match`, and the host
        // deletes by exact whole-entry equality (removeExact) — never a
        // substring match, so deleting a short entry cannot wipe a longer
        // one that merely contains it. Archive rows map onto their track.
        const body = await readBody(req)
        const target = String(body?.target ?? '')
        const match = String(body?.match ?? '').trim()
        if (!match) throw new Error('match 不能为空')
        const ARCHIVE = { 'archive-memory': 'memory', 'archive-user': 'user', 'archive-key': 'key' }
        // 分组化（2026-10-13）：主轨白名单 = 启用中的记忆分组（内置六轨 +
        // 自建分组），归档三页签另算。
        const TRACKS = new Set([
          ...listEnabledGroups(loadGroups(deps.config.memoryDir), 'memory').map((g) => g.id),
          ...Object.keys(ARCHIVE),
        ])
        if (!TRACKS.has(target)) throw new Error(`无效的记忆轨 "${target}"`)
        let outcome
        if (target in ARCHIVE) {
          const cwd = ARCHIVE[target] === 'key' ? resolveSessionCwd(body, deps) : undefined
          outcome = archive.removeExact(ARCHIVE[target], match, cwd)
        } else {
          const sessionId = String(body?.sessionId ?? '')
          const cwd = deps.resolveCwd?.(sessionId)
          const agent = cwd ? { session: { header: { cwd } } } : undefined
          if ((target === 'project' || target === 'key') && !cwd) {
            throw new Error('无法定位项目记忆：会话没有工作目录')
          }
          outcome = store.removeExact(target, match, agent)
        }
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/memory/update') {
        // Per-entry content edit from the memory tab's pretty view. The UI
        // sends the FULL entry text (with its stamp) as `match` — the host
        // locates it by exact whole-entry equality and rewrites only the
        // body, preserving the timestamp and every tag (git branch, branch
        // scope, daily project tag). The delimiter § is rejected, so the
        // §-split format can never be broken by an edit.
        const body = await readBody(req)
        const target = String(body?.target ?? '')
        const match = String(body?.match ?? '').trim()
        const content = String(body?.content ?? '')
        if (!match) throw new Error('match 不能为空')
        if (!content.trim()) throw new Error('内容不能为空')
        // 分组化（2026-10-13）：可编辑主轨 = 启用中的记忆分组（内置 + 自建）
        const TRACKS = new Set(listEnabledGroups(loadGroups(deps.config.memoryDir), 'memory').map((g) => g.id))
        if (!TRACKS.has(target)) throw new Error(`无效的记忆轨 "${target}"`)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        const agent = cwd ? { session: { header: { cwd } } } : undefined
        if ((target === 'project' || target === 'key') && !cwd) {
          throw new Error('无法定位项目记忆：会话没有工作目录')
        }
        const outcome = store.updateEntryContent(target, match, content, agent)
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/memory/dsh-only') {
        // 给一条目打/取消「仅 DSH」标记（[dsh-only]）：标记的条目仍注入 DSH
        // 自身会话，但注入外部执行器（COI 任务的 injectTracks 记忆注入）时
        // 整条跳过——用于存放只对 DSH 有意义的纪律/规则/架构类事实。整条
        // 精确匹配（同 /api/memory/update），memory/user/key 三轨可用。
        const body = await readBody(req)
        const target = String(body?.target ?? '')
        const match = String(body?.match ?? '').trim()
        const on = body?.on !== false
        if (!match) throw new Error('match 不能为空')
        if (target !== 'memory' && target !== 'user' && target !== 'key') {
          throw new Error('target 必须是 memory / user / key')
        }
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        const agent = cwd ? { session: { header: { cwd } } } : undefined
        if (target === 'key' && !cwd) throw new Error('无法定位项目关键记忆：会话没有工作目录')
        const outcome = store.setEntryDshOnly(target, match, on, agent)
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/memory/archive') {
        // Archive a main-track entry from the memory tab: the entry is
        // removed from MEMORY.md / USER.md / KEY.md by exact whole-entry
        // match and appended verbatim to the matching archive file.
        // Reversible — the archive tab can promote it back with
        // POST /api/archive/promote. Order: append to the archive FIRST,
        // then remove from the main track — a failed archive write must
        // never leave the entry deleted (data loss); a failed removal (the
        // entry was concurrently archived/deleted elsewhere) leaves one
        // extra archive entry the user can clean up manually, which is
        // recoverable. Trade-off: duplicates over data loss.
        const body = await readBody(req)
        const target = String(body?.target ?? '')
        const match = String(body?.match ?? '').trim()
        // 归档对**任意记忆分组**可用（kb / project / daily / session 与用户自建分组）：
        // 此前这里的白名单是分组化之前的三轨（memory / user / key），导致 kb 之类
        // 分组在界面上干脆不给归档按钮、直接调接口也被拒。
        const archiveGroup = findGroup(loadGroups(deps.config.memoryDir), 'memory', target)
        if (archiveGroup === null) throw new Error(`无效的记忆分组 "${target}"（归档只对记忆分组有意义）`)
        if (!match) throw new Error('match 不能为空')
        const sessionId = String(body?.sessionId ?? '')
        // 会话类分组的目录带会话 id、项目类带工作目录 —— 两者都得经 agent 传下去，
        // 否则 peekExact / removeExact 定位不到文件。
        const needsSession = archiveGroup.klass === 'project' || archiveGroup.klass === 'session'
        const cwd = needsSession ? resolveSessionCwd(body, deps) : undefined
        const agent = (needsSession || sessionId !== '')
          ? { session: { id: sessionId === '' ? undefined : sessionId, header: cwd === undefined ? {} : { cwd } } }
          : undefined
        // 先校验目标条目确实整条存在于主轨（read-only）——无效请求（子串、
        // 已删除条目）绝不把垃圾内容写进归档文件
        const peeked = store.peekExact(target, match, agent)
        if (!peeked.ok) throw new Error(peeked.message)
        const appended = archive.append(target, peeked.entry, cwd, sessionId || undefined)
        if (!appended.ok) throw new Error(`归档写入失败：${appended.message ?? '未知错误'}（主轨条目未动，可重试）`)
        const outcome = store.removeExact(target, match, agent)
        if (!outcome.ok) {
          throw new Error(`已写入归档（现有 ${appended.total} 条）但主轨删除失败：${outcome.message}——归档里多出的那条可在归档页手动清理`)
        }
        sendJson(res, 200, { ok: true, message: apit('api.archivedOk', { target, count: appended.total, detail: outcome.message }) })
        return
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/todo') {
        if (todoDisabled()) {
          sendTodoDisabled(res)
          return
        }
        // Todo list for the 待办 sub-tab. `target` optional (default all
        // four tracks); `all=1` shows everything (the tab defaults to the
        // smart view like the dtodo tool); `past=1` also reads the daily
        // track's files from earlier days, `expired=1` includes the expired
        // past leftovers (default: filtered out). sessionId resolves cwd.
        const sessionId = url.searchParams.get('sessionId')
        const cwd = deps.resolveCwd?.(sessionId)
        const target = url.searchParams.get('target') || undefined
        // 分组化（2026-10-13）：默认视图覆盖**全部启用中的待办分组**
        // （内置四轨 + 用户自建分组），不再写死 life/work/project/daily。
        const allTodoTargets = listGroups(loadGroups(deps.config.memoryDir), 'todo')
          .filter((g) => g.enabled)
          .map((g) => g.id)
        const targets = target !== undefined ? [target] : allTodoTargets
        const date = url.searchParams.get('date') || undefined
        const result = todoStore.listTodos(targets, {
          status: url.searchParams.get('status') || undefined,
          quadrant: url.searchParams.get('quadrant') || undefined,
          due: url.searchParams.get('due') || undefined,
          cat: url.searchParams.get('cat') || undefined,
          all: url.searchParams.get('all') === '1',
          past: url.searchParams.get('past') === '1',
          expired: url.searchParams.get('expired') === '1',
          date,
        }, cwd ?? undefined, date ?? undefined, sessionId === null ? undefined : sessionId)
        sendJson(res, 200, {
          items: result.items,
          total: result.total,
          truncated: result.truncated,
          defaultView: result.defaultView,
          cwd: cwd ?? null,
        })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/todo') {
        if (todoDisabled()) {
          sendTodoDisabled(res)
          return
        }
        // Todo mutations from the 待办 sub-tab (user is the confirmer: direct
        // writes). Actions: add / done / update / remove.
        const body = await readBody(req)
        const sessionId = String(body?.sessionId ?? '')
        const cwd = deps.resolveCwd?.(sessionId)
        const action = String(body?.action ?? '')
        const target = typeof body?.target === 'string' && body.target !== '' ? body.target : undefined
        if (action === 'add') {
          // 缺省轨道按类解析——life/work 已出厂停用，不能再当兜底。
          const track = target ?? todoStore.defaultTarget(cwd ?? null, sessionId === '' ? undefined : sessionId)
          const validTracks = todoStore.allTargets()
          if (!validTracks.includes(track)) throw new Error(`无效 target "${track}"（可用：${validTracks.join(' / ')}）`)
          const due = typeof body?.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.due) ? body.due : undefined
          const quadrant = typeof body?.quadrant === 'string' && /^q[1-4]$/.test(body.quadrant) ? body.quadrant : undefined
          const cat = typeof body?.cat === 'string' && body.cat.trim() !== '' ? body.cat.trim() : undefined
          const outcome = todoStore.addTodo(track, String(body?.content ?? ''), { quadrant, due, cat }, cwd, sessionId || undefined)
          if (!outcome.ok) throw new Error(outcome.message)
          sendJson(res, 200, outcome)
          return
        }
        const id = String(body?.id ?? '').trim()
        if (!id) throw new Error('id 不能为空')
        const date = typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : undefined
        if (action === 'done') {
          const outcome = todoStore.doneTodo(target, id, cwd, date, sessionId || undefined)
          if (!outcome.ok) throw new Error(outcome.message)
          sendJson(res, 200, outcome)
          return
        }
        if (action === 'remove') {
          const outcome = todoStore.removeTodo(target, id, cwd, date, sessionId || undefined)
          if (!outcome.ok) throw new Error(outcome.message)
          sendJson(res, 200, outcome)
          return
        }
        if (action === 'update') {
          const patch = {}
          if (body?.status !== undefined) patch.status = String(body.status)
          if (body?.quadrant !== undefined) patch.quadrant = String(body.quadrant)
          if (body?.due !== undefined) patch.due = String(body.due)
          if (body?.cat !== undefined) patch.cat = String(body.cat)
          if (body?.content !== undefined) patch.content = String(body.content)
          const outcome = todoStore.updateTodo(target, id, patch, cwd, date, sessionId || undefined)
          if (!outcome.ok) throw new Error(outcome.message)
          sendJson(res, 200, outcome)
          return
        }
        throw new Error(`未知操作 "${action}"（应为 add / done / update / remove）`)
      }
      if (req.method === 'GET' && path === '/memory-evolve/api/pending-skills') {
        sendJson(res, 200, { entries: listPendingSkills(pendingSkillDir(deps)) })
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/pending-skills/approve') {
        const body = await readBody(req)
        const name = String(body?.name ?? '').trim()
        const outcome = approvePendingSkill(pendingSkillDir(deps), deps.config.skillDir, name)
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      if (req.method === 'POST' && path === '/memory-evolve/api/pending-skills/reject') {
        const body = await readBody(req)
        const name = String(body?.name ?? '').trim()
        const outcome = rejectPendingSkill(pendingSkillDir(deps), name)
        if (!outcome.ok) throw new Error(outcome.message)
        sendJson(res, 200, outcome)
        return
      }
      // ---- 模型设置模块（lib/models.js）：表格数据 + 配置更新 ----
      // GET /api/models：聚合快照（供应商 + 模型 + 思考等级 + enabled/备注），
      // 供「模型设置」Tab 渲染；enabledOnly=1 只返回启用的模型（外部查询用）。
      // 模块未启用（modelsEnabled=false）时拒绝访问（store 为 null）。
      if (req.method === 'GET' && path === '/memory-evolve/api/models') {
        if (deps.modelsStore === null) throw new Error('模型设置模块未启用（请在「设置」Tab 的「配置」里打开「模型设置」开关）')
        const snapshot = await deps.buildModelsSnapshot()
        if (url.searchParams.get('enabledOnly') === '1') {
          for (const p of snapshot.providers) {
            p.models = p.models.filter((m) => m.enabled)
          }
        }
        sendJson(res, 200, snapshot)
        return
      }
      // POST /api/models/update { provider, model, patch }：更新一个模型的
      // 插件配置（enabled / thinking / note / reasoning.enabled 白名单 /
      // reasoning.recommended / reasoning.custom）。返回规范化后的 entry
      // （全空配置被删除时 entry 为 null）。
      if (req.method === 'POST' && path === '/memory-evolve/api/models/update') {
        if (deps.modelsStore === null) throw new Error('模型设置模块未启用（请在「设置」Tab 的「配置」里打开「模型设置」开关）')
        const body = await readBody(req)
        const provider = String(body?.provider ?? '').trim()
        const model = String(body?.model ?? '').trim()
        if (provider === '') throw new Error('provider 不能为空')
        if (model === '') throw new Error('model 不能为空')
        const patch = normalizeModelsPatch(body?.patch)
        const entry = deps.modelsStore.update(provider, model, patch)
        sendJson(res, 200, { ok: true, entry: entry ?? null })
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? String(error) })
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: '/memory-evolve', handler })
}
