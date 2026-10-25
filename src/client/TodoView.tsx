/**
 * dsh-memory-evolve — todo sub-tab（待办）。
 *
 * 2026-10-15 三级改造：与「记忆」页签**完全同构的三级结构**——
 *   一级：[全部] [会话类] [项目类] [全局类]
 *   二级：当前类下的待办分组（停用项依 showDisabled 决定是否出现）
 *         + 全局类专属「过往」+ 最后一格「归档」
 *   三级：待办列表（列表 / 四象限看板）、过往列表、归档分段（可「移回」）
 *
 * 「全部」是**跨分组功能格**（不是类；对应记忆页签一级的「待确认建议」
 * 功能格）：选中它时二级行不渲染，内容区给全部启用分组的待办，保住既有
 * `all=1`（关掉智能视图、不过滤）的语义。
 * 「过往」是每日待办（daily）的历史日期视图，daily 属全局类，所以它是
 * 全局类下的一格（见 t('todo.track.past')）。
 *
 * 分组 / 快速添加目标 / 条目轨徽标全部跟随「分组」配置
 * （GET /api/groups 的 todo 列表）驱动：内置 life/work/project/daily 只是
 * 列表里的普通分组，用户可以自建、改名、停用；分组接口拿不到时回落内置
 * 四个 id，保证页签不空白。支持两种视图：
 *   - 列表（list）：原有纵向列表 + 状态/象限筛选 + 行内编辑
 *   - 看板（board）：艾森豪威尔四象限四宫格，卡片按象限归位
 *
 * 数据均来自宿主 /memory-evolve/api/todo（归档走 /api/archive，移回走
 * /api/archive/promote）；样式复用 styles.css 的 me-/mt- 前缀。
 * 看板与列表共用同一套操作路径（完成/恢复、编辑、删除、快速添加），仅展示层不同。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { askConfirm } from './ask-confirm.ts'
import { useToast } from './Toast.tsx'
import {
  DEFAULT_EXPAND_OPTIONS,
  entryKeyOf,
  expandOptionsOf,
  useEntryViews,
  type EntryExpandOptions,
} from './entry-view.ts'
import { MemoryQueueView } from './MemoryQueueView.tsx'
import { TabGuideView, type GuideSection } from './TabGuideView.tsx'
import type { ChangeEvent } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * 待办分组（GET /memory-evolve/api/groups 的 todo 项）。
 * 内置 life/work/project/daily 与用户自建分组在这里没有区别。
 */
interface TodoGroup {
  kind: 'todo'
  id: string
  /** 用户自定义名；null/空 = 用内置名（先查既有 i18n 键，再回落裸 id）。 */
  label: string | null
  builtin: boolean
  scope: 'global' | 'project'
  /** 所属的类（2026-10-15 三类改造）：会话 / 项目 / 全局。 */
  klass?: 'session' | 'project' | 'global'
  /** 按日期分文件（只有这种分组才有「过往」一说）。 */
  daily: boolean
  inject: boolean
  enabled: boolean
  order: number
}

/**
 * 展示视图模式：
 * - list：纵向列表（默认）
 * - board：四象限看板
 */
type TodoViewMode = 'list' | 'board'

/** 四象限标识（q1~q4）。 */
type QuadrantId = 'q1' | 'q2' | 'q3' | 'q4'

/** GET /api/todo 返回的单条待办。 */
interface TodoItem {
  id: string
  time: string
  /** 存储侧象限；null 表示未写 quadrant 标签。 */
  quadrant: string | null
  due: string | null
  status: string
  doneAt: string | null
  cat: string | null
  text: string
  /** 所属分组 id（内置 life/work/project/daily 或用户自建分组 id）。 */
  target: string
  /** daily 条目所属日期（今天或过往某天）。 */
  day?: string
  /** 过往 daily 条目（今天之前）。 */
  past?: boolean
  /**
   * 可选：重要/紧急布尔（宿主当前 API 通常不返回；
   * 若将来扩展或中间层注入，看板可据此在无 quadrant 时推断）。
   */
  important?: boolean
  urgent?: boolean
}

/** GET /api/archive 的单条归档条目（`target` 对记忆侧是分组 id，对待办侧是 `todo-<组id>`）。 */
interface ArchiveEntry {
  target: string
  content: string
}

/** 待办 Tab 的外壳页签（指南 / 待确认待办管理 / 待办）。 */
export type TodosShellFeature = 'guide' | 'todo-suggestions' | 'todo'

/**
 * 外壳（TodosTabView）注入的上下文（用户 UI-11③：外壳页签与类/分组页签
 * **合并到同一行**，所以外壳只把状态传进来，页签行由本组件统一渲染）。
 */
export interface TodoShellProps {
  /** 当前选中的外壳页签。 */
  feature: TodosShellFeature
  /** 切换外壳页签。 */
  onFeature: (feature: TodosShellFeature) => void
  /** 待确认待办数（外壳页签上的徽标）。 */
  suggestions: number
  /** 待确认队列变更后的回调（刷新徽标）。 */
  onChanged: () => void
}

/** Locale-bound props。 */
export interface TodoViewProps {
  t: Translate
  sessionId: string
  /** 给了它 = 由待办 Tab 外壳托管（页签合并到第一行）。 */
  shell?: TodoShellProps
}

/**
 * 待办 Tab 专属指南内容（「指南」外壳页签）：
 * 详细介绍待办功能本身——四轨、如何添加、待确认待办管理、状态与筛选、
 * 智能视图与到期提醒。文案来自全局 locale（todosTab.guide.* 键组）。
 * 2026-10-15 UI-11③ 从 TodosTabView 搬来：页签合并后本组件要能直接渲染它。
 */
function todosGuideSections(t: Translate): GuideSection[] {
  return [
    {
      icon: '📋',
      title: t('todosTab.guide.tracks.title'),
      body: t('todosTab.guide.tracks.body'),
      items: [
        t('todosTab.guide.tracks.item1'),
        t('todosTab.guide.tracks.item2'),
        t('todosTab.guide.tracks.item3'),
        t('todosTab.guide.tracks.item4'),
      ],
    },
    {
      icon: '➕',
      title: t('todosTab.guide.add.title'),
      body: t('todosTab.guide.add.body'),
      items: [
        t('todosTab.guide.add.item1'),
        t('todosTab.guide.add.item2'),
      ],
    },
    {
      icon: '🔲',
      title: t('todosTab.guide.pending.title'),
      body: t('todosTab.guide.pending.body'),
      items: [
        t('todosTab.guide.pending.item1'),
        t('todosTab.guide.pending.item2'),
      ],
    },
    {
      icon: '🎯',
      title: t('todosTab.guide.attrs.title'),
      body: t('todosTab.guide.attrs.body'),
      items: [
        t('todosTab.guide.attrs.item1'),
        t('todosTab.guide.attrs.item2'),
        t('todosTab.guide.attrs.item3'),
      ],
    },
    {
      icon: '📅',
      title: t('todosTab.guide.view.title'),
      body: t('todosTab.guide.view.body'),
      items: [
        t('todosTab.guide.view.item1'),
        t('todosTab.guide.view.item2'),
      ],
    },
    {
      icon: '⏰',
      title: t('todosTab.guide.remind.title'),
      body: t('todosTab.guide.remind.body'),
    },
  ]
}

