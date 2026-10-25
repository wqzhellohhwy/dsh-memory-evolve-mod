/**
 * 「记忆库管理」工具（2026-10-15 用户需求，代号 B3 / F-5）。
 *
 * 定位：`memory` 工具管**单条**记忆的增删改查，`memory_search` 管**检索**；
 * 本工具管**库级**操作 —— 摸清结构、批量整理、跨级搬移、查重、取路径。
 * 目标是让模型自己就能把记忆库理干净，而不是让用户一条条点。
 *
 * ## 每个 action 与「工具 / 命令行」的取舍（用户要求逐项想清楚）
 * | action | 走工具的理由 |
 * |---|---|
 * | `info` | 路径/分组/计数都要读 groups.json 与目录，模型自己拼不出来 |
 * | `titles` | 要解析 frontmatter（标题≠文件名的情况），`ls` 做不到 |
 * | `path` | 拿绝对路径给 `read` 用 —— 这是**唯一推荐的命令行入口**（已知路径读文件比再调一次工具快） |
 * | `read` | 已知 id/title 时走它；已有路径时用 `read` 工具更快（描述里写明了） |
 * | `create` / `update` | 必须：要写 frontmatter、分配稳定 id、走文件锁 |
 * | `delete` | 必须：批量删除要按分组遍历 + 精确匹配，`rm` 会绕过校验且不可逆 |
 * | `archive` / `promote` | 必须：跨目录搬移 + 归档页索引 |
 * | `move` | 必须：跨类搬移（会话↔项目↔全局）要重算目录 |
 * | `dedupe` | 必须：要拿全库标题与摘要做比对 |
 *
 * 危险操作的边界：批量 `delete` / `archive` 必须给**精确匹配串列表**（不接受正则、
 * 不接受空匹配），逐条命中失败不阻断其余条目（返回逐条结果）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { projectIdOf } from './groups.js'

/** 只读 action（布局门禁放行；其余 action 会写盘）。 */
const LIBRARY_READ_ACTIONS = new Set(['info', 'titles', 'path', 'read', 'dedupe'])

/** 每条记忆的展示元数据（titles / info 用）。 */
function metaOf(entry) {
  return {
    title: entry.title ?? null,
    summary: entry.summary ?? null,
    keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
    scenario: entry.scenario ?? null,
    created: entry.created ?? null,
    updated: entry.updated ?? null,
    archived: entry.archivedAt != null,
    path: entry.file ?? null,
  }
}

/**
 * Build the `memory_library` tool definition.
 * @param {object} deps
 * @param {object} deps.config - resolved plugin config（要 memoryDir）。
 * @param {() => object} deps.getRuntime - 运行时配置（读开关）。
 * @param {(target: string, agent?: object) => object[]} deps.listEntries - 列某分组的条目实体。
 * @param {(group: object, agent?: object) => string} deps.titlesOf - 列某分组的标题与元数据。
 * @param {() => object[]} deps.listGroups - 全部记忆分组。
 * @param {(group: object, ctx: object) => string|null} deps.dirOf - 分组主轨目录。
 * @param {(group: object, ctx: object) => string|null} deps.archiveDirOf - 分组归档目录。
 * @param {() => object|null} deps.findGroup - 按 id 找记忆分组。
 * @param {(target: string, body: string, agent?: object) => object} deps.removeEntry - 精确删除。
 * @param {(target: string, body: string, agent?: object) => object} deps.updateEntry - 改写正文。
 * @param {(group: object, needle: string, cwd?: string, sessionId?: string) => object} deps.archiveEntry - 归档一条。
 * @param {(target: string, content: string) => object} deps.promoteEntry - 从归档移回。
 * @param {() => string|null} [deps.writesBlocked] - 布局门禁（返回拒绝文案或 null）。
 * @param {object} deps.t - host i18n（本工具文案走 `lib/i18n.js`）。
 * @returns {object} ToolDefinition。
 */
