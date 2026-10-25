/**
 * useSyncedBoxHeights — 一批文本框的高度管理：拖自绘手柄改高，值按槽位分开记。
 *
 * 用在两处：
 *   - ToolsPanel：工具定义块的输入框（**同一行的两个**共用一个槽）＋ 每个工具的
 *     描述框（每个工具自己的槽，下限用 DESC_BOX_H），高度记在 localStorage 里
 *   - SnapshotPromptPanel：开局提示词左右两栏（一个槽 'all'，两栏一起变）
 *
 * 四条硬约定（都是实测踩出来的，别改回去）：
 *
 * ① 同一个元素的高度只能有一个写入方。原生斜拉条是**浏览器**在写高度，React 受控
 *    style.height 也在写 → 框在光标底下反复横跳。所以 CSS 关掉原生手柄
 *    （resize: none），高度只由这里的 state 写；手柄自绘（.me-resize-handle）。
 *
 * ② **只准拖大，不准拖小**（下限 = 该槽的初始高度）。拖小会让文档总高变矮，若当前
 *    scrollTop 超过新的 maxScrollTop，浏览器立刻把 scrollTop 拉回上限 → 整页往上跳。
 *
 * ③ 拖动期间冻结滚动位置（关滚动锚定 + 每帧回写 scrollTop）。拖大时浏览器会为了
 *    保住锚点而回调 scrollTop，不锁住的话用户会觉得"页面自己在动"。
 *
 * ④ 记忆的高度若小于该槽下限（用户后来把默认值调大了），按下限处理，不看记忆值。
 *
 * 槽的初始高度可以逐槽不同：`heightOf(slot, initial)` / `startResize(slot, event, initial)`，
 * 不传就用构造 hook 时的 `defaultInitial`。**同一个 storageKey 只用一个 hook 实例**
 * （写盘是整对象覆盖，两个实例共键会互相抹掉对方的槽）。
 *
 * 工具页的块槽：宽屏（两列）按「行」分（`row<floor(index/2)>`，同一行两个一起变）；
 * **窄屏（一列，≤900px）没有"同一行"这回事，每块各自一个槽**（`block:<tool>.<id>`）。
 * 代价：宽屏/窄屏之间同一块的高度记忆不互通（两套槽名），可接受。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export interface SyncedBoxHeights {
  /** 取某槽的高度（没记过、或记的值小于给的下限 → 返回下限）。 */
  heightOf: (slot: string, initial?: number) => number
  /** 挂到自绘手柄的 `onPointerDown` 上（第三个参数是该槽的下限）。 */
  startResize: (slot: string, event: ReactPointerEvent<HTMLElement>, initial?: number) => void
}

/** 拖动期间挂在 `<html>` 上的类：禁选中、光标竖向缩放、关滚动锚定。 */
const DRAGGING_CLASS = 'me-resizing'

/** 记忆高度的上限（像素）：挡住坏数据把页面撑爆。 */
const MAX_STORED_HEIGHT = 4000

/**
 * 找到最近的滚动容器；都没有就回退 window。
 * @param el - 从哪个元素往上找（通常是被拖的手柄）。
 */
function findScrollParent(el: HTMLElement): HTMLElement | Window {
  let node: HTMLElement | null = el.parentElement
  while (node !== null) {
    const { overflowY } = getComputedStyle(node)
    if (/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return window
}

/** 读记忆的高度；坏数据一律当没有。 */
function readStored(storageKey: string): Record<string, number> {
  if (storageKey === '') return {}
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [slot, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_STORED_HEIGHT) {
        out[slot] = value
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 写记忆的高度（隐私模式 / 配额满时静默放弃，不影响交互）。 */
function writeStored(storageKey: string, heights: Record<string, number>): void {
  if (storageKey === '') return
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(heights))
  } catch { /* 忽略 */ }
}

/**
 * @param defaultInitial - 各槽默认的初始高度（像素），同时也是下限：只能拖大。
 * @param storageKey - localStorage 键；空串 = 不记忆。
 */
export function useSyncedBoxHeights(defaultInitial = 180, storageKey = ''): SyncedBoxHeights {
  const [heights, setHeights] = useState<Record<string, number>>(() => readStored(storageKey))
  /** 松手时写盘用（避免在 setState 更新函数里做副作用）。 */
  const heightsRef = useRef(heights)
  heightsRef.current = heights

  const heightOf = useCallback((slot: string, initial: number = defaultInitial): number => {
    const stored = heights[slot]
    return stored === undefined || stored < initial ? initial : stored
  }, [heights, defaultInitial])

  const startResize = useCallback((slot: string, event: ReactPointerEvent<HTMLElement>,
    initial: number = defaultInitial): void => {
    event.preventDefault()
    const startY = event.clientY
    const startH = heightOf(slot, initial)
    const scroller = findScrollParent(event.currentTarget)
    const isWindow = scroller === window
    /** 拖动开始时的滚动位置，拖动全程保持不变。 */
    const startTop = isWindow ? window.scrollY : (scroller as HTMLElement).scrollTop

    const restoreScroll = (): void => {
      if (isWindow) {
        if (window.scrollY !== startTop) window.scrollTo(window.scrollX, startTop)
      } else {
        const box = scroller as HTMLElement
        if (box.scrollTop !== startTop) box.scrollTop = startTop
      }
    }

    const onMove = (move: PointerEvent): void => {
      // 下限就是本槽的初始高度：不允许拖到比默认值更小（见文件头约定 ②）。
      const next = Math.max(initial, Math.round(startH + move.clientY - startY))
      setHeights((prev) => (prev[slot] === next ? prev : { ...prev, [slot]: next }))
      // setState 是异步的：同一帧里回写会被随后的浏览器钳制再覆盖一次，
      // 必须等下一帧 DOM 更新完（新 scrollHeight 生效）再拉回。
      requestAnimationFrame(restoreScroll)
    }
    const onUp = (): void => {
      document.documentElement.classList.remove(DRAGGING_CLASS)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      writeStored(storageKey, heightsRef.current)
      // 收尾再补一次：最后一次浏览器回调可能落在最后一次 pointermove 之后。
      requestAnimationFrame(restoreScroll)
    }

    document.documentElement.classList.add(DRAGGING_CLASS)
    // 监听挂在 window 上：鼠标拖出框外、拖出窗口都不断线。
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    // 触控笔/触摸手势被打断时只发 pointercancel，不监听它类会永久留在 <html> 上。
    window.addEventListener('pointercancel', onUp)
    // 窗口失焦（切窗口、弹窗）时 pointerup 可能收不到，兜底同 pointercancel。
    window.addEventListener('blur', onUp)
  }, [heightOf, defaultInitial, storageKey])

  return { heightOf, startResize }
}

/**
 * 当前是否窄屏（工具页块网格在该断点下只有一列，那时每块独立调高度）。
 * @param query - 媒体查询，默认与 styles.css 里 .me-tool-blocks-grid 的断点一致。
 */
export function useNarrowLayout(query = '(max-width: 900px)'): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = (): void => setNarrow(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])
  return narrow
}
