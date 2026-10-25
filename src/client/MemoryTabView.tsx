/**
 * dsh-memory-evolve — session memory tab (conversation.view entry).
 *
 * 2026-10-15「三类改造」后的页签结构（三级）：
 *
 *   一级：[待确认记忆建议] [会话类] [项目类] [全局类] …… [指南（最后一位）]
 *   二级：选中某个类之后，该类下每个**启用分组**一个页签 + 最后一个是「归档」
 *   三级：分组页签显示该分组的条目卡片；归档页签显示该类下所有分组的归档条目
 *
 * 数据来自宿主 `GET /memory-evolve/api/memory-files`：
 *   - `files`：旧版扁平数组（兜底路径仍可用）；
 *   - `classes`：三类树（`{klass, label, groups[], archive}`），每个分组带
 *     目录、条目数、归档目录与归档条目数、以及已经渲染好的条目正文（§ 契约）。
 * 兼容三种载荷形状：顶层 `classes`；`files` 是对象（api.js 目前把它包在
 * `files:` 字段里）；都没有时用旧扁平行现场合成一棵单层树。
 *
 * 每个分组都是**只读白名单**：条目正文不会被就地编辑——写入一律走宿主 API
 * （memory 工具、手动添加框、卡片上的编辑/删除按钮），避免手改 § 分隔格式
 * 破坏记忆解析。本 Tab 只读宿主数据，对 LLM 上下文零影响。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DEFAULT_EXPAND_OPTIONS,
  entryKeyOf,
  expandOptionsOf,
  useEntryViews,
  type EntryExpandOptions,
} from './entry-view.ts'
import { MemoryQueueView } from './MemoryQueueView.tsx'
import { TabGuideView, type GuideSection } from './TabGuideView.tsx'
import { askConfirm } from './ask-confirm.ts'
import { useToast } from './Toast.tsx'
import { InlineError } from './InlineError.tsx'

/**
 * 功能子 tab（记忆专属）：指南 / 待确认记忆建议。
 * 整体指南与运行时配置已抽到「Memory Evolve 设置」Tab（SettingsTabView）；
 * 本 Tab 的「指南」是记忆功能自己的详细介绍（非整体简介），且**固定排在
 * 一级页签最后一位**。
 */
type TabFeature = 'guide' | 'suggestions' | 'prompt'

/** 归档页签的哨兵 id（二级页签里跟在所有分组之后）。 */
const ARCHIVE_ID = '__archive__'

/** 停用分组的显示二态（与宿主运行时配置 `showDisabled` 同值；缺省 hidden）。 */
type DisabledMode = 'shown' | 'hidden'

/** 显示二态的本地兜底键（宿主 /api/config 的 `showDisabled` 是权威值）。 */
const DISABLED_SETTING_KEY = 'memory-evolve:showDisabledGroups'

/**
 * 归一宿主/本地给的值（非法值 → null）。
 * 历史值 `dim`（灰显）已废弃：它与 `shown` 视觉上分不出来（用户实测：
 * "灰显根本看不出来"），统一按 `shown` 处理，旧配置不会失效。
 */
function normalizeDisabledMode(value: unknown): DisabledMode | null {
  if (value === 'dim') return 'shown'
  return value === 'shown' || value === 'hidden' ? value : null
}

/** 本地兜底设置（宿主没给值时的初值；默认 hidden = 停用分组不显示）。 */
function readDisabledMode(): DisabledMode {
  try {
    return normalizeDisabledMode(window.localStorage.getItem(DISABLED_SETTING_KEY)) ?? 'hidden'
  } catch {
    // 隐私模式/存储禁用：按缺省处理
    return 'hidden'
  }
}

/** One legacy memory-file row (the pre-three-class flat listing). */
interface MemoryFileRow {
  key: string
  title: string
  available: boolean
  exists: boolean
  truncated: boolean
  path?: string
  content: string
}

/** 一个分组（二级页签的一格），来自宿主 classes 树。 */
interface MemoryGroupItem {
  klass?: string
  id: string
  title: string
  /** 分组**目录**（一条记忆一个 md 文件，2026-10-15 起）。 */
  path?: string
  /** 分组目录里的条目数（含日志型的一层日期子目录）。 */
  count?: number
  archivedPath?: string
  archivedCount?: number
  enabled?: boolean
  daily?: boolean
  builtin?: boolean
  available?: boolean
  exists?: boolean
  /** 时间戳形状：time `[HH:MM]` / datetime `[YYYY-MM-DD HH:MM]` / date `[YYYY-MM-DD]`。 */
  stampKind?: string
  content?: string
  /** 结构化条目（宿主 entryItemOf 的输出，F-7 / F-8 用；旧载荷没有）。 */
  entries?: MemoryEntryMeta[]
}

/** 归档页签内的一「来源分组」块。 */
interface MemoryArchiveGroup {
  id: string
  title: string
  path?: string
  count?: number
  stampKind?: string
  content?: string
  /** 结构化条目（同分组项）。 */
  entries?: MemoryEntryMeta[]
}

/**
 * 宿主 `entries` 里一条的元数据形状（lib/memory-tab.js 的 entryItemOf）。
 * `raw` 是完整原文，用来确认两边逐条对齐。
 */
interface MemoryEntryMeta {
  id?: string
  raw?: string
  title?: string
  summary?: string
  keywords?: string[]
  scenario?: string
}

/** 一个类的归档节点（该类下所有分组的归档条目）。 */
interface MemoryArchiveNode {
  klass?: string
  label?: string
  count?: number
  groups?: MemoryArchiveGroup[]
}

/** 一个类节点（一级页签的一格）。 */
interface MemoryClassNode {
  klass: string
  label?: string
  /** 该类根路径（会话=会话目录 / 工作区=工作区路径 / 全局=dsh-home），用户 UI-13。 */
  rootPath?: string
  groups?: MemoryGroupItem[]
  archive?: MemoryArchiveNode | null
}

/** 条目数显示口径（用户 UI-16）：三类各一个显示开关 + 含停用 / 含归档两个口径开关。 */
interface CountDisplayOptions {
  session: boolean
  project: boolean
  global: boolean
  /** 数字是否算上已停用分组的条目。 */
  includeDisabled: boolean
  /** 数字是否算上已归档条目。 */
  includeArchived: boolean
}

/** 缺省口径：三类都显示数字；含停用、不含归档（与改造前行为一致）。 */
const DEFAULT_COUNT_OPTIONS: CountDisplayOptions = {
  session: true,
  project: true,
  global: true,
  includeDisabled: true,
  includeArchived: false,
}

/**
 * 宿主运行时配置 → 条目数显示口径。
 * @param config - `/api/config` 返回的 config 对象。
 * @returns 归一后的口径（键缺失一律回退缺省值）。
 */
function countOptionsOf(config: Record<string, unknown> | undefined): CountDisplayOptions {
  if (config === undefined) return DEFAULT_COUNT_OPTIONS
  return {
    session: config.countShowSession !== false,
    project: config.countShowProject !== false,
    global: config.countShowGlobal !== false,
    includeDisabled: config.countIncludeDisabled !== false,
    includeArchived: config.countIncludeArchived === true,
  }
}

/** Locale-bound props (the `memoryEvolve` namespace). */
export interface MemoryTabViewProps {
  t: Translate
}

/** 视图模式：美观（条目卡片）/ 纯文本（原始 <pre>）。 */
type ViewMode = 'pretty' | 'raw'

/** 一条解析后的 § 条目：可选时间戳 + 可选项目标签 + 可选 git 分支 + 正文 + 原始全文。 */
interface MemoryEntry {
  /** vault 条目的稳定 id（宿主 entries 提供；旧数据没有时用原文指纹）。 */
  id?: string
  time: string | null
  tag: string | null
  /** 程序标注的 git 分支（[git main]），daily/project 日志来源分支。 */
  branch: string | null
  /** key 轨的分支范围：null=全部，否则为分支名列表（来自 [branch:...] 标记）。 */
  branches: string[] | null
  /** 「仅 DSH」标记（[dsh-only]）：该条目只注入 DSH 自身，注入外部执行器（COI）时跳过。 */
  dshOnly: boolean
  /** 剥离前缀后的正文。 */
  text: string
  /** 剥离前/解析前的完整条目原文（含时间戳），删除时按它精确匹配。 */
  raw: string
  /** 以下四项来自宿主的结构化 entries（frontmatter），旧载荷里为空（F-7）。 */
  title?: string
  summary?: string
  keywords?: string[]
  scenario?: string
}

/** § 条目分隔符，与 lib/store.js 的 ENTRY_DELIMITER 保持一致。 */
const ENTRY_DELIMITER = '\n§\n'

/** key 条目分支标记：`[2026-08-06] [branch:main,dev] 内容`。 */
const BRANCH_TAG_RE = /(?:^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*)?\[branch:([^\]]*)\]\s*/

/** 「仅 DSH」标记：`[2026-08-06] [dsh-only] 内容`（任意位置出现即视为已标记）。 */
const DSH_ONLY_RE = /\[dsh-only\]\s*/

