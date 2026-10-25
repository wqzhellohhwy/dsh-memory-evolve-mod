/**
 * dsh-memory-evolve — 配置页「工具」二级页。
 *
 * 布局（2026-10-17 用户拍板）：
 *   - 顶部一行提示：**改动先暂存，点工具右上角的「保存」才生效**；
 *   - **一行一个**工具（单列）；
 *   - 卡片头：工具名（左）+ `#id` + 右侧「查看内置 / 恢复默认 / 保存」；
 *   - 卡片体：启用（按钮式）+ 描述；
 *   - **工具定义块**：包在工具卡片内，两列排布，可整体折叠；每块可勾启用、
 *     可写文案、可「恢复默认」（清空覆盖）。块的启停与文案**只暂存在本地**，
 *     随卡片「保存」一次性提交 —— 避免改一下就立刻换掉模型看到的定义。
 *   - 「新建工具」模块已按用户要求**整体删除**（实测没用）。
 *
 * 数据面在 `/memory-evolve/api/tools`（读写 `<memoryDir>/tools.json` 与运行时配置）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { askConfirm } from './ask-confirm.ts'
import { useSyncedBoxHeights, useNarrowLayout } from './use-synced-box-height.ts'

interface ToolParam {
  key: string
  description: string
  defaultDescription: string
}

interface BuiltinTool {
  id: string
  name: string
  defaultName: string
  /** 「通用定义」（描述框编辑的这一层，不含分块内容）。 */
  description: string
  defaultDescription: string
  /** 当前完整注册给模型的定义（通用定义 + 分组段 + 各启用块），只读展示。 */
  merged?: string
  enabled: boolean
  params: ToolParam[]
}

interface CustomTool {
  id: string
  name: string
  description: string
  action: { kind: string; fixed: Record<string, unknown> }
}

/** 一个工具定义块（含出厂文案与用户覆盖）。 */
interface ToolBlock {
  tool: string
  id: string
  label: string
  defaultText: string
  text: string
}

interface ToolCatalog {
  file: string
  actions: Array<{ kind: string; label: string }>
  builtin: BuiltinTool[]
  custom: CustomTool[]
  /** 工具定义联动：开着时改名/停用才真正作用到模型侧工具面。 */
  toolDefsLive?: boolean
  blocks?: {
    definitions: ToolBlock[]
    enabled: Record<string, boolean>
    texts?: Record<string, string>
  }
}

/** 一行草稿：改完点该卡片的「保存」才提交。 */
interface Draft {
  name: string
  description: string
  params: Record<string, string>
}

/** 一个块的草稿（同样是暂存）。 */
interface BlockDraft {
  enabled: boolean
  /** 框里的文字 = 生效文案（没覆盖时就是默认原文，与默认相同即视为无覆盖）。 */
  text: string
}

/** 工具页接口前缀（统一出口：漏前缀会让请求 404 并静默失败）。 */
const TOOL_API = '/memory-evolve/api/tools'

/** 块输入框默认高度 = 2 行文字（字号 11px、行高 1.6 → 17.6px/行）+ 内边距 8×2 + 边框 1×2。 */
const BLOCK_BOX_H = 54

/** 工具描述框默认高度 = 7 行文字（字号 12px、行高 1.6 → 19.2px/行）+ 内边距 8×2 + 边框 1×2。 */
const DESC_BOX_H = 153

/** 文本框高度的记忆键（localStorage，浏览器本地，按实例各自记）。 */
const HEIGHT_KEY = 'dsh-memory-evolve:tools-heights'

/** 框里的文字 → 提交值：与默认原文一致就交空串（后端据此删掉覆盖）。 */
function blockTextPayload(text: string, block: ToolBlock): string {
  return text.trim() === block.defaultText.trim() ? '' : text
}

/**
 * 统一请求帮手：自动带前缀、自动 JSON、非 2xx 抛错（文案交给调用方显示）。
 * @param path - 相对路径（'' 或 '/reset' 或 '?id=…'）。
 * @param init - fetch 初始化。
 * @returns 解析后的 JSON。
 */
async function toolRequest<T>(path = '', init?: RequestInit): Promise<T> {
  const res = await fetch(`${TOOL_API}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
  if (!res.ok) throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`)
  return data as T
}