/** 类（一级页签）的固定顺序：会话 / 项目 / 全局。 */
const KLASSES = ['session', 'project', 'global'] as const
type TodoKlass = (typeof KLASSES)[number]

/** 二级页签的两个哨兵格：归档（最后一格）与过往（全局类专属）。 */
const ARCHIVE_ID = '__archive__'
const PAST_ID = '__past__'

/** 旧的单文件归档轨（三类改造前遗留，无分组归属）。 */
const LEGACY_ARCHIVE_TARGET = 'todo-archive'

/** 停用分组的显示二态（与宿主运行时配置 showDisabled 同值；缺省 hidden）。 */
type DisabledMode = 'shown' | 'hidden'

/** 显示二态的本地兜底键（与记忆页签同一项设置，宿主 /api/config 是权威值）。 */
const DISABLED_SETTING_KEY = 'memory-evolve:showDisabledGroups'

/**
 * 归一宿主/本地给的值（非法值 → null）。
 * 历史值 `dim`（灰显）已废弃，统一按 `shown` 处理（与记忆页签一致）。
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

/**
 * 分组接口拿不到（接口失败 / 返回坏数据）时的兜底：**出厂启用**的那几个组
 * （2026-10-15 三类改造后 life/work 已停用，不再放进兜底表）。
 * 目的只有一个——别让整个 Tab 的页签空白。
 */
const FALLBACK_TODO_GROUPS: TodoGroup[] = [
  { kind: 'todo', id: 'session', label: null, builtin: true, scope: 'global', klass: 'session', daily: false, inject: false, enabled: true, order: 10 },
  { kind: 'todo', id: 'project', label: null, builtin: true, scope: 'project', klass: 'project', daily: false, inject: false, enabled: true, order: 20 },
  { kind: 'todo', id: 'global', label: null, builtin: true, scope: 'global', klass: 'global', daily: false, inject: false, enabled: true, order: 30 },
  { kind: 'todo', id: 'daily', label: null, builtin: true, scope: 'global', klass: 'global', daily: true, inject: false, enabled: true, order: 40 },
]

/** 归一化一个来自 /api/groups 的待办分组（坏数据直接丢弃，不抛）。 */
function parseTodoGroup(raw: unknown): TodoGroup | null {
  if (raw === null || typeof raw !== 'object') return null
  const group = raw as Record<string, unknown>
  const id = typeof group.id === 'string' ? group.id.trim() : ''
  if (id === '') return null
  return {
    kind: 'todo',
    id,
    label: typeof group.label === 'string' ? group.label : null,
    builtin: group.builtin === true,
    scope: group.scope === 'project' ? 'project' : 'global',
    klass: group.klass === 'session' ? 'session' : group.klass === 'project' ? 'project' : 'global',
    daily: group.daily === true,
    inject: group.inject === true,
    enabled: group.enabled !== false,
    order: Number.isFinite(Number(group.order)) ? Number(group.order) : 100,
  }
}

/**
 * 归一化整份分组列表：**保留停用分组**（三级页签要按 showDisabled 决定它们
 * 是否出现），按 order 升序（同 order 按 id 稳定排序）。接口拿不到时回落内置表。
 */
function parseTodoGroups(raw: unknown): TodoGroup[] {
  if (!Array.isArray(raw)) return [...FALLBACK_TODO_GROUPS]
  const groups = raw
    .map(parseTodoGroup)
    .filter((group): group is TodoGroup => group !== null)
    .sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
  return groups.length > 0 ? groups : [...FALLBACK_TODO_GROUPS]
}

/**
 * 分组显示名：用户自定义 label 优先 → 既有 todo.track.<id> 键（内置分组）
 * → 裸 id 兜底（不为凑文案新造 i18n 键）。
 */
function groupLabelOf(t: Translate, group: TodoGroup | undefined, id: string): string {
  const label = group?.label
  if (typeof label === 'string' && label.trim() !== '') return label
  const key = `todo.track.${id}`
  const text = t(key)
  // 未知分组时 locale 回落为 key 本身（或空串），此时直接展示分组 id
  return text === key || text === '' ? id : text
}

/** 已结束状态（完成/取消），快速视图中默认隐藏。 */
const DONE_STATUSES = new Set(['done', 'cancelled'])

/** 看板四宫格的固定顺序：左上 q1、右上 q2、左下 q3、右下 q4。 */
const BOARD_QUADRANTS: QuadrantId[] = ['q1', 'q2', 'q3', 'q4']

/**
 * 跨重挂持久化的视图状态（模块级）。
 * badge 刷新等导致组件重挂时，恢复用户上次选的类 / 分组 / 列表-看板。
 *
 * 2026-10-15（F-8，用户要求"记住记忆/待办打开时的位置"）：模块级变量只能扛
 * 组件重挂 —— 刷新页面就丢、而且刻意**跨会话共用**（切换会话会沿用上一个会话的
 * 分组）。现在改为**按会话落 localStorage**：模块级仍保留（同一次挂载内最快），
 * 读写时以 localStorage 为持久层。
 */
let persistedViewMode: TodoViewMode | null = null
/** 一级选择：null = 「全部」功能格。 */
let persistedKlass: string | null = null
/** 二级选择：分组 id / PAST_ID / ARCHIVE_ID；null = 交给默认选择逻辑。 */
let persistedGroupId: string | null = null

/** 位置记忆的 localStorage 键（按会话分桶）。 */
function todoPositionKey(sessionId: string): string {
  return `memory-evolve:todo-tab:position:${sessionId}`
}

/** 读回该会话上次的位置（读不到或不合法时给 null）。 */
function readTodoPosition(sessionId: string | null): { klass: string | null; groupId: string | null; viewMode: TodoViewMode | null } {
  const empty = { klass: null, groupId: null, viewMode: null }
  if (sessionId === null || sessionId === '') return empty
  try {
    const raw = window.localStorage.getItem(todoPositionKey(sessionId))
    if (raw === null) return empty
    const parsed = JSON.parse(raw) as { klass?: unknown; groupId?: unknown; viewMode?: unknown }
    if (parsed === null || typeof parsed !== 'object') return empty
    return {
      klass: typeof parsed.klass === 'string' ? parsed.klass : null,
      groupId: typeof parsed.groupId === 'string' ? parsed.groupId : null,
      viewMode: parsed.viewMode === 'list' || parsed.viewMode === 'board' ? parsed.viewMode : null,
    }
  } catch {
    return empty
  }
}

