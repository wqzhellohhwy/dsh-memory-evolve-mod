/**
 * dsh-memory-evolve — 记忆页签的数据面（三类 → 分组 → 归档 树）。
 *
 * 2026-10-15「三类改造」后，记忆页签的页签结构是三级：
 *   一级 = 待确认记忆建议 / 会话类 / 项目类 / 全局类 / 指南
 *   二级 = 该类下的每个分组 + 最后一个「归档」（`archive/<分组id>/` 目录）
 *   三级 = 分组条目卡片（沿用既有美观/纯文本视图、搜索、分页、编辑删除）
 *
 * 本模块只负责**宿主端数据面**：一个会话一份「按类组织的树」。前端不再
 * 自己拼目录——每个分组直接拿到目录（`path`）、条目数（`count`）、归档目录
 * 与归档条目数（`archivedPath` / `archivedCount`）、以及已经按 § 文本契约渲染
 * 好的条目正文（`content`，供前端卡片视图直接解析）。
 *
 * `content` 走 `store.entriesOf()`（store 的对外文本契约：`[id:…] [时间戳]
 * [git …] [branch:…] [dsh-only] [summary:…] 正文`），这样页面上的「编辑 /
 * 删除 / 归档」把整条原文回传宿主时，能命中 store 的整条精确匹配。展示前
 * 剥掉 `[id:…]` 与 `[summary:…]`（程序元数据，与旧实现同规则）。
 *
 * 归档条目不经过 store（归档目录是纯目录），由本模块按 vault 条目直接渲染
 * 成同样的 § 文本；归档页签在渲染端是只读展示。
 *
 * 返回值保持**向后兼容**：`{ files, classes }`——`files` 是旧版扁平数组
 * （旧前端/兜底路径仍可用），`classes` 是新的三类树。渲染端两种形状都认。
 *
 * @module dsh-memory-evolve/memory-tab
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { stripEntrySummary, textOfEntry } from './store.js'
import {
  KLASSES,
  groupArchiveDirOf,
  groupLabel,
  klassLabel,
  listGroupsByClass,
  loadGroups,
} from './groups.js'
import { listVaultSubdirs, readVaultDeep, vaultCount } from './vault.js'
import { getLocale, MEMORY_TAB_DICT, translate } from './i18n.js'

/**
 * 旧版扁平行标题字典（仍用于 `files` 里的 AGENTS.md 行与归档行）。
 * 新增文案一律进 lib/i18n.js 的 MEMORY_TAB_DICT。
 */
const TITLE_DICT = {
  'memoryTab.row.agents': ['全局规则 AGENTS.md', 'AGENTS.md'],
}

/** 三类的顺序（与 lib/groups.js 的 KLASSES 同源，这里只是重导出给调用方省一次 import）。 */
export { KLASSES }

/**
 * agent 形状归一（2026-10-15 三类改造）。
 *
 * 兼容三种入参：① 字符串（旧签名里的会话 cwd）；② agent 对象
 * （`{ session: { id, header: { cwd } } }`，store 认这个形状）；③
 * `{ cwd }` 之类的松散对象。会话类分组定位需要 `session.id`，项目类需要
 * `session.header.cwd`。
 * @param {string|object|undefined} input - cwd 或 agent。
 * @param {string|undefined} sessionId - 额外提供的会话 id。
 * @returns {object|undefined} 归一后的 agent（信息不足时为 undefined）。
 */
function normalizeAgent(input, sessionId) {
  const extra = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  if (typeof input === 'string' && input !== '') {
    return { session: { id: extra, header: { cwd: input } } }
  }
  if (input === null || typeof input !== 'object') {
    return extra === undefined ? undefined : { session: { id: extra, header: {} } }
  }
  const session = input.session !== null && typeof input.session === 'object' ? input.session : {}
  const header = session.header !== null && typeof session.header === 'object' ? session.header : {}
  const cwd = typeof header.cwd === 'string' && header.cwd !== ''
    ? header.cwd
    : (typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : undefined)
  const id = typeof session.id === 'string' && session.id !== ''
    ? session.id
    : (typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : extra)
  if (cwd === undefined && id === undefined) return undefined
  return { session: { id, header: cwd === undefined ? {} : { cwd } } }
}

