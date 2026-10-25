/**
 * dsh-memory-evolve — 记忆检索（`memory_search` 工具，2026-10-15）。
 *
 * 用户需求：「模型可通过工具搜索元数据和摘要找到相关记忆」。
 *
 * 一条记忆 = 一个 md 文件 + YAML frontmatter（标题 / 摘要 / 关键词 / 使用
 * 场景 / 创建与修改时间 / 所属分组与类）。本模块按这些字段加正文做加权
 * 检索，返回"标题 + 摘要 + 命中片段 + 文件路径"，模型据此再用 `memory`
 * 工具（action=expand 或 list）读全文。
 *
 * 检索范围默认覆盖**全部三类**（会话类 / 项目类 / 全局类）的启用分组；
 * 归档默认**不在**范围内，要查历史得显式 `includeArchived: true`（用户拍板
 * 2026-10-15：归档默认不搜、带参数才搜）。
 *
 * @module dsh-memory-evolve/memory-search
 */

import { groupArchiveDirOf, listGroups, listGroupsByClass, normalizeKlass } from './groups.js'
// 工具描述的用户覆盖（tools.json）：注册与配置页共用同一个出口，覆盖优先（含显式置空）。
import { loadToolsConfig, toolDescriptionOf } from './tool-registry.js'
import { readVaultDeep } from './vault.js'

/** 命中字段的权重（标题最重，正文最轻）。 */
const WEIGHTS = { title: 10, keywords: 8, summary: 5, scenario: 4, body: 1 }

/** 默认返回条数上限。 */
const DEFAULT_LIMIT = 20

/** 单条结果里正文片段的长度。 */
const SNIPPET_RADIUS = 70

/**
 * 把查询串切成词（空格 / 逗号 / 顿号 / 分号都算分隔符）。
 * @param {string} query - 原始查询。
 * @returns {string[]} 小写化的词（去重，最多 8 个）。
 */
export function queryTerms(query) {
  const out = []
  for (const raw of String(query ?? '').split(/[\s,，、;；]+/)) {
    const term = raw.trim().toLowerCase()
    if (term === '' || out.includes(term)) continue
    out.push(term)
    if (out.length >= 8) break
  }
  return out
}

/** 一条记忆 vs 一组词：全部命中才算命中，得分 = 各字段权重之和。 */
function scoreEntry(entry, terms) {
  const fields = {
    title: String(entry.title ?? '').toLowerCase(),
    keywords: (entry.keywords ?? []).join(' ').toLowerCase(),
    summary: String(entry.summary ?? '').toLowerCase(),
    scenario: String(entry.scenario ?? '').toLowerCase(),
    body: String(entry.body ?? '').toLowerCase(),
  }
  let score = 0
  for (const term of terms) {
    let hit = 0
    for (const [field, weight] of Object.entries(WEIGHTS)) {
      if (fields[field].includes(term)) hit += weight
    }
    if (hit === 0) return 0
    score += hit
  }
  return score
}

/** 正文里第一个命中的位置附近的片段。 */
function snippetOf(body, terms, radius = SNIPPET_RADIUS) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  const lower = text.toLowerCase()
  let at = -1
  for (const term of terms) {
    const found = lower.indexOf(term)
    if (found !== -1 && (at === -1 || found < at)) at = found
  }
  if (at === -1) return text.slice(0, radius * 2)
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/**
 * 检索记忆。
 * @param {object} params
 * @param {object} params.store - MemoryStore（用来算每个分组的目录）。
 * @param {string} params.memoryDir - 记忆根目录。
 * @param {object} params.groupsData - 分组配置（`loadGroups()` 的结果）。
 * @param {string} params.query - 查询串（空格分隔多个词，全部命中才返回）。
 * @param {object} [params.agent] - 调用方 agent（项目类要 cwd、会话类要 session id）。
 * @param {string} [params.groupId] - 只搜这一个分组。
 * @param {string} [params.klass] - 只搜这一类（session / project / global）。
 * @param {boolean} [params.includeArchived] - 是否把归档也纳入（默认否）。
 * @param {number} [params.limit] - 返回上限（默认 20）。
 * @returns {{ok: boolean, count: number, results: object[], message?: string, searched: number}}
 */