/** 写回该会话的位置（存储不可用时静默降级为仅内存）。 */
function writeTodoPosition(sessionId: string | null, value: { klass: string | null; groupId: string | null; viewMode: TodoViewMode | null }): void {
  if (sessionId === null || sessionId === '') return
  try {
    window.localStorage.setItem(todoPositionKey(sessionId), JSON.stringify(value))
  } catch {
    // 隐私模式 / 存储禁用
  }
}

/** 统一请求宿主 API（/memory-evolve 前缀）。 */
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

/** 象限文案（q1..q4）；null = 未分类。 */
function quadrantLabel(t: Translate, quadrant: string | null): string {
  if (quadrant === null) return t('todo.quadrant.none')
  return t(`todo.quadrant.${quadrant}`)
}

/**
 * 解析条目归属象限（看板归位 + 展示用）。
 *
 * 规则（与需求一致）：
 * 1. 已有合法 quadrant（q1~q4）→ 直接使用；
 * 2. 否则按 important/urgent 推断：
 *    重要+紧急=q1，重要不紧急=q2，紧急不重要=q3，都不=q4。
 *
 * 注意：宿主 list 当前一般只返回 quadrant 字段；important/urgent 为扩展兼容。
 * 无 quadrant 且无布尔标记时按「都不」落入 q4，避免看板丢条目。
 */
function resolveItemQuadrant(item: TodoItem): QuadrantId {
  if (
    item.quadrant === 'q1'
    || item.quadrant === 'q2'
    || item.quadrant === 'q3'
    || item.quadrant === 'q4'
  ) {
    return item.quadrant
  }
  const important = item.important === true
  const urgent = item.urgent === true
  if (important && urgent) return 'q1'
  if (important && !urgent) return 'q2'
  if (!important && urgent) return 'q3'
  return 'q4'
}

/** 状态文案键：pending / doing / done / blocked / cancelled。 */
function statusLabel(t: Translate, status: string): string {
  const key = `todo.status.${status}`
  const label = t(key)
  // 未知状态时 locale 可能回落为 key 本身，直接展示原始 status
  return label === key ? status : label
}

/** 'YYYY-MM-DD' → '8月5日'（过往分组标题）。 */
function dayLabel(day: string): string {
  const [, month, date] = day.split('-')
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('en')
      ? `${Number(month)}/${Number(date)}`
      : `${Number(month)}月${Number(date)}日`
}

/**
 * 待办主视图（三级）：类页签 / 分组页签（+ 过往、归档）/ 待办列表。
 * 每次变更后重新 load 当前选择的待办数据。
 */
