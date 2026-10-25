/**
 * SnapshotPromptPanel — 「开局提示词」设置面板（2026-10-14 用户需求）。
 *
 * 记忆插件每轮会给模型注入一段**固定指导文案**（工具说明 + 收尾职责清单），
 * 以前写死在插件里、用户看不见也改不了。这个面板把它**显示出来**并允许改写：
 *   - 上方只读预览：内置渲染结果（当前配置下真实会长什么样）；
 *   - 下方编辑框：写自己的版本 → 保存后整段替换内置文案（空 = 恢复内置）；
 *   - 支持占位符 {branch} {memoryTool} {todoTool} {targets} {reviewInterval} {sessionId}。
 *
 * 读接口：GET /memory-evolve/api/snapshot-prompt
 * 写接口：POST /memory-evolve/api/snapshot-prompt { text }
 *
 * 储备文案（2026-10-19 用户改版）：没有「启用/禁用」，每份只有一个
 * 「复制到文案」按钮——把内容填进上方编辑框（**不落盘**），再点保存才生效；
 * 编辑框当前的文字可一键「保存为储备文案」（名字留空 = 未命名，之后再改）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncedBoxHeights } from './use-synced-box-height.ts'
import { askConfirm } from './ask-confirm.ts'
import { useToast } from './Toast.tsx'
import { InlineError } from './InlineError.tsx'

/** 后端返回的形状。 */
interface SnapshotPromptResponse {
  /** 内置渲染结果（只读预览）。 */
  default: string
  /** 用户当前保存的自定义文本（空 = 用内置）。 */
  custom: string
  /** 实际生效的文本。 */
  effective: string
  /** 可用占位符列表。 */
  vars: string[]
  /** 注入方式：context = 运行时上下文快照；section = 系统提示词段。 */
  injectMode: 'context' | 'section'
  /** 内置文案是否启用（关掉后只注入自定义文案 / 分组内容）。 */
  builtinGuidance: boolean
  /** 储备文案列表（2026-10-19 用户需求）。 */
  presets?: PresetItem[]
}

/** 一份储备文案。 */
interface PresetItem {
  id: string
  name: string
  text: string
}

/** Locale-bound props（memory-evolve 命名空间）。 */
export interface SnapshotPromptPanelProps {
  t: Translate
}

const API = '/memory-evolve/api/snapshot-prompt'