/** 配置页「工具」页。 */
export function ToolsPanel(props: { t: Translate }): JSX.Element {
  const { t } = props
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, Draft>>({})
  /** 块草稿：key = `<工具>.<块id>`（暂存，随卡片保存提交）。 */
  const [blockDraft, setBlockDraft] = useState<Record<string, BlockDraft>>({})
  /** 块区是否展开（全局一键折叠）。 */
  const [blocksOpen, setBlocksOpen] = useState(true)
  /** 文本框高度：块框按**行**分槽（同一行的两个一起变，不是全部块连带，下限 BLOCK_BOX_H），
      描述框按工具分槽（下限 DESC_BOX_H）；值记在 localStorage 里，刷新后保持。 */
  const { heightOf, startResize } = useSyncedBoxHeights(BLOCK_BOX_H, HEIGHT_KEY)
  /** 窄屏（块网格一列）下每块独立调高度，不按行配对。 */
  const narrowLayout = useNarrowLayout()
  const [showDefault, setShowDefault] = useState<Record<string, boolean>>({})
  /** 每个工具是否展开「当前完整定义」（合并后的只读文本）。 */
  const [showMerged, setShowMerged] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void toolRequest<ToolCatalog>()
      .then((data) => {
        setCatalog(data)
        const next: Record<string, Draft> = {}
        for (const tool of data.builtin ?? []) {
          next[tool.id] = {
            name: tool.name,
            description: tool.description,
            params: Object.fromEntries((tool.params ?? []).map((p) => [p.key, p.description])),
          }
        }
        setDraft(next)
        const nextBlocks: Record<string, BlockDraft> = {}
        for (const block of data.blocks?.definitions ?? []) {
          const key = `${block.tool}.${block.id}`
          nextBlocks[key] = {
            enabled: data.blocks?.enabled?.[key] !== false,
            // 框里直接放**生效文案**（没写过覆盖就是默认原文）——不是灰字占位符。
            text: data.blocks?.texts?.[key] ?? block.defaultText,
          }
        }
        setBlockDraft(nextBlocks)
      })
      .catch((error: Error) => { setError(error.message || String(t('settingsTab.tools.loadFailed'))) })
  }, [t])

  useEffect(() => { load() }, [load])

  /**
   * 保存一个工具：工具定义覆盖 + **该工具**的块启停与块文案，一次提交。
   * @param tool - 该工具。
   * @param blocks - 该工具的块草稿（key = `<工具>.<块id>`）。
   */
  const post = useCallback((body: unknown, then?: () => void) => {
    setBusy(true)
    setError(null)
    void toolRequest<{ ok?: boolean; message?: string }>('', { method: 'POST', body: JSON.stringify(body) })
      .then((data) => {
        if (data.ok === false) setError(data.message ?? String(t('settingsTab.tools.saveFailed')))
        else { then?.(); load() }
      })
      .catch((error: Error) => { setError(error.message || String(t('settingsTab.tools.saveFailed'))) })
      .finally(() => { setBusy(false) })
  }, [load, t])

  const patchDraft = useCallback((id: string, patch: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { name: '', description: '', params: {} }), ...patch } }))
  }, [])

  const patchBlock = useCallback((key: string, patch: Partial<BlockDraft>) => {
    setBlockDraft((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { enabled: true, text: '' }), ...patch } }))
  }, [])

  /**
   * 保存**单个块**（2026-10-17 用户：块要有自己的保存按钮，位置在「恢复默认」左侧）。
   * 只提交这一个块的启停与文案，不带工具 id —— 后端走"只改块"分支。
   */
  const saveBlock = useCallback((key: string, block: ToolBlock) => {
    const state = blockDraft[key]
    if (state === undefined) return
    post({ blocks: { [key]: state.enabled }, blockTexts: { [key]: blockTextPayload(state.text, block) } })
  }, [blockDraft, post])

  const saveBuiltin = useCallback((tool: BuiltinTool) => {
    const current = draft[tool.id]
    if (current === undefined) return
    const patch: Record<string, unknown> = {
      // 与默认值一致就清掉覆盖（null = 删除该项覆盖），配置文件保持干净
      name: current.name.trim() === tool.defaultName ? null : current.name,
      description: current.description.trim() === tool.defaultDescription ? null : current.description,
    }
    if (tool.params.length > 0) {
      patch.params = Object.fromEntries(tool.params.map((param) => [
        param.key,
        current.params[param.key] === param.defaultDescription ? null : (current.params[param.key] ?? ''),
      ]))
    }
    const prefix = `${tool.id}.`
    const blocks: Record<string, boolean> = {}
    const blockTexts: Record<string, string> = {}
    for (const block of catalog?.blocks?.definitions ?? []) {
      const key = `${block.tool}.${block.id}`
      if (!key.startsWith(prefix)) continue
      const value = blockDraft[key]
      if (value === undefined) continue
      blocks[key] = value.enabled
      blockTexts[key] = blockTextPayload(value.text, block)
    }
    post({
      id: tool.id,
      patch,
      ...(Object.keys(blocks).length > 0 ? { blocks, blockTexts } : {}),
    })
  }, [draft, blockDraft, catalog, post])

  const toggleEnabled = useCallback((tool: BuiltinTool, enabled: boolean) => {
    post({ id: tool.id, patch: { enabled } })
  }, [post])

  /** 工具定义联动开关（2026-10-19）：开启后改名/停用才作用于模型侧工具面。
      默认关 —— 改工具面会让老会话的 KV 缓存失效，必须用户显式打开。 */
  const toggleLiveDefs = useCallback(() => {
    setBusy(true)
    setError(null)
    void fetch('/memory-evolve/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { toolDefsLive: catalog?.toolDefsLive !== true } }),
    })
      .then(async (res) => {
        if (!res.ok) {
          // 取服务端原因（撞名/格式不合格），别只丢一个 HTTP 500 给用户。
          const body = await res.json().catch(() => ({} as { error?: string }))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        load()
      })
      .catch((error: Error) => { setError(error.message || String(t('settingsTab.tools.saveFailed'))) })
      .finally(() => { setBusy(false) })
  }, [catalog, load, t])

  const removeCustom = useCallback((id: string) => {
    setBusy(true)
    void toolRequest(`?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then(() => load())
      .catch((error: Error) => { setError(error.message || String(t('settingsTab.tools.saveFailed'))) })
      .finally(() => { setBusy(false) })
  }, [load, t])

  /** 只恢复一个工具的出厂定义（scope = 该工具 id），不动别的工具。 */
  const resetOne = useCallback((tool: BuiltinTool) => {
    setBusy(true)
    setError(null)
    void toolRequest<{ ok?: boolean }>('/reset', {
      method: 'POST',
      body: JSON.stringify({ scope: tool.id }),
    })
      .then((data) => {
        if (data.ok === false) setError(String(t('settingsTab.tools.resetFailed')))
        else load()
      })
      .catch((error: Error) => { setError(error.message || String(t('settingsTab.tools.resetFailed'))) })
      .finally(() => { setBusy(false) })
  }, [load, t])

  // 全局恢复默认（破坏性，二次确认）：确认文案逐条说清将丢弃什么。
  const resetAll = useCallback(async (): Promise<void> => {
    const overridden = (catalog?.builtin ?? []).filter((tool) => tool.enabled === false
      || tool.name !== tool.defaultName
      || tool.description !== tool.defaultDescription
      || (tool.params ?? []).some((param) => param.description !== param.defaultDescription))
    const customs = catalog?.custom ?? []
    const parts: string[] = []
    if (overridden.length > 0) {
      parts.push(String(t('settingsTab.tools.resetOverrides', {
        n: String(overridden.length),
        names: overridden.map((tool) => tool.name).join('、'),
      })))
    }
    if (customs.length > 0) {
      parts.push(String(t('settingsTab.tools.resetCustoms', {
        n: String(customs.length),
        names: customs.map((tool) => tool.name).join('、'),
      })))
    }
    const message = parts.length === 0
      ? String(t('settingsTab.tools.resetConfirmEmpty'))
      : String(t('settingsTab.tools.resetConfirm', { detail: parts.join('\n') }))
    if (!(await askConfirm(message, {
      okText: String(t('settingsTab.tools.reset')),
      cancelText: String(t('settingsTab.tools.cancel')),
    }))) return
    setBusy(true)
    setError(null)
    try {
      const data = await toolRequest<{ ok?: boolean; cleared?: unknown[]; removedCustom?: unknown[] }>('/reset', {
        method: 'POST',
        body: JSON.stringify({ scope: 'all' }),
      })
      if (data.ok === false) {
        setError(String(t('settingsTab.tools.resetFailed')))
        return
      }
      load()
    } catch (error) {
      setError(`${String(t('settingsTab.tools.resetFailed'))}：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [catalog, load, t])

  /** 工具 id → 绑定动作的显示名。 */
  const actionLabelOf = (kind: string): string =>
    (catalog?.actions ?? []).find((action) => action.kind === kind)?.label ?? kind

  if (catalog === null) {
    return (
      <div className="me-block">
        {error !== null ? <p className="me-error">{error}</p> : <div className="me-hint">{t('settingsTab.configLoading')}</div>}
      </div>
    )
  }

  return (
    <div className="me-block">
      {error !== null && <p className="me-error">{error}</p>}
      {/* 顶部一行锁定说明（用户 2026-10-17）：所有改动都先暂存。 */}
      <p className="me-hint">{t('settingsTab.tools.lockHint')}</p>

      {/* 工具定义联动（2026-10-19）：默认关 —— 改名/停用会改工具面、让老会话掉缓存。 */}
      <div className="me-field">
        <span className="me-field-label">
          {t('settingsTab.tools.liveDefs')}
          <em className="me-field-hint">{t('settingsTab.tools.liveDefsHint')}</em>
        </span>
        <button
          type="button"
          className={catalog.toolDefsLive === true ? 'mt-view-btn mt-view-btn-active' : 'mt-view-btn'}
          disabled={busy}
          aria-pressed={catalog.toolDefsLive === true}
          onClick={toggleLiveDefs}
        >
          {catalog.toolDefsLive === true ? t('settingsTab.tools.liveDefsOn') : t('settingsTab.tools.liveDefsOff')}
        </button>
      </div>

      <div className="me-tools-grid">
        {catalog.builtin.map((tool) => {
          const current = draft[tool.id] ?? { name: tool.name, description: tool.description, params: {} }
          const toolBlocks = (catalog.blocks?.definitions ?? []).filter((block) => block.tool === tool.id)
          return (
            <div className="me-tool-card" key={tool.id}>
              <div className="me-tool-head">
                <input
                  type="text"
                  className="me-todo-input me-tool-name"
                  value={current.name}
                  disabled={busy}
                  onChange={(event) => patchDraft(tool.id, { name: event.target.value })}
                />
                <span className="me-muted me-tool-id">#{tool.id}</span>
                <span className="me-tool-actions">
                  <button
                    type="button"
                    className="me-btn me-btn-archive"
                    disabled={busy}
                    onClick={() => setShowMerged((prev) => ({ ...prev, [tool.id]: prev[tool.id] !== true }))}
                  >
                    {showMerged[tool.id] === true
                      ? t('settingsTab.tools.hideMerged')
                      : t('settingsTab.tools.showMerged')}
                  </button>
                  <button
                    type="button"
                    className="me-btn me-btn-archive"
                    disabled={busy}
                    onClick={() => setShowDefault((prev) => ({ ...prev, [tool.id]: prev[tool.id] !== true }))}
                  >
                    {showDefault[tool.id] === true
                      ? t('settingsTab.tools.hideDefault')
                      : t('settingsTab.tools.viewDefault')}
                  </button>
                  <button type="button" className="me-btn me-btn-archive" disabled={busy} onClick={() => resetOne(tool)}>
                    {t('settingsTab.tools.reset')}
                  </button>
                  <button type="button" className="me-btn me-btn-primary" disabled={busy} onClick={() => saveBuiltin(tool)}>
                    {t('settingsTab.tools.save')}
                  </button>
                </span>
              </div>
              <div className="me-tool-row">
                <button
                  type="button"
                  className={tool.enabled ? 'mt-view-btn mt-view-btn-active' : 'mt-view-btn'}
                  disabled={busy}
                  aria-pressed={tool.enabled}
                  onClick={() => toggleEnabled(tool, !tool.enabled)}
                >
                  {t('settingsTab.tools.enabled')}
                </button>
              </div>
              {/* 工具描述框：默认可清空（= 显式置空，模型侧看到空描述）。
                  不加 placeholder —— 否则清空后框里还显示灰字，看不出已置空。 */}
              <div className="me-desc-wrap">
                <textarea
                  className="me-item-edit me-tool-desc-text"
                  style={{ height: `${heightOf(`desc:${tool.id}`, DESC_BOX_H)}px` }}
                  value={current.description}
                  disabled={busy}
                  onChange={(event) => patchDraft(tool.id, { description: event.target.value })}
                />
                <span
                  className="me-resize-handle"
                  role="separator"
                  aria-label={String(t('settingsTab.tools.resizeHint'))}
                  onPointerDown={(event) => startResize(`desc:${tool.id}`, event, DESC_BOX_H)}
                />
              </div>
              {/* 工具定义块：包在该工具卡片内，两列；整块可一键折叠。 */}
              {toolBlocks.length > 0 && (
                <div className="me-tool-blocks">
                  <div className="me-tool-blocks-head">
                    <button
                      type="button"
                      className="me-tool-blocks-toggle"
                      onClick={() => setBlocksOpen((open) => !open)}
                    >
                      {blocksOpen ? '▾' : '▸'} {t('settingsTab.tools.blocks')}（{toolBlocks.length}）
                    </button>
                  </div>
                  {blocksOpen && (
                    <div className="me-tool-blocks-grid">
                      {toolBlocks.map((block, index) => {
                        const key = `${tool.id}.${block.id}`
                        const blockState = blockDraft[key] ?? { enabled: true, text: '' }
                        // 宽屏两列：同一行的两个块共用一个槽（index/2）；窄屏一列：每块各自一个槽。
                        const slot = narrowLayout ? `block:${key}` : `block:${tool.id}.row${Math.floor(index / 2)}`
                        return (
                          <div className="me-tool-block" key={key}>
                            <div className="me-tool-block-head">
                              <label className="me-tool-block-check">
                                <input
                                  type="checkbox"
                                  checked={blockState.enabled}
                                  disabled={busy}
                                  onChange={(event) => patchBlock(key, { enabled: event.target.checked })}
                                />
                                <span title={block.id}>{block.label}</span>
                              </label>
                              <button
                                type="button"
                                className="me-btn me-btn-primary"
                                disabled={busy}
                                title={t('settingsTab.tools.blockSaveHint')}
                                onClick={() => saveBlock(key, block)}
                              >
                                {t('settingsTab.tools.save')}
                              </button>
                              <button
                                type="button"
                                className="me-btn me-btn-archive"
                                disabled={busy || blockState.text === block.defaultText}
                                title={t('settingsTab.tools.blockResetHint')}
                                onClick={() => patchBlock(key, { text: block.defaultText })}
                              >
                                {t('settingsTab.tools.reset')}
                              </button>
                            </div>
                            {/* 框里就是**生效原文**（没有灰字占位符）；高度与**同一行**的另一个块联动。
                                原生斜拉条已关掉（会和受控高度打架），改用自绘手柄。 */}
                            <textarea
                              className="me-item-edit me-tool-block-text"
                              style={{ height: `${heightOf(slot)}px` }}
                              value={blockState.text}
                              disabled={busy}
                              onChange={(event) => patchBlock(key, { text: event.target.value })}
                            />
                            <span
                              className="me-resize-handle"
                              role="separator"
                              aria-label={String(t('settingsTab.tools.resizeHint'))}
                              onPointerDown={(event) => startResize(slot, event)}
                            />
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
              {showMerged[tool.id] === true && (
                <pre className="me-tool-merged">{tool.merged ?? tool.description}</pre>
              )}
              {showDefault[tool.id] === true && (
                <div className="me-tool-default">
                  <div className="me-tool-default-row">
                    <span className="me-tool-default-label">{t('settingsTab.tools.defaultName')}</span>
                    <span>{tool.defaultName}</span>
                  </div>
                  <div className="me-tool-default-row">
                    <span className="me-tool-default-label">{t('settingsTab.tools.defaultDesc')}</span>
                    <span>{tool.defaultDescription === '' ? '—' : tool.defaultDescription}</span>
                  </div>
                  {tool.params.length > 0 && (
                    <div className="me-tool-default-row">
                      <span className="me-tool-default-label">{t('settingsTab.tools.defaultParams')}</span>
                      <ul className="me-tool-default-params">
                        {tool.params.map((param) => (
                          <li key={param.key}>
                            <span className="me-tool-param-key">{param.key}</span>
                            {param.defaultDescription === '' ? '—' : param.defaultDescription}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* 自建工具：同款卡片，可删除（「新建工具」已按用户要求整体删除）。 */}
      {catalog.custom.length > 0 && (
        <>
          <p className="me-field-sub">{t('settingsTab.tools.customTitle')}</p>
          <div className="me-tools-grid">
            {catalog.custom.map((tool) => (
              <div className="me-tool-card" key={tool.id}>
                <div className="me-tool-head">
                  <span className="me-tool-custom-name">{tool.name}</span>
                  <span className="me-muted me-tool-id">#{tool.id}</span>
                  <span className="me-tool-actions">
                    <span className="me-badge">{actionLabelOf(tool.action.kind)}</span>
                    <button
                      type="button"
                      className="me-btn me-btn-danger"
                      disabled={busy}
                      onClick={() => removeCustom(tool.id)}
                    >
                      {t('settingsTab.tools.remove')}
                    </button>
                  </span>
                </div>
                {tool.description !== '' && <p className="me-tool-custom-desc">{tool.description}</p>}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="me-field" style={{ marginTop: '16px', borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: '10px' }}>
        <span className="me-field-label">{t('settingsTab.tools.resetAll')}</span>
        <button type="button" className="me-btn me-btn-danger" disabled={busy} onClick={() => { void resetAll() }}>
          {t('settingsTab.tools.reset')}
        </button>
      </div>
      <p className="me-hint">{t('settingsTab.tools.resetHint')}</p>
      <p className="me-hint" style={{ wordBreak: 'break-all' }}>{catalog.file}</p>
    </div>
  )
}