/**
 * 目录里的条目文件数，**含日志型的一层日期子目录**。
 *
 * `vaultCount` 只数一层；日志型分组（会话日志 / 项目日志 / 今日日志）把条目
 * 放进 `<日期>/` 子目录，只用 vaultCount 会恒为 0，故按目录树求和。
 * @param {string|undefined} dir - 分组（或归档）目录。
 * @returns {number} 条目数。
 */
function countEntriesDeep(dir) {
  if (typeof dir !== 'string' || dir === '') return 0
  let total = vaultCount(dir)
  for (const name of listVaultSubdirs(dir)) total += vaultCount(join(dir, name))
  return total
}

/**
 * 分组的时间戳形状（渲染端据此剥掉条目前的 `[…]` 时间戳）。
 *
 * 与 lib/store.js 的 `timeStampOf` 保持一致：今日日志 `[HH:MM]`、项目日志
 * `[YYYY-MM-DD HH:MM]`、其余 `[YYYY-MM-DD]`（含日志型的会话类/自建分组——
 * 它们的时间戳同样是日期粒度）。
 * @param {object} group - 分组实体。
 * @returns {'time'|'datetime'|'date'} 时间戳形状。
 */
function stampKindOf(group) {
  if (group.id === 'daily') return 'time'
  if (group.id === 'project') return 'datetime'
  return 'date'
}

/** 展示剥离：`[id:…]`（跨设备合并锚点）与 `[summary:…]` 是程序元数据，不展示。 */
function displayText(line) {
  const trimmed = String(line ?? '').trim()
  if (trimmed === '') return ''
  return stripEntrySummary(trimmed).replace(/^\[id:[0-9a-f]{8}\]\s*/, '')
}

/**
 * 读一个分组的条目行（`{date, text, entry}`）。与 store 的 `readRaw` 同源，
 * 所以文本契约不变。
 * @param {object} store - 记忆 store。
 * @param {string} id - 分组 id。
 * @param {object|undefined} agent - 归一后的 agent。
 * @returns {object[]} 行数组（无法定位/读盘失败时为空数组）。
 */
function groupRows(store, id, agent) {
  try {
    return store.rowsOf(id, agent)
  } catch {
    return []
  }
}

/**
 * 结构化条目（2026-10-15 F-7 / F-8 的前置）：渲染端要在条目标题行显示元数据
 * （标题 / 摘要 / 关键词 / 使用场景），还要把「默认折叠成标题行」做出来 ——
 * 光有 § 拼接的文本拼不出这些。
 *
 * `text` 与分组 `content` 里那一条**逐字一致**（同一个 displayText 出口）；
 * `raw` 是完整原文，删除 / 编辑回传时的精确匹配基准。
 * @param {object} entry - vault 条目对象。
 * @param {string} text - 该条目的 store 文本（textOfEntry 的输出）。
 * @returns {object} 给渲染端的条目对象。
 */
function entryItemOf(entry, text) {
  return {
    id: entry.id,
    text: displayText(text),
    raw: text,
    title: typeof entry.title === 'string' ? entry.title : '',
    summary: typeof entry.summary === 'string' ? entry.summary : '',
    keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
    scenario: typeof entry.scenario === 'string' ? entry.scenario : '',
    created: typeof entry.created === 'string' ? entry.created : '',
    updated: typeof entry.updated === 'string' ? entry.updated : '',
  }
}

/**
 * 读一个归档目录里的条目并渲染成 § 文本（`[创建时间] 正文`）。
 *
 * 归档目录里的文件是 vault 条目（一条一个 md），不是 store 的文本契约——
 * 但渲染成同形状后，前端卡片视图可以原样复用；归档页签是只读展示，不需要
 * 与 store 的整条匹配语义对齐。
 * @param {string|undefined} dir - 归档目录。
 * @returns {string[]} 条目文本列表。
 */