export function libraryToolDefinition(deps) {
  const { config, getRuntime } = deps

  // 路径上下文只传 id（v3）：`projectDirOf` 返回的是元数据目录，只取末段作
  // 项目 id；数据目录由 groups.js 的路径函数产出。
  const ctxOf = (agent) => {
    const cwd = agent?.session?.header?.cwd
    const resolved = cwd ? deps.projectDirOf?.(cwd) : null
    return {
      memoryDir: config.memoryDir,
      projectId: resolved ? projectIdOf({ projectDir: resolved }) : null,
      sessionId: agent?.session?.id ?? null,
    }
  }

  /** 某分组的目录信息（主轨 + 归档 + 条目数）。 */
  const groupInfo = (group, agent) => {
    const ctx = ctxOf(agent)
    const dir = deps.dirOf(group, ctx)
    const archiveDir = deps.archiveDirOf(group, ctx)
    return {
      id: group.id,
      klass: group.klass,
      kind: group.kind ?? 'memory',
      title: group.label ?? group.id,
      dir,
      archiveDir,
      inject: group.inject === true,
      injectMode: group.injectMode ?? 'inherit',
      confirm: group.confirm === true,
      enabled: group.enabled !== false,
      count: dir ? countMarkdownFiles(dir) : 0,
      archivedCount: archiveDir ? countMarkdownFiles(archiveDir) : 0,
    }
  }

  const GROUP_FILTER = (group, args) => {
    if (typeof args.group === 'string' && args.group !== '' && group.id !== args.group) return false
    if (typeof args.klass === 'string' && args.klass !== '' && group.klass !== args.klass) return false
    return true
  }

  return {
    name: 'memory_library',
    get description() { return deps.t('library.desc') },
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['info', 'titles', 'path', 'read', 'create', 'update', 'delete', 'archive', 'promote', 'dedupe'],
          get description() { return deps.t('library.action') },
        },
        group: { type: 'string', get description() { return deps.t('library.group') } },
        klass: { type: 'string', enum: ['session', 'project', 'global'], get description() { return deps.t('library.klass') } },
        title: { type: 'string', get description() { return deps.t('library.title') } },
        summary: { type: 'string', get description() { return deps.t('library.summary') } },
        keywords: { type: 'string', get description() { return deps.t('library.keywords') } },
        scenario: { type: 'string', get description() { return deps.t('library.scenario') } },
        body: { type: 'string', get description() { return deps.t('library.body') } },
        match: { type: 'string', get description() { return deps.t('library.match') } },
        matches: {
          type: 'array',
          items: { type: 'string' },
          get description() { return deps.t('library.matches') },
        },
        limit: { type: 'integer', get description() { return deps.t('library.limit') } },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          root: { type: 'string' },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                klass: { type: 'string' },
                kind: { type: 'string' },
                title: { type: 'string' },
                dir: { type: 'string' },
                archiveDir: { type: 'string' },
                inject: { type: 'boolean' },
                injectMode: { type: 'string' },
                confirm: { type: 'boolean' },
                enabled: { type: 'boolean' },
                count: { type: 'integer' },
                archivedCount: { type: 'integer' },
              },
              required: ['id', 'klass', 'kind', 'title', 'inject', 'injectMode', 'confirm', 'enabled', 'count', 'archivedCount'],
            },
          },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                group: { type: 'string' },
                title: { type: 'string' },
                summary: { type: 'string' },
                keywords: { type: 'array', items: { type: 'string' } },
                scenario: { type: 'string' },
                created: { type: 'string' },
                updated: { type: 'string' },
                archived: { type: 'boolean' },
                path: { type: 'string' },
              },
              required: ['group', 'title', 'archived'],
            },
          },
          group: { type: 'string' },
          title: { type: 'string' },
          path: { type: 'string' },
          body: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                match: { type: 'string' },
                group: { type: 'string' },
                ok: { type: 'boolean' },
                message: { type: 'string' },
              },
              required: ['match', 'group', 'ok', 'message'],
            },
          },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
          duplicates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                groups: { type: 'array', items: { type: 'string' } },
              },
              required: ['title', 'groups'],
            },
          },
        },
        required: ['ok', 'message'],
      },
      // render 必须把**数据**也回给模型：只回一句 message 的话，titles / dedupe /
      // 批量操作的结果模型根本看不到（实测踩过 —— 调用成功但等于没拿到东西）。
      render: (_args, value) => {
        const lines = []
        if (typeof value.message === 'string' && value.message !== '') lines.push(value.message)
        if (Array.isArray(value.groups)) {
          for (const group of value.groups) {
            lines.push(`· [${group.klass}] ${group.id}（${group.title}）：主轨 ${group.count} 条 / 归档 ${group.archivedCount} 条 / 注入 ${group.inject ? '开' : '关'}（${group.injectMode}）/ 需确认 ${group.confirm ? '是' : '否'} / ${group.enabled ? '启用' : '停用'}\n  ${group.dir ?? '-'}`)
          }
        }
        if (Array.isArray(value.entries)) {
          for (const entry of value.entries) {
            const meta = [entry.summary, Array.isArray(entry.keywords) ? entry.keywords.join(',') : ''].filter(Boolean).join('｜')
            lines.push(`· [${entry.group}] ${entry.title ?? '(无标题)'}${meta ? `｜${meta}` : ''}${entry.path ? `\n  ${entry.path}` : ''}`)
          }
        }
        if (Array.isArray(value.results)) {
          for (const row of value.results) lines.push(`${row.ok ? '✓' : '✗'} ${row.group || '-'}｜${row.match}｜${row.message}`)
        }
        if (Array.isArray(value.duplicates)) {
          for (const row of value.duplicates) lines.push(`· ${row.title} ← 出现在 ${row.groups.join(' / ')}`)
        }
        if (typeof value.body === 'string' && value.body !== '') lines.push(value.body)
        return [{ type: 'text', text: lines.filter((line) => line !== '').join('\n') }]
      },
    },
    async execute(args, exec) {
      const runtime = getRuntime()
      if (runtime.memoryLibraryEnabled !== true) {
        return { ok: false, message: deps.t('library.disabled') }
      }
      // 布局门禁（v3）：迁移未完成时只放行只读 action。
      if (!LIBRARY_READ_ACTIONS.has(args.action)) {
        const blocked = typeof deps.writesBlocked === 'function' ? deps.writesBlocked() : null
        if (blocked !== null) return { ok: false, message: blocked }
      }
      const agent = exec?.agent
      const action = args.action
      const groups = deps.listGroups().filter((group) => GROUP_FILTER(group, args))
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 200

      // ── info：摸清库结构（分组 / 目录 / 计数 / 开关） ──────────────────
      if (action === 'info') {
        const rows = groups.map((group) => groupInfo(group, agent))
        return {
          ok: true,
          root: config.memoryDir,
          groups: rows,
          total: rows.reduce((sum, row) => sum + row.count, 0),
          message: deps.t('library.infoDone', {
            root: config.memoryDir,
            groups: rows.length,
            count: rows.reduce((sum, row) => sum + row.count, 0),
          }),
        }
      }

      // ── titles：扫描全库标题 + 元数据（记忆树骨架） ────────────────────
      if (action === 'titles') {
        const entries = []
        let truncated = false
        for (const group of groups) {
          for (const item of deps.titlesOf(group, agent)) {
            if (entries.length >= limit) { truncated = true; break }
            entries.push({ group: group.id, ...metaOf(item), archived: false })
          }
          if (truncated) break
        }
        return {
          ok: true,
          entries,
          total: entries.length,
          truncated,
          message: deps.t('library.titlesDone', { count: entries.length, groups: groups.length }),
        }
      }

      // ── path：取文件绝对路径（**唯一推荐的命令行入口**：拿到路径后直接用
      //     read 工具读文本比再调一次本工具快） ──────────────────────────
      if (action === 'path') {
        if (groups.length === 0) return { ok: false, message: deps.t('library.noGroup') }
        const ctx = ctxOf(agent)
        const lines = []
        for (const group of groups) {
          const dir = deps.dirOf(group, ctx)
          const archiveDir = deps.archiveDirOf(group, ctx)
          lines.push(`${group.id}\t${dir ?? '-'}\t${archiveDir ?? '-'}`)
        }
        return {
          ok: true,
          root: config.memoryDir,
          path: config.memoryDir,
          message: `${deps.t('library.pathDone', { root: config.memoryDir })}\n${lines.join('\n')}`,
        }
      }

      // ── read：按精确匹配读一条的正文（已知路径时用 read 工具更快） ────
      if (action === 'read') {
        const match = String(args.match ?? args.title ?? '').trim()
        if (match === '') return { ok: false, message: deps.t('library.needMatch') }
        for (const group of groups) {
          const hit = deps.readEntry(group, match, agent)
          if (hit !== null) {
            return {
              ok: true,
              group: hit.group,
              title: hit.title,
              path: hit.path,
              body: hit.body,
              message: hit.body,
            }
          }
        }
        return { ok: false, message: deps.t('library.notFound', { match }) }
      }

      // ── create：新建（走该分组的确认门槛，与 memory 工具一致） ────────
      if (action === 'create') {
        const body = String(args.body ?? '').trim()
        if (body === '') return { ok: false, message: deps.t('library.needBody') }
        if (groups.length !== 1) return { ok: false, message: deps.t('library.needOneGroup') }
        const outcome = await deps.createEntry(groups[0], {
          title: args.title,
          summary: args.summary,
          keywords: args.keywords,
          scenario: args.scenario,
          body,
        }, agent)
        return { ok: outcome.ok === true, message: outcome.message ?? '', results: undefined }
      }

      // ── update：改写正文（按精确匹配定位） ────────────────────────────
      if (action === 'update') {
        const match = String(args.match ?? args.title ?? '').trim()
        const body = String(args.body ?? '').trim()
        if (match === '' || body === '') return { ok: false, message: deps.t('library.needMatchAndBody') }
        // 逐个分组试：某组"没命中"（ok:false）**不能**直接判失败 ——
        // 否则条目在别的分组时永远改不动（分组顺序在前的那组会抢先返回失败）。
        let last = null
        for (const group of groups) {
          const outcome = deps.updateEntry(group, match, body, agent)
          if (outcome === null) continue
          if (outcome.ok === true) return { ok: true, message: outcome.message ?? '' }
          last = outcome
        }
        return { ok: false, message: last?.message ?? deps.t('library.notFound', { match }) }
      }

      // ── delete / archive：批量（必须给精确匹配串列表；逐条报告，不因一条失败停下）
      if (action === 'delete' || action === 'archive') {
        const list = Array.isArray(args.matches) && args.matches.length > 0
          ? args.matches.map((item) => String(item))
          : (typeof args.match === 'string' && args.match.trim() !== '' ? [args.match.trim()] : [])
        if (list.length === 0) return { ok: false, message: deps.t('library.needMatches') }
        const results = []
        const t = deps.t
        for (const needle of list) {
          // 同上：只有**成功**才算命中，失败要继续试后面的分组。
          let reported = null
          for (const group of groups) {
            const outcome = action === 'delete'
              ? deps.deleteEntry(group, needle, agent)
              : deps.archiveEntry(group, needle, agent)
            if (outcome === null) continue
            if (outcome.ok === true) {
              reported = { match: needle, group: group.id, ok: true, message: outcome.message ?? '' }
              break
            }
            if (reported === null) reported = { match: needle, group: group.id, ok: false, message: outcome.message ?? '' }
          }
          results.push(reported ?? { match: needle, group: '', ok: false, message: t('library.notFound', { match: needle }) })
        }
        const okCount = results.filter((row) => row.ok).length
        return {
          ok: okCount > 0,
          results,
          total: results.length,
          message: deps.t(action === 'delete' ? 'library.deleteDone' : 'library.archiveDone', { ok: okCount, total: results.length }),
        }
      }

      // ── promote：从归档移回主轨 ──────────────────────────────────────
      if (action === 'promote') {
        const match = String(args.match ?? args.title ?? '').trim()
        if (match === '') return { ok: false, message: deps.t('library.needMatch') }
        // 同上：某个分组的归档里没有这条，不代表别的分组也没有。
        let last = null
        for (const group of groups) {
          const outcome = deps.promoteEntry(group, match, agent)
          if (outcome === null) continue
          if (outcome.ok === true) return { ok: true, message: outcome.message ?? '' }
          last = outcome
        }
        return { ok: false, message: last?.message ?? deps.t('library.notFoundInArchive', { match }) }
      }

      // ── dedupe：查重（同标题出现在多个分组 = 疑似重复） ────────────────
      if (action === 'dedupe') {
        const seen = new Map()
        for (const group of groups) {
          for (const item of deps.titlesOf(group, agent)) {
            const title = String(item.title ?? '').trim()
            if (title === '') continue
            const key = deps.normalizeTitle(title)
            const row = seen.get(key) ?? { title, groups: [] }
            if (!row.groups.includes(group.id)) row.groups.push(group.id)
            seen.set(key, row)
          }
        }
        const duplicates = [...seen.values()].filter((row) => row.groups.length > 1)
        return {
          ok: true,
          duplicates,
          total: duplicates.length,
          message: deps.t('library.dedupeDone', { count: duplicates.length }),
        }
      }

      return { ok: false, message: deps.t('library.unknownAction', { action }) }
    },
  }
}

/** 目录里 md 文件数（不存在按 0；用于 info 的计数）。 */
export function countMarkdownFiles(dir) {
  if (typeof dir !== 'string' || dir === '' || !existsSync(dir)) return 0
  let count = 0
  const walk = (base) => {
    let names = []
    try {
      names = readdirSync(base, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of names) {
      if (item.isDirectory()) walk(join(base, item.name))
      else if (item.name.endsWith('.md')) count += 1
    }
  }
  walk(dir)
  return count
}
