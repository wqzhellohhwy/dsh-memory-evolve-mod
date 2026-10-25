/**
 * dsh-memory-evolve — 「分组」设置面板。
 *
 * 记忆与待办过去是**硬编码轨道**，现在是用户可自定义的**分组**（host 侧
 * lib/groups.js + `/memory-evolve/api/groups`）。本面板是这套模型唯一的 UI：
 *   - 顶部状态：记忆根路径 + 布局版本（v3 未就绪时写操作停用）；
 *   - 「全局开关」：待确认红点 / 有待确认时直接跳待确认 / 全局自动通过 /
 *     待办注入 / 收尾检查待办 / 分组文本自动保存；
 *   - 「记忆分组」/「待办分组」：改名、改 id、注入、写入需确认、启用、提示词、删除。
 *
 * 磁盘布局 v3（docs/layout-v3.md）在 UI 上的三条硬约束：
 *   1. 日志型（daily）**创建后不可改**——分组行只显示「日志」徽标，没有开关；
 *   2. 自建分组的 `#id` 可改，保存时走 `POST /api/groups/rename`（目录一起改名），
 *      内置分组的 id 只读；
 *   3. 删除前先 `GET /api/groups/delete-preview`，确认框里报条目数与归档数。
 *
 * 内置分组（`builtin:true`）可改名/停用，但**不可删除、类与 id 不可改**。
 * 内置行**不发送 scope/klass**，作用域渲染成只读徽标。
 *
 * 一切都走 host 的写接口，成功后用响应里的新列表重建本地视图——不在前端自己
 * 推导状态，避免与服务端不一致。写接口在布局未迁移时回 409，`error` 字段就是
 * 中文原因，面板原样显示。
 */