export function searchMemory(params) {
  const {
    store, memoryDir, groupsData, query, agent,
    groupId, klass, includeArchived = false, limit = DEFAULT_LIMIT,
  } = params
  const terms = queryTerms(query)
  if (terms.length === 0) {
    return { ok: false, count: 0, results: [], searched: 0, message: '请给出要搜索的关键词' }
  }
  const wanted = klass === undefined || klass === null || klass === ''
    ? listGroups(groupsData, 'memory')
    : listGroupsByClass(groupsData, 'memory', normalizeKlass(klass))
  const groups = wanted.filter((group) => group.enabled === true
    && (groupId === undefined || groupId === null || groupId === '' || group.id === groupId))
  if (groups.length === 0) {
    return { ok: true, count: 0, results: [], searched: 0, message: '没有匹配的分组（检查 group / klass 或分组是否已停用）' }
  }

  const results = []
  let searched = 0
  for (const group of groups) {
    const targets = []
    try {
      const loc = store.resolveTarget(group.id, agent)
      targets.push({ dir: loc.dir, archived: false })
      if (includeArchived === true) {
        const archiveDir = groupArchiveDirOf(group, store.ctxOf(group, agent))
        if (archiveDir !== null) targets.push({ dir: archiveDir, archived: true })
      }
    } catch {
      // 项目类缺 cwd、会话类缺 session id：这一组跳过，不影响其它组
      continue
    }
    for (const target of targets) {
      for (const entry of readVaultDeep(target.dir)) {
        searched += 1
        const score = scoreEntry(entry, terms)
        if (score === 0) continue
        results.push({
          title: entry.title,
          summary: entry.summary,
          keywords: entry.keywords,
          scenario: entry.scenario,
          group: group.id,
          groupLabel: group.label ?? group.id,
          klass: group.klass,
          created: entry.created,
          updated: entry.updated,
          path: entry.file,
          snippet: snippetOf(entry.body, terms),
          archived: target.archived === true || entry.archivedAt !== null,
          score,
        })
      }
    }
  }
  results.sort((a, b) => (b.score - a.score) || String(b.updated).localeCompare(String(a.updated)))
  const capped = results.slice(0, Math.max(1, Math.min(200, Number(limit) || DEFAULT_LIMIT)))
  return { ok: true, count: capped.length, results: capped, searched, total: results.length }
}

/** 把检索结果渲染成给模型看的紧凑文本。 */
export function renderSearchResults(payload) {
  if (payload.ok !== true) return payload.message ?? '检索失败'
  if (payload.count === 0) {
    return `没有命中（已检索 ${payload.searched} 条）。可换关键词，或用 includeArchived=true 查归档。`
  }
  const lines = [`命中 ${payload.count} 条（共 ${payload.total ?? payload.count} 条，已检索 ${payload.searched} 条）：`]
  payload.results.forEach((row, index) => {
    const kls = row.klass === 'session' ? '会话类' : row.klass === 'project' ? '工作区类' : '全局类'
    const flags = [row.archived ? '已归档' : null, row.keywords?.length ? `关键词: ${row.keywords.join('/')}` : null]
      .filter(Boolean).join(' · ')
    lines.push(
      `${index + 1}. 【${kls}/${row.groupLabel}】${row.title}`
      + (flags ? `\n   ${flags}` : '')
      + (row.summary ? `\n   摘要：${row.summary}` : '')
      + (row.scenario ? `\n   场景：${row.scenario}` : '')
      + `\n   片段：${row.snippet}`
      + `\n   文件：${row.path}`,
    )
  })
  return lines.join('\n')
}

/**
 * 构造 `memory_search` 工具定义。
 * @param {object} deps
 * @param {string} deps.name - 工具名（可在配置里改）。
 * @param {string} deps.memoryDir
 * @param {object} deps.store - MemoryStore。
 * @param {() => object} deps.getGroups - 每次调用现读分组配置。
 * @param {(key: string, params?: object) => string} deps.t - 词条翻译（MISC2_DICT）。
 * @returns {object} 工具定义对象。
 */
export function memorySearchTool(deps) {
  const { name, memoryDir, store, getGroups, t } = deps
  return {
    name,
    get description() {
      return toolDescriptionOf(loadToolsConfig(memoryDir), 'memory_search', t('searchTool.desc'))
    },
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          get description() { return t('searchTool.query') },
        },
        group: {
          type: 'string',
          get description() { return t('searchTool.group') },
        },
        klass: {
          type: 'string',
          enum: ['session', 'project', 'global'],
          get description() { return t('searchTool.klass') },
        },
        includeArchived: {
          type: 'boolean',
          get description() { return t('searchTool.includeArchived') },
        },
        limit: {
          type: 'integer',
          get description() { return t('searchTool.limit') },
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
          total: { type: 'integer' },
          searched: { type: 'integer' },
          message: { type: 'string' },
          // results 必须声明：DSH 对工具输出做严格 JSON Schema 校验
          // （additionalProperties:false），漏声明会让整个工具报
          // "returned invalid output" 而不可用。
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                summary: { type: 'string' },
                keywords: { type: 'array', items: { type: 'string' } },
                scenario: { type: 'string' },
                group: { type: 'string' },
                groupLabel: { type: 'string' },
                klass: { type: 'string' },
                created: { type: 'string' },
                updated: { type: 'string' },
                path: { type: 'string' },
                snippet: { type: 'string' },
                archived: { type: 'boolean' },
                score: { type: 'number' },
              },
            },
          },
        },
        required: ['ok', 'count'],
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchResults(value) }],
    },
    async execute(args, exec) {
      return searchMemory({
        store,
        memoryDir,
        groupsData: getGroups(),
        query: args?.query,
        agent: exec?.agent,
        groupId: args?.group,
        klass: args?.klass,
        includeArchived: args?.includeArchived === true,
        limit: args?.limit,
      })
    },
  }
}
