/**
 * 右下角一次性提示（toast）：模块级单例 + 纯 DOM，不依赖任何挂载点。
 *
 * 为什么不用 React 渲染：提示要能被任意组件（甚至非 React 模块，如 advisor-store）
 * 触发，而插件的槽位挂载点由宿主控制、面板一卸载提示就没了。这里自建
 * `#dsh-memory-evolve-toasts` 容器挂在 `<body>` 上，与 ask-confirm.ts 同一套路。
 *
 * 用法：
 *   - 组件内：`const notify = useToast(t)` → `notify('ok', t('xxx.saved'))`
 *   - 组件外：`toast('error', message)`
 * 成功（ok）3 秒自动消失；失败/警告（error/warn）**不自动消失**，必须点 ×；
 * 最多同时 5 条（超出丢最旧），容器限高 60vh。
 * 条目本身不吃点击（只有 × 可点），不会挡住下方按钮。
 * 颜色只用 `var(--dsw-alias-state-*)`（见 styles.css 的 .me-toast*）。
 */
import { useCallback } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** 提示类型：成功 / 失败 / 警告（与 .me-notice-* 的语义对齐）。 */
export type ToastKind = 'ok' | 'error' | 'warn'

/** 容器 id（单例；已存在就复用，不重复建）。 */
const HOST_ID = 'dsh-memory-evolve-toasts'
/** 自动消失时间（毫秒）：0 = 不自动消失（失败/警告必须手动关闭）。 */
const DURATION: Record<ToastKind, number> = { ok: 3000, error: 0, warn: 0 }
/** 同时最多保留的条数（超出丢最旧，防止连续操作堆出屏幕）。 */
const MAX_VISIBLE = 5
/** 淡出动画时长（毫秒），与 styles.css 的 transition 一致。 */
const FADE = 160
/** 组件外调用时的默认关闭说明（组件内用 useToast 覆盖成本地化文案）。 */
const DEFAULT_CLOSE = (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('en'))
  ? 'Dismiss'
  : '关闭提示'

/** 取（或建）右下角容器。 */
function hostOf(): HTMLElement {
  const existing = document.getElementById(HOST_ID)
  if (existing !== null) return existing
  const host = document.createElement('div')
  host.id = HOST_ID
  host.className = 'me-toast-host'
  document.body.appendChild(host)
  return host
}

/**
 * 弹一条提示。
 * @param kind - 提示类型（决定颜色与是否自动消失）。
 * @param text - 正文（纯文本，不解析 HTML）。
 * @param closeTitle - 「×」按钮的悬浮说明；空串用默认（zh「关闭提示」/ en「Dismiss」）。
 */
export function toast(kind: ToastKind, text: string, closeTitle = ''): void {
  const host = hostOf()
  const box = document.createElement('div')
  box.className = `me-toast me-toast-${kind}`
  box.setAttribute('role', 'status')
  const body = document.createElement('span')
  body.className = 'me-toast-text'
  body.textContent = text
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'me-toast-close'
  close.textContent = '×'
  close.title = closeTitle === '' ? DEFAULT_CLOSE : closeTitle
  close.setAttribute('aria-label', close.title)
  box.append(body, close)

  let closed = false
  /** 先淡出再移除；重复调用只生效一次。 */
  const remove = (): void => {
    if (closed) return
    closed = true
    box.classList.add('me-toast-out')
    window.setTimeout(() => box.remove(), FADE)
  }
  close.addEventListener('click', remove)

  const lifetime = DURATION[kind]
  if (lifetime > 0) window.setTimeout(remove, lifetime)

  host.appendChild(box)
  // 超出上限：从最旧的开始丢（只按 DOM 顺序，不含正在淡出的）
  while (host.querySelectorAll('.me-toast:not(.me-toast-out)').length > MAX_VISIBLE) {
    const oldest = host.querySelector('.me-toast:not(.me-toast-out)')
    if (oldest === null) break
    oldest.remove()
  }
  window.requestAnimationFrame(() => box.classList.add('me-toast-in'))
}

/**
 * 组件内用的推送器：自动带上「×」按钮的本地化说明。
 * @param t - 面板拿到的 Translate。
 * @returns `notify(kind, text)`。
 */
export function useToast(t: Translate): (kind: ToastKind, text: string) => void {
  return useCallback((kind: ToastKind, text: string): void => {
    toast(kind, text, String(t('toast.close')))
  }, [t])
}