/** 统一 fetch 封装：错误取 { error } 信封。 */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: string }))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function SnapshotPromptPanel(props: SnapshotPromptPanelProps): JSX.Element {
  const { t } = props
  const [data, setData] = useState<SnapshotPromptResponse | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  /** 注入方式（2026-10-14）：context = 快照；section = 系统提示词段。 */
  const [injectMode, setInjectMode] = useState<'context' | 'section'>('context')
  /** 内置文案开关（2026-10-14）。 */
  const [builtinGuidance, setBuiltinGuidance] = useState(true)
  const [savingMode, setSavingMode] = useState(false)
  const [presetBusy, setPresetBusy] = useState(false)
  /** 每份储备文案的本地草稿（名字 + 文本），编辑后点该行的「保存」才落盘。 */
  const [presetDrafts, setPresetDrafts] = useState<Record<string, { name: string; text: string }>>({})
  /** 两栏共用的高度槽 'all'：只能拖大、不能拖小（下限就是初始 180），拖任一手柄两栏一起变；
      高度记在 localStorage 里。 */
  const { heightOf, startResize } = useSyncedBoxHeights(180, 'dsh-memory-evolve:snapshot-prompt-height')
  const boxH = heightOf('all')
  /** 储备文案文本区共用一个槽 'presets'：拖任一卡片的右下角手柄，所有卡片一起变高。 */
  const { heightOf: presetHeightOf, startResize: startPresetResize } =
    useSyncedBoxHeights(120, 'dsh-memory-evolve:snapshot-presets-height')
  const presetH = presetHeightOf('presets')
  /** 一次性结果提示（右下角弹窗）；页面内不再有提示条。 */
  const notify = useToast(t)
  /** 整页加载失败：页内常驻错误 + 重试（只弹 toast 会留下空面板）。 */
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback((): void => {
    void api<SnapshotPromptResponse>(API)
      .then((res) => {
        setLoadError(null)
        setData(res)
        setDraft(res.custom)
        setInjectMode(res.injectMode)
        setBuiltinGuidance(res.builtinGuidance)
        setPresetDrafts(Object.fromEntries((res.presets ?? []).map((item) => [item.id, { name: item.name, text: item.text }])))
      })
      .catch((error: Error) => setLoadError(t('panel.loadFailed', { message: error.message })))
  }, [t])

  useEffect(() => { load() }, [load])

  /** 内置渲染结果：只读预览栏的内容，也是「恢复内置」要填回编辑框的原文。 */
  const builtinText = data?.default ?? ''

  /**
   * 保存草稿。内容与内置文案一致就提交空串 —— 等价于"没有自定义"，
   * 配置文件保持干净，状态行也照实显示"用内置"。
   * 成功后**只做本地更新**（重拉整页会把编辑框重置、界面闪一下）。
   */
  const save = (text: string): void => {
    if (saving) return
    const payload = text.trim() === builtinText.trim() ? '' : text
    setSaving(true)
    void api<unknown>(API, { method: 'POST', body: JSON.stringify({ text: payload }) })
      .then(() => {
        setData((prev) => (prev === null ? prev : { ...prev, custom: payload }))
        notify('ok', payload === '' ? t('snapshotPrompt.resetDone') : t('snapshotPrompt.saved'))
      })
      .catch((error: Error) => notify('error', error.message))
      .finally(() => setSaving(false))
  }

  /** 保存「注入方式 + 内置文案开关」（与文案本身各自独立保存）；同样只做本地更新。 */  const saveSettings = (): void => {
    if (savingMode) return
    setSavingMode(true)
    void api<unknown>(API, { method: 'POST', body: JSON.stringify({ injectMode, builtinGuidance }) })
      .then(() => {
        setData((prev) => (prev === null ? prev : { ...prev, injectMode, builtinGuidance }))
        notify('ok', t('snapshotPrompt.modeSaved'))
      })
      .catch((error: Error) => notify('error', error.message))
      .finally(() => setSavingMode(false))
  }

  /** 只刷新储备列表：**不**整页重载，避免冲掉编辑框里没保存的草稿。 */
  const refreshPresets = useCallback((): void => {
    void api<SnapshotPromptResponse>(API)
      .then((res) => {
        setData((prev) => (prev === null ? res : { ...prev, presets: res.presets, custom: res.custom }))
      })
      .catch(() => { /* 列表刷新失败不打断编辑，保持原样 */ })
  }, [])

  /**
   * 储备文案的统一提交（保存 / 删除同一个通道）。
   * @param body - POST 载荷。
   * @param done - 成功提示。
   */
  const presetPost = useCallback((body: unknown, done: string): void => {
    if (presetBusy) return
    setPresetBusy(true)
    void api<unknown>(API, { method: 'POST', body: JSON.stringify(body) })
      .then(() => {
        notify('ok', done)
        refreshPresets()
      })
      .catch((error: Error) => notify('error', error.message))
      .finally(() => setPresetBusy(false))
  }, [notify, presetBusy, refreshPresets])

  /** 删除储备文案（不可恢复，先确认）。 */
  const removePreset = useCallback(async (preset: PresetItem): Promise<void> => {
    const name = preset.name.trim() === '' ? String(t('snapshotPrompt.presetUnnamed')) : preset.name
    const ok = await askConfirm(String(t('snapshotPrompt.presetRemoveConfirm', { name })), {
      okText: String(t('snapshotPrompt.presetRemove')),
      cancelText: String(t('snapshotPrompt.presetCancel')),
    })
    if (!ok) return
    presetPost({ removePreset: preset.id }, String(t('snapshotPrompt.presetRemoved')))
  }, [presetPost, t])

  /** 改某份储备的本地草稿（名字或文本）。 */
  const patchPresetDraft = useCallback((id: string, patch: { name?: string; text?: string }): void => {
    setPresetDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { name: '', text: '' }), ...patch } }))
  }, [])

  /** 复制到文案：把该份储备的文本填进上方编辑框，**不落盘**（还要点保存才生效）。
      编辑框有未保存改动时先确认，别把用户正在写的东西静默冲掉。 */
  const copyToDraft = useCallback(async (itemDraft: { name: string; text: string }): Promise<void> => {
    if (data !== null && draft !== data.custom) {
      const ok = await askConfirm(String(t('snapshotPrompt.presetCopyConfirm')), {
        okText: String(t('snapshotPrompt.presetOverwrite')),
        cancelText: String(t('snapshotPrompt.presetCancel')),
      })
      if (!ok) return
    }
    setDraft(itemDraft.text)
    notify('ok', t('snapshotPrompt.presetCopied'))
  }, [data, draft, notify, t])

  const custom = data !== null && data.custom.trim() !== ''
  const presets = data?.presets ?? []

  return (
    <div className="me-panel">
      {loadError !== null && (
        <InlineError text={loadError} retryText={t('panel.retry')} onRetry={load} />
      )}
      <section className="me-block">
        <h3 className="me-heading">{t('snapshotPrompt.title')}</h3>
        <p className="me-help">{t('snapshotPrompt.help')}</p>
        <p className="me-help">
          {t('snapshotPrompt.state')}
          <strong>{custom ? t('snapshotPrompt.stateCustom') : t('snapshotPrompt.stateBuiltin')}</strong>
        </p>

        {/* 注入方式 + 内置文案开关（2026-10-14）：
            注入方式对**全部注入内容**生效（各记忆分组、内置指导文案、待办注入）。
            布局沿用 me-field 的一行式（左标签+说明 / 右控件），避免被压成竖排。 */}
        <label className="me-field">
          <span className="me-field-label">
            {t('snapshotPrompt.injectMode')}
            <em className="me-field-hint">{t('snapshotPrompt.injectMode.hint')}</em>
          </span>
          <select
            className="me-select"
            value={injectMode}
            onChange={(event) => setInjectMode(event.target.value === 'section' ? 'section' : 'context')}
          >
            <option value="context">{t('snapshotPrompt.injectMode.context')}</option>
            <option value="section">{t('snapshotPrompt.injectMode.section')}</option>
          </select>
        </label>
        <label className="me-field">
          <span className="me-field-label">
            {t('snapshotPrompt.builtinGuidance')}
            <em className="me-field-hint">{t('snapshotPrompt.builtinGuidance.hint')}</em>
          </span>
          <input
            type="checkbox"
            className="me-switch"
            checked={builtinGuidance}
            onChange={(event) => setBuiltinGuidance(event.target.checked)}
          />
        </label>
        <div className="me-field" style={{ justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="me-btn me-btn-primary"
            disabled={savingMode}
            onClick={saveSettings}
          >
            {savingMode ? t('snapshotPrompt.saving') : t('snapshotPrompt.saveMode')}
          </button>
        </div>

        {/* 两栏并排（2026-10-16 用户）：左＝内置文案（只读），右＝自定义文案（可编辑），
            两栏等高、各自内部滚动。不再有「查看内置文案」按钮，也不再列占位符说明。 */}
        <div className="sp-two-col">
          <div className="sp-col">
            <span className="me-field-label">{t('snapshotPrompt.builtin')}</span>
            <pre className="me-item-edit sp-box" style={{ height: `${boxH}px` }}>{builtinText}</pre>
            <span
              className="me-resize-handle"
              role="separator"
              aria-label={String(t('snapshotPrompt.resizeHint'))}
              onPointerDown={(event) => startResize('all', event)}
            />
          </div>
          <div className="sp-col">
            <span className="me-field-label">{t('snapshotPrompt.custom')}</span>
            <textarea
              className="me-item-edit sp-box"
              style={{ height: `${boxH}px` }}
              value={draft}
              placeholder={t('snapshotPrompt.placeholder')}
              onChange={(event) => setDraft(event.target.value)}
            />
            <span
              className="me-resize-handle"
              role="separator"
              aria-label={String(t('snapshotPrompt.resizeHint'))}
              onPointerDown={(event) => startResize('all', event)}
            />
          </div>
        </div>
        {/* 操作行放在两栏**下方**（用户 2026-10-17）：按钮原先留在右栏内，会侵吞文本框
            高度、还把两栏挤得不对齐。
            「保存为储备文案」= 立刻把编辑框现内容存成一条（名字留空 = 未命名，之后可改）。
            「恢复内置」= 把编辑框内容**换回内置原文**（不是清空、也不落盘），
            之后仍要点「保存」才生效。 */}
        <div className="sp-actions">
          <button
            type="button"
            className="me-btn"
            disabled={presetBusy || data === null || draft.trim() === ''}
            onClick={() => presetPost({ preset: { name: '', text: draft } },
              String(t('snapshotPrompt.presetSaved')))}
          >
            {t('snapshotPrompt.presetSaveAsPreset')}
          </button>
          <button
            type="button"
            className="me-btn"
            title={t('snapshotPrompt.resetHint')}
            disabled={saving || data === null || draft === builtinText}
            onClick={() => setDraft(builtinText)}
          >
            {t('snapshotPrompt.reset')}
          </button>
          <button
            type="button"
            className="me-btn me-btn-primary"
            disabled={saving}
            onClick={() => save(draft)}
          >
            {saving ? t('snapshotPrompt.saving') : t('snapshotPrompt.save')}
          </button>
        </div>
        {/* 储备文案（2026-10-19 用户改版）：没有启用/禁用，只有「复制到文案」
            ——填进上方编辑框但不落盘，点了保存才算生效。 */}
        <div className="sp-presets">
          <div className="sp-presets-head">
            <span className="me-field-label">{t('snapshotPrompt.presets')}</span>
          </div>
          {presets.length === 0 ? (
            <p className="me-hint">{t('snapshotPrompt.presetsEmpty')}</p>
          ) : (
            <div className="sp-presets-grid">
              {presets.map((preset) => {
                const itemDraft = presetDrafts[preset.id] ?? { name: preset.name, text: preset.text }
                return (
                  <div className="sp-preset" key={preset.id}>
                    <div className="sp-preset-head">
                      <input
                        type="text"
                        className="me-todo-input sp-preset-name"
                        value={itemDraft.name}
                        placeholder={t('snapshotPrompt.presetUnnamed')}
                        onChange={(event) => patchPresetDraft(preset.id, { name: event.target.value })}
                      />
                      <button
                        type="button"
                        className="me-btn me-btn-archive"
                        title={itemDraft.text.trim() === '' ? t('snapshotPrompt.presetEmptyHint') : undefined}
                        disabled={presetBusy || itemDraft.text.trim() === ''}
                        onClick={() => { void copyToDraft(itemDraft) }}
                      >
                        {t('snapshotPrompt.presetCopyToDraft')}
                      </button>
                      <button
                        type="button"
                        className="me-btn me-btn-primary"
                        disabled={presetBusy}
                        onClick={() => presetPost({ preset: { id: preset.id, name: itemDraft.name, text: itemDraft.text } },
                          String(t('snapshotPrompt.presetSaved')))}
                      >
                        {t('snapshotPrompt.presetSave')}
                      </button>
                      <button
                        type="button"
                        className="me-btn me-btn-danger"
                        disabled={presetBusy}
                        onClick={() => { void removePreset(preset) }}
                      >
                        {t('snapshotPrompt.presetRemove')}
                      </button>
                    </div>
                    <div className="sp-preset-text-wrap">
                      <textarea
                        className="me-item-edit sp-preset-text"
                        style={{ height: `${presetH}px` }}
                        value={itemDraft.text}
                        onChange={(event) => patchPresetDraft(preset.id, { text: event.target.value })}
                      />
                      <span
                        className="me-resize-handle"
                        role="separator"
                        aria-label={String(t('snapshotPrompt.resizeHint'))}
                        onPointerDown={(event) => startPresetResize('presets', event)}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