/** 时间戳前缀（按分组的时间戳形状选择；宿主 stampKind 给的就是这三种）。 */
const STAMP_RE = {
  time: /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/,
  datetime: /^\[(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?::\d{2})?)\]\s*/,
  date: /^\[(\d{4}-\d{2}-\d{2})\]\s*/,
} as const


/** 兜底时间戳正则：stampKind 与实际文本不符时仍能剥掉时间戳。 */
const GENERIC_STAMP_RE = /^\[(\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}:\d{2}(?::\d{2})?)\]\s*/

/** 内置分组 id（其余即用户自建分组）。 */
/** 内置分组 id（UI-17 后手写框一视同仁，本集合不再用于限制写入）。 */
/** 内置全局轨：手动添加框的既有支持对象。 */
const BUILTIN_MANUAL_ADD = new Set(['memory', 'user', 'kb'])
/**
 * 归档按钮「对所有记忆分组可用」（含 kb / project / daily / session 与用户自建分组）——
 * 原先这里是分组化之前的三轨白名单 `['memory','user','key']`，于是 kb 等分组的条目
 * 只剩「编辑 / 删除」，用户报「归档按钮不见了」。判定改成「不是归档页签即可」，
 * 与宿主 `/api/memory/archive` 现在接受任意记忆分组一致。
 */
/** 服务端「仅 DSH」端点白名单。 */
const DSH_ONLY_IDS = new Set(['memory', 'user', 'key'])
/** 注入轨：保存后会立即进入模型上下文（编辑保存需确认）。 */
const INJECTED_IDS = new Set(['memory', 'user', 'key'])
/** 「用系统工具打开」的目标映射（宿主 /api/reveal 只认这些固定名）。 */
const REVEAL_TARGET: Record<string, string> = {
  memory: 'memoryFile',
  user: 'userFile',
  kb: 'kbFile',
  daily: 'dailyFile',
  project: 'projectsDir',
  key: 'projectsDir',
  agents: 'agentsFile',
}

/** 旧扁平行 key → 时间戳形状（兜底路径用）。 */
function legacyStampKind(key: string): string {
  if (key === 'daily') return 'time'
  if (key === 'project') return 'datetime'
  return 'date'
}

/**
 * 该分组是否显示手动添加框。
 *
 * **一视同仁**（2026-10-15 用户 UI-17）：除 key（有自带分支 / DSH 选项的专用框）
 * 与已停用分组外，内置分组、日志型分组、自建分组都显示同一个手写框。写入分流：
 * 内置全局三轨（memory / user / kb）→ 各自的专用端点；其余（含会话类、工作区类、
 * 每日日志）→ /api/memory/group，由宿主按该分组的「类」解析目录。
 */
function isManualAddGroup(group: MemoryGroupItem): boolean {
  if (group.enabled === false) return false
  if (group.id === 'key') return false // key 有自带分支/DSH 选项的专用框
  return true
}

/**
 * 把宿主的结构化 entries（frontmatter 元数据 + vault id）按顺序挂到解析结果上。
 *
 * 排版与剥离仍以 § 文本为准（不变），这里只补文本里没有的东西。两边的原文
 * 逐条必须完全一致才挂（`raw` 比对）—— 旧载荷、手改过内容的场合宁缺不串位。
 * @param entries - parseEntries 的结果。
 * @param meta - 宿主给的 entries（缺省/空 = 原样返回）。
 * @returns 补上 id 与元数据的条目数组。
 */
function attachMeta(entries: MemoryEntry[], meta: MemoryEntryMeta[] | undefined): MemoryEntry[] {
  if (meta === undefined || meta.length === 0) return entries
  return entries.map((entry, index) => {
    const hit = meta[index]
    if (hit === undefined || hit.raw !== entry.raw) return entry
    return {
      ...entry,
      id: hit.id,
      title: hit.title,
      summary: hit.summary,
      keywords: hit.keywords,
      scenario: hit.scenario,
    }
  })
}

/** 把宿主 content 拆成 § 条目，按时间戳形状剥离前缀与各标签。 */
function parseEntries(content: string, stampKind: string | undefined): MemoryEntry[] {
  const prefix = STAMP_RE[(stampKind ?? 'date') as keyof typeof STAMP_RE] ?? STAMP_RE.date
  const entries: MemoryEntry[] = []
  for (const raw of String(content ?? '').split(ENTRY_DELIMITER)) {
    let text = raw.trim()
    if (text === '') continue
    const rawText = text // 完整原文（含时间戳），删除/编辑时精确匹配用
    let time: string | null = null
    let tag: string | null = null
    let branch: string | null = null
    let branches: string[] | null = null
    let dshOnly = false
    const timeMatch = prefix.exec(text) ?? GENERIC_STAMP_RE.exec(text)
    if (timeMatch !== null) {
      time = timeMatch[1]
      text = text.slice(timeMatch[0].length)
      // 程序标注的 git 分支（[git main]）：daily/project 日志的来源分支
      const gitMatch = /^\[git ([^\]]+)\]\s*/.exec(text)
      if (gitMatch !== null) {
        branch = gitMatch[1]
        text = text.slice(gitMatch[0].length)
      }
      // key 轨的分支范围 [branch:main,dev]
      const branchMatch = BRANCH_TAG_RE.exec(rawText)
      if (branchMatch !== null) {
        const list = branchMatch[1].split(',').map((item) => item.trim()).filter(Boolean)
        branches = list.length > 0 ? list : null
        text = text.replace(BRANCH_TAG_RE, '')
      }
      // 「仅 DSH」标记（显示剥离，整条原文保留在 raw）
      if (DSH_ONLY_RE.test(text)) {
        dshOnly = true
        text = text.replace(DSH_ONLY_RE, '')
      }
      // 摘要标记 [summary:…]（渐进式披露用的程序元数据；展示正文时不再显示）
      text = text.replace(/^\[summary:[^\]]*\]\s*/, '')
      // daily/项目日志的程序项目标签：时间戳后紧跟的第一个任意 […]（[git …] 已剥）
      const tagMatch = /^\[([^\]]+)\]\s*/.exec(text)
      if (tagMatch !== null) {
        tag = tagMatch[1]
        text = text.slice(tagMatch[0].length)
      }
    }
    entries.push({ time, tag, branch, text, branches, dshOnly, raw: rawText })
  }
  return entries
}

/** 关键词匹配：内容 / 时间 / 标签，大小写不敏感（q 已转小写）。 */
function entryMatches(entry: MemoryEntry, q: string): boolean {
  return entry.text.toLowerCase().includes(q)
    || (entry.time ?? '').toLowerCase().includes(q)
    || (entry.tag ?? '').toLowerCase().includes(q)
}

/**
 * 美观视图分页大小（2026-08-10）：项目日志/每日日志是追加增长型文件
 * （一年可达几千条），一次性渲染全部条目会卡顿；按条目分页，每页 50 条。
 */
