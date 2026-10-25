/**
 * dsh-memory-evolve — todos tab (conversation.view entry).
 *
 * 独立待办 Tab（从原「记忆技能待办」Tab 拆分而来）：两个子 tab——
 *   「待确认待办管理」：后台审查产出的待办建议队列，采纳后写入对应待办轨
 *     （生活/工作/本项目/今日；待办建议不可改分类——待办永远是待办）
 *     （MemoryQueueView feature='todo-suggestions'）；
 *   「待办」：四轨待办管理器（生活/工作/项目/每日），列表 + 状态/象限
 *     过滤 + 快捷添加 + 逐条完成/编辑/删除（TodoView）。
 *
 * 子 tab 徽标显示待确认待办数（/api/badge 的 todoSuggestions 字段）：
 * 30s 轮询 + 监听 dsh-memory-evolve:badge-change 事件即时刷新；任一队列
 * 变更后由 onChanged 主动触发事件，让会话页标签的小红点同步更新。
 *
 * 样式复用 mt- 前缀（styles.css：mt-panel / mt-file-tabs / mt-feature-count）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { TodoView } from './TodoView.tsx'

/** 待办 Tab 的三个子功能：指南 / 待确认待办管理 / 待办。 */
type TodosFeature = 'guide' | 'todo-suggestions' | 'todo'

/** Locale-bound props（locate namespace：memory-evolve）。 */
export interface TodosTabViewProps {
  t: Translate
}

/** 跨重挂持久化的子 tab 选择（模块级：badge 刷新导致组件重挂后恢复）。 */
let persistedTodosFeature: TodosFeature | null = null

// 「指南」页签的内容与外壳页签已合并进 TodoView（用户 UI-11③）：todosGuideSections
// 随之搬到那边。本文件只剩两件事：轮询待确认待办数、把外壳状态交给 TodoView。

/** The conversation view todos tab component. */
export function TodosTabView(props: ConvViewProps & TodosTabViewProps): JSX.Element {
  const { sessionId, t } = props
  /** 当前激活的子 tab（缺省=待确认待办管理）。 */
  const [feature, setFeature] = useState<TodosFeature>(persistedTodosFeature ?? 'todo-suggestions')
  /** 待确认待办数（子 tab 徽标）。 */
  const [todoSuggestionsCount, setTodoSuggestionsCount] = useState(0)

  /** 拉取待确认待办数（尽力而为）。 */
  const pollBadge = useCallback((): void => {
    void fetch('/memory-evolve/api/badge')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { todoSuggestions?: number }) => setTodoSuggestionsCount(data.todoSuggestions ?? 0))
      .catch(() => { /* 徽标尽力而为；功能不受影响 */ })
  }, [])

  // 同步子 tab 选择到模块级：badge 刷新导致的组件重挂后恢复。
  useEffect(() => { persistedTodosFeature = feature }, [feature])

  // 30s 轮询徽标 + 监听 badge-change 事件（队列变更后即时刷新）。
  useEffect(() => {
    pollBadge()
    const timer = window.setInterval(pollBadge, 30_000)
    const onChange = (): void => pollBadge()
    window.addEventListener('dsh-memory-evolve:badge-change', onChange)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('dsh-memory-evolve:badge-change', onChange)
    }
  }, [pollBadge])

  return (
    <TodoView
      t={t}
      sessionId={String(sessionId)}
      shell={{
        feature,
        onFeature: setFeature,
        suggestions: todoSuggestionsCount,
        onChanged: () => {
          // 队列变更后：刷新本组件徽标，并通知宿主层（index.ts）立即重查
          // badge，让会话页标签的小红点即时更新（不等 30s 轮询）。
          pollBadge()
          window.dispatchEvent(new CustomEvent('dsh-memory-evolve:badge-change'))
        },
      }}
    />
  )
}