function archiveEntries(dir, target) {
  if (typeof dir !== 'string' || dir === '') return []
  // **必须走 store 的 textOfEntry**（2026-10-15 修 P1）：归档页回传的展示文本
  // 要拿去调 `/api/archive/delete` 与 `/api/archive/promote`，而那边的匹配基准
  // 是 ArchiveStore.entriesOf()（同样用 textOfEntry）。此前这里自己渲染成
  // "[完整时间戳] 正文"，与契约的按轨粒度（`[YYYY-MM-DD]` / `[HH:MM]`）不同形，
  // 也没有 `[id:…]` 前缀 —— 于是归档删除与移回**一律匹配失败**。
  return readVaultDeep(dir).map((entry) => entryItemOf(entry, textOfEntry(entry, target)))
}

/**
 * 构造一个分组项（二级页签的一格）。
 * @param {object} group - 分组实体（lib/groups.js）。
 * @param {object} store - 记忆 store。
 * @param {object|undefined} agent - 归一后的 agent。
 * @param {{memoryDir: string, projectId: string|null, sessionId: string|null}} ctx - 路径上下文。
 * @param {'zh'|'en'} locale - 宿主语言。
 * @returns {object} 分组项。
 */
function buildGroupItem(group, store, agent, ctx, locale) {
  let dir
  try {
    dir = store.pathOf(group.id, agent)
  } catch {
    dir = undefined // 项目类缺 cwd / 会话类缺 session id：不可定位，但仍列出该分组
  }
  let archiveDir
  try {
    archiveDir = groupArchiveDirOf(group, ctx) ?? undefined
  } catch {
    archiveDir = undefined
  }
  const rows = dir === undefined ? [] : groupRows(store, group.id, agent)
  const lines = rows.map((row) => row.text)
  const title = groupLabel(group, locale)
  return {
    klass: group.klass,
    id: group.id,
    title,
    label: title,
    // path/dir 都是**目录**（一条记忆一个 md 文件，2026-10-15 起）
    path: dir,
    dir,
    count: countEntriesDeep(dir),
    archivedPath: archiveDir,
    archivedCount: countEntriesDeep(archiveDir),
    enabled: group.enabled === true,
    daily: group.daily === true,
    builtin: group.builtin === true,
    order: group.order,
    inject: group.inject === true,
    confirm: group.confirm === true,
    available: dir !== undefined,
    exists: lines.length > 0,
    stampKind: stampKindOf(group),
    content: lines.map(displayText).filter((text) => text !== '').join('\n§\n'),
    // 结构化条目（F-7 / F-8）：渲染端要元数据、要逐条折叠，光有 § 文本拼不出来。
    entries: rows.map((row) => entryItemOf(row.entry, row.text)),
  }
}

/**
 * 构造一个类的归档节点（该类下所有分组的归档条目，按来源分组分块）。
 * @param {string} klass - 类 id。
 * @param {object[]} items - 该类的分组项。
 * @param {'zh'|'en'} locale - 宿主语言。
 * @returns {object} 归档节点。
 */
function buildArchiveNode(klass, items, locale) {
  const groups = []
  let total = 0
  for (const item of items) {
    if (item.archivedCount <= 0) continue
    const entryItems = archiveEntries(item.archivedPath, item.id)
    if (entryItems.length === 0) continue
    total += entryItems.length
    groups.push({
      id: item.id,
      title: item.title,
      path: item.archivedPath,
      count: entryItems.length,
      stampKind: 'datetime', // 归档文本统一 `[YYYY-MM-DD HH:MM] 正文`
      enabled: true,
      content: entryItems.map((entry) => entry.raw).join('\n§\n'),
      entries: entryItems,
    })
  }
  return {
    klass,
    label: translate(MEMORY_TAB_DICT, 'memoryTab.tab.archiveOf', { klass: klassLabel(klass, locale) }, locale),
    groups,
    count: total,
  }
}

/**
 * 构造按类组织的记忆树（记忆页签的数据面）。
 *
 * @param {object} config - 解析后的插件配置（用到 `memoryDir`）。
 * @param {import('./store.js').MemoryStore} store - 记忆 store。
 * @param {string|object|undefined} agentOrCwd - 会话 cwd（旧签名），或 agent
 *   对象 `{ session: { id, header: { cwd } } }`（会话类分组需要 session id）。
 * @param {{sessionId?: string}} [extra] - 额外上下文（会话 id 兜底）。
 * @returns {{files: object[], classes: object[]}} 扁平兼容行 + 三类树。
 *   分组项字段：`klass / id / title / path / count / archivedPath /
 *   archivedCount / enabled / daily / builtin / available / stampKind / content`。
 */