const PAGE_SIZE = 50

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/memory-evolve${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

/** 跨重挂持久化的 tab 选择（模块级：badge 刷新导致的组件重挂后恢复）。 */
// 跨会话隔离（稳定版复审 P1-4）：模块级单值变量会在会话间串台——切换
// 会话时子 Tab/分组页签选择沿用上一会话的。改为按 sessionId 分桶。
// 值的形状：`<类id>/<分组id|__archive__|空>`（2026-10-15 三类改造）。
//
// 2026-10-15（F-8，用户要求"记住记忆/待办打开时的位置"）：**落 localStorage**
// —— 模块级 Map 只能扛组件重挂，刷新页面就丢，用户下次进来又回到第一个分组。
const persistedFeatures = new Map<string, TabFeature | null>()
const persistedSelections = new Map<string, string>()

/** 位置记忆的 localStorage 键（按会话分桶，与内存 Map 同源）。 */
function positionKeyOf(sessionKey: string): string {
  return `memory-evolve:memory-tab:position:${sessionKey}`
}

/** 读回该会话上次的位置（读不到给空对象）。 */
function readPosition(sessionKey: string): { feature?: TabFeature | null; selection?: string } {
  try {
    const raw = window.localStorage.getItem(positionKeyOf(sessionKey))
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as { feature?: TabFeature | null; selection?: string }
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 写回该会话的位置（存储不可用时静默降级为仅内存）。 */
function writePosition(sessionKey: string, feature: TabFeature | null, selection: string): void {
  try {
    window.localStorage.setItem(positionKeyOf(sessionKey), JSON.stringify({ feature, selection }))
  } catch {
    // 隐私模式 / 存储禁用：本次会话内仍由内存 Map 生效
  }
}

/**
 * 记忆数据的模块级缓存（按 sessionId，2026-10-11「无感进入」）。
 *
 * 背景：宿主在 badge（待确认建议计数）变化时会 dispose + 重新注册本 Tab
 * 的 conversation.view 槽位，组件因此重挂；每次重挂都会重新拉取
 * `/api/memory-files`——该接口要读全部分组条目并跑 git 查询，于是每点一次
 * 「记忆」都先闪一段"加载中"。
 *
 * 缓存语义：拿到过一次数据后，重挂/切回 Tab 先用缓存瞬时渲染（首帧就有
 * 内容、不显示加载态），随后后台静默刷新并与磁盘对齐；刷新失败保留缓存
 * 内容，只提示错误。数据只是展示用，陈旧一瞬无副作用。
 */
interface MemoryFilesPayload {
  files: MemoryFileRow[]
  classes: MemoryClassNode[] | null
  cwd: string | null
  branch: string | null
  branches: string[]
}
const filesCache = new Map<string, MemoryFilesPayload>()

/**
 * 兼容三种宿主载荷形状，取出「扁平数组 + 三类树」：
 *   ① `res.classes` 是数组（api.js 已展开）；
 *   ② `res.files` 是对象且带 `classes`（api.js 仍是 `files: buildMemoryFiles(...)`）；
 *   ③ 都没有（宿主还没升到三类模型）→ 用旧扁平行现场合成单层树。
 * @param raw - 接口原始返回。
 * @returns {{files: MemoryFileRow[], classes: MemoryClassNode[]|null}}
 */
function normalizePayload(raw: unknown): { files: MemoryFileRow[]; classes: MemoryClassNode[] | null } {
  const body = (raw ?? {}) as Record<string, unknown>
  const rawFiles = body.files
  const nested = rawFiles !== null && typeof rawFiles === 'object' && !Array.isArray(rawFiles)
    ? (rawFiles as Record<string, unknown>)
    : null
  const files: MemoryFileRow[] = Array.isArray(rawFiles)
    ? (rawFiles as MemoryFileRow[])
    : nested !== null && Array.isArray(nested.files) ? (nested.files as MemoryFileRow[]) : []
  const topClasses = Array.isArray(body.classes) ? (body.classes as MemoryClassNode[]) : null
  const nestedClasses = nested !== null && Array.isArray(nested.classes)
    ? (nested.classes as MemoryClassNode[])
    : null
  const classes = topClasses ?? nestedClasses
  return { files, classes: classes !== null && classes.length > 0 ? classes : (classes ?? null) }
}

/** 旧扁平行 → 三类树（宿主未升级时的兜底：按旧 key 猜类）。 */
function legacyClasses(files: MemoryFileRow[]): MemoryClassNode[] {
  const nodes: Record<string, MemoryClassNode> = {
    session: { klass: 'session', label: '会话类', groups: [], archive: { klass: 'session', groups: [] } },
    project: { klass: 'project', label: '项目类', groups: [], archive: { klass: 'project', groups: [] } },
    global: { klass: 'global', label: '全局类', groups: [], archive: { klass: 'global', groups: [] } },
  }
  const klassOf = (key: string): string =>
    key === 'project' || key === 'key' || key === 'archive-key' ? 'project' : 'global'
  for (const row of files) {
    const klass = klassOf(row.key)
    const archive = row.key.startsWith('archive-')
    const id = archive ? row.key.slice('archive-'.length) : row.key
    const item: MemoryGroupItem = {
      klass,
      id,
      title: row.title,
      path: row.path,
      enabled: true,
      daily: false,
      builtin: true,
      available: row.available,
      exists: row.exists,
      stampKind: legacyStampKind(id),
      content: row.content,
    }
    if (archive) {
      nodes[klass].archive?.groups?.push({ id, title: row.title, path: row.path, stampKind: 'datetime', content: row.content })
    } else {
      nodes[klass].groups?.push(item)
    }
  }
  for (const node of Object.values(nodes)) {
    if (node.archive !== null && node.archive !== undefined) {
      node.archive.count = (node.archive.groups ?? []).reduce((sum, group) => sum + (group.count ?? 0), 0)
    }
  }
  return [nodes.session, nodes.project, nodes.global].filter((node) => (node.groups ?? []).length > 0)
}

/**
 * 记忆 Tab 专属指南内容（「指南」子 Tab）：
 * 详细介绍记忆功能本身——三类三级页签、分组与归档、git 分支感知、编辑维护、
 * 待确认记忆建议机制。文案来自全局 locale（memoryTab.guide.* 键组）。
 */
function memoryGuideSections(t: Translate): GuideSection[] {
  return [
    {
      icon: '🧠',
      title: t('memoryTab.guide.tracks.title'),
      body: t('memoryTab.guide.tracks.body'),
      items: [
        t('memoryTab.guide.tracks.item1'),
        t('memoryTab.guide.tracks.item2'),
        t('memoryTab.guide.tracks.item3'),
        t('memoryTab.guide.tracks.item4'),
        t('memoryTab.guide.tracks.item5'),
      ],
    },
    {
      icon: '📂',
      title: t('memoryTab.guide.files.title'),
      body: t('memoryTab.guide.files.body'),
      items: [
        t('memoryTab.guide.files.item1'),
        t('memoryTab.guide.files.item2'),
        t('memoryTab.guide.files.item3'),
      ],
    },
    {
      icon: '🌿',
      title: t('memoryTab.guide.branch.title'),
      body: t('memoryTab.guide.branch.body'),
      items: [
        t('memoryTab.guide.branch.item1'),
        t('memoryTab.guide.branch.item2'),
      ],
    },
    {
      icon: '🛠️',
      title: t('memoryTab.guide.maintain.title'),
      body: t('memoryTab.guide.maintain.body'),
      items: [
        t('memoryTab.guide.maintain.item1'),
        t('memoryTab.guide.maintain.item2'),
        t('memoryTab.guide.maintain.item3'),
      ],
    },
    {
      icon: '✅',
      title: t('memoryTab.guide.suggestions.title'),
      body: t('memoryTab.guide.suggestions.body'),
      items: [
        t('memoryTab.guide.suggestions.item1'),
        t('memoryTab.guide.suggestions.item2'),
      ],
    },
    {
      icon: '🛡️',
      title: t('memoryTab.guide.confirm.title'),
      body: t('memoryTab.guide.confirm.body'),
    },
  ]
}

/** The conversation view tab component. */
export function MemoryTabView(props: ConvViewProps & MemoryTabViewProps): JSX.Element {
  const { sessionId, t } = props
  const sessionKey = String(sessionId)
  const cached = filesCache.get(sessionKey)
  // 跨重挂持久化：badge 变化时宿主会 deferral.refresh()（dispose+重新注册），
  // 组件被卸载重挂——功能 tab / 类 / 分组的选择必须恢复。
  // 内存 Map 优先（本次会话内最快且含"用户显式清空"的 null），其次读 localStorage
  // 上次落盘的位置（F-8：刷新页面后也要回到上次那个分组）。
  const position = readPosition(sessionKey)
  const saved = persistedSelections.get(sessionKey) ?? position.selection ?? ''
  const [savedKlass, savedGroup] = saved.split('/')

  const [classes, setClasses] = useState<MemoryClassNode[] | null>(cached?.classes ?? null)
  /** 旧扁平行（仅在宿主没给三类树时用于兜底视图）。 */
  const [files, setFiles] = useState<MemoryFileRow[]>(cached?.files ?? [])
  /** 一次性结果提示（右下角弹窗）。 */
  const notify = useToast(t)
  /** 整页加载失败：页内常驻错误 + 重试。 */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [cwd, setCwd] = useState<string | null>(cached?.cwd ?? null)
  /** 当前 git 分支（null=非 git/无法获取）；branches=全部分支（下拉选项）。 */
  const [branch, setBranch] = useState<string | null>(cached?.branch ?? null)
  const [branches, setBranches] = useState<string[]>(cached?.branches ?? [])
  const [view, setView] = useState<ViewMode>('pretty')
  const [query, setQuery] = useState('')
  // 美观视图分页（大分组如项目日志按条目分页渲染，每页 PAGE_SIZE 条）
  const [page, setPage] = useState(0)
  /** 停用分组的显示三态（缺省 hidden）。 */
  const [showDisabled, setShowDisabled] = useState<DisabledMode>(readDisabledMode)
  /** 当前选中的类（一级页签）与分组（二级页签，ARCHIVE_ID = 归档）。 */
  const [activeKlass, setActiveKlass] = useState<string>(savedKlass === undefined || savedKlass === '' ? 'session' : savedKlass)
  const [activeGroupId, setActiveGroupId] = useState<string | null>(savedGroup === undefined || savedGroup === '' ? null : savedGroup)
  /** 手动添加项目关键记忆的草稿与保存状态。 */
  const [keyDraft, setKeyDraft] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  /** 手动添加全局记忆的草稿（按分组 id 分桶，切页签不丢草稿）与保存状态。 */
  const [globalDrafts, setGlobalDrafts] = useState<Record<string, string>>({})
  const [globalSaving, setGlobalSaving] = useState(false)
  /** 手动添加时的「仅 DSH」勾选：勾上 = 条目带 [dsh-only] 标记。 */
  const [keyDshOnly, setKeyDshOnly] = useState(false)
  /** 手动添加时的分支范围选择：[] = 全部（与具体分支互斥，全部权重最大）。 */
  const [keyScope, setKeyScope] = useState<string[]>([])
  /** 正在编辑分支范围的条目 raw（null = 未在编辑）。 */
  const [scopeEdit, setScopeEdit] = useState<string | null>(null)
  const [scopeDraft, setScopeDraft] = useState<string[]>([])
  const [scopeSaving, setScopeSaving] = useState(false)
  /** 正在编辑正文的条目 raw（null = 未在编辑）；草稿与保存状态。 */
  const [editEntryRaw, setEditEntryRaw] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  /** 删除条目进行中（防止连点并发删除）。 */
  const [deleting, setDeleting] = useState(false)
  /** 功能子 tab：null = 记忆视图（类 + 分组）；否则显示待确认建议/指南。 */
  // 初始值只认"内存 Map 里确实有这条会话"（`null` 本身是合法选择，不能用 ?? 兜底），
  // 内存没有才回落到 localStorage 里上次落盘的位置。
  const [feature, setFeature] = useState<TabFeature | null>(
    persistedFeatures.has(sessionKey) ? (persistedFeatures.get(sessionKey) ?? null) : (position.feature ?? null),
  )
  /** 待确认记忆建议计数（来自 /api/badge，用于功能 tab 的徽标文本）。 */
  const [badge, setBadge] = useState<{ suggestions: number }>({ suggestions: 0 })
  /**
   * jumpToPending（2026-10-13 用户需求）：开着且有未处理的待确认记忆时，
   * 点进记忆 Tab 直接落在「待确认记忆建议」子页，而不是上次看的分组页。
   * 只在本次挂载跳一次——用户随后手动切到别的页签不会被反复拉回。
   */
  const [jumpToPending, setJumpToPending] = useState(false)
  const jumpedToPending = useRef(false)
  /** 条目数显示口径（UI-16）：宿主运行时配置是权威值，缺键回退缺省。 */
  const [countOpts, setCountOpts] = useState<CountDisplayOptions>(DEFAULT_COUNT_OPTIONS)
  /** 条目展开设置（F-8②）：宿主运行时配置是权威值，缺键回退「全部折叠」。 */
  const [expandOpts, setExpandOpts] = useState<EntryExpandOptions>(DEFAULT_EXPAND_OPTIONS)
  /** 条目展开状态（F-8③）：localStorage 持久化，与待办页共用同一套实现。 */
  const views = useEntryViews(expandOpts)
  /** 条目元数据行开关（F-7，记忆页）：设置 → 界面。 */
  const [metaOn, setMetaOn] = useState(true)

  useEffect(() => {
    void api<{ config?: Record<string, unknown> }>('/api/config')
      .then((data) => {
        const config = data.config
        setJumpToPending(config?.jumpToPending === true)
        setCountOpts(countOptionsOf(config))
        setExpandOpts(expandOptionsOf(config))
        setMetaOn(config?.entryMetaMemory !== false)
        // 停用分组显示三态：宿主运行时配置 showDisabled 是权威值（与
        // 「设置 → 界面」同一项）；本地只存一份兜底副本。
        const mode = normalizeDisabledMode(config?.showDisabled)
        if (mode !== null) {
          setShowDisabled(mode)
          try {
            window.localStorage.setItem(DISABLED_SETTING_KEY, mode)
          } catch {
            // 存储不可用：仅本次会话生效
          }
        }
      })
      .catch(() => { /* 读不到配置就用默认：不跳、停用分组隐藏 */ })
  }, [])

  useEffect(() => {
    if (jumpedToPending.current) return
    if (!jumpToPending || badge.suggestions <= 0) return
    jumpedToPending.current = true
    setFeature('suggestions')
  }, [jumpToPending, badge.suggestions])

  /** 拉取待确认记忆建议计数（功能 tab 徽标）。 */
  const pollBadge = useCallback((): void => {
    void api<{ suggestions?: number }>('/api/badge')
      .then((data) => setBadge({ suggestions: data.suggestions ?? 0 }))
      .catch(() => { /* 徽标尽力而为 */ })
  }, [])

  useEffect(() => {
    pollBadge()
    const timer = window.setInterval(pollBadge, 30_000)
    return () => window.clearInterval(timer)
  }, [pollBadge])

  // 会话切换（组件实例跨会话复用）时恢复该会话的历史选择。
  useEffect(() => {
    const restored = persistedSelections.get(sessionKey) ?? readPosition(sessionKey).selection ?? ''
    const [klass, group] = restored.split('/')
    setActiveKlass(klass === undefined || klass === '' ? 'session' : klass)
    setActiveGroupId(group === undefined || group === '' ? null : group)
    const savedFeature = persistedFeatures.get(sessionKey) ?? readPosition(sessionKey).feature ?? null
    setFeature(savedFeature)
  }, [sessionKey])

  // 同步选择到模块级（按会话分桶）：badge 刷新导致的组件重挂
  // （deferral.refresh()）后恢复，避免处理完一条建议视图跳回别的页。
  // 同时落 localStorage（F-8）：刷新页面后还能回到上次那个类/分组。
  useEffect(() => { persistedFeatures.set(sessionKey, feature) }, [feature, sessionKey])
  useEffect(() => {
    const selection = `${activeKlass}/${activeGroupId ?? ''}`
    persistedSelections.set(sessionKey, selection)
    writePosition(sessionKey, persistedFeatures.get(sessionKey) ?? null, selection)
  }, [activeKlass, activeGroupId, sessionKey])

  /**
   * 拉取记忆树（无感进入的核心，2026-10-11）。
   * @param options.useCache 缺省 true：先把该会话的缓存内容渲染出来，再
   *   后台静默刷新与磁盘对齐——重挂/切回 Tab 时首帧即有内容、不闪加载态。
   *   条目增删改后的刷新传 false。
   * @param options.silent 缺省 false：仅在**没有缓存**时显示 loading 占位；
   *   true 时无论有无缓存都不清空当前 DOM（等新数据就地替换，零闪烁）。
   */
  const load = useCallback((options: { useCache?: boolean; silent?: boolean } = {}): void => {
    const key = String(sessionId)
    const hit = filesCache.get(key)
    if ((options.useCache ?? true) && hit !== undefined) {
      setClasses(hit.classes)
      setFiles(hit.files)
      setCwd(hit.cwd)
      setBranch(hit.branch)
      setBranches(hit.branches)
    } else if (options.silent !== true) {
      setClasses(null)
      setFiles([])
    }
    void api<unknown>(`/api/memory-files?sessionId=${encodeURIComponent(key)}`)
      .then((res) => {
        const body = (res ?? {}) as Record<string, unknown>
        const normalized = normalizePayload(res)
        const payload: MemoryFilesPayload = {
          files: normalized.files,
          classes: normalized.classes ?? legacyClasses(normalized.files),
          cwd: typeof body.cwd === 'string' ? body.cwd : null,
          branch: typeof body.branch === 'string' ? body.branch : null,
          branches: Array.isArray(body.branches) ? (body.branches as string[]) : [],
        }
        filesCache.set(key, payload)
        setLoadError(null)
        setClasses(payload.classes)
        setFiles(payload.files)
        setCwd(payload.cwd)
        setBranch(payload.branch)
        setBranches(payload.branches)
      }).catch((error: Error) => {
        setLoadError(t('panel.loadFailed', { message: error.message }))
        // 有缓存时保留上次内容（错误条已够，不必把页面清空）
        if (filesCache.get(key) === undefined) {
          setClasses([])
          setFiles([])
        }
      })
  }, [sessionId])

  // load 随 sessionId 变化重建 → 会话切换时重新拉取该会话的树。
  useEffect(() => {
    load()
  }, [load])

  useEffect(() => { setPage(0) }, [activeGroupId, activeKlass, feature])

  /** 当前类节点（一级选择）。 */
  const activeClassNode = useMemo(
    () => (classes ?? []).find((node) => node.klass === activeKlass) ?? null,
    [classes, activeKlass],
  )

  /**
   * 二级页签要显示的分组：按停用显示三态过滤。
   * hidden → 只显示启用分组；shown → 全部；dim → 全部，但停用的灰字显示。
   */
  const visibleGroups = useMemo((): MemoryGroupItem[] => {
    const all = activeClassNode?.groups ?? []
    if (showDisabled === 'hidden') return all.filter((group) => group.enabled !== false)
    return all
  }, [activeClassNode, showDisabled])

  const archiveNode = activeClassNode?.archive ?? null
  const isArchive = activeGroupId === ARCHIVE_ID
  /** 当前选中的分组（归档页签时为 null）。 */
  const activeGroup = useMemo(
    () => (isArchive ? null : visibleGroups.find((group) => group.id === activeGroupId) ?? null),
    [isArchive, visibleGroups, activeGroupId],
  )

  // 默认选择：类必须先合法；组缺省落到该类第一个可见分组（没有则归档页）。
  useEffect(() => {
    if (classes === null) return
    if (classes.length === 0) return
    if (!classes.some((node) => node.klass === activeKlass)) {
      setActiveKlass(classes[0].klass)
      setActiveGroupId(null)
      return
    }
    if (isArchive) return
    const ids = visibleGroups.map((group) => group.id)
    if (activeGroupId !== null && ids.includes(activeGroupId)) return
    setActiveGroupId(ids.length > 0 ? ids[0] : ARCHIVE_ID)
  }, [classes, activeKlass, activeGroupId, visibleGroups, isArchive])

  /** Transient ok notice: auto-dismiss so it never lingers. */
  const flash = (text: string): void => {
    notify('ok', text)
  }

  const openWithSystem = (id: string): void => {
    const target = REVEAL_TARGET[id]
    if (target === undefined) return
    // 成功不再弹「已用系统工具打开」提示（用户要求删掉）：系统文件管理器
    // 自己会把窗口带到前台，再弹一条提示是噪音；失败仍报错。
    void api<{ ok: boolean }>('/api/reveal', { method: 'POST', body: JSON.stringify({ target }) })
      .catch((error: Error) => notify('error', error.message))
  }

  /**
   * 切换停用分组的显示三态（显示 / 灰显 / 隐藏）。
   *
   * 这一项是**宿主运行时配置**（与「Memory Evolve 设置 → 界面」的
   * `showDisabled` 同一项），所以点击后写回宿主，配置页与本页立刻一致；
   * localStorage 只存一份兜底副本（宿主读不到 config 时用）。
   */
  const changeDisabledMode = (mode: DisabledMode): void => {
    setShowDisabled(mode)
    try {
      window.localStorage.setItem(DISABLED_SETTING_KEY, mode)
    } catch {
      // 存储不可用：仅本次会话生效
    }
    void api<{ config?: unknown }>('/api/config', {
      method: 'POST',
      body: JSON.stringify({ patch: { showDisabled: mode } }),
    }).catch((error: Error) => {
      notify('error', error.message)
    })
  }

  /** 手动写入一条项目关键记忆：走宿主 API 的 store.add，保持程序盖戳。 */
  const saveKey = (): void => {
    const content = keyDraft.trim()
    if (content === '' || keySaving) return
    setKeySaving(true)
    void api<{ ok: boolean }>('/api/memory/key', {
      method: 'POST',
      body: JSON.stringify({ sessionId: sessionKey, content, branches: keyScope, dshOnly: keyDshOnly }),
    }).then(() => {
      setKeyDraft('')
      setKeyDshOnly(false)
      load({ useCache: false, silent: true })
      flash(t('memoryTab.keyAdded'))
    }).catch((error: Error) => {
      notify('error', error.message)
    }).finally(() => setKeySaving(false))
  }

  /** 手动写入一条全局轨记忆（MEMORY / USER / KB）或一个自建分组：走宿主 API 的 store.add。 */
  const saveGlobal = (id: string): void => {
    const content = (globalDrafts[id] ?? '').trim()
    if (content === '' || globalSaving) return
    setGlobalSaving(true)
    const isBuiltin = BUILTIN_MANUAL_ADD.has(id)
    const endpoint = isBuiltin ? `/api/memory/${id}` : '/api/memory/group'
    // 非内置轨统一走 /api/memory/group：会话类靠 sessionId、工作区类靠 cwd
    // （两个都带上，宿主按该分组的类取用需要的那个）。
    const payload = isBuiltin
      ? { content }
      : { id, content, sessionId: sessionKey, cwd: cwd ?? undefined }
    void api<{ ok: boolean }>(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
    }).then(() => {
      setGlobalDrafts((prev) => ({ ...prev, [id]: '' }))
      load({ useCache: false, silent: true })
      flash(t('memoryTab.memoryUserAdded'))
    }).catch((error: Error) => {
      notify('error', error.message)
    }).finally(() => setGlobalSaving(false))
  }

  /** 分支选择互斥：勾「全部」→ 清空所有分支；勾具体分支 → 自动取消「全部」。 */
  const toggleScopeBranch = (b: string): void => {
    setScopeDraft((prev) => (prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]))
  }

  const toggleKeyScopeBranch = (b: string): void => {
    setKeyScope((prev) => (prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]))
  }

  /** 打开某条目的分支范围编辑（草稿=当前范围）。 */
  const openScope = (entry: MemoryEntry): void => {
    setScopeEdit(entry.raw)
    setScopeDraft(entry.branches ?? [])
  }

  /** 保存分支范围：[] = 全部（后端移除标记）。 */
  const saveScope = (): void => {
    if (scopeEdit === null || activeGroup === null || scopeSaving) return
    setScopeSaving(true)
    void api<{ ok: boolean }>('/api/key/scope', {
      method: 'POST',
      body: JSON.stringify({ sessionId: sessionKey, match: scopeEdit, branches: scopeDraft }),
    }).then(() => {
      setScopeEdit(null)
      load({ useCache: false, silent: true })
      flash(t('memoryTab.keyScopeSaved'))
    }).catch((error: Error) => {
      notify('error', error.message)
    }).finally(() => setScopeSaving(false))
  }

  /** 切换一条目的「仅 DSH」标记（[dsh-only]）。整条原文精确匹配。 */
  const toggleDshOnly = (entry: MemoryEntry): void => {
    if (activeGroup === null || deleting) return
    setDeleting(true)
    void api<{ ok: boolean }>('/api/memory/dsh-only', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: sessionKey,
        target: activeGroup.id,
        match: entry.raw,
        on: !entry.dshOnly,
      }),
    }).then(() => {
      load({ useCache: false, silent: true })
      flash(entry.dshOnly ? t('memoryTab.dshOnlyRemoved') : t('memoryTab.dshOnlySet'))
    }).catch((error: Error) => {
      notify('error', error.message)
    }).finally(() => setDeleting(false))
  }

  /**
   * 删除一条记忆条目：先让用户确认，再把【完整条目原文】交给宿主
   * 精确删除（整条相等匹配）——短条目不会误删长条目。
   */
  const deleteEntry = async (entry: MemoryEntry): Promise<void> => {
    if (activeGroup === null || deleting) return
    const snippet = entry.text.length > 60 ? `${entry.text.slice(0, 60)}…` : entry.text
    if (!(await askConfirm(t('memoryTab.deleteConfirm', { snippet })))) return
    setDeleting(true)
    void api<{ ok: boolean }>('/api/memory/delete', {
      method: 'POST',
      body: JSON.stringify({ sessionId: sessionKey, target: activeGroup.id, match: entry.raw }),
    }).then(() => {
      load({ useCache: false, silent: true })
      flash(t('memoryTab.deleted'))
    }).catch((error: Error) => {
      notify('error', error.message)
    }).finally(() => setDeleting(false))
  }

  /** 开始编辑某条正文（草稿=当前正文）。 */
  const startEdit = (entry: MemoryEntry): void => {
    setEditEntryRaw(entry.raw)
    setEditDraft(entry.text)
  }

  /** 保存正文编辑：只改内容，时间戳/tag 由宿主保留；§ 分隔符输入即过滤。 */
  const saveEdit = async (): Promise<void> => {
    if (editEntryRaw === null || activeGroup === null || editSaving) return
    const content = editDraft.trim()
    if (content === '') return
    if (INJECTED_IDS.has(activeGroup.id)) {
      const snippet = content.length > 60 ? `${content.slice(0, 60)}…` : content
      if (!(await askConfirm(t('memoryTab.editConfirm', { snippet })))) return
    }
    setEditSaving(true)
    void api<{ ok: boolean }>('/api/memory/update', {
      method: 'POST',
      body: JSON.stringify({ sessionId: sessionKey, target: activeGroup.id, match: editEntryRaw, content: editDraft }),
    }).then(() => {
      setEditEntryRaw(null)
      load({ useCache: false, silent: true })
      flash(t('memoryTab.updated'))
    }).catch((error: Error) => {
      notify('error', error.message)
    }).finally(() => setEditSaving(false))
  }

  /**
   * 把一条条目移入归档（memory/user/key 三轨）：先让用户确认，再交给宿主
   * 按整条原文移动。归档页签只读——新的归档目录模型下「移回」入口在宿主侧
   * 重构完成前不提供（避免与正在改造的归档写入路径耦合）。
   */
  const moveEntry = async (entry: MemoryEntry): Promise<void> => {
    if (activeGroup === null || deleting) return
    const snippet = entry.text.length > 60 ? `${entry.text.slice(0, 60)}…` : entry.text
    if (!(await askConfirm(t('memoryTab.archiveConfirm', { snippet })))) return
    setDeleting(true)
    void api<{ ok: boolean }>('/api/memory/archive', {
      method: 'POST',
      body: JSON.stringify({ sessionId: sessionKey, target: activeGroup.id, match: entry.raw }),
    }).then(() => {
      load({ useCache: false, silent: true })
      flash(t('memoryTab.archived'))
    }).catch((error: Error) => {
      notify('error', error.message)
    }).finally(() => setDeleting(false))
  }

  /**
   * 把一条归档条目移回它的原分组（2026-10-15 补：归档页此前只读）。
   *
   * 走宿主 `/api/archive/promote`（内部 promoteArchived）：按整条原文匹配 →
   * 写回原分组 → 从归档删除。归档展示文本与匹配基准**同形**（同一套
   * `store.textOfEntry` 渲染，见 lib/memory-tab.js 的 archiveLines），所以这里
   * 直接把 `entry.raw` 回传即可，不需要任何额外转换。
   * @param from - 来源分组 id（归档块自带）。
   * @param entry - 归档条目。
   */
  const promoteEntry = (from: string, entry: MemoryEntry): void => {
    void api<{ ok?: boolean; message?: string }>('/api/archive/promote', {
      method: 'POST',
      body: JSON.stringify({ target: from, match: entry.raw }),
    }).then((res) => {
      if (res.ok === false) {
        notify('error', res.message ?? t('memoryTab.promoteFailed'))
        return
      }
      load({ useCache: false, silent: true })
      flash(t('memoryTab.promoted'))
    }).catch((error: Error) => {
      notify('error', error.message)
    })
  }

  /** 搜索词（小写）；空串表示不过滤。 */
  const q = query.trim().toLowerCase()
  /** 当前分组的条目（按需解析；纯文本视图不解条目）。 */
  let activeEntries: MemoryEntry[] | null = null
  let activeHidden = false
  if (activeGroup !== null && (activeGroup.available ?? true)) {
    const raw = String(activeGroup.content ?? '')
    if (view === 'raw' || activeGroup.id === 'agents') {
      activeHidden = q !== '' && !raw.toLowerCase().includes(q)
    } else {
      const all = attachMeta(parseEntries(raw, activeGroup.stampKind), activeGroup.entries)
      activeEntries = q === '' ? all : all.filter((entry) => entryMatches(entry, q))
      activeHidden = q !== '' && activeEntries.length === 0
    }
  }

  /** 归档视图：每个来源分组一块（搜索生效；不分页——归档量小）。 */
  const archiveBlocks = useMemo(() => {
    if (!isArchive || archiveNode === null) return []
    return (archiveNode.groups ?? []).map((group) => {
      const entries = attachMeta(
        parseEntries(String(group.content ?? ''), group.stampKind ?? 'datetime'),
        group.entries,
      )
      return {
        group,
        entries: q === '' ? entries : entries.filter((entry) => entryMatches(entry, q)),
      }
    })
  }, [isArchive, archiveNode, q])

  // 分页：先倒序（最新在前）再切页——每页都是连续的最新条目；
  // 页码越界（搜索/删除后条目变少）时自动回退到最后一页。
  const pageCount = activeEntries === null ? 1 : Math.max(1, Math.ceil(activeEntries.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageEntries = activeEntries === null
    ? null
    : [...activeEntries].reverse().slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  /** 二级页签的激活判定。 */
  const groupTabActive = (id: string): boolean => feature === null && id === activeGroupId

  /** 一级页签：类名（宿主已本地化，缺省回退渲染端词条）。 */
  const klassTitle = (node: MemoryClassNode): string =>
    typeof node.label === 'string' && node.label !== ''
      ? node.label
      : t(`memoryTab.klass.${node.klass}`) === `memoryTab.klass.${node.klass}`
        ? node.klass
        : t(`memoryTab.klass.${node.klass}`)

  /**
   * 分组目录 + 该类根路径（用户 UI-13 / 22:37 修正）：用「 ｜ 」分隔，且根路径
   * 带类标签（会话目录 / 工作区 / dsh-home）—— 单一个「·」不醒目，看不出后者
   * 是什么。
   * @param klass - 类 id（决定标签词条）。
   * @param dir - 该分组自己的目录。
   * @param root - 该类根路径（缺省 = 不追加）。
   */
  const pathWithRoot = (klass: string, dir: string, root?: string): string => {
    if (typeof root !== 'string' || root === '') return dir
    const key = `memoryTab.rootLabel.${klass}`
    const label = t(key)
    return `${dir} ｜ ${label === key ? '' : label}${root}`
  }

  /** 该类的数字显示开关（用户 UI-16）。 */
  const countShown = (klass: string): boolean =>
    klass === 'session' ? countOpts.session : klass === 'project' ? countOpts.project : countOpts.global

  /**
   * 一格页签的数字文本（用户 UI-16）。返回空串 = 不显示。
   * @param klass - 所属类（决定该类的显示开关）。
   * @param own - 该格自己的条目数。
   * @param ownArchived - 可并入的归档条目数（口径含归档时相加）。
   * @param disabled - 该格是否已停用（口径不含停用时一律不显示）。
   */
  const countText = (klass: string, own: number, ownArchived = 0, disabled = false): string => {
    if (!countShown(klass)) return ''
    if (disabled && !countOpts.includeDisabled) return ''
    const total = countOpts.includeArchived ? own + ownArchived : own
    return total > 0 ? ` (${total})` : ''
  }

  /**
   * 渲染一条条目卡片（分组视图与归档视图共用）。
   * @param entry - 已解析条目。
   * @param index - 列表下标（React key）。
   * @param readOnly - true = 归档页签（只展示，不允许编辑/删除）。
   * @param promoteFrom - 归档条目的**来源分组 id**；给了它就在卡片上出现
   *   「移回」按钮（归档页专用，2026-10-15 起支持还原）。
   */
  const renderEntry = (entry: MemoryEntry, index: number, readOnly: boolean, promoteFrom?: string): JSX.Element => {
    const id = activeGroup?.id ?? ''
    const editable = !readOnly && (activeGroup?.enabled ?? true) !== false
    return (
      <div key={index} className="mt-entry">
        <div className="mt-entry-head">
          {entry.time !== null && <span className="mt-entry-time">{entry.time}</span>}
          {/* 展开 / 收起箭头（F-8②，用户 2026-10-15：图标就是两个箭头，不另设样式）：
              默认形态由「设置 → 界面」的展开程度决定，点一下即覆盖并记住。 */}
          <button
            type="button"
            className="mt-entry-toggle"
            aria-expanded={views.isOpen(entryKeyOf(entry.id, entry.raw))}
            title={views.isOpen(entryKeyOf(entry.id, entry.raw)) ? t('memoryTab.entryCollapse') : t('memoryTab.entryExpand')}
            onClick={() => views.toggle(entryKeyOf(entry.id, entry.raw))}
          >
            {views.isOpen(entryKeyOf(entry.id, entry.raw)) ? '▼' : '▶'}
          </button>
          {entry.branch !== null && (
            <span className="mt-entry-branch mt-entry-branch-tag" title={t('memoryTab.gitBranch')}>
              {entry.branch}
            </span>
          )}
          {entry.tag !== null && (
            <span className="mt-entry-tag" title={t('memoryTab.projectTag')}>{entry.tag}</span>
          )}
          {entry.dshOnly && (
            <span className="mt-entry-dsh-only" title={t('memoryTab.dshOnlyHint')}>
              🔒 {t('memoryTab.dshOnly')}
            </span>
          )}
          {readOnly && promoteFrom !== undefined && (
            <button
              type="button"
              className="mt-btn"
              title={t('memoryTab.promoteHint')}
              onClick={() => promoteEntry(promoteFrom, entry)}
            >
              {t('memoryTab.promote')}
            </button>
          )}
          {!readOnly && id === 'key' && branches.length > 0 && (
            <button
              type="button"
              className={entry.branches === null ? 'mt-entry-branch mt-entry-branch-all' : 'mt-entry-branch'}
              title={entry.branches === null ? t('memoryTab.keyScopeAllHint') : t('memoryTab.keyScopeHint')}
              onClick={() => openScope(entry)}
            >
              {t('memoryTab.keyScopeLabel')}: {entry.branches === null ? t('memoryTab.keyScopeAll') : entry.branches.join(', ')} ▾
            </button>
          )}
          {/* 条目元数据（用户 F-7）：时间戳右侧、操作按钮之前，一项挨一项平铺；
              整行撑满，放不下就省略号。开关在「设置 → 界面」。 */}
          {metaOn && (entry.title !== undefined || entry.summary !== undefined
            || entry.scenario !== undefined || (entry.keywords ?? []).length > 0) && (
            <span className="mt-entry-meta">
              {entry.title !== undefined && entry.title !== '' && (
                <span className="mt-entry-meta-title" title={entry.title}>{entry.title}</span>
              )}
              {entry.summary !== undefined && entry.summary !== '' && (
                <span className="mt-entry-meta-summary" title={entry.summary}>{entry.summary}</span>
              )}
              {(entry.keywords ?? []).length > 0 && (
                <span className="mt-entry-meta-keywords" title={(entry.keywords ?? []).join(', ')}>
                  {(entry.keywords ?? []).join(' · ')}
                </span>
              )}
              {entry.scenario !== undefined && entry.scenario !== '' && (
                <span className="mt-entry-meta-scenario" title={entry.scenario}>{entry.scenario}</span>
              )}
            </span>
          )}
          {!readOnly && (
            <span className="mt-entry-ops">
              {editable && id !== ARCHIVE_ID && (
                <button
                  type="button"
                  className="mt-btn mt-entry-op"
                  title={t('memoryTab.archive')}
                  disabled={deleting}
                  onClick={() => { void moveEntry(entry) }}
                >
                  {t('memoryTab.archive')}
                </button>
              )}
              {editable && editEntryRaw !== entry.raw && (
                <button
                  type="button"
                  className="mt-btn mt-entry-op"
                  title={t('memoryTab.edit')}
                  disabled={deleting}
                  onClick={() => startEdit(entry)}
                >
                  {t('memoryTab.edit')}
                </button>
              )}
              {editable && DSH_ONLY_IDS.has(id) && (
                <button
                  type="button"
                  className={`mt-btn mt-entry-op${entry.dshOnly ? ' mt-entry-dsh-on' : ''}`}
                  title={t('memoryTab.dshOnlyToggleHint')}
                  disabled={deleting}
                  onClick={() => toggleDshOnly(entry)}
                >
                  {entry.dshOnly ? t('memoryTab.dshOnlyOff') : t('memoryTab.dshOnlyOn')}
                </button>
              )}
              {editable && (
                <button
                  type="button"
                  className="mt-btn mt-entry-del"
                  title={t('memoryTab.delete')}
                  disabled={deleting}
                  onClick={() => { void deleteEntry(entry) }}
                >
                  {t('memoryTab.delete')}
                </button>
              )}
            </span>
          )}
        </div>
        {!readOnly && editEntryRaw === entry.raw ? (
          <div className="mt-entry-edit">
            <textarea
              className="mt-item-edit"
              rows={3}
              value={editDraft}
              onChange={(event) => setEditDraft(event.target.value.replaceAll('§', ''))}
            />
            <div className="mt-entry-edit-row">
              <span className="mt-entry-edit-hint">{t('memoryTab.editHint')}</span>
              <button
                type="button"
                className="mt-btn mt-btn-primary"
                disabled={editSaving || editDraft.trim() === ''}
                onClick={() => { void saveEdit() }}
              >
                {t('memoryTab.save')}
              </button>
              <button type="button" className="mt-btn" disabled={editSaving} onClick={() => setEditEntryRaw(null)}>
                {t('memoryTab.cancel')}
              </button>
            </div>
          </div>
        ) : views.isOpen(entryKeyOf(entry.id, entry.raw)) ? (
          <>
            <p className="mt-entry-text" style={views.textStyle(entryKeyOf(entry.id, entry.raw))}>{entry.text}</p>
            {/* 拖拽下边缘改高度（F-8③）：松手写进 localStorage，下次回来还是这个高度。
                设置里关掉「记住拖拽高度」时这根把手不渲染。 */}
            {expandOpts.rememberHeight && (
              <div
                className="mt-entry-resize"
                title={t('memoryTab.entryResize')}
                onPointerDown={(event) => views.startResize(entryKeyOf(entry.id, entry.raw), event)}
              />
            )}
          </>
        ) : null}
        {!readOnly && id === 'key' && scopeEdit === entry.raw && branches.length > 0 && (
          <div className="mt-scope">
            <span className="mt-key-scope-label">{t('memoryTab.keyScope')}:</span>
            <label className="mt-scope-opt">
              <input
                type="checkbox"
                checked={scopeDraft.length === 0}
                onChange={() => setScopeDraft([])}
              />
              {t('memoryTab.keyScopeAll')}
              <em className="mt-scope-all-hint">{t('memoryTab.keyScopeAllWeight')}</em>
            </label>
            {branches.map((b) => (
              <label key={b} className="mt-scope-opt">
                <input
                  type="checkbox"
                  checked={scopeDraft.includes(b)}
                  onChange={() => toggleScopeBranch(b)}
                />
                {b}
              </label>
            ))}
            <span className="mt-scope-actions">
              <button type="button" className="mt-btn mt-btn-primary" disabled={scopeSaving} onClick={saveScope}>
                {t('memoryTab.keyScopeSave')}
              </button>
              <button type="button" className="mt-btn" disabled={scopeSaving} onClick={() => setScopeEdit(null)}>
                {t('memoryTab.keyScopeCancel')}
              </button>
            </span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="mt-panel">
      {loadError !== null && (
        <InlineError text={loadError} retryText={t('panel.retry')} onRetry={() => load({ useCache: false })} />
      )}
      {/* 一级页签（2026-10-15 三类改造）：待确认记忆建议 / 会话类 / 项目类 /
          全局类 …… / 指南（固定最后一位）。点某个类 → 下方再出该类的二级页签。 */}
      {/* 一级 + 二级页签同处**第一行**（用户需求 UI-3）：页签放进可横向溢出的
          容器，操作区固定在行最右且永不换行 —— 这样二级页签再多也不会换到第二行、
          更不会把「开局提示词」之类的页签顶掉（用户实测过"看不到"那个现象）。
          整行 sticky 悬浮，内容滚动时始终可见。 */}
      <div className="mt-tabs-bar">
        <div className="mt-tabs-scroll" role="tablist">
        {/* 指南固定**最左**（2026-10-15 用户定）：它是"这一页怎么看"的说明，
            当入口放最前面最顺手；原来固定最后一位的约定只对设置页成立。 */}
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'guide'}
          className={feature === 'guide' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature(feature === 'guide' ? null : 'guide')}
        >
          {t('memoryTab.feature.guide')}
        </button>
        <span className="mt-tab-sep" role="presentation" />
        <button
          type="button"
          role="tab"
          aria-selected={feature === 'suggestions'}
          className={feature === 'suggestions' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => setFeature(feature === 'suggestions' ? null : 'suggestions')}
        >
          {t('memoryTab.feature.suggestions')}
          {badge.suggestions > 0 && <span className="mt-feature-count">{badge.suggestions}</span>}
        </button>
        {(classes ?? []).map((node) => {
          const tabActive = feature === null && node.klass === activeKlass
          // 类数字（UI-16）：先按口径计入停用 / 归档条目，再决定显不显示。
          const count = (node.groups ?? []).reduce((sum, group) => {
            if (!countOpts.includeDisabled && group.enabled === false) return sum
            return sum + (group.count ?? 0) + (countOpts.includeArchived ? (group.archivedCount ?? 0) : 0)
          }, 0)
          return (
            <button
              key={node.klass}
              type="button"
              role="tab"
              aria-selected={tabActive}
              className={tabActive ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
              onClick={() => {
                setActiveKlass(node.klass)
                setActiveGroupId(null) // 交给默认选择 effect 落到该类第一个分组
                setFeature(null)
                setPage(0)
              }}
            >
              {klassTitle(node)}
              {count > 0 && countShown(node.klass) ? ` (${count})` : ''}
            </button>
          )
        })}
        {/* 开局提示词已搬回**设置页**（2026-10-15 用户定：它属于"配置"而不是
            "记忆内容"，跟其它设置放一起）。这里不再有它的页签。 */}
        {/* 二级页签**并入同一行**：当前类下的分组 + 最后一个是「归档」。
            没有二级（未选类 / 在看指南等）时整段不渲染。 */}
        {feature === null && activeClassNode !== null && (
          <>
            <span className="mt-tab-sep" role="presentation" />
          {visibleGroups.map((group) => {
            const tabActive = groupTabActive(group.id)
            const disabled = group.enabled === false
            const cls = [
              'mt-file-tab',
              tabActive ? 'mt-file-tab-active' : '',
              disabled ? 'mt-muted' : '',
            ].filter((name) => name !== '').join(' ')
            return (
              <button
                key={group.id}
                type="button"
                role="tab"
                aria-selected={tabActive}
                className={cls}
                title={disabled ? t('memoryTab.groupDisabled') : (group.path ?? '')}
                onClick={() => {
                  setActiveGroupId(group.id)
                  setFeature(null)
                  setPage(0)
                }}
              >
                {group.title}
                {countText(group.klass ?? activeKlass, group.count ?? 0, group.archivedCount ?? 0, disabled)}
                {disabled ? ` · ${t('memoryTab.groupDisabled')}` : ''}
              </button>
            )
          })}
          <button
            type="button"
            role="tab"
            aria-selected={feature === null && isArchive}
            className={feature === null && isArchive ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
            onClick={() => {
              setActiveGroupId(ARCHIVE_ID)
              setFeature(null)
              setPage(0)
            }}
          >
            {t('memoryTab.tab.archive')}
            {countText(activeKlass, archiveNode?.count ?? 0)}
          </button>
          </>
        )}
        </div>
        {/* 操作区：**锁定第一行最右**，`flex: none` + 永不换行 —— 页签再多、
            再溢出也只会让页签那一侧横向滚动，这组按钮始终留在第一行最右
            （用户原话：停用、隐藏锁定最右边）。 */}
        <div className="mt-tabs-actions">
          {feature === null && activeClassNode !== null && (
            /* 停用分组显示：**一个按钮**显示当前状态，点击在「显示 / 隐藏」之间切换
               （用户 UI-9：两个按钮合成一个，字体与左侧页签一致 —— mt-view-btn 与
               mt-file-tab 同为 13px）。停用项显示时一律灰字（mt-muted），所以没有
               单独的「灰显」档。 */
            <button
              type="button"
              className="mt-view-btn"
              title={t('memoryTab.showDisabledHint')}
              onClick={() => changeDisabledMode(showDisabled === 'shown' ? 'hidden' : 'shown')}
            >
              {t(`memoryTab.showDisabled.${showDisabled}`)}
            </button>
          )}
        </div>
      </div>
      {/* 「⚠️ 以下文件为 § 分隔的结构化记忆…」那行提示已删除（2026-10-15 UI-7）；
          顶部「当前会话工作目录」行同样删除（UI-13），类根路径改在分组卡片行右侧显示。 */}
      {feature !== null ? (
        feature === 'guide' ? (
          // 记忆专属指南：详细介绍记忆 Tab 自己的功能。整体插件指南在
          // 「Memory Evolve 设置」Tab。
          <TabGuideView sections={memoryGuideSections(t)} />
        ) : (
          <MemoryQueueView
            t={t}
            feature="suggestions"
            onChanged={() => {
              // 队列变更后：刷新本组件计数，并通知宿主层（index.ts）
              // 立即重查 badge，让会话页标签的小红点即时更新（不等 30s 轮询）。
              pollBadge()
              window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
            }}
          />
        )
      ) : classes === null ? (
        <p className="mt-muted">{t('memoryTab.loading')}</p>
      ) : activeClassNode === null ? (
        <p className="mt-muted">{t('memoryTab.empty')}</p>
      ) : isArchive ? (
        /* 归档页签：该类下所有分组的归档条目，按来源分组分块（只读）。 */
        <>
          <div className="mt-toolbar">
            <div className="mt-view-toggle" role="group">
              <button
                type="button"
                className={view === 'pretty' ? 'mt-view-btn mt-view-btn-active' : 'mt-view-btn'}
                onClick={() => setView('pretty')}
              >
                {t('memoryTab.viewPretty')}
              </button>
              <button
                type="button"
                className={view === 'raw' ? 'mt-view-btn mt-view-btn-active' : 'mt-view-btn'}
                onClick={() => setView('raw')}
              >
                {t('memoryTab.viewRaw')}
              </button>
            </div>
            <input
              type="search"
              className="mt-search"
              value={query}
              placeholder={t('memoryTab.searchPlaceholder')}
              onChange={(event) => { setQuery(event.target.value); setPage(0) }}
            />
          </div>
          {archiveBlocks.length === 0 ? (
            <p className="mt-muted">{t('memoryTab.archiveEmpty')}</p>
          ) : (
            archiveBlocks.map((block) => (
              <div key={block.group.id} className="mt-card">
                <div className="mt-card-head">
                  <span className="mt-card-title">{block.group.title}</span>
                  <span className="mt-badge mt-badge-ro">{t('memoryTab.readonly')}</span>
                  {countShown(activeKlass) && (
                    <span className="mt-badge mt-badge-count">
                      {t('memoryTab.entryCount', { count: block.entries.length })}
                    </span>
                  )}
                  {block.group.path !== undefined && (
                    <span
                      className="mt-card-path"
                      title={pathWithRoot(activeKlass, block.group.path, activeClassNode?.rootPath)}
                    >
                      {pathWithRoot(activeKlass, block.group.path, activeClassNode?.rootPath)}
                    </span>
                  )}
                </div>
                {block.entries.length === 0 ? (
                  <p className="mt-muted">{t('memoryTab.empty')}</p>
                ) : view === 'raw' ? (
                  <pre className="mt-content">{String(block.group.content ?? '')}</pre>
                ) : (
                  <div className="mt-entries">
                    {block.entries.map((entry, index) => renderEntry(entry, index, true, block.group.id))}
                  </div>
                )}
              </div>
            ))
          )}
        </>
      ) : activeGroup === null ? (
        <p className="mt-muted">{t('memoryTab.empty')}</p>
      ) : (
        /* 分组页签：条目卡片（美观/纯文本 + 搜索 + 分页 + 手动添加 + 条目操作）。 */
        <>
          <div className="mt-toolbar">
            <div className="mt-view-toggle" role="group">
              <button
                type="button"
                className={view === 'pretty' ? 'mt-view-btn mt-view-btn-active' : 'mt-view-btn'}
                onClick={() => setView('pretty')}
              >
                {t('memoryTab.viewPretty')}
              </button>
              <button
                type="button"
                className={view === 'raw' ? 'mt-view-btn mt-view-btn-active' : 'mt-view-btn'}
                onClick={() => setView('raw')}
              >
                {t('memoryTab.viewRaw')}
              </button>
            </div>
            <input
              type="search"
              className="mt-search"
              value={query}
              placeholder={t('memoryTab.searchPlaceholder')}
              onChange={(event) => { setQuery(event.target.value); setPage(0) }}
            />
          </div>
          {q !== '' && activeHidden && (
            <p className="mt-empty">{t('memoryTab.noResults')}</p>
          )}
          <div className="mt-card">
            <div className="mt-card-head">
              <span className="mt-card-title">{activeGroup.title}</span>
              <span className="mt-badge mt-badge-ro">{t('memoryTab.readonly')}</span>
              {activeEntries !== null && countShown(activeKlass) && (
                <span className="mt-badge mt-badge-count">
                  {t('memoryTab.entryCount', { count: activeEntries.length })}
                </span>
              )}
              {activeGroup.id === 'key' && branch !== null && (
                <span className="mt-badge mt-badge-branch">{t('memoryTab.keyBranchInfo', { branch })}</span>
              )}
              {activeGroup.path !== undefined && (
                <span
                  className="mt-card-path"
                  title={pathWithRoot(activeKlass, activeGroup.path, activeClassNode?.rootPath)}
                >
                  {pathWithRoot(activeKlass, activeGroup.path, activeClassNode?.rootPath)}
                </span>
              )}
              {REVEAL_TARGET[activeGroup.id] !== undefined && (
                <span className="mt-card-actions">
                  <button type="button" className="mt-btn" onClick={() => openWithSystem(activeGroup.id)}>
                    {t('memoryTab.open')}
                  </button>
                </span>
              )}
            </div>
            {activeGroup.id === 'key' && (activeGroup.available ?? true) && (
              <div className="mt-key-add">
                <textarea
                  className="mt-key-input"
                  rows={2}
                  value={keyDraft}
                  placeholder={t('memoryTab.keyAddPlaceholder')}
                  onChange={(event) => setKeyDraft(event.target.value)}
                />
                {branches.length > 0 && (
                  <div className="mt-key-scope">
                    <span className="mt-key-scope-label">{t('memoryTab.keyScope')}:</span>
                    <label className="mt-scope-opt">
                      <input
                        type="checkbox"
                        checked={keyScope.length === 0}
                        onChange={() => setKeyScope([])}
                      />
                      {t('memoryTab.keyScopeAll')}
                    </label>
                    {branches.map((b) => (
                      <label key={b} className="mt-scope-opt">
                        <input
                          type="checkbox"
                          checked={keyScope.includes(b)}
                          onChange={() => toggleKeyScopeBranch(b)}
                        />
                        {b}
                      </label>
                    ))}
                  </div>
                )}
                <div className="mt-key-add-foot">
                  <span className="mt-key-help">{t('memoryTab.keyAddHelp')}</span>
                  <label className="mt-key-dsh-opt" title={t('memoryTab.dshOnlyHint')}>
                    <input
                      type="checkbox"
                      checked={keyDshOnly}
                      onChange={(event) => setKeyDshOnly(event.target.checked)}
                    />
                    {t('memoryTab.dshOnlyAdd')}
                  </label>
                  <button
                    type="button"
                    className="mt-btn mt-btn-primary"
                    disabled={keySaving || keyDraft.trim() === ''}
                    onClick={saveKey}
                  >
                    {t('memoryTab.keyAdd')}
                  </button>
                </div>
              </div>
            )}
            {isManualAddGroup(activeGroup) && (activeGroup.available ?? true) && (
              <div className="mt-key-add">
                <textarea
                  className="mt-key-input"
                  rows={2}
                  value={globalDrafts[activeGroup.id] ?? ''}
                  placeholder={t('memoryTab.addPlaceholder')}
                  onChange={(event) => setGlobalDrafts((prev) => ({ ...prev, [activeGroup.id]: event.target.value }))}
                />
                <div className="mt-key-add-foot">
                  <span className="mt-key-help">{t('memoryTab.addHelp')}</span>
                  <button
                    type="button"
                    className="mt-btn mt-btn-primary"
                    disabled={globalSaving || (globalDrafts[activeGroup.id] ?? '').trim() === ''}
                    onClick={() => saveGlobal(activeGroup.id)}
                  >
                    {t('memoryTab.memoryAdd')}
                  </button>
                </div>
              </div>
            )}
            {!(activeGroup.available ?? true) ? (
              <p className="mt-muted">{t('memoryTab.noCwd')}</p>
            ) : !(activeGroup.exists ?? false) && (activeGroup.count ?? 0) === 0 ? (
              <pre className="mt-content">{t('memoryTab.empty')}</pre>
            ) : activeEntries === null ? (
              <pre className="mt-content">{String(activeGroup.content ?? '')}</pre>
            ) : (
              <div className="mt-entries">
                {(pageEntries ?? []).map((entry, index) => renderEntry(entry, index, false))}
              </div>
            )}
            {/* 分页器：仅多页时显示；上一页/下一页 + 页码 + 总条数 */}
            {activeEntries !== null && pageCount > 1 && (
              <div className="mt-pager">
                <button
                  type="button"
                  className="mt-btn"
                  disabled={safePage <= 0}
                  onClick={() => setPage(safePage - 1)}
                >
                  {t('memoryTab.pagePrev')}
                </button>
                <span className="mt-pager-info">
                  {t('memoryTab.pageInfo', { page: safePage + 1, total: pageCount, count: activeEntries.length })}
                </span>
                <button
                  type="button"
                  className="mt-btn"
                  disabled={safePage >= pageCount - 1}
                  onClick={() => setPage(safePage + 1)}
                >
                  {t('memoryTab.pageNext')}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
