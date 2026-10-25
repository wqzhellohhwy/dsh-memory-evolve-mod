/**
 * dsh-memory-evolve — 条目展开状态（用户 F-8）的共享逻辑。
 *
 * 记忆页与待办页的条目是两套组件，但「默认展开程度 + 逐条覆盖 + 拖拽高度」
 * 的行为完全一样，所以抽到这里：一份 localStorage、一份归一逻辑、一个 hook。
 *
 * 存储按**条目 id** 索引（记忆条目用 vault 的 sha1 短 id，全局唯一；待办条目
 * 用它自己的 id）；旧数据没有 id 时退回原文指纹。
 */
import { useCallback, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

/** 展开形态：collapsed 只显示标题行（默认）/ preview 显示前 N 行 / full 整条撑开。 */
export type EntryExpandMode = 'collapsed' | 'preview' | 'full'

/** 展开设置（宿主运行时配置，入口在「设置 → 界面」）。 */
export interface EntryExpandOptions {
  mode: EntryExpandMode
  /** preview 模式显示多少行。 */
  lines: number
  /** 是否记住每条手动拖拽过的高度。 */
  rememberHeight: boolean
}

/** 缺省展开设置：全部折叠成标题行，记住手动拖拽的高度。 */
export const DEFAULT_EXPAND_OPTIONS: EntryExpandOptions = {
  mode: 'collapsed',
  lines: 3,
  rememberHeight: true,
}

/**
 * 宿主运行时配置 → 展开设置（缺键一律回退缺省）。
 * @param config - `/api/config` 返回的 config 对象。
 * @returns 归一后的展开设置。
 */
export function expandOptionsOf(config: Record<string, unknown> | undefined): EntryExpandOptions {
  if (config === undefined) return DEFAULT_EXPAND_OPTIONS
  const mode = config.entryExpandMode
  const lines = Number(config.entryPreviewLines)
  return {
    mode: mode === 'preview' || mode === 'full' ? mode : 'collapsed',
    lines: Number.isFinite(lines) && lines >= 1 ? Math.min(50, Math.floor(lines)) : 3,
    rememberHeight: config.entryRememberHeight !== false,
  }
}

/** 单条条目的界面状态：展开与否 + 手动拖过的高度（px）。 */
export interface EntryViewState {
  open?: boolean
  h?: number
}

/** 条目界面状态的本地存储键（条目 id 唯一，所以跨分组共用一份）。 */
const ENTRY_VIEW_KEY = 'memory-evolve:entryView'

/** 读条目界面状态（读不到/坏数据一律空表）。 */
function readEntryViews(): Record<string, EntryViewState> {
  try {
    const raw = window.localStorage.getItem(ENTRY_VIEW_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as Record<string, EntryViewState>
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 写条目界面状态（存储不可用时静默跳过，只影响本次会话）。 */
function writeEntryViews(map: Record<string, EntryViewState>): void {
  try {
    window.localStorage.setItem(ENTRY_VIEW_KEY, JSON.stringify(map))
  } catch {
    // 隐私模式 / 存储禁用
  }
}

/** 没有稳定 id 的条目用原文指纹当键。 */
function fingerprintOf(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return `r${(hash >>> 0).toString(36)}`
}

/**
 * 条目的界面状态键：优先用稳定 id，没有就退回原文指纹。
 * @param id - 条目 id（可能没有）。
 * @param raw - 条目原文（算指纹用）。
 * @returns 存储键。
 */
export function entryKeyOf(id: string | undefined, raw: string): string {
  return typeof id === 'string' && id !== '' ? id : fingerprintOf(raw)
}

/** hook 的返回值。 */
export interface EntryViews {
  /** 该条目当前是否展开（用户点过就听用户的，否则按设置）。 */
  isOpen: (key: string) => boolean
  /** 正文的内联高度样式（拖过用拖拽值 / preview 限高 / full 不限）。 */
  textStyle: (key: string) => CSSProperties | undefined
  /** 切换展开状态（会记住）。 */
  toggle: (key: string) => void
  /** 拖拽下边缘改高度（松手写进 localStorage）。 */
  startResize: (key: string, event: ReactPointerEvent<HTMLDivElement>) => void
}

/**
 * 条目展开状态的读写 hook（记忆页与待办页共用）。
 * @param expand - 当前展开设置（来自 /api/config）。
 * @returns 读状态与写状态的四个函数。
 */
export function useEntryViews(expand: EntryExpandOptions): EntryViews {
  const [views, setViews] = useState<Record<string, EntryViewState>>(readEntryViews)

  const patch = useCallback((key: string, next: EntryViewState): void => {
    setViews((prev) => {
      const merged = { ...prev, [key]: { ...prev[key], ...next } }
      writeEntryViews(merged)
      return merged
    })
  }, [])

  const isOpen = useCallback((key: string): boolean => {
    const state = views[key]
    if (state?.open !== undefined) return state.open
    return expand.mode !== 'collapsed'
  }, [views, expand.mode])

  const textStyle = useCallback((key: string): CSSProperties | undefined => {
    const h = views[key]?.h
    if (typeof h === 'number' && h > 0) return { maxHeight: `${h}px` }
    if (expand.mode === 'preview') return { maxHeight: `${Math.round(expand.lines * 19.2)}px` }
    return undefined
  }, [views, expand.mode, expand.lines])

  const toggle = useCallback((key: string): void => {
    const state = views[key]
    const current = state?.open !== undefined ? state.open : expand.mode !== 'collapsed'
    patch(key, { open: !current })
  }, [views, expand.mode, patch])

  /**
   * 拖动时直接改 DOM 的 maxHeight（不触发渲染），松手才写进 localStorage ——
   * 避免每动一像素就 setState 把整页重渲染一遍。
   */
  const startResize = useCallback((key: string, event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!expand.rememberHeight) return
    const el = event.currentTarget.previousElementSibling as HTMLElement | null
    if (el === null) return
    event.preventDefault()
    const startY = event.clientY
    const startH = el.getBoundingClientRect().height
    let latest = Math.round(startH)
    const move = (e: PointerEvent): void => {
      latest = Math.max(60, Math.round(startH + (e.clientY - startY)))
      el.style.maxHeight = `${latest}px`
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      patch(key, { h: latest })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [expand.rememberHeight, patch])

  return { isOpen, textStyle, toggle, startResize }
}
