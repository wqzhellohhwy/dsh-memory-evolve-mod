/**
 * dsh-memory-evolve — 自建工具的**动作分发**（2026-10-15 用户需求：
 * 「工具可自由增删，新建的工具绑定内置动作」）。
 *
 * 分工（两层，别混）：
 *   - 数据层：`lib/tool-registry.js` + `<memoryDir>/tools.json` 的 `custom[]`
 *     ——名字 / 描述 / 绑定动作（`action.kind` + `action.fixed`）；
 *   - 本模块：把 `custom[]` 编译成 DSH 工具定义数组（`buildCustomTools`），
 *     执行时按 `action.kind` 分发到既有内置实现。**自建工具不新增任何行为**，
 *     只是给已有动作换一个名字/描述/固定参数。
 *
 * 输出契约（踩过的坑）：DSH 对工具**输出**做严格 JSON Schema 校验
 * （`additionalProperties: false`），漏声明一个字段整个工具就报
 * "returned invalid output" 而不可用。所以本模块：
 *   1. `OUTPUT_SCHEMA.properties` 声明**全部**可能字段；
 *   2. 所有分支一律经 `result()` 归一化——每个字段都有值（undefined 被抹成
 *      空串/0/false/[]），绝不把底层实现的原始对象直接抛给 DSH；
 *   3. `results` 内部字段同样由 `normalizeResults()` 固定，schema 与值严格一致。
 *
 * @module dsh-memory-evolve/custom-tools
 */

import { extractEntryId, legacyIdFor, stripEntryId } from './sync/entryid.js'
import { searchMemory } from './memory-search.js'
import { enqueueSuggestion, promoteArchived } from './review.js'
import { splitEntryHead, stripEntrySummary } from './store.js'
import { BUILTIN_TOOL_IDS, loadToolsConfig } from './tool-registry.js'
import { loadGroups } from './groups.js'

/**
 * 自建工具的通用参数 schema。
 *
 * 动作已在配置里固定，参数只留「内容 / 定位 / 关键词 / 条数」五个可选字符串：
 *   - `body`：要写入的内容（add / update / todo add / suggest 用它）；
 *   - `match`：唯一子串定位（read / update / remove / archive / restore / promote
 *     / todo 的子操作名）；
 *   - `query`：检索关键词（search / list 的过滤词）；
 *   - `id`：条目 id（read / todo 定位）；
 *   - `limit`：条数上限（字符串，运行期转数字）。
 */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    body: { type: 'string', description: '要写入的内容（add / update / todo 新增 / suggest 用）' },
    match: { type: 'string', description: '唯一标识一条目的子串片段（read / update / remove / archive / restore / promote 用；todo 动作里填子操作名 done / remove）' },
    query: { type: 'string', description: '检索或过滤的关键词（search / list 用）' },
    id: { type: 'string', description: '条目 id（read / todo 定位用）' },
    limit: { type: 'string', description: '返回条数上限（数字字符串，如 "20"）' },
  },
}

/** 检索结果的单条形状（必须与 normalizeResults 的输出逐字段一致）。 */
const RESULT_ITEM_SCHEMA = {
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
    snippet: { type: 'string' },
    path: { type: 'string' },
    archived: { type: 'boolean' },
  },
  required: ['title', 'summary', 'keywords', 'scenario', 'group', 'groupLabel', 'klass', 'snippet', 'path', 'archived'],
}

/** 输出 schema：顶层**全部**字段都要声明（见文件头「踩过的坑」）。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    action: { type: 'string' },
    target: { type: 'string' },
    count: { type: 'integer' },
    total: { type: 'integer' },
    searched: { type: 'integer' },
    id: { type: 'string' },
    entries: { type: 'array', items: { type: 'string' } },
    results: { type: 'array', items: RESULT_ITEM_SCHEMA },
  },
  required: ['ok', 'message', 'action'],
}

/** 任何值 → 安全字符串（undefined / null 变空串）。 */
function text(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

/** 任何值 → 安全整数（解析不出记 0）。 */
function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0
}

