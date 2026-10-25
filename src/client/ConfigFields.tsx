/**
 * dsh-memory-evolve — 通用运行时配置字段面板（2026-10-15 配置页拆分）。
 *
 * 配置页从「一个长表单」拆成 分组 / 工具 / 注入 / 界面 / 数据 / 功能 / 关于
 * 七个二级页后，注入页与界面页都是「若干运行时开关」——本组件把这件事做成
 * 数据驱动：调用方给字段清单，它负责渲染表单、读写 `/memory-evolve/api/config`。
 *
 * 读写走运行时配置（RUNTIME_KEYS）：改动立即 POST `{patch:{key:value}}`，宿主
 * 那边 `applyRuntimePatch` 会顺手同步依赖模块（快照通道、提示词等）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** 一个可渲染的配置字段。 */
export interface ConfigFieldDef {
  /** 运行时配置键（必须在 RUNTIME_KEYS 里）。 */
  key: string
  /** 标题词条 key。 */
  labelKey: string
  /** 说明词条 key（可选）。 */
  hintKey?: string
  /** 控件类型：布尔开关（默认）/ 数字 / 文本 / 下拉。 */
  kind?: 'bool' | 'number' | 'text' | 'select'
  /** `kind='select'` 时的选项。 */
  options?: Array<{ value: string; labelKey: string }>
  /** 数字框最小值。 */
  min?: number
}

interface ConfigFieldsProps {
  t: Translate
  fields: ConfigFieldDef[]
  /** 字段上方的说明段（可选）。 */
  introKey?: string
}

/** 一组运行时配置开关/输入框。 */
export function ConfigFields(props: ConfigFieldsProps): JSX.Element {
  const { t, fields, introKey } = props
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch('/memory-evolve/api/config')
      .then((res) => res.json())
      .then((data: { config?: Record<string, unknown> }) => { setConfig(data.config ?? {}) })
      .catch(() => { setError(String(t('settingsTab.configLoadFailed'))) })
  }, [t])

  useEffect(() => { load() }, [load])

  const save = useCallback((key: string, value: unknown) => {
    setSaving(true)
    setError(null)
    // 乐观更新：先改本地（开关手感不卡），失败再回滚并提示。
    setConfig((prev) => (prev === null ? prev : { ...prev, [key]: value }))
    fetch('/memory-evolve/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { [key]: value } }),
    })
      .then((res) => res.json())
      .then((data: { config?: Record<string, unknown> }) => {
        if (data.config) setConfig(data.config)
      })
      .catch(() => {
        setError(String(t('settingsTab.configSaveFailed')))
        load()
      })
      .finally(() => { setSaving(false) })
  }, [load, t])

  if (config === null) return <div className="me-hint">{t('settingsTab.configLoading')}</div>

  return (
    <div className="me-block">
      {introKey !== undefined && <p className="me-hint">{t(introKey)}</p>}
      {error !== null && <p className="me-error">{error}</p>}
      {fields.map((field) => {
        const value = config[field.key]
        const label = (
          <span className="me-field-label">
            {t(field.labelKey)}
            {field.hintKey !== undefined && <em className="me-field-hint">{t(field.hintKey)}</em>}
          </span>
        )
        if (field.kind === 'number') {
          return (
            <label className="me-field" key={field.key}>
              {label}
              <input
                type="number"
                className="me-todo-input"
                style={{ flex: 'none', width: '96px' }}
                min={field.min ?? 0}
                value={Number(value ?? 0)}
                disabled={saving}
                onChange={(event) => save(field.key, Number(event.target.value))}
              />
            </label>
          )
        }
        if (field.kind === 'text') {
          return (
            <label className="me-field" key={field.key}>
              {label}
              <input
                type="text"
                className="me-todo-input"
                value={String(value ?? '')}
                disabled={saving}
                onChange={(event) => save(field.key, event.target.value)}
              />
            </label>
          )
        }
        if (field.kind === 'select') {
          return (
            <label className="me-field" key={field.key}>
              {label}
              <select
                className="me-select"
                value={String(value ?? '')}
                disabled={saving}
                onChange={(event) => save(field.key, event.target.value)}
              >
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                ))}
              </select>
            </label>
          )
        }
        return (
          <label className="me-field" key={field.key}>
            {label}
            <input
              type="checkbox"
              className="me-switch"
              checked={value === true}
              disabled={saving}
              onChange={(event) => save(field.key, event.target.checked)}
            />
          </label>
        )
      })}
    </div>
  )
}