export function TodoView(props: TodoViewProps): JSX.Element {
  const { t, sessionId, shell } = props
  /**
   * 是否显示类 / 分组页签（用户 UI-11③）：外壳托管时只有「待办」这一格需要
   * 它们；独立使用（没有 shell）时始终显示。
   */
  const showClassTabs = shell === undefined || shell.feature === 'todo'
  // 位置记忆（F-8）：内存变量只在"同一次挂载"内可靠，刷新页面要靠 localStorage。
  // 这里一次性读出该会话上次的位置，作为三个选择状态的初值；之后每次变化都写回
  // （见下方同步 effect）。
  const savedPosition = readTodoPosition(sessionId)
  /** 一级选择：null = 「全部」（跨分组功能格）；否则为类 id。 */
  const [activeKlass, setActiveKlass] = useState<string | null>(persistedKlass ?? savedPosition.klass)
  /** 二级选择：分组 id / PAST_ID / ARCHIVE_ID；null = 交给默认选择 effect。 */
  const [activeGroupId, setActiveGroupId] = useState<string | null>(persistedGroupId ?? savedPosition.groupId)
  /** 停用分组的显示二态（宿主 /api/config 的 showDisabled 是权威值）。 */
  const [showDisabled, setShowDisabled] = useState<DisabledMode>(readDisabledMode)
  /** 条目展开设置（F-8②）：与记忆页共用同一套（设置 → 界面）。 */
  const [expandOpts, setExpandOpts] = useState<EntryExpandOptions>(DEFAULT_EXPAND_OPTIONS)
  /** 条目展开状态（F-8③）：localStorage 持久化，与记忆页共享一份记录。 */
  const views = useEntryViews(expandOpts)
  /** 条目元数据开关（F-7，待办页）：关掉后隐藏象限 / 截止日期等元数据徽章。 */
  const [metaOn, setMetaOn] = useState(true)
  /** 待办分组（**含停用项**）：一级/二级页签、快速添加、轨徽标的总驱动。 */
  const [todoGroups, setTodoGroups] = useState<TodoGroup[]>(FALLBACK_TODO_GROUPS)
  /** 归档条目（/api/archive，含记忆侧；只用 `todo-*` 的）。null = 未加载。 */
  const [archiveEntries, setArchiveEntries] = useState<ArchiveEntry[] | null>(null)
  /** 快速添加时的目标分组：全部视图下由用户选（缺省按 cwd 判定）。 */
  const [addTarget, setAddTarget] = useState<string>('work')
  const [items, setItems] = useState<TodoItem[] | null>(null)
  const [cwd, setCwd] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'done'>('active')
  const [quadFilter, setQuadFilter] = useState<string>('all')
  /** 显示已过期的过往待办（默认 false：过往遗留默认不显示，不增加信息负担）。 */
  const [showExpired, setShowExpired] = useState(false)
  /** 列表 / 看板视图切换（默认列表；跨重挂用模块级持久化）。 */
  const [viewMode, setViewMode] = useState<TodoViewMode>(persistedViewMode ?? savedPosition.viewMode ?? 'list')
  /** 搜索词（当前视图与归档视图共用；只过滤展示，不查后端）。 */
  const [query, setQuery] = useState('')
  /** 快速添加框草稿。 */
  const [draft, setDraft] = useState('')
  const [draftQuad, setDraftQuad] = useState<string>('')
  const [draftDue, setDraftDue] = useState('')
  /** 行内编辑中的条目 id（null = 未在编辑）。 */
  const [editId, setEditId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editQuad, setEditQuad] = useState<string>('')
  const [editDue, setEditDue] = useState('')
  const [editStatus, setEditStatus] = useState('')
  const [busy, setBusy] = useState(false)
  /** 一次性结果提示（右下角弹窗）。 */
  const notify = useToast(t)

  // 视图状态跨重挂持久化：内存变量（同一次挂载内恢复最快）+ localStorage
  // （F-8：刷新页面、以及"切走再切回来"都要回到同一个位置）。
  useEffect(() => {
    persistedViewMode = viewMode
    persistedKlass = activeKlass
    persistedGroupId = activeGroupId
    writeTodoPosition(sessionId, { klass: activeKlass, groupId: activeGroupId, viewMode })
  }, [viewMode, activeKlass, activeGroupId, sessionId])

  // 拉取分组配置：保留启用与停用两组（停用项是否出现由 showDisabled 决定）。
  // 失败只在 catch 里静默——保留兜底内置四组，绝不因分组接口不可用而白屏。
  useEffect(() => {
    let cancelled = false
    void api<{ todo?: unknown }>('/api/groups')
      .then((res) => {
        if (cancelled) return
        setTodoGroups(parseTodoGroups(res.todo))
      })
      .catch(() => { /* 分组接口不可用：保留内置兜底，功能不受影响 */ })
    return () => { cancelled = true }
  }, [])

  // 停用分组显示二态：宿主运行时配置 showDisabled 是权威值（与记忆页签同一项）。
  useEffect(() => {
    let cancelled = false
    void api<{ config?: { showDisabled?: string; entryExpandMode?: string; entryPreviewLines?: number; entryRememberHeight?: boolean } }>('/api/config')
      .then((res) => {
        if (cancelled) return
        const mode = normalizeDisabledMode(res.config?.showDisabled)
        if (mode !== null) setShowDisabled(mode)
        setExpandOpts(expandOptionsOf(res.config as Record<string, unknown> | undefined))
        setMetaOn((res.config as Record<string, unknown> | undefined)?.entryMetaTodo !== false)
      })
      .catch(() => { /* 配置读不到：用 localStorage 兜底值 */ })
    return () => { cancelled = true }
  }, [])

  /** 「过往」要查的分组：启用配置里第一个按日期分文件的分组；没有就回落内置 daily。 */
  const dailyGroupId = todoGroups.find((group) => group.daily === true)?.id ?? 'daily'
  /** 是否存在按日期分文件的分组（决定全局类要不要给「过往」一格）。 */
  const hasDaily = todoGroups.some((group) => group.daily === true)

  /** 当前类下的分组（含停用项），选定类为空（「全部」）时为空数组。 */
  const classGroups = useMemo(
    () => (activeKlass === null
      ? []
      : todoGroups.filter((group) => (group.klass ?? 'global') === activeKlass)),
    [todoGroups, activeKlass],
  )
  /** 二级页签要显示的分组：hidden → 只显示启用分组；shown → 全部（停用项灰字）。 */
  const visibleGroups = useMemo(
    () => (showDisabled === 'hidden' ? classGroups.filter((group) => group.enabled) : classGroups),
    [classGroups, showDisabled],
  )

  const isAll = activeKlass === null
  const isArchive = !isAll && activeGroupId === ARCHIVE_ID
  const isPast = !isAll && activeGroupId === PAST_ID
  /** 当前选中的分组（全部/归档/过往时为空）。 */
  const activeGroup = useMemo(
    () => (isAll || isArchive || isPast || activeGroupId === null
      ? null
      : visibleGroups.find((group) => group.id === activeGroupId) ?? null),
    [isAll, isArchive, isPast, activeGroupId, visibleGroups],
  )

  /**
   * 默认/合法性：类的 id 必须合法；二级缺省落到该类第一个可见分组
   * （一个都没有则落到「归档」）；「过往」只在全局类有效。
   */
  useEffect(() => {
    if (activeKlass === null) return
    if (!(KLASSES as readonly string[]).includes(activeKlass)) {
      setActiveKlass(KLASSES[0])
      return
    }
    if (isArchive) return
    if (isPast) {
      if (activeKlass === 'global') return
      setActiveGroupId(null)
      return
    }
    const ids = visibleGroups.map((group) => group.id)
    if (activeGroupId !== null && ids.includes(activeGroupId)) return
    setActiveGroupId(ids.length > 0 ? ids[0] : ARCHIVE_ID)
  }, [activeKlass, activeGroupId, visibleGroups, isArchive, isPast])

  /** 可作快速添加目标的启用分组（停用分组不接受新条目）。 */
  const addableGroups = useMemo(() => todoGroups.filter((group) => group.enabled), [todoGroups])

  // 添加目标必须落在启用分组里：旧选择失效时按 cwd 偏好重选
  // （有工作目录优先项目级分组，否则第一个启用分组；与 dtodo 工具缺省一致）
  useEffect(() => {
    if (addableGroups.length === 0) return
    if (addableGroups.some((group) => group.id === addTarget)) return
    // 三类改造（2026-10-15）：默认添加目标必须落在**当前可写**的分组上——
    // 项目类要 cwd、会话类要 sessionId；都缺时退到全局类（非日志型），
    // 最后才随便挑一个。此前只看 scope，会把会话类当全局类选选中。
    const projectLevel = cwd !== null
      ? addableGroups.find((group) => group.klass === 'project')
      : undefined
    const globalLevel = addableGroups.find((group) => group.klass === 'global' && group.daily !== true)
    const preferred = projectLevel ?? globalLevel ?? addableGroups[0]
    if (preferred !== undefined) setAddTarget(preferred.id)
  }, [addableGroups, addTarget, cwd])

  const load = useCallback((): void => {
    setItems(null)
    const params = new URLSearchParams({ sessionId, all: '1' })
    if (isAll) {
      // 跨分组「全部」：不传 target（宿主默认覆盖全部启用分组）；
      // 勾选「显示已过期」时才顺带读历史文件（默认零额外开销）
      if (showExpired) {
        params.set('past', '1')
        params.set('expired', '1')
      }
    } else if (isPast) {
      // 「过往」查启用配置里那个按日期分文件的分组（内置 id 就是 daily）
      params.set('target', dailyGroupId)
      params.set('past', '1')
      if (showExpired) params.set('expired', '1')
    } else if (activeGroupId !== null) {
      params.set('target', activeGroupId)
    }
    // 状态/象限筛选在前端做（全部视图需要跨轨过滤；active = 未完成的所有状态）
    void api<{ items: TodoItem[]; cwd: string | null }>(`/api/todo?${params.toString()}`)
      .then((res) => {
        setItems(res.items)
        setCwd(res.cwd)
      })
      .catch((error: Error) => notify('error', error.message))
  }, [sessionId, isAll, isPast, activeGroupId, showExpired, dailyGroupId])

  /** 拉归档条目（本级页签的「归档」格 + 页签计数都要它）。 */
  const loadArchive = useCallback((): void => {
    void api<{ entries: ArchiveEntry[] }>(`/api/archive?sessionId=${encodeURIComponent(sessionId)}`)
      .then((res) => setArchiveEntries(res.entries))
      .catch((error: Error) => notify('error', error.message))
  }, [sessionId])

  // 归档数据用于页签计数：进页面先拉一次；进归档格时再刷新一次。
  useEffect(() => { loadArchive() }, [loadArchive])
  useEffect(() => {
    if (isArchive) loadArchive()
    else load()
  }, [isArchive, loadArchive, load])

  /** 短暂成功提示（右下角弹窗，3 秒自动消失）。 */
  const flash = (text: string): void => {
    notify('ok', text)
  }

  /** 切一级页签（类，或 null = 全部）；二级交给默认选择 effect。 */
  const selectKlass = (klass: string | null): void => {
    setActiveKlass(klass)
    setActiveGroupId(null)
  }

  /**
   * 切换停用分组的显示二态。
   * 这一项是**宿主运行时配置**（与「Memory Evolve 设置 → 界面」的 showDisabled
   * 同一项，也与记忆页签同一项），所以点击后写回宿主；localStorage 只存兜底副本。
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
    }).catch((error: Error) => notify('error', error.message))
  }

  /** 快速添加：用户口述直写（用户即确认者）。 */
  const addTodo = (): void => {
    const content = draft.trim()
    if (content === '' || busy || isPast || isArchive) return
    setBusy(true)
    const addTrack = isAll ? addTarget : activeGroupId ?? addTarget
    void api<{ ok: boolean; id: string }>('/api/todo', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        action: 'add',
        target: addTrack,
        content,
        quadrant: draftQuad === '' ? undefined : draftQuad,
        due: draftDue === '' ? undefined : draftDue,
      }),
    }).then(() => {
      setDraft('')
      setDraftQuad('')
      setDraftDue('')
      load()
      flash(t('todo.added'))
    }).catch((error: Error) => {
      notify('error', error.message)
    }).finally(() => setBusy(false))
  }

  /** 完成 / 恢复（列表与看板共用）。 */
  const toggleDone = (item: TodoItem): void => {
    if (busy) return
    setBusy(true)
    const done = !DONE_STATUSES.has(item.status)
    void api<{ ok: boolean }>('/api/todo', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        action: done ? 'done' : 'update',
        target: item.target,
        id: item.id,
        status: 'pending',
      }),
    }).then(() => {
      load()
      flash(done ? t('todo.done') : t('todo.undone'))
    }).catch((error: Error) => {
      notify('error', error.message)
    }).finally(() => setBusy(false))
  }

  /** 删除（确认后；列表与看板共用）。 */
  const removeTodo = async (item: TodoItem): Promise<void> => {
    if (busy) return
    const snippet = item.text.split('\n')[0].slice(0, 40)
    if (!(await askConfirm(t('todo.deleteConfirm', { snippet })))) return
    setBusy(true)
    void api<{ ok: boolean }>('/api/todo', {
      method: 'POST',
      body: JSON.stringify({ sessionId, action: 'remove', target: item.target, id: item.id }),
    }).then(() => {
      load()
      flash(t('todo.deleted'))
    }).catch((error: Error) => {
      notify('error', error.message)
    }).finally(() => setBusy(false))
  }

  /** 开始行内编辑。 */
  const startEdit = (item: TodoItem): void => {
    setEditId(item.id)
    setEditDraft(item.text)
    setEditQuad(item.quadrant ?? '')
    setEditDue(item.due ?? '')
    setEditStatus(item.status)
  }

  /** 保存行内编辑。 */
  const saveEdit = (item: TodoItem): void => {
    if (busy) return
    setBusy(true)
    void api<{ ok: boolean }>('/api/todo', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        action: 'update',
        target: item.target,
        id: item.id,
        content: editDraft.trim(),
        quadrant: editQuad === '' ? undefined : editQuad,
        due: editDue === '' ? undefined : editDue,
        status: editStatus,
      }),
    }).then(() => {
      setEditId(null)
      load()
      flash(t('todo.updated'))
    }).catch((error: Error) => {
      notify('error', error.message)
    }).finally(() => setBusy(false))
  }

  /**
   * 看板卡片上快捷切换状态（pending→doing→done→blocked→cancelled→pending 循环）。
   * 走与行内编辑相同的 update 路径，不另开 API。
   */
  const cycleStatus = (item: TodoItem): void => {
    if (busy) return
    const order = ['pending', 'doing', 'done', 'blocked', 'cancelled']
    const idx = order.indexOf(item.status)
    const next = order[(idx + 1) % order.length] ?? 'pending'
    setBusy(true)
    void api<{ ok: boolean }>('/api/todo', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        action: 'update',
        target: item.target,
        id: item.id,
        status: next,
      }),
    }).then(() => {
      load()
      flash(t('todo.updated'))
    }).catch((error: Error) => {
      notify('error', error.message)
    }).finally(() => setBusy(false))
  }

  /**
   * 归档条目「移回」它原来的待办分组（走宿主 /api/archive/promote）。
   * 匹配基准直接用归档页展示的正文：宿主两侧都做 normalizeForMatch 归一化，
   * 展示文本（已剥 [id:…]）仍是原文的子串（issue #59 的既有语义）。
   * 旧的单文件轨（todo-archive）没有分组归属，不提供移回。
   */
  const promoteArchiveEntry = (entry: ArchiveEntry): void => {
    if (busy || entry.target === LEGACY_ARCHIVE_TARGET) return
    setBusy(true)
    void api<{ ok?: boolean; message?: string }>('/api/archive/promote', {
      method: 'POST',
      body: JSON.stringify({ target: entry.target, match: entry.content, sessionId }),
    }).then((res) => {
      if (res.ok === false) {
        notify('error', res.message ?? t('todo.promoteFailed'))
        return
      }
      loadArchive()
      flash(t('todo.promoted'))
    }).catch((error: Error) => {
      notify('error', error.message)
    }).finally(() => setBusy(false))
  }

  /** 今天（本地时区），用于逾期标红。不能 toISOString——那是 UTC 日期，
   *  东八区晚上本地已过零点时 UTC 仍是前一天，「今天」的截止会被误标成
   *  逾期（稳定版复审 P0-9）。 */
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  /** 分组 id → 分组（轨徽标 / 分组提示查名用）。 */
  const groupById = new Map<string, TodoGroup>()
  for (const group of todoGroups) groupById.set(group.id, group)

  /** 搜索词（小写）；空串表示不过滤。 */
  const q = query.trim().toLowerCase()

  /** 前端筛选：状态（active=未完成全部状态）+ 象限 + 搜索 + 过往视图只看过往条目。 */
  const visible = (items ?? []).filter((item) => {
    if (isPast && item.past !== true) return false
    if (statusFilter === 'active' && DONE_STATUSES.has(item.status)) return false
    if (statusFilter === 'done' && !DONE_STATUSES.has(item.status)) return false
    if (quadFilter === 'none' && item.quadrant !== null) return false
    if (quadFilter !== 'all' && quadFilter !== 'none' && item.quadrant !== quadFilter) return false
    if (q !== '' && !item.text.toLowerCase().includes(q) && !(item.cat ?? '').toLowerCase().includes(q)) return false
    return true
  })

  /** 过往条目按日期分组（倒序，后端已排序）；非过往条目单列一组。 */
  const groups: { day: string | null; items: TodoItem[] }[] = []
  for (const item of visible) {
    const day = item.past === true ? item.day ?? null : null
    const last = groups[groups.length - 1]
    if (day !== null && last !== undefined && last.day === day) last.items.push(item)
    else groups.push({ day, items: [item] })
  }

  /**
   * 看板：按解析后的象限分桶。
   * 注意：列表筛选仍用存储侧 quadrant（含 none）；看板归位用 resolveItemQuadrant。
   */
  const boardBuckets: Record<QuadrantId, TodoItem[]> = {
    q1: [],
    q2: [],
    q3: [],
    q4: [],
  }
  for (const item of visible) {
    boardBuckets[resolveItemQuadrant(item)].push(item)
  }

  /**
   * 归档视图：按**当前类下的各分组**分段（顺序同二级页签），只留有条目的段；
   * 旧单文件轨（todo-archive）归到全局类最后一段。搜索生效。
   */
  const archiveBlocks = useMemo((): { id: string; title: string; legacy: boolean; entries: ArchiveEntry[] }[] => {
    if (!isArchive || archiveEntries === null) return []
    const blocks: { id: string; title: string; legacy: boolean; entries: ArchiveEntry[] }[] = []
    for (const group of classGroups) {
      const entries = archiveEntries.filter((entry) => entry.target === `todo-${group.id}`)
      if (entries.length === 0) continue
      blocks.push({ id: group.id, title: groupLabelOf(t, group, group.id), legacy: false, entries })
    }
    if (activeKlass === 'global') {
      const legacy = archiveEntries.filter((entry) => entry.target === LEGACY_ARCHIVE_TARGET)
      if (legacy.length > 0) {
        blocks.push({ id: LEGACY_ARCHIVE_TARGET, title: t('todo.archiveLegacy'), legacy: true, entries: legacy })
      }
    }
    if (q === '') return blocks
    return blocks
      .map((block) => ({ ...block, entries: block.entries.filter((entry) => entry.content.toLowerCase().includes(q)) }))
      .filter((block) => block.entries.length > 0)
  }, [isArchive, archiveEntries, classGroups, activeKlass, q, t])

  /** 「归档」格的计数：当前类下各分组 + （全局类）旧单文件轨的条目数。 */
  const archiveCount = useMemo((): number => {
    if (archiveEntries === null) return 0
    const ids = new Set(classGroups.map((group) => `todo-${group.id}`))
    return archiveEntries.filter((entry) => ids.has(entry.target)
      || (activeKlass === 'global' && entry.target === LEGACY_ARCHIVE_TARGET)).length
  }, [archiveEntries, classGroups, activeKlass])

  /** 渲染单条卡片的元信息徽标区（轨 / 日期 / 截止 / 分类 / 状态）。 */
  const renderMetaBadges = (item: TodoItem, opts?: { showQuad?: boolean }): JSX.Element => {
    const done = DONE_STATUSES.has(item.status)
    const overdue = item.due !== null && item.due < today && !done
    return (
      <>
        {isAll && (
          <span className="me-badge me-badge-target">
            {item.past === true
              ? t('todo.track.past')
              : groupLabelOf(t, groupById.get(item.target), item.target)}
          </span>
        )}
        {item.past === true && !isAll && (
          <span className="me-badge me-badge-day">{dayLabel(item.day ?? '')}</span>
        )}
        {opts?.showQuad === true && (
          <span className={`me-badge me-badge-quad me-badge-quad-${item.quadrant ?? 'none'}`}>
            {quadrantLabel(t, item.quadrant)}
          </span>
        )}
        {item.due !== null && (
          <span className={`me-badge ${overdue ? 'me-badge-overdue' : 'me-badge-due'}`}>
            {overdue ? `${t('todo.overdue')} ${item.due}` : `${t('todo.due')} ${item.due}`}
          </span>
        )}
        {item.cat !== null && <span className="me-badge me-badge-target">{item.cat}</span>}
        <button
          type="button"
          className={`me-badge me-badge-status me-badge-status-${item.status}`}
          title={t('todo.board.cycleStatus')}
          disabled={busy}
          onClick={(event) => {
            // 阻止冒泡，避免与卡片其它点击冲突
            event.stopPropagation()
            cycleStatus(item)
          }}
        >
          {statusLabel(t, item.status)}
        </button>
      </>
    )
  }

  /** 渲染完成/编辑/删除操作按钮（列表行与看板卡片共用）。 */
  const renderActions = (item: TodoItem): JSX.Element => {
    const done = DONE_STATUSES.has(item.status)
    return (
      <span className="me-item-actions">
        <button type="button" className="me-btn me-btn-ok" disabled={busy} onClick={() => toggleDone(item)}>
          {done ? t('todo.undone') : t('todo.done')}
        </button>
        {editId !== item.id && (
          <button type="button" className="me-btn" disabled={busy} onClick={() => startEdit(item)}>
            {t('todo.edit')}
          </button>
        )}
        <button type="button" className="me-btn me-btn-danger" disabled={busy} onClick={() => removeTodo(item)}>
          {t('memoryTab.delete')}
        </button>
      </span>
    )
  }

  /** 渲染行内编辑表单（列表与看板共用）。 */
  const renderEditForm = (item: TodoItem): JSX.Element => (
    <div className="me-todo-edit">
      <textarea
        className="me-item-edit"
        rows={2}
        value={editDraft}
        onChange={(event) => setEditDraft(event.target.value)}
      />
      <div className="me-todo-edit-row">
        <select value={editQuad} onChange={(event) => setEditQuad(event.target.value)}>
          <option value="">{t('todo.quadrant.none')}</option>
          <option value="q1">{t('todo.quadrant.q1')}</option>
          <option value="q2">{t('todo.quadrant.q2')}</option>
          <option value="q3">{t('todo.quadrant.q3')}</option>
          <option value="q4">{t('todo.quadrant.q4')}</option>
        </select>
        <input
          type="date"
          value={editDue}
          onChange={(event) => setEditDue(event.target.value)}
        />
        <select value={editStatus} onChange={(event) => setEditStatus(event.target.value)}>
          <option value="pending">{t('todo.status.pending')}</option>
          <option value="doing">{t('todo.status.doing')}</option>
          <option value="done">{t('todo.status.done')}</option>
          <option value="blocked">{t('todo.status.blocked')}</option>
          <option value="cancelled">{t('todo.status.cancelled')}</option>
        </select>
        <button
          type="button"
          className="me-btn me-btn-ok"
          disabled={busy || editDraft.trim() === ''}
          onClick={() => saveEdit(item)}
        >
          {t('todo.save')}
        </button>
        <button type="button" className="me-btn" disabled={busy} onClick={() => setEditId(null)}>
          {t('todo.cancel')}
        </button>
      </div>
    </div>
  )

  /** 看板单张卡片。 */
  const renderBoardCard = (item: TodoItem): JSX.Element => {
    const done = DONE_STATUSES.has(item.status)
    // 标题取首行，过长截断；完整内容在编辑或 title 悬停可见
    const titleLine = item.text.split('\n')[0] || item.text
    return (
      <article
        key={item.id}
        className={`me-todo-card${done ? ' me-todo-card--done' : ''}`}
      >
        <div className="me-todo-card-meta">
          {renderMetaBadges(item)}
        </div>
        {editId === item.id ? (
          renderEditForm(item)
        ) : (
          <>
            <p className="me-todo-card-title" title={item.text}>{titleLine}</p>
            {item.text.includes('\n') && (
              <p className="me-todo-card-body">{item.text.slice(titleLine.length).trim()}</p>
            )}
          </>
        )}
        <div className="me-todo-card-foot">
          <span className="me-item-time">{item.time}</span>
          {renderActions(item)}
        </div>
      </article>
    )
  }

  /** 看板四宫格主体。 */
  const renderBoard = (): JSX.Element => (
    <div className="me-todo-board" role="region" aria-label={t('todo.view.board')}>
      {BOARD_QUADRANTS.map((qid) => {
        const bucket = boardBuckets[qid]
        return (
          <section
            key={qid}
            className={`me-todo-quad me-todo-quad-${qid}`}
            aria-label={t(`todo.quadrant.${qid}`)}
          >
            <header className="me-todo-quad-head">
              <span className="me-todo-quad-title">{t(`todo.quadrant.${qid}`)}</span>
              <span className="me-todo-quad-count">{bucket.length}</span>
            </header>
            <div className="me-todo-quad-body">
              {bucket.length === 0 ? (
                <p className="me-todo-quad-empty">{t('todo.board.empty')}</p>
              ) : (
                bucket.map((item) => renderBoardCard(item))
              )}
            </div>
          </section>
        )
      })}
    </div>
  )

  /** 列表主体（原逻辑 + 搜索过滤）。 */
  const renderList = (): JSX.Element => {
    if (visible.length === 0) {
      return (
        <p className="me-empty">
          {q !== '' ? t('todo.noResults') : t('todo.empty')}
          {q === '' && (isAll || isPast) && !showExpired && ` ${t('todo.pastHint')}`}
        </p>
      )
    }
    return (
      <ul className="me-list">
        {groups.map((group) => (
          <Fragment key={group.day ?? group.items[0].id}>
            {group.day !== null && (
              <li className="me-todo-day">{dayLabel(group.day)}</li>
            )}
            {group.items.map((item) => {
              const done = DONE_STATUSES.has(item.status)
              return (
                <li key={item.id} className={`me-item me-todo-item${done ? ' me-todo-item--done' : ''}`}>
                  <div className="me-item-head">
                    {metaOn && renderMetaBadges(item, { showQuad: true })}
                    <span className="me-item-time">{item.time}</span>
                    {/* 展开 / 收起箭头（F-8②）：与记忆页同款，默认形态由设置决定，
                        点一下覆盖并记住。 */}
                    <button
                      type="button"
                      className="mt-entry-toggle"
                      aria-expanded={views.isOpen(entryKeyOf(item.id, item.text))}
                      title={views.isOpen(entryKeyOf(item.id, item.text))
                        ? t('memoryTab.entryCollapse')
                        : t('memoryTab.entryExpand')}
                      onClick={() => views.toggle(entryKeyOf(item.id, item.text))}
                    >
                      {views.isOpen(entryKeyOf(item.id, item.text)) ? '▼' : '▶'}
                    </button>
                    {renderActions(item)}
                  </div>
                  {editId === item.id ? renderEditForm(item) : views.isOpen(entryKeyOf(item.id, item.text)) ? (
                    <>
                      <p className="me-todo-text" style={views.textStyle(entryKeyOf(item.id, item.text))}>{item.text}</p>
                      {expandOpts.rememberHeight && (
                        <div
                          className="mt-entry-resize"
                          title={t('memoryTab.entryResize')}
                          onPointerDown={(event) => views.startResize(entryKeyOf(item.id, item.text), event)}
                        />
                      )}
                    </>
                  ) : null}
                </li>
              )
            })}
          </Fragment>
        ))}
      </ul>
    )
  }

  /** 归档视图：每个来源分组一块（mt-card + 条目卡片，与记忆页签归档同构）。 */
  const renderArchive = (): JSX.Element => (
    <>
      <div className="me-todo-search-row">
        <input
          type="search"
          className="mt-search"
          value={query}
          placeholder={t('todo.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {archiveEntries === null ? (
        <p className="me-muted">{t('panel.loading')}</p>
      ) : archiveBlocks.length === 0 ? (
        <p className="me-empty">{q !== '' ? t('todo.noResults') : t('todo.archiveEmpty')}</p>
      ) : (
        archiveBlocks.map((block) => (
          <div key={block.id} className="mt-card">
            <div className="mt-card-head">
              <span className="mt-card-title">{block.title}</span>
              <span className="mt-badge mt-badge-ro">{t('memoryTab.readonly')}</span>
              <span className="mt-badge mt-badge-count">
                {t('memoryTab.entryCount', { count: block.entries.length })}
              </span>
            </div>
            <div className="mt-entries">
              {block.entries.map((entry, index) => (
                <div key={index} className="mt-entry">
                  <div className="mt-entry-head">
                    {!block.legacy && (
                      <button
                        type="button"
                        className="mt-btn"
                        title={t('todo.promoteHint')}
                        disabled={busy}
                        onClick={() => promoteArchiveEntry(entry)}
                      >
                        {t('todo.promote')}
                      </button>
                    )}
                  </div>
                  <p className="mt-entry-text">{entry.content}</p>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </>
  )

  return (
    <div className="mt-panel">
      {/* 一级页签（2026-10-15 三级改造，与记忆页签同构）：
          [全部] [会话类] [项目类] [全局类]。「全部」是跨分组功能格——
          选中它时下面的二级页签不渲染，内容区直接给全部启用分组的待办。 */}
      <div className="mt-tabs-bar">
        <div className="mt-tabs-scroll" role="tablist">
        {/* 外壳页签（用户 UI-11③）：指南 / 待确认待办管理 / 待办 与类、分组页签
            **合并到同一行**（不再各占一行），指南固定最左。选了指南或待确认
            队列时，右侧的类 / 分组页签整段收起（与记忆页签同构）。 */}
        {shell !== undefined && (
          <>
            <button
              type="button"
              role="tab"
              aria-selected={shell.feature === 'guide'}
              className={shell.feature === 'guide' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
              onClick={() => shell.onFeature('guide')}
            >
              {t('todosTab.feature.guide')}
            </button>
            <span className="mt-tab-sep" role="presentation" />
            <button
              type="button"
              role="tab"
              aria-selected={shell.feature === 'todo-suggestions'}
              className={shell.feature === 'todo-suggestions' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
              onClick={() => shell.onFeature('todo-suggestions')}
            >
              {t('todosTab.feature.todoSuggestions')}
              {shell.suggestions > 0 && <span className="mt-feature-count">{shell.suggestions}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={shell.feature === 'todo'}
              className={shell.feature === 'todo' ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
              onClick={() => shell.onFeature('todo')}
            >
              {t('todosTab.feature.todo')}
            </button>
            <span className="mt-tab-sep" role="presentation" />
          </>
        )}
        {showClassTabs && (
          <>
        <button
          type="button"
          role="tab"
          aria-selected={isAll}
          className={isAll ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
          onClick={() => selectKlass(null)}
        >
          {t('todo.track.all')}
        </button>
        {KLASSES.map((klass) => {
          const tabActive = activeKlass === klass
          return (
            <button
              key={klass}
              type="button"
              role="tab"
              aria-selected={tabActive}
              className={tabActive ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
              onClick={() => selectKlass(klass)}
            >
              {t(`groupsPanel.klass.${klass}`)}
            </button>
          )
        })}
        {/* 二级页签**并入同一行**：当前类下的分组 +（全局类）「过往」+ 最后一格「归档」 */}
        {!isAll && (
          <>
            <span className="mt-tab-sep" role="presentation" />
          {visibleGroups.map((group) => {
            const tabActive = activeGroupId === group.id
            const disabled = !group.enabled
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
                title={disabled ? t('memoryTab.groupDisabled') : ''}
                onClick={() => setActiveGroupId(group.id)}
              >
                {groupLabelOf(t, group, group.id)}
                {disabled ? ` · ${t('memoryTab.groupDisabled')}` : ''}
              </button>
            )
          })}
          {/* 过往：每日待办（daily）在全局类下，所以这一格只出现在全局类 */}
          {activeKlass === 'global' && hasDaily && (
            <button
              type="button"
              role="tab"
              aria-selected={isPast}
              className={isPast ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
              onClick={() => setActiveGroupId(PAST_ID)}
            >
              {t('todo.track.past')}
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={isArchive}
            className={isArchive ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
            onClick={() => setActiveGroupId(ARCHIVE_ID)}
          >
            {t('memoryTab.tab.archive')}
            {archiveCount > 0 ? ` (${archiveCount})` : ''}
          </button>
          </>
        )}
          </>
        )}
        </div>
        {/* 操作区：锁定第一行最右，永不换行 —— 页签溢出只让页签那侧横向滚动 */}
        <div className="mt-tabs-actions">
          {showClassTabs && !isAll && (
            /* 停用分组显示：一个按钮显示当前状态，点击切换（用户 UI-9，与记忆页签同款） */
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
      {/* 外壳页签的内容分流（用户 UI-11③）：指南与待确认队列各渲染自己的组件；
          「待办」才是下面这一整块类 / 分组 / 条目视图。 */}
      {shell !== undefined && shell.feature === 'guide' ? (
        <TabGuideView sections={todosGuideSections(t)} />
      ) : shell !== undefined && shell.feature === 'todo-suggestions' ? (
        <MemoryQueueView t={t} feature="todo-suggestions" onChanged={shell.onChanged} />
      ) : (
        <>
      {/* 「待办按「类 → 分组 → 条目」三级浏览…」那行常驻说明已删除（用户 UI-18）：
          内容仍保留在「指南」页里，需要时自己点开看。 */}
      {activeGroup?.scope === 'project' && cwd === null && (
        <p className="me-muted">{t('todo.projectHint')}</p>
      )}
      {isArchive ? renderArchive() : (
        <>
          {/* 快速添加：全部视图下可选目标分组；过往只查看历史、归档只读，都不添加 */}
          {!isPast && (
            <div className="me-todo-add">
              {isAll && addableGroups.length > 0 && (
                <select
                  className="me-todo-select"
                  value={addTarget}
                  onChange={(event) => setAddTarget(event.target.value)}
                  title={t('todo.track')}
                >
                  {addableGroups.map((group) => (
                    <option key={group.id} value={group.id}>{groupLabelOf(t, group, group.id)}</option>
                  ))}
                </select>
              )}
              <input
                type="text"
                className="me-todo-input"
                value={draft}
                placeholder={t('todo.addPlaceholder')}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') addTodo() }}
              />
              <select
                className="me-todo-select"
                value={draftQuad}
                onChange={(event) => setDraftQuad(event.target.value)}
                title={t('todo.quadrant')}
              >
                <option value="">{t('todo.quadrant.none')}</option>
                <option value="q1">{t('todo.quadrant.q1')}</option>
                <option value="q2">{t('todo.quadrant.q2')}</option>
                <option value="q3">{t('todo.quadrant.q3')}</option>
                <option value="q4">{t('todo.quadrant.q4')}</option>
              </select>
              <input
                type="date"
                className="me-todo-date"
                value={draftDue}
                onChange={(event) => setDraftDue(event.target.value)}
                title={t('todo.due')}
              />
              <button type="button" className="me-btn me-btn-ok" disabled={busy || draft.trim() === ''} onClick={addTodo}>
                {t('todo.add')}
              </button>
            </div>
          )}
          {/* 搜索 + 筛选 + 列表/看板视图切换 */}
          <div className="me-todo-search-row">
            <input
              type="search"
              className="mt-search"
              value={query}
              placeholder={t('todo.searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="me-todo-filters">
            <label className="me-todo-filter">
              <span>{t('todo.filterStatus')}</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | 'active' | 'done')}>
                <option value="active">{t('todo.status.active')}</option>
                <option value="all">{t('todo.all')}</option>
                <option value="done">{t('todo.status.done')}</option>
              </select>
            </label>
            <label className="me-todo-filter">
              <span>{t('todo.filterQuadrant')}</span>
              <select value={quadFilter} onChange={(event) => setQuadFilter(event.target.value)}>
                <option value="all">{t('todo.all')}</option>
                <option value="q1">{t('todo.quadrant.q1')}</option>
                <option value="q2">{t('todo.quadrant.q2')}</option>
                <option value="q3">{t('todo.quadrant.q3')}</option>
                <option value="q4">{t('todo.quadrant.q4')}</option>
                <option value="none">{t('todo.quadrant.none')}</option>
              </select>
            </label>
            {(isAll || isPast) && (
              <label className="me-todo-filter me-todo-filter-check">
                <input
                  type="checkbox"
                  checked={showExpired}
                  onChange={(event) => setShowExpired(event.target.checked)}
                />
                <span>{t('todo.showExpired')}</span>
              </label>
            )}
            {/* 分段控件：列表 / 看板 */}
            <div className="me-todo-view-switch" role="group" aria-label={t('todo.view.mode')}>
              <button
                type="button"
                className={viewMode === 'list' ? 'me-todo-view-btn me-todo-view-btn-active' : 'me-todo-view-btn'}
                aria-pressed={viewMode === 'list'}
                onClick={() => setViewMode('list')}
              >
                {t('todo.view.list')}
              </button>
              <button
                type="button"
                className={viewMode === 'board' ? 'me-todo-view-btn me-todo-view-btn-active' : 'me-todo-view-btn'}
                aria-pressed={viewMode === 'board'}
                onClick={() => setViewMode('board')}
              >
                {t('todo.view.board')}
              </button>
            </div>
          </div>
          {/* 内容区：加载中 / 列表 / 看板 */}
          {items === null ? (
            <p className="me-muted">{t('panel.loading')}</p>
          ) : viewMode === 'board' ? (
            renderBoard()
          ) : (
            renderList()
          )}
        </>
      )}
        </>
      )}
    </div>
  )
}