/** 检索结果归一化：固定字段、无 undefined（schema 与值严格对齐）。 */
function normalizeResults(rows) {
  if (!Array.isArray(rows)) return []
  return rows.map((row) => ({
    title: text(row?.title),
    summary: text(row?.summary),
    keywords: Array.isArray(row?.keywords) ? row.keywords.map(text) : [],
    scenario: text(row?.scenario),
    group: text(row?.group),
    groupLabel: text(row?.groupLabel),
    klass: text(row?.klass),
    snippet: text(row?.snippet),
    path: text(row?.path),
    archived: row?.archived === true,
  }))
}

/**
 * 统一结果构造：所有分发分支的唯一出口。
 * @param {string} kind - 动作 kind。
 * @param {object} patch - 原始字段（缺项自动补默认值）。
 * @returns {object} 与 OUTPUT_SCHEMA 严格一致的返回对象。
 */
function result(kind, patch = {}) {
  const ok = patch.ok === true
  return {
    ok,
    message: text(patch.message) || (ok ? `${kind} 完成` : `${kind} 失败`),
    action: text(kind),
    target: text(patch.target),
    count: number(patch.count),
    total: number(patch.total),
    searched: number(patch.searched),
    id: text(patch.id),
    entries: Array.isArray(patch.entries) ? patch.entries.map(text) : [],
    results: normalizeResults(patch.results),
  }
}

/** 失败结果（message 必填，保证模型看得懂）。 */
function fail(kind, message, target = '') {
  return result(kind, { ok: false, message, target })
}

/** 展示形态：剥掉程序维护的 `[id:…]` 与 `[summary:…]`（与内置工具同一出口规则）。 */
function display(entry) {
  return stripEntrySummary(stripEntryId(text(entry)))
}

/** 取条目正文（剥掉全部程序前缀：id / 时间戳 / git / branch / dsh-only / summary）。 */
function bodyOf(entry, group) {
  try {
    return text(splitEntryHead(text(entry), group).body).trim()
  } catch {
    return display(entry)
  }
}

/**
 * 该工具的目标分组：`action.fixed.group`（可含 target）优先，其次调用方参数。
 * @param {object} tool - 自建工具定义。
 * @param {object} args - 本次调用参数。
 * @returns {string} 分组 id，解析不出返回空串。
 */