export function buildMemoryFiles(config, store, agentOrCwd, extra = {}) {
  const locale = getLocale()
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const agent = normalizeAgent(agentOrCwd, extra?.sessionId)
  const data = loadGroups(config.memoryDir)
  // v3：项目类分组目录 = `<memory>/<组id>/project/<项目id>`，末段即项目 id；
  // 会话类看 sessionId，全局类不需要项目上下文。
  let projectId = null
  try {
    const projectLogDir = agent === undefined ? undefined : store.pathOf('project', agent)
    if (typeof projectLogDir === 'string') projectId = basename(projectLogDir)
  } catch {
    projectId = null
  }
  const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : null
  const ctx = { memoryDir: config.memoryDir, projectId, sessionId }
  const cwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : undefined

  /**
   * 类根路径（用户 UI-13）：显示在分组目录右侧，标出这个分组属于哪个上下文。
   * 会话类给**组级**路径 `<kind根>/<组id>/session`（v3 没有会话公共目录）；
   * 工作区类 = 工作区路径（cwd）；全局类 = dsh-home。
   * @param {string} klass - 类 id。
   * @param {object[]} items - 该类的分组项（取第一个可定位项的父目录）。
   * @returns {string|undefined} 绝对路径（无法解析时为 undefined）。
   */
  const classRootOf = (klass, items) => {
    if (klass === 'session') {
      if (sessionId === null) return undefined
      const withDir = items.find((item) => typeof item.dir === 'string' && item.dir !== '')
      return withDir === undefined ? undefined : dirname(withDir.dir)
    }
    if (klass === 'project') return cwd
    return dshHome
  }

  const classes = []
  const files = []
  for (const klass of KLASSES) {
    const items = listGroupsByClass(data, 'memory', klass)
      .map((group) => buildGroupItem(group, store, agent, ctx, locale))
    const archive = buildArchiveNode(klass, items, locale)
    classes.push({
      klass,
      label: klassLabel(klass, locale),
      rootPath: classRootOf(klass, items),
      groups: items,
      archive,
    })
    // 扁平兼容行：分组行（与旧 files 的字段形状一致）+ 该类归档行
    for (const item of items) {
      files.push({
        key: item.id,
        title: item.title,
        available: item.available,
        exists: item.exists,
        truncated: false,
        path: item.path,
        klass: item.klass,
        count: item.count,
        enabled: item.enabled,
        daily: item.daily,
        builtin: item.builtin,
        stampKind: item.stampKind,
        content: item.content,
      })
    }
    if (archive.count > 0) {
      files.push({
        key: `archive-${klass}`,
        title: archive.label,
        available: true,
        exists: true,
        truncated: false,
        klass,
        count: archive.count,
        enabled: true,
        daily: false,
        builtin: true,
        stampKind: 'datetime',
        archived: true,
        // 内容**不再套 `[分组标题]\n` 块头**：那是展示用的分组标签，前端从
        // archive.groups[].title 自己就能拿到；拼进内容会让回传文本与
        // ArchiveStore 的匹配基准错位（2026-10-15 修的 P1）。
        content: archive.groups.map((group) => group.content).join('\n§\n'),
      })
    }
  }
  // 全局规则 AGENTS.md：既不是类也不是分组，保持独立一行（旧行为），渲染端
  // 不把它放进三级结构。
  const agentsPath = join(dshHome, 'AGENTS.md')
  let agentsText = ''
  if (existsSync(agentsPath)) {
    try {
      agentsText = readFileSync(agentsPath, 'utf8')
    } catch {
      agentsText = ''
    }
  }
  files.push({
    key: 'agents',
    title: translate(TITLE_DICT, 'memoryTab.row.agents', undefined, locale),
    available: true,
    exists: agentsText !== '',
    truncated: false,
    path: agentsPath,
    content: agentsText,
  })

  return { files, classes }
}