import { useEffect, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { askConfirm } from './ask-confirm.ts'
import { useToast } from './Toast.tsx'

/** 分组大类：记忆 / 待办。 */
type GroupKind = 'memory' | 'todo'

/** 分组作用域：全局 / 项目级（旧二值视图，保留兼容；新代码用 GroupKlass）。 */
type GroupScope = 'global' | 'project'

/** 分组的类（会话类 / 项目类 / 全局类）；内置分组锁死不可改。 */
type GroupKlass = 'session' | 'project' | 'global'

/** 注入通道：跟随全局（默认）/ 运行时上下文快照 / 系统提示词段。 */
type InjectMode = 'inherit' | 'context' | 'section'

/** 一个分组此刻的磁盘布局（后端 layoutOfGroup 的形状，GET 才有）。 */
interface GroupLayout {
  dir: string | null
  archiveDir: string | null
  daily: boolean
  klass: string
  kind: string
}

/** 一个分组实体（GET/POST /api/groups 返回的形状，见 lib/groups.js）。 */
interface Group {
  kind: GroupKind
  id: string
  /** 展示名（后端已把默认名解析进 label）。 */
  label: string | null
  /** 内置分组：不可删除，类与 id 不可改。 */
  builtin: boolean
  scope: GroupScope
  klass: GroupKlass
  injectMode: InjectMode
  /** 日志型（按日期分文件）：创建后不可改。 */
  daily: boolean
  inject: boolean
  prompt: string | null
  confirm: boolean
  autoApprove: boolean
  enabled: boolean
  order: number
  /** 该分组此刻的磁盘布局（写接口返回的列表不带这个字段）。 */
  layout?: GroupLayout
}

/** 记忆根的整体布局状态（lib/index.js layoutStatusOf）。 */
interface LayoutStatus {
  state: string
  expected: number
  needsMigration: boolean
  migrating: boolean
  writesBlocked: boolean
}

/** 分组列表（POST / DELETE 的响应）。 */
interface GroupsList {
  memory: Group[]
  todo: Group[]
}

/** GET /api/groups 的响应（比列表多出布局与路径）。 */
interface GroupsResponse extends GroupsList {
  file: string
  /** 真正的记忆根（`memoryRoot`/`todoRoot` 是它下面的两个分组根，顶部不展示）。 */
  memoryDir?: string
  layoutVersion?: number | null
  layout?: LayoutStatus | null
}

/** 删除前统计（GET /api/groups/delete-preview）。 */
interface DeletePreview {
  ok: boolean
  kind: GroupKind
  id: string
  builtin: boolean
  deletable: boolean
  stats: { entries: number; archived: number; locations: number }
}

/** DELETE /api/groups 的响应：多一个**实际**删除结果。 */
interface GroupsDeleteResponse extends GroupsList {
  deleted?: { entries: number; archived: number; locations: number }
}

/** 本面板编辑的全局开关子集（/api/config 的 RUNTIME_KEYS）。 */
interface RuntimeSwitches {
  pendingBadge: boolean
  jumpToPending: boolean
  allAutoApprove: boolean
  todoInject: boolean
  todoCheck: boolean
  groupAutoSave: boolean
}

/** 一行的可编辑草稿（点「保存」才回写 host）。 */
interface Draft {
  /** 内部 id：自建分组可改，保存时触发改名。 */
  id: string
  label: string
  prompt: string
  scope: GroupScope
  klass: GroupKlass
  injectMode: InjectMode
  inject: boolean
  confirm: boolean
  autoApprove: boolean
  enabled: boolean
}

/** 一行的稳定标识（kind + id）。 */
function groupKey(kind: GroupKind, id: string): string {
  return `${kind}:${id}`
}

/** One fetch helper against the node half's API prefix（与 MemoryQueueView 同款）。 */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/memory-evolve${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

/** 从 /api/config 的响应里挑出本面板的开关（缺字段回落出厂默认）。 */
function pickSwitches(config: Partial<RuntimeSwitches>): RuntimeSwitches {
  return {
    pendingBadge: config.pendingBadge !== false,
    jumpToPending: config.jumpToPending === true,
    allAutoApprove: config.allAutoApprove === true,
    todoInject: config.todoInject === true,
    todoCheck: config.todoCheck !== false,
    groupAutoSave: config.groupAutoSave === true,
  }
}

/** 服务端分组 → 行草稿。 */
function draftOf(group: Group): Draft {
  return {
    id: group.id,
    label: group.label ?? '',
    prompt: group.prompt ?? '',
    scope: group.scope,
    klass: group.klass ?? 'global',
    injectMode: group.injectMode ?? 'inherit',
    inject: group.inject,
    confirm: group.confirm,
    autoApprove: group.autoApprove,
    enabled: group.enabled,
  }
}

/**
 * 用最新列表重建草稿表：保留用户正在编辑的行（key 还在的行用旧草稿），
 * 新出现的行（刚新建的分组）用服务端值，删掉的行自然消失。
 */
function buildDrafts(groups: Group[], prev: Record<string, Draft>): Record<string, Draft> {
  const next: Record<string, Draft> = {}
  for (const group of groups) {
    const key = groupKey(group.kind, group.id)
    next[key] = prev[key] ?? draftOf(group)
  }
  return next
}

/** 内置分组的默认名（用户没改过名时显示；与 lib/groups.js 的标签字典对齐）。 */
function defaultLabel(t: Translate, group: Group): string {
  if (group.kind === 'todo') {
    if (group.id === 'session') return t('groupsPanel.label.todo.session')
    if (group.id === 'global') return t('groupsPanel.label.todo.global')
    if (group.id === 'life') return t('groupsPanel.label.todo.life')
    if (group.id === 'work') return t('groupsPanel.label.todo.work')
    if (group.id === 'project') return t('groupsPanel.label.todo.project')
    if (group.id === 'daily') return t('groupsPanel.label.todo.daily')
    return group.id
  }
  if (group.id === 'session') return t('groupsPanel.label.session')
  if (group.id === 'sessionkey') return t('groupsPanel.label.sessionkey')
  if (group.id === 'memory') return t('groupsPanel.label.memory')
  if (group.id === 'user') return t('groupsPanel.label.user')
  if (group.id === 'key') return t('groupsPanel.label.key')
  if (group.id === 'kb') return t('groupsPanel.label.kb')
  if (group.id === 'project') return t('groupsPanel.label.project')
  if (group.id === 'daily') return t('groupsPanel.label.daily')
  return group.id
}

/** 行的展示名（草稿有名字用草稿，否则用默认名）。 */
function displayName(t: Translate, group: Group, draft: Draft | undefined): string {
  const typed = draft?.label.trim() ?? ''
  return typed === '' ? defaultLabel(t, group) : typed
}

/** 类的展示名（会话类 / 项目类 / 全局类）。 */
function klassText(t: Translate, klass: GroupKlass): string {
  if (klass === 'session') return t('groupsPanel.klass.session')
  if (klass === 'project') return t('groupsPanel.klass.project')
  return t('groupsPanel.klass.global')
}

/**
 * 注入下拉值 → 需要提交的字段补丁（三态：不注入 / 普通 / 系统）。
 * 「不注入」= inject:false；另两态 = inject:true + 具体通道。
 */
function injectPatchOf(value: string): Partial<Draft> {
  if (value === 'off') return { inject: false }
  return { inject: true, injectMode: value === 'section' ? 'section' : 'context' }
}

/** Locale-bound props（memory-evolve 命名空间）。 */
export interface GroupsPanelProps {
  t: Translate
}

/** 「Memory Evolve 设置」的「分组」子面板。 */
export function GroupsPanel(props: GroupsPanelProps): JSX.Element {
  const { t } = props
  /** 服务端分组列表（null = 还在加载）。 */
  const [groups, setGroups] = useState<Group[] | null>(null)
  /** groups.json 路径（底部展示）。 */
  const [file, setFile] = useState<string | null>(null)
  /** 记忆根路径（顶部展示；用 memoryDir，不是它下面的 memory/ 分组根）。 */
  const [memoryDir, setMemoryDir] = useState<string | null>(null)
  /** 布局版本（.layout-version，未迁移时为 null）。 */
  const [layoutVersion, setLayoutVersion] = useState<number | null>(null)
  /** 记忆目录的整体布局状态。 */
  const [layout, setLayout] = useState<LayoutStatus | null>(null)
  /** 全局开关草稿。 */
  const [switches, setSwitches] = useState<RuntimeSwitches | null>(null)
  /**
   * 全局注入方式：分组里选了「跟随全局」(inherit) 时，用它把**实际生效**的
   * 通道解析出来，并据此高亮——用户看到的亮项就是真正生效的那一档。
   */
  const [globalInjectMode, setGlobalInjectMode] = useState<'context' | 'section'>('context')
  /** 每行的可编辑草稿（key = `${kind}:${id}`）。 */
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  /** 哪些行展开了提示词输入框。 */
  const [openPrompts, setOpenPrompts] = useState<Record<string, boolean>>({})
  /** 新建行：名称。 */
  const [newName, setNewName] = useState<Record<GroupKind, string>>({ memory: '', todo: '' })
  /** 新建行：类。 */
  const [newKlass, setNewKlass] = useState<Record<GroupKind, GroupKlass>>({ memory: 'global', todo: 'global' })
  /** 新建行：分组 id（可编辑，留空由宿主自动分配）。 */
  const [newId, setNewId] = useState<Record<GroupKind, string>>({ memory: '', todo: '' })
  /** 新建待办分组：日志型（创建时选定，创建后不可改）。 */
  const [newDaily, setNewDaily] = useState(false)
  /** 全局开关保存中。 */
  const [busy, setBusy] = useState(false)
  /** 行内操作中的行 key。 */
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  /** 一次性结果提示（右下角弹窗）；页面内只留常驻的布局告警条。 */
  const notify = useToast(t)

  /** 布局未迁移：所有分组写操作停用（后端也会回 409）。 */
  const blocked = layout?.writesBlocked === true
  /** 停用按钮的悬浮说明。 */
  const lockTitle = blocked ? t('groupsPanel.layout.writesBlocked') : undefined

  const load = (): void => {
    void Promise.all([
      api<GroupsResponse>('/api/groups'),
      api<{ config: Partial<RuntimeSwitches> & { injectMode?: string } }>('/api/config'),
    ]).then(([g, c]) => {
      const list = [...g.memory, ...g.todo]
      setFile(g.file)
      setMemoryDir(g.memoryDir ?? null)
      setLayoutVersion(g.layoutVersion ?? null)
      setLayout(g.layout ?? null)
      setGroups(list)
      setDrafts((prev) => buildDrafts(list, prev))
      setSwitches((prev) => prev ?? pickSwitches(c.config))
      setGlobalInjectMode(c.config.injectMode === 'section' ? 'section' : 'context')
    }).catch((error: Error) => {
      notify('error', t('panel.config.failed', { message: error.message }))
    })
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 用服务端返回的列表刷新视图；`resetKey` 那一行的草稿重置为服务端值
   * （保存后服务端会归一 label/prompt/klass，让界面立刻显示真实值）。
   */
  const applyGroups = (res: GroupsList, resetKey?: string): void => {
    const list = [...res.memory, ...res.todo]
    setGroups(list)
    setDrafts((prev) => {
      const next = buildDrafts(list, prev)
      if (resetKey !== undefined) {
        const saved = list.find((group) => groupKey(group.kind, group.id) === resetKey)
        if (saved !== undefined) next[resetKey] = draftOf(saved)
      }
      return next
    })
  }

  const patchDraft = (key: string, patch: Partial<Draft>): void => {
    setDrafts((prev) => {
      const current = prev[key]
      if (current === undefined) return prev
      return { ...prev, [key]: { ...current, ...patch } }
    })
  }

  const togglePrompt = (key: string): void => {
    setOpenPrompts((prev) => ({ ...prev, [key]: prev[key] !== true }))
  }

  const setName = (kind: GroupKind, value: string): void => {
    setNewName((prev) => (kind === 'memory' ? { ...prev, memory: value } : { ...prev, todo: value }))
  }

  const setId = (kind: GroupKind, value: string): void => {
    setNewId((prev) => (kind === 'memory' ? { ...prev, memory: value } : { ...prev, todo: value }))
  }

  /** 新建行选择的「类」：服务端按 klass 派生 scope（项目类 → project）。 */
  const setKlass = (kind: GroupKind, value: GroupKlass): void => {
    setNewKlass((prev) => (kind === 'memory' ? { ...prev, memory: value } : { ...prev, todo: value }))
  }

  const patchSwitch = (patch: Partial<RuntimeSwitches>): void => {
    setSwitches((prev) => (prev === null ? prev : { ...prev, ...patch }))
  }

  /** 保存全局开关（/api/config，只发本面板的键；配置写接口不受布局门禁影响）。 */
  const saveSwitches = (): void => {
    if (switches === null) return
    setBusy(true)
    void api<{ config: Partial<RuntimeSwitches> }>('/api/config', {
      method: 'POST',
      body: JSON.stringify({ patch: switches }),
    }).then((res) => {
      setSwitches(pickSwitches(res.config))
      // 只广播红点重查事件：本面板改的键没有影响「待办 Tab 是否存在」的
      // todoEnabled，不能发 RUNTIME_CONFIG_CHANGED（缺字段会被当成 true）。
      window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
      notify('ok', t('groupsPanel.switches.saved'))
    }).catch((error: Error) => {
      notify('error', t('panel.config.failed', { message: error.message }))
    }).finally(() => setBusy(false))
  }

  /** 一行草稿 → POST /api/groups 的请求体（内置行不发 scope/klass）。 */
  const bodyOf = (group: Group, draft: Draft): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      kind: group.kind,
      id: group.id,
      label: draft.label,
      inject: draft.inject,
      prompt: draft.prompt,
      enabled: draft.enabled,
      injectMode: draft.injectMode,
    }
    if (!group.builtin) {
      body.scope = draft.scope
      body.klass = draft.klass
    }
    if (group.kind === 'memory') {
      body.confirm = draft.confirm
      body.autoApprove = draft.autoApprove
    }
    return body
  }

  /** 提交一行的草稿到 host。 */
  const submitDraft = (group: Group, draft: Draft): void => {
    const key = groupKey(group.kind, group.id)
    setRowBusy(key)
    void api<GroupsList>('/api/groups', {
      method: 'POST',
      body: JSON.stringify(bodyOf(group, draft)),
    }).then((res) => {
      applyGroups(res, key)
      notify('ok', t('groupsPanel.group.saved', { name: displayName(t, group, draft) }))
    }).catch((error: Error) => {
      notify('error', t('panel.config.failed', { message: error.message }))
    }).finally(() => setRowBusy(null))
  }

  /**
   * 改名 + 保存一趟走完（自建分组）：先 `POST /api/groups/rename`（目录一起
   * rename），成功后用新 id 再 POST 其余字段。改名失败原样显示后端的中文原因
   * （400/404 的 `error`，或 409 的 LAYOUT_NOT_V3 文案）；改名成功而字段没
   * 保存上时仍以改名后的状态刷新，避免界面显示旧 id。
   */
  const renameThenSave = async (group: Group, draft: Draft, newId: string): Promise<void> => {
    const key = groupKey(group.kind, group.id)
    setRowBusy(key)
    try {
      const res = await api<GroupsList>('/api/groups/rename', {
        method: 'POST',
        body: JSON.stringify({ kind: group.kind, id: group.id, newId }),
      })
      const list = [...res.memory, ...res.todo]
      setGroups(list)
      const renamed = list.find((entry) => entry.kind === group.kind && entry.id === newId)
      if (renamed === undefined) throw new Error(t('groupsPanel.rename.lost'))
      const renamedKey = groupKey(renamed.kind, renamed.id)
      setDrafts((prev) => {
        const next = buildDrafts(list, prev)
        delete next[key]
        next[renamedKey] = { ...draft, id: renamed.id }
        return next
      })
      notify('ok', t('groupsPanel.rename.ok', { from: group.id, to: renamed.id }))
      try {
        const saved = await api<GroupsList>('/api/groups', {
          method: 'POST',
          body: JSON.stringify(bodyOf(renamed, { ...draft, id: renamed.id })),
        })
        applyGroups(saved, renamedKey)
      } catch (error) {
        notify('error', t('panel.config.failed', { message: (error as Error).message }))
      }
    } catch (error) {
      notify('error', t('groupsPanel.rename.failed', { message: (error as Error).message }))
    } finally {
      setRowBusy(null)
    }
  }

  /**
   * 「保存」：id 变了先走改名（自建分组），否则直接提交。日志型/内置 id 只读，
   * 因此这里只会对自建分组触发 rename。
   */
  const saveGroup = (group: Group): void => {
    const key = groupKey(group.kind, group.id)
    const draft = drafts[key] ?? draftOf(group)
    if (group.builtin) {
      submitDraft(group, draft)
      return
    }
    const wanted = draft.id.trim().toLowerCase()
    if (wanted === '') {
      notify('error', t('groupsPanel.id.empty'))
      return
    }
    if (wanted === group.id) {
      submitDraft(group, draft)
      return
    }
    void renameThenSave(group, draft, wanted)
  }

  /**
   * 改一个「选择类」字段并**立即提交**（注入与否 / 启用等不需点保存）。
   * 文本类字段（名称、提示词、id）走显式保存。
   */
  const patchNow = (group: Group, patch: Partial<Draft>): void => {
    const key = groupKey(group.kind, group.id)
    const next = { ...(drafts[key] ?? draftOf(group)), ...patch }
    patchDraft(key, patch)
    submitDraft(group, next)
  }

  /** 新建分组（不传 id 时 host 分配 `g` 开头的 id）。 */
  const createGroup = (kind: GroupKind): void => {
    const label = newName[kind].trim()
    if (label === '') return
    setBusy(true)
    const body: Record<string, unknown> = { kind, label, klass: newKlass[kind] }
    const requestedId = newId[kind].trim()
    if (requestedId !== '') body.id = requestedId
    if (kind === 'todo') body.daily = newDaily
    void api<GroupsList>('/api/groups', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((res) => {
      applyGroups(res)
      setName(kind, '')
      setId(kind, '')
      notify('ok', t('groupsPanel.group.created', { name: label }))
    }).catch((error: Error) => {
      notify('error', t('panel.config.failed', { message: error.message }))
    }).finally(() => setBusy(false))
  }

  /**
   * 删除自建分组：先取统计（delete-preview），确认框里报「条目数 / 分布处数 /
   * 归档数」，用户明确确认后才 DELETE（连目录一起删）。
   */
  const removeGroup = async (group: Group): Promise<void> => {
    const key = groupKey(group.kind, group.id)
    const name = displayName(t, group, drafts[key])
    setRowBusy(key)
    try {
      const params = `kind=${encodeURIComponent(group.kind)}&id=${encodeURIComponent(group.id)}`
      const preview = await api<DeletePreview>(`/api/groups/delete-preview?${params}`)
      if (!preview.deletable) {
        notify('error', t('groupsPanel.group.deleteBuiltin'))
        return
      }
      const confirmed = await askConfirm(t('groupsPanel.group.deleteConfirm', {
        name,
        entries: preview.stats.entries,
        locations: preview.stats.locations,
        archived: preview.stats.archived,
      }))
      if (!confirmed) return
      const res = await api<GroupsDeleteResponse>('/api/groups?' + params, { method: 'DELETE' })
      applyGroups(res)
      // 提示报**真实删除结果**（preview 只是确认前的预告，并发增删时两者会不同）。
      const done = res.deleted ?? preview.stats
      notify('ok', t('groupsPanel.group.deleted', {
        name,
        entries: done.entries,
        archived: done.archived,
      }))
    } catch (error) {
      notify('error', t('panel.config.failed', { message: (error as Error).message }))
    } finally {
      setRowBusy(null)
    }
  }

  /**
   * 配置表单里的一行开关（标签 + 说明 + 按钮式开关）。
   * 项目约定：除多选外不用勾选态，状态由按钮颜色承担。
   */
  const switchField = (
    label: string,
    hint: string,
    checked: boolean,
    onChange: (next: boolean) => void,
  ): JSX.Element => (
    <div className="me-field">
      <span className="me-field-label">
        {label}
        <em className="me-field-hint">{hint}</em>
      </span>
      <button
        type="button"
        className={checked ? 'mt-view-btn mt-view-btn-active' : 'mt-view-btn'}
        aria-pressed={checked}
        onClick={() => onChange(!checked)}
      >
        {checked ? t('groupsPanel.on') : t('groupsPanel.off')}
      </button>
    </div>
  )

  /** 行内紧凑开关（分组行里并排的小开关，说明放 title 悬浮提示）。 */
  const chip = (
    label: string,
    title: string,
    checked: boolean,
    onChange: (next: boolean) => void,
    disabled = false,
  ): JSX.Element => (
    <button
      type="button"
      className={checked ? 'mt-view-btn mt-view-btn-active' : 'mt-view-btn'}
      title={disabled ? lockTitle ?? title : title}
      aria-pressed={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      {label}
    </button>
  )

  /** 分组**实际生效**的注入通道：inherit 解析成全局值（按钮据此高亮）。 */
  const effectiveInjectMode = (mode: InjectMode): 'context' | 'section' =>
    mode === 'inherit' ? globalInjectMode : mode

  /** 一行分组：名称 / 类 / 日志徽标 / id / 开关 / 提示词 / 保存 / 删除。 */
  const renderRow = (group: Group): JSX.Element => {
    const key = groupKey(group.kind, group.id)
    const draft = drafts[key] ?? draftOf(group)
    /** 自动保存是**全局统一开关**：打开后本行保存按钮都变灰。 */
    const autoSaveOn = switches?.groupAutoSave === true
    const rowLocked = rowBusy === key
    return (
      <div className="me-item" key={key}>
        <div className="me-item-head">
          <input
            type="text"
            className="me-todo-input me-group-name"
            value={draft.label}
            placeholder={defaultLabel(t, group)}
            title={t('groupsPanel.group.label.hint')}
            disabled={blocked}
            onChange={(event) => patchDraft(key, { label: event.target.value })}
            onBlur={() => { if (autoSaveOn && !blocked) saveGroup(group) }}
          />
          {/* 元数据区：类 / 日志 / 内置 / #id 固定在这一行最右并保持一行，
              左侧的名称框是可被挤压的那一方。 */}
          <span className="me-group-meta">
            {group.builtin ? (
              <span className="me-badge" title={t('groupsPanel.klass.fixed')}>{klassText(t, draft.klass)}</span>
            ) : (
              <select
                className="me-todo-select"
                value={draft.klass}
                title={t('groupsPanel.klass')}
                disabled={blocked || rowLocked}
                onChange={(event) => patchNow(group, { klass: event.target.value as GroupKlass })}
              >
                <option value="session">{t('groupsPanel.klass.session')}</option>
                <option value="project">{t('groupsPanel.klass.project')}</option>
                <option value="global">{t('groupsPanel.klass.global')}</option>
              </select>
            )}
            {/* 日志型只给徽标：daily 创建后不可改，行里没有任何切换控件。 */}
            {group.daily && (
              <span className="me-badge" title={t('groupsPanel.group.daily.fixed')}>
                {t('groupsPanel.group.daily.badge')}
              </span>
            )}
            {group.builtin && (
              <span className="me-badge" title={t('groupsPanel.builtin.hint')}>{t('groupsPanel.builtin')}</span>
            )}
            {group.builtin ? (
              <span className="me-muted" title={t('groupsPanel.id.hint')}>#{group.id}</span>
            ) : (
              <span className="me-group-id-edit" title={t('groupsPanel.id.editHint')}>
                <span className="me-group-id-hash">#</span>
                <input
                  type="text"
                  className="me-todo-input me-group-id"
                  value={draft.id}
                  placeholder={group.id}
                  disabled={blocked || rowLocked}
                  onChange={(event) => patchDraft(key, { id: event.target.value })}
                  onKeyDown={(event) => { if (event.key === 'Enter' && !blocked) saveGroup(group) }}
                />
              </span>
            )}
          </span>
        </div>
        {/* 一行到底：开关 / 注入 / 提示词 / 保存 / 删除 全部锁在同一行、可换行，
            字号与按钮高度统一（见 .me-group-row）。 */}
        <div className="me-group-row">
          {group.kind === 'memory' && (
            /* 写入确认：合成一个二选下拉，判定与宿主的 needsConfirmation() 一致
               （autoApprove 优先，否则看 confirm）。 */
            <label className="me-todo-filter" title={t('groupsPanel.group.confirm.hintPick')}>
              <select
                className="me-todo-select"
                value={draft.autoApprove === true || draft.confirm !== true ? 'auto' : 'need'}
                disabled={blocked || rowLocked}
                onChange={(event) => patchNow(group, {
                  confirm: event.target.value === 'need',
                  autoApprove: event.target.value === 'auto',
                })}
              >
                <option value="need">{t('groupsPanel.group.confirm.need')}</option>
                <option value="auto">{t('groupsPanel.group.confirm.auto')}</option>
              </select>
            </label>
          )}
          {chip(
            t('groupsPanel.group.enabled'),
            t('groupsPanel.group.enabled.hint'),
            draft.enabled,
            (next) => patchNow(group, { enabled: next }),
            blocked || rowLocked,
          )}
          <select
            className="me-todo-select"
            title={t('groupsPanel.group.injectMode.hint')}
            value={draft.inject ? effectiveInjectMode(draft.injectMode) : 'off'}
            disabled={blocked || rowLocked}
            onChange={(event) => patchNow(group, injectPatchOf(event.target.value))}
          >
            <option value="off">{t('groupsPanel.group.injectMode.off')}</option>
            <option value="context">{t('groupsPanel.group.injectMode.context')}</option>
            <option value="section">{t('groupsPanel.group.injectMode.section')}</option>
          </select>
          <button
            type="button"
            className="me-btn me-btn-archive"
            onClick={() => togglePrompt(key)}
          >
            {t('groupsPanel.prompt')}
          </button>
          <button
            type="button"
            className="me-btn me-btn-primary"
            title={lockTitle}
            disabled={rowLocked || autoSaveOn || blocked}
            onClick={() => saveGroup(group)}
          >
            {t('groupsPanel.group.save')}
          </button>
          {!group.builtin && (
            <button
              type="button"
              className="me-btn me-btn-danger"
              title={lockTitle}
              disabled={rowLocked || blocked}
              onClick={() => void removeGroup(group)}
            >
              {t('groupsPanel.group.delete')}
            </button>
          )}
        </div>
        {openPrompts[key] === true && (
          <>
            <textarea
              className="me-item-edit"
              style={{ minHeight: 64 }}
              value={draft.prompt}
              placeholder={t('groupsPanel.prompt.placeholder')}
              title={lockTitle}
              disabled={blocked}
              onChange={(event) => patchDraft(key, { prompt: event.target.value })}
              onBlur={() => { if (autoSaveOn && !blocked) saveGroup(group) }}
            />
            <div className="me-item-actions">
              <button
                type="button"
                className="me-btn me-btn-primary"
                title={lockTitle}
                disabled={rowLocked || autoSaveOn || blocked}
                onClick={() => saveGroup(group)}
              >
                {t('groupsPanel.prompt.save')}
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  /** 一个分区的完整渲染（记忆 / 待办结构相同）。 */
  const renderKind = (kind: GroupKind): JSX.Element => {
    const rows = (groups ?? []).filter((group) => group.kind === kind)
    const isMemory = kind === 'memory'
    return (
      <section className="me-block" key={kind}>
        <div className="me-block-head">
          <h3 className="me-heading">
            {isMemory ? t('groupsPanel.memory.title') : t('groupsPanel.todo.title')}
          </h3>
        </div>
        <div className="me-todo-add">
          <input
            type="text"
            className="me-todo-input"
            value={newName[kind]}
            placeholder={t('groupsPanel.new.placeholder')}
            title={lockTitle}
            disabled={blocked}
            onChange={(event) => setName(kind, event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') createGroup(kind) }}
          />
          <input
            type="text"
            className="me-todo-input me-group-new-id"
            value={newId[kind]}
            placeholder={t('groupsPanel.new.idPlaceholder')}
            title={t('groupsPanel.new.idHint')}
            disabled={blocked}
            onChange={(event) => setId(kind, event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') createGroup(kind) }}
          />
          <select
            className="me-todo-select"
            value={newKlass[kind]}
            title={t('groupsPanel.klass')}
            disabled={blocked}
            onChange={(event) => setKlass(kind, event.target.value as GroupKlass)}
          >
            <option value="session">{t('groupsPanel.klass.session')}</option>
            <option value="project">{t('groupsPanel.klass.project')}</option>
            <option value="global">{t('groupsPanel.klass.global')}</option>
          </select>
          {/* 日志型只能在**创建时**选定（创建后不可改），因此这一档留在新建行。 */}
          {!isMemory && (
            <button
              type="button"
              className={newDaily ? 'mt-view-btn mt-view-btn-active' : 'mt-view-btn'}
              title={t('groupsPanel.group.daily.fixed')}
              aria-pressed={newDaily}
              disabled={blocked}
              onClick={() => setNewDaily(!newDaily)}
            >
              {t('groupsPanel.group.daily.badge')}
            </button>
          )}
          <button
            type="button"
            className="me-btn me-btn-ok"
            title={lockTitle}
            disabled={busy || blocked || newName[kind].trim() === ''}
            onClick={() => createGroup(kind)}
          >
            {t('groupsPanel.new.create')}
          </button>
        </div>
        <p className="me-muted">{t('groupsPanel.new.hint')}</p>
        {groups === null ? (
          <p className="me-muted">{t('panel.loading')}</p>
        ) : (
          <div className="me-list me-list-groups">
            {rows.map((group) => renderRow(group))}
          </div>
        )}
      </section>
    )
  }

  /** 顶部状态：记忆根路径 + 布局版本；非 v3 时醒目提示（写操作是否停用看后端）。 */
  const renderLayout = (): JSX.Element => (
    <section className="me-block me-layout-bar">
      <div className="me-block-head">
        <h3 className="me-heading">{t('groupsPanel.layout.title')}</h3>
        <span className="me-badge">{t('groupsPanel.layout.version', { version: layoutVersion ?? '—' })}</span>
        {blocked && <span className="me-badge me-badge-warn">{t('groupsPanel.layout.readonly')}</span>}
      </div>
      <p className="me-muted" title={memoryDir ?? ''}>
        {t('groupsPanel.layout.root')}: {memoryDir ?? t('groupsPanel.layout.unknownRoot')}
      </p>
      {layout !== null && layout.state !== 'v3' && (
        <div className="me-notice me-notice-warn">
          {blocked
            ? t('groupsPanel.layout.needsMigration', { version: layoutVersion ?? '—' })
            : t('groupsPanel.layout.unmarked')}
        </div>
      )}
    </section>
  )

  return (
    <div className="me-panel">
      {/* —— 顶部：记忆根 + 布局版本 —— */}
      {renderLayout()}

      {/* —— 全局开关（/api/config）—— */}
      <section className="me-block">
        <div className="me-block-head">
          <h3 className="me-heading">{t('groupsPanel.switches.title')}</h3>
        </div>
        <p className="me-help">{t('groupsPanel.switches.help')}</p>
        {switches === null ? (
          <p className="me-muted">{t('panel.loading')}</p>
        ) : (
          <div className="me-form">
            <div className="me-group">
              {switchField(
                t('groupsPanel.switch.pendingBadge'),
                t('groupsPanel.switch.pendingBadge.hint'),
                switches.pendingBadge,
                (next) => patchSwitch({ pendingBadge: next }),
              )}
              {switchField(
                t('groupsPanel.switch.jumpToPending'),
                t('groupsPanel.switch.jumpToPending.hint'),
                switches.jumpToPending,
                (next) => patchSwitch({ jumpToPending: next }),
              )}
              {switchField(
                t('groupsPanel.switch.allAutoApprove'),
                t('groupsPanel.switch.allAutoApprove.hint'),
                switches.allAutoApprove,
                (next) => patchSwitch({ allAutoApprove: next }),
              )}
              {switchField(
                t('groupsPanel.switch.todoInject'),
                t('groupsPanel.switch.todoInject.hint'),
                switches.todoInject,
                (next) => patchSwitch({ todoInject: next }),
              )}
              {switchField(
                t('groupsPanel.switch.todoCheck'),
                t('groupsPanel.switch.todoCheck.hint'),
                switches.todoCheck,
                (next) => patchSwitch({ todoCheck: next }),
              )}
              {switchField(
                t('groupsPanel.switch.groupAutoSave'),
                t('groupsPanel.switch.groupAutoSave.hint'),
                switches.groupAutoSave,
                (next) => patchSwitch({ groupAutoSave: next }),
              )}
            </div>
            <div className="me-actions">
              <button type="button" className="me-btn me-btn-primary" disabled={busy} onClick={saveSwitches}>
                {t('groupsPanel.switches.save')}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* —— 记忆分组 / 待办分组 —— */}
      {renderKind('memory')}
      {renderKind('todo')}

      {file !== null && (
        <p className="me-muted" title={file}>{t('groupsPanel.file')}: {file}</p>
      )}
    </div>
  )
}