function groupFrom(tool, args) {
  const fixed = tool?.action?.fixed ?? {}
  for (const value of [fixed.group, fixed.target, args?.target]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 渲染结果文本（`output.render`）。 */
export function renderCustomResult(value) {
  const lines = [text(value?.message)]
  const results = Array.isArray(value?.results) ? value.results : []
  results.forEach((row, index) => {
    lines.push(`${index + 1}. 【${row.groupLabel || row.group}】${row.title}${row.archived ? '（已归档）' : ''}`)
    if (row.summary) lines.push(`   摘要：${row.summary}`)
    if (row.keywords.length > 0) lines.push(`   关键词：${row.keywords.join('/')}`)
    if (row.snippet) lines.push(`   片段：${row.snippet}`)
    if (row.path) lines.push(`   文件：${row.path}`)
  })
  const entries = Array.isArray(value?.entries) ? value.entries : []
  entries.forEach((entry, index) => lines.push(`${index + 1}. ${entry}`))
  return lines.join('\n')
}

/**
 * 把一个自建工具的执行请求分发到内置动作。
 * @param {object} tool - `custom[]` 中的一条（含 action.kind / action.fixed）。
 * @param {object} args - 调用参数。
 * @param {object} exec - 工具执行上下文（取 exec.agent）。
 * @param {object} deps - 依赖（store / archive / todoStore / queue / getGroups / memoryDir）。
 * @returns {Promise<object>} 与 OUTPUT_SCHEMA 一致的返回对象（出错不抛）。
 */
async function dispatch(tool, args, exec, deps) {
  const { store, archive, todoStore, queue, getGroups, memoryDir } = deps
  const enqueue = deps.enqueue ?? enqueueSuggestion
  const kind = text(tool?.action?.kind)
  const fixed = tool?.action?.fixed ?? {}
  const agent = exec?.agent
  const cwd = agent?.session?.header?.cwd
  const sessionId = agent?.session?.id
  const params = args ?? {}
  const body = text(params.body).trim()
  const match = text(params.match).trim()
  const id = text(params.id).trim()
  const query = text(params.query).trim()
  const limit = number(params.limit)

  switch (kind) {
    // ── 检索记忆（元数据 + 摘要 + 正文加权）────────────────────────────
    case 'search': {
      const group = groupFrom(tool, params)
      const keyword = query || body
      if (keyword === '') return fail('search', '缺少 query 参数（要检索的关键词）', group)
      const payload = searchMemory({
        store,
        memoryDir,
        groupsData: getGroups(),
        query: keyword,
        agent,
        groupId: group === '' ? undefined : group,
        klass: typeof fixed.klass === 'string' ? fixed.klass : undefined,
        includeArchived: fixed.includeArchived === true,
        limit: limit > 0 ? limit : undefined,
      })
      const rows = normalizeResults(payload?.results)
      return result('search', {
        ok: payload?.ok === true,
        message: text(payload?.message) || `命中 ${rows.length} 条（已检索 ${number(payload?.searched)} 条）`,
        target: group,
        count: payload?.count ?? rows.length,
        total: payload?.total,
        searched: payload?.searched,
        results: rows,
      })
    }

    // ── 读条目全文（按 id 或唯一子串）──────────────────────────────────
    case 'read': {
      const group = groupFrom(tool, params)
      if (group === '') return fail('read', '未指定分组：请给自建工具配置固定的分组，或调用时给出 target')
      const entries = store.entriesOf(group, agent)
      let hits = []
      if (id !== '') {
        hits = entries.filter((entry) => extractEntryId(entry) === id
          || legacyIdFor(entry) === id
          || text(entry).includes(`[id:${id}]`))
      } else if (match !== '') {
        hits = entries.filter((entry) => text(entry).includes(match))
      } else {
        return fail('read', '缺少定位参数：请给 id 或 match（唯一子串）', group)
      }
      if (hits.length === 0) return fail('read', `在 ${group} 中没有找到匹配条目`, group)
      if (hits.length > 1) {
        return fail('read', `匹配到 ${hits.length} 条，请用更长的片段或 id 精确定位`, group)
      }
      return result('read', {
        ok: true,
        message: `读取 ${group} 的条目全文`,
        target: group,
        count: 1,
        id: text(extractEntryId(hits[0]) ?? id),
        entries: [display(hits[0])],
      })
    }

    // ── 写入条目（正文 + 可选标题；分组由 action.fixed.group 固定）──────
    case 'add': {
      const group = groupFrom(tool, params)
      if (group === '') return fail('add', '未指定写入分组：请给自建工具配置固定的分组，或调用时给出 target')
      if (body === '') return fail('add', '缺少 body 参数（要写入的内容）', group)
      const outcome = store.addEntry(group, { body }, agent)
      return result('add', {
        ok: outcome?.ok === true,
        message: text(outcome?.message) || `已写入 ${group}`,
        target: group,
        count: outcome?.ok === true ? 1 : 0,
        id: text(outcome?.entry?.id),
      })
    }

    // ── 列出条目（关键词过滤 + 条数上限）───────────────────────────────
    case 'list': {
      const group = groupFrom(tool, params)
      if (group === '') return fail('list', '未指定分组：请给自建工具配置固定的分组，或调用时给出 target')
      const stats = {}
      const options = {}
      const filter = query || match
      if (filter !== '') options.filter = filter
      if (limit > 0) options.limit = limit
      const entries = store.query(group, agent, options, stats).map(display)
      return result('list', {
        ok: true,
        message: `${group}：${entries.length} 条${number(stats.total) > entries.length ? `（共 ${number(stats.total)} 条）` : ''}`,
        target: group,
        count: entries.length,
        total: number(stats.total) || entries.length,
        entries,
      })
    }

    // ── 改写条目正文（唯一子串定位 → 整条精确匹配）─────────────────────
    case 'update': {
      const group = groupFrom(tool, params)
      if (group === '') return fail('update', '未指定分组：请给自建工具配置固定的分组，或调用时给出 target')
      if (match === '') return fail('update', '缺少 match 参数（唯一标识条目的片段）', group)
      if (body === '') return fail('update', '缺少 body 参数（新正文）', group)
      const preview = store.peek(group, match, agent)
      if (preview?.ok !== true) return fail('update', text(preview?.message) || '没有找到匹配条目', group)
      const outcome = store.updateEntryContent(group, preview.entry, body, agent)
      return result('update', {
        ok: outcome?.ok === true,
        message: text(outcome?.message) || `已改写 ${group} 的条目`,
        target: group,
        count: outcome?.ok === true ? 1 : 0,
      })
    }

    // ── 删除条目 ───────────────────────────────────────────────────────
    case 'remove': {
      const group = groupFrom(tool, params)
      if (group === '') return fail('remove', '未指定分组：请给自建工具配置固定的分组，或调用时给出 target')
      if (match === '') return fail('remove', '缺少 match 参数（唯一标识条目的片段）', group)
      const outcome = store.remove(group, match, agent)
      return result('remove', {
        ok: outcome?.ok === true,
        message: text(outcome?.message) || `已从 ${group} 删除条目`,
        target: group,
        count: outcome?.ok === true ? 1 : 0,
      })
    }

    // ── 归档（先写归档、后删主轨：归档失败不丢数据）─────────────────────
    case 'archive': {
      const group = groupFrom(tool, params)
      if (group === '') return fail('archive', '未指定分组：请给自建工具配置固定的分组，或调用时给出 target')
      if (match === '') return fail('archive', '缺少 match 参数（唯一标识条目的片段）', group)
      const preview = store.peek(group, match, agent)
      if (preview?.ok !== true) return fail('archive', text(preview?.message) || '没有找到匹配条目', group)
      const appended = archive.append(group, preview.entry, cwd)
      if (appended?.ok !== true) {
        return fail('archive', `归档写入失败：${text(appended?.message) || '未知原因'}`, group)
      }
      const removed = store.remove(group, match, agent)
      if (removed?.ok !== true) {
        return fail('archive', `已写入归档（共 ${number(appended.total)} 条）但主轨删除失败：${text(removed?.message)}`, group)
      }
      return result('archive', {
        ok: true,
        message: `已归档 ${group} 的 1 条（归档共 ${number(appended.total)} 条）`,
        target: group,
        count: 1,
        total: number(appended.total),
      })
    }

    // ── 从归档转正回原分组 ─────────────────────────────────────────────
    case 'restore': {
      const group = groupFrom(tool, params)
      if (group === '') return fail('restore', '未指定分组：请给自建工具配置固定的分组，或调用时给出 target')
      const needle = match || id || query
      if (needle === '') return fail('restore', '缺少 match 参数（唯一标识归档条目的片段）', group)
      const outcome = promoteArchived(store, todoStore, archive, group, needle, cwd, sessionId)
      return result('restore', {
        ok: outcome?.ok === true,
        message: text(outcome?.message) || `已从归档转正回 ${group}`,
        target: group,
        count: outcome?.ok === true ? 1 : 0,
      })
    }

    // ── 提升：条目从固定分组搬到目标分组 ───────────────────────────────
    case 'promote': {
      // 源分组**只认固定分组**（不受调用方参数影响）：搬迁的语义是
      // 「从这个工具绑定的分组里挑一条，搬到目标分组」。目标分组来源：
      // 配置 `action.fixed.dest`（推荐，工具意图明确）→ 调用方 `query`
      // （通用 schema 只有五个参数，promote 里 query 不作他用，借它传目标）。
      const source = text(fixed.group).trim()
      const dest = text(fixed.dest ?? fixed.to ?? params.target ?? params.query).trim()
      if (source === '') return fail('promote', '未指定源分组：请给自建工具配置固定的分组', source)
      if (dest === '') return fail('promote', '缺少目标分组（调用时给出 target）', source)
      if (dest === source) return fail('promote', '源分组与目标分组相同，无需提升', source)
      if (match === '') return fail('promote', '缺少 match 参数（唯一标识条目的片段）', source)
      const preview = store.peek(source, match, agent)
      if (preview?.ok !== true) return fail('promote', text(preview?.message) || '没有找到匹配条目', source)
      const added = store.addEntry(dest, { body: bodyOf(preview.entry, source) }, agent)
      if (added?.ok !== true) return fail('promote', `写入 ${dest} 失败：${text(added?.message)}`, dest)
      const removed = store.remove(source, match, agent)
      if (removed?.ok !== true) {
        return fail('promote', `已写入 ${dest} 但源分组 ${source} 删除失败：${text(removed?.message)}`, dest)
      }
      return result('promote', {
        ok: true,
        message: `已把条目从 ${source} 提升到 ${dest}`,
        target: dest,
        count: 1,
      })
    }

    // ── 待办增删改查 ───────────────────────────────────────────────────
    case 'todo': {
      const group = groupFrom(tool, params)
      if (group === '') return fail('todo', '未指定待办分组：请给自建工具配置固定的分组，或调用时给出 target')
      // add：给了 body 且没给 id
      if (body !== '' && id === '') {
        const outcome = todoStore.addTodo(group, body, {}, cwd, sessionId)
        return result('todo', {
          ok: outcome?.ok === true,
          message: text(outcome?.message) || `已加入 ${group}`,
          target: group,
          count: outcome?.ok === true ? 1 : 0,
          id: text(outcome?.id),
        })
      }
      // 按 id 操作：match 填子操作名 done / remove，其它文本当作新正文
      if (id !== '') {
        if (match === '') return fail('todo', '按 id 操作需要 match：done=完成，remove=删除，其它文本=改写正文', group)
        const outcome = match === 'done'
          ? todoStore.doneTodo(group, id, cwd, undefined, sessionId)
          : match === 'remove'
            ? todoStore.removeTodo(group, id, cwd, undefined, sessionId)
            : todoStore.updateTodo(group, id, { content: match }, cwd, undefined, sessionId)
        return result('todo', {
          ok: outcome?.ok === true,
          message: text(outcome?.message) || `已更新 ${group} 的待办`,
          target: text(outcome?.target) || group,
          count: outcome?.ok === true ? 1 : 0,
          id,
        })
      }
      // 默认：列出该分组的待办
      const view = todoStore.listTodos([group], { all: true }, cwd, undefined, sessionId)
      const entries = (Array.isArray(view?.items) ? view.items : []).map((item) => {
        const flags = [text(item?.status) || 'pending']
        if (item?.quadrant) flags.push(text(item.quadrant))
        if (item?.due) flags.push(`due:${text(item.due)}`)
        return `${text(item?.id)} | ${flags.join(' ')} | ${text(item?.text)}`
      })
      return result('todo', {
        ok: true,
        message: `${group}：${entries.length} 条待办`,
        target: group,
        count: entries.length,
        total: number(view?.total) || entries.length,
        entries,
      })
    }

    // ── 提交待确认建议（不直接落盘）────────────────────────────────────
    case 'suggest': {
      const group = groupFrom(tool, params)
      if (group === '') return fail('suggest', '未指定目标分组：请给自建工具配置固定的分组，或调用时给出 target')
      if (body === '') return fail('suggest', '缺少 body 参数（建议写入的内容）', group)
      if (queue === null || queue === undefined) return fail('suggest', '建议队列不可用（插件未装配队列）', group)
      const outcome = enqueue(queue, group, body, text(fixed.reason).trim() || undefined, agent)
      return result('suggest', {
        ok: outcome?.ok === true,
        message: text(outcome?.message) || `已进入待确认队列（共 ${number(outcome?.queued)} 条）`,
        target: group,
        count: number(outcome?.queued),
      })
    }

    default:
      return fail(kind || 'unknown', `未知动作 "${kind}"（该动作不在可绑定清单内）`)
  }
}

/**
 * 根据 `<memoryDir>/tools.json` 的 `custom[]` 生成 DSH 工具定义数组。
 *
 * @param {object} deps - 依赖集合。
 * @param {object} deps.config - 插件配置（仅用于 memoryDir 兜底）。
 * @param {string} deps.memoryDir - 记忆根目录（读 tools.json）。
 * @param {object} deps.store - MemoryStore。
 * @param {object} deps.archive - ArchiveStore。
 * @param {object} deps.todoStore - TodoStore。
 * @param {object} [deps.queue] - SuggestionQueue（suggest 动作需要）。
 * @param {() => object} [deps.getGroups] - 现读分组配置（缺省读 memoryDir/groups.json）。
 * @param {(queue, target, content, reason, agent) => object} [deps.enqueue] - 入队实现（测试可注入）。
 * @param {() => object} [deps.loadConfig] - 读 tools.json（测试可注入）。
 * @returns {object[]} 工具定义数组（可直接 ctx.tools.register）。
 */
export function buildCustomTools(deps = {}) {
  const memoryDir = text(deps.memoryDir) || text(deps.config?.memoryDir)
  const store = deps.store
  const archive = deps.archive
  const todoStore = deps.todoStore
  const queue = deps.queue ?? null
  const getGroups = typeof deps.getGroups === 'function' ? deps.getGroups : () => loadGroups(memoryDir)
  const loadConfig = typeof deps.loadConfig === 'function' ? deps.loadConfig : () => loadToolsConfig(memoryDir)
  const dispatchDeps = { store, archive, todoStore, queue, getGroups, memoryDir, enqueue: deps.enqueue }

  let custom = []
  try {
    custom = loadConfig()?.custom ?? []
  } catch {
    custom = [] // 配置读不动 = 没有自建工具（内置定义永远可用）
  }

  const tools = []
  const used = new Set()
  for (const item of custom) {
    const name = text(item?.name).trim()
    // 撞名/非法名直接跳过：既不覆盖内置工具，也不让同一批次里后一条顶掉前一条
    if (name === '' || BUILTIN_TOOL_IDS.includes(name) || used.has(name)) continue
    // 名字必须符合 DSH 工具名规则（小写字母数字 + . _ -）
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(name)) continue
    used.add(name)
    tools.push({
      name,
      get description() {
        return text(item.description) || `自建工具（绑定动作：${text(item.action?.kind)}）`
      },
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderCustomResult(value) }],
      },
      async execute(args, exec) {
        // 任何异常都转成结构化失败：绝不把底层错误抛给 DSH（会被记成工具崩溃）
        try {
          // 布局门禁（v3）：迁移未完成时只放行只读动作（search/read/list 与 todo list）。
          const kind = text(item.action?.kind)
          const blocked = typeof deps.writesBlocked === 'function' ? deps.writesBlocked() : null
          const readOnly = kind === 'search' || kind === 'read' || kind === 'list'
            || (kind === 'todo' && text(args?.action) === 'list')
          if (blocked !== null && !readOnly) return fail(kind || 'custom', blocked)
          return await dispatch(item, args ?? {}, exec ?? {}, dispatchDeps)
        } catch (error) {
          return fail(text(item.action?.kind) || 'custom', `执行失败：${error?.message ?? String(error)}`)
        }
      },
    })
  }
  return tools
}
