/**
 * dsh-memory-evolve — settings tab (conversation.view entry)。
 *
 * 「Memory Evolve 设置」Tab：插件的总配置入口（2026-10-15 按用户拍板重组）。
 *
 * ## 二级页（顺序即界面顺序）
 * | 页 | 内容 |
 * |---|---|
 * | 分组 | 记忆 / 待办的分组管理（名称、类、启用、注入、待确认、提示词） |
 * | 工具 | 工具定义：内置工具停用 / 改名 / 改描述，新建绑定内置动作的自建工具 |
 * | 注入 | 全局注入方式（含强制系统提示词覆盖全部分组）、指导文案、渐进式披露 |
 * | 界面 | 待确认红点、进页跳转、停用分组的显示二态（显示 / 不显示） |
 * | 数据 | 存储格式版本、迁移（试运行 / 执行）与备份回滚、记忆根目录 |
 * | 功能 | 各独立模块的开关（COI / 广播 / 评审员 / 通知 / 画板 / 同步 …） |
 * | 关于 | 版本检测与更新 |
 * | 指南 | 插件全部功能的简介（**固定最后一位**，2026-10-15 用户拍板） |
 *
 * 「开局提示词」**不在这里**——它属于记忆内容而非设置，放在记忆页签。
 */
import { Fragment, useEffect, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { MemoryQueueView } from './MemoryQueueView.tsx'
import { GroupsPanel } from './GroupsPanel.tsx'
import { VersionTabView } from './VersionTabView.tsx'
import { ConfigFields, type ConfigFieldDef } from './ConfigFields.tsx'
import { ToolsPanel } from './ToolsPanel.tsx'
// 「数据」子页（DataPanel）已按用户要求删除（2026-10-16）：存储格式与迁移信息
// 用户不看，页面直接下掉；宿主 /api/vault/* 端点保留（迁移仍在后台自动跑）。
import { SnapshotPromptPanel } from './SnapshotPromptPanel.tsx'

/** 配置页的二级页。 */
type SettingsFeature = 'groups' | 'tools' | 'inject' | 'snapshotPrompt' | 'ui' | 'features' | 'about' | 'guide'

/** 二级页顺序（指南固定最后）。 */
const FEATURES: Array<{ id: SettingsFeature; labelKey: string }> = [
  { id: 'groups', labelKey: 'settingsTab.feature.groups' },
  { id: 'tools', labelKey: 'settingsTab.feature.tools' },
  { id: 'inject', labelKey: 'settingsTab.feature.inject' },
  // 开局提示词（2026-10-15 用户定）：从记忆页签搬回设置页 —— 它属于"配置"而不是
  // "记忆内容"。紧挨「注入」放，两者语义最近（都是"每轮注入给 AI 什么"）。
  { id: 'snapshotPrompt', labelKey: 'settingsTab.feature.snapshotPrompt' },
  { id: 'ui', labelKey: 'settingsTab.feature.ui' },
  { id: 'features', labelKey: 'settingsTab.feature.features' },
  { id: 'about', labelKey: 'settingsTab.feature.about' },
  { id: 'guide', labelKey: 'settingsTab.feature.guide' },
]

/** 「注入」页的字段（全是运行时键，改完立即生效）。 */
const INJECT_FIELDS: ConfigFieldDef[] = [
  {
    key: 'injectMode',
    labelKey: 'settingsTab.inject.mode',
    hintKey: 'settingsTab.inject.modeHint',
    kind: 'select',
    options: [
      { value: 'context', labelKey: 'settingsTab.inject.modeContext' },
      { value: 'section', labelKey: 'settingsTab.inject.modeSection' },
    ],
  },
  { key: 'builtinGuidance', labelKey: 'settingsTab.inject.builtin', hintKey: 'settingsTab.inject.builtinHint' },
  { key: 'snapshotOrder', labelKey: 'settingsTab.inject.order', hintKey: 'settingsTab.inject.orderHint', kind: 'number' },
  {
    key: 'keyProgressiveDisclosure',
    labelKey: 'settingsTab.inject.disclosure',
    hintKey: 'settingsTab.inject.disclosureHint',
    kind: 'select',
    options: [
      { value: 'off', labelKey: 'settingsTab.inject.disclosureOff' },
      { value: 'auto', labelKey: 'settingsTab.inject.disclosureAuto' },
      { value: 'on', labelKey: 'settingsTab.inject.disclosureOn' },
    ],
  },
  { key: 'keyFullInjectThreshold', labelKey: 'settingsTab.inject.threshold', kind: 'number' },
  { key: 'keyFullInjectCharLimit', labelKey: 'settingsTab.inject.charLimit', kind: 'number' },
  { key: 'keyBranchFilter', labelKey: 'settingsTab.inject.branchFilter' },
]

/** 「界面」页的字段。 */
const UI_FIELDS: ConfigFieldDef[] = [
  { key: 'pendingBadge', labelKey: 'settingsTab.ui.badge', hintKey: 'settingsTab.ui.badgeHint' },
  { key: 'jumpToPending', labelKey: 'settingsTab.ui.jump', hintKey: 'settingsTab.ui.jumpHint' },
  {
    key: 'showDisabled',
    labelKey: 'settingsTab.ui.showDisabled',
    hintKey: 'settingsTab.ui.showDisabledHint',
    kind: 'select',
    options: [
      // 只有二态：历史值 dim（灰显）与 shown 视觉上分不出来（用户实测），已合并掉。
      { value: 'hidden', labelKey: 'settingsTab.ui.showDisabledHidden' },
      { value: 'shown', labelKey: 'settingsTab.ui.showDisabledShown' },
    ],
  },
  // 条目数显示（2026-10-15 用户需求 UI-16）：三类各一个显示开关 + 两个计数口径。
  { key: 'countShowSession', labelKey: 'settingsTab.ui.countSession', hintKey: 'settingsTab.ui.countShowHint' },
  { key: 'countShowProject', labelKey: 'settingsTab.ui.countProject' },
  { key: 'countShowGlobal', labelKey: 'settingsTab.ui.countGlobal' },
  { key: 'countIncludeDisabled', labelKey: 'settingsTab.ui.countDisabled', hintKey: 'settingsTab.ui.countDisabledHint' },
  { key: 'countIncludeArchived', labelKey: 'settingsTab.ui.countArchived', hintKey: 'settingsTab.ui.countArchivedHint' },
  // 条目展开形态（2026-10-15 用户 F-8）：默认折叠成标题行；行数与「记住拖拽高度」都可设置。
  {
    key: 'entryExpandMode',
    labelKey: 'settingsTab.ui.expandMode',
    hintKey: 'settingsTab.ui.expandModeHint',
    kind: 'select',
    options: [
      { value: 'collapsed', labelKey: 'settingsTab.ui.expandCollapsed' },
      { value: 'preview', labelKey: 'settingsTab.ui.expandPreview' },
      { value: 'full', labelKey: 'settingsTab.ui.expandFull' },
    ],
  },
  {
    key: 'entryPreviewLines',
    labelKey: 'settingsTab.ui.previewLines',
    hintKey: 'settingsTab.ui.previewLinesHint',
    kind: 'number',
    min: 1,
  },
  { key: 'entryRememberHeight', labelKey: 'settingsTab.ui.rememberHeight', hintKey: 'settingsTab.ui.rememberHeightHint' },
  // 条目元数据行（F-7，2026-10-16）：记忆 / 待办各一个开关。
  { key: 'entryMetaMemory', labelKey: 'settingsTab.ui.metaMemory', hintKey: 'settingsTab.ui.metaHint' },
  { key: 'entryMetaTodo', labelKey: 'settingsTab.ui.metaTodo' },
]

/** Locale-bound props（memory-evolve 命名空间）。 */
export interface SettingsTabViewProps {
  t: Translate
}

/** 跨重挂持久化的二级页选择（模块级：badge 刷新导致组件重挂后恢复）。 */
let persistedSettingsFeature: SettingsFeature | null = null

/** The conversation view settings tab component. */
export function SettingsTabView(props: ConvViewProps & SettingsTabViewProps): JSX.Element {
  const { t } = props
  const [feature, setFeature] = useState<SettingsFeature>(persistedSettingsFeature ?? 'groups')

  useEffect(() => { persistedSettingsFeature = feature }, [feature])

  const notify = (): void => {
    window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
  }

  return (
    <div className="mt-panel">
      <div className="mt-file-tabs" role="tablist">
        {FEATURES.map((entry) => (
          <Fragment key={entry.id}>
            {/* 「功能」与「关于」之间加分隔符（用户 UI-12）：前面是插件的各项能力
                开关，后面（关于 / 指南）是版本与说明——语义分组不同。 */}
            {entry.id === 'about' && <span className="mt-tab-sep" role="presentation" />}
            <button
              type="button"
              role="tab"
              aria-selected={feature === entry.id}
              className={feature === entry.id ? 'mt-file-tab mt-file-tab-active' : 'mt-file-tab'}
              onClick={() => setFeature(entry.id)}
            >
              {t(entry.labelKey)}
            </button>
          </Fragment>
        ))}
      </div>
      {feature === 'about' ? (
        <VersionTabView t={t} />
      ) : feature === 'groups' ? (
        <GroupsPanel t={t} />
      ) : feature === 'tools' ? (
        <ToolsPanel t={t} />
      ) : feature === 'inject' ? (
        <ConfigFields t={t} fields={INJECT_FIELDS} />
      ) : feature === 'snapshotPrompt' ? (
        // 开局提示词（每轮注入给 AI 的固定指导文案，可看可改）——2026-10-15 用户定
        // 搬回设置页；内容本身与原来完全一致，只是入口位置变了。
        <SnapshotPromptPanel t={t} />
      ) : feature === 'ui' ? (
        <ConfigFields t={t} fields={UI_FIELDS} />
      ) : (
        <MemoryQueueView t={t} feature={feature === 'guide' ? 'guide' : 'config'} onChanged={notify} />
      )}
    </div>
  )
}
