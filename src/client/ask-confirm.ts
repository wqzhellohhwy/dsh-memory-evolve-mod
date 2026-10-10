/**
 * dsh-memory-evolve — 网页内对话框（替代 window.confirm / alert / prompt）。
 *
 * ## 背景（2026-10-10 实测复现 + 用户确认）
 *
 * DSH 桌面版是 Electron 应用。在 Electron 里 `window.confirm()` / `alert()` /
 * `prompt()` 弹出的是**系统原生模态对话框**，而不是网页内的框。它会夺走窗口
 * 焦点与输入法（IME）上下文，并且**会让应用卡死**——实测：弹出原生框后应用
 * 变为无响应（Windows 弹出「DeepSeek Harness 无法使用」#32770 对话框），
 * 只能强杀重启。
 *
 * 用户可见症状：
 *   - 输入框点不中、键盘打不了字，但**粘贴仍可用**（paste 不依赖键盘焦点）
 *   - 严重时整个应用卡死
 *
 * ## 本模块做什么
 *
 * 1. `askConfirm()` / `askAlert()` / `askPrompt()`：用纯 DOM 覆盖层实现，
 *    **全程不经过系统层**，焦点自始至终留在页面内；关闭时把焦点还给打开前的
 *    元素（或正文编辑器）。
 * 2. `installConfirmGuard()`：兜底包装 `window.confirm`，漏网的调用点至少在
 *    返回后能把焦点抢回页面。
 *
 * ## 迁移约定（全插件统一，勿再新增原生对话框）
 *
 *   window.confirm(msg)      ->  if (!(await askConfirm(msg))) return   （所在函数改 async）
 *   window.alert(msg)        ->  void askAlert(msg)                      （无需 async）
 *   window.prompt(msg, def)  ->  const v = await askPrompt(msg, def)     （所在函数改 async）
 */

/** 当前打开的对话框（同一时刻只允许一个）。 */
let activeClose: ((value: boolean) => void) | null = null

/** 正文编辑器选区：焦点还回去时的兜底目标。 */
const EDITOR_SELECTOR = '[data-lexical-editor="true"], .dsh-composer [contenteditable="true"], [contenteditable="true"]'

/** 把焦点还给打开对话框之前的元素，退而求其次还给正文编辑器。 */
function restoreFocus(previous: HTMLElement | null): void {
  try {
    const target = previous !== null && previous.isConnected
      ? previous
      : document.querySelector<HTMLElement>(EDITOR_SELECTOR)
    target?.focus?.()
  } catch {
    // 焦点恢复是尽力而为，失败不影响结果
  }
}

/** 按钮文案走调用方传入的本地化字符串。 */
export interface AskDialogOptions {
  okText?: string
  cancelText?: string
}

interface DialogSpec {
  message: string
  okText: string
  /** 省略即没有取消按钮（alert 形态）。 */
  cancelText?: string
  /** 有值即渲染文本输入框（prompt 形态）。 */
  input?: { defaultValue: string }
}

/**
 * 打开一个网页内对话框。
 * @returns 点确定 -> { ok: true, value: 输入框内容或空串 }；取消/Esc/点遮罩 -> { ok: false, value: '' }。
 */
function openDialog(spec: DialogSpec): Promise<{ ok: boolean; value: string }> {
  return new Promise((resolve) => {
    // 弹窗叠加：旧的按「取消」处理，避免出现两个覆盖层谁也点不动
    if (activeClose !== null) activeClose(false)

    const previousFocus = (document.activeElement as HTMLElement | null) ?? null

    const overlay = document.createElement('div')
    overlay.setAttribute('data-memory-evolve-ask', '1')
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483000',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,0.42)',
      'padding:24px',
      'box-sizing:border-box',
    ].join(';')

    const card = document.createElement('div')
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-modal', 'true')
    card.style.cssText = [
      'display:flex',
      'flex-direction:column',
      'gap:16px',
      'min-width:300px',
      'max-width:min(560px,88vw)',
      'max-height:70vh',
      'overflow:auto',
      'box-sizing:border-box',
      'background:var(--dsw-alias-bg-layer-3,#ffffff)',
      'color:var(--dsw-alias-label-primary,#111827)',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.28))',
      'border-radius:12px',
      'padding:16px 18px',
      'box-shadow:0 16px 40px rgba(0,0,0,0.3)',
      'font:inherit',
      'font-size:13px',
      'line-height:1.6',
    ].join(';')

    const text = document.createElement('div')
    text.style.cssText = 'white-space:pre-wrap;word-break:break-word'
    text.textContent = spec.message

    const row = document.createElement('div')
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'

    const button = (label: string, primary: boolean): HTMLButtonElement => {
      const node = document.createElement('button')
      node.type = 'button'
      node.textContent = label
      node.style.cssText = [
        'appearance:none',
        'font:inherit',
        'font-size:13px',
        'line-height:1.2',
        'padding:6px 14px',
        'border-radius:8px',
        'cursor:pointer',
        primary
          ? 'border:1px solid transparent;background:var(--dsw-alias-label-primary,#111827);color:var(--dsw-alias-bg-layer-3,#ffffff)'
          : 'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.28));background:transparent;color:var(--dsw-alias-label-primary,#111827)',
      ].join(';')
      return node
    }

    const okButton = button(spec.okText, true)

    let input: HTMLInputElement | null = null
    if (spec.input !== undefined) {
      input = document.createElement('input')
      input.type = 'text'
      input.value = spec.input.defaultValue
      input.style.cssText = [
        'width:100%',
        'box-sizing:border-box',
        'font:inherit',
        'font-size:13px',
        'padding:6px 10px',
        'border-radius:8px',
        'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,0.28))',
        'background:var(--dsw-alias-bg-base,#ffffff)',
        'color:var(--dsw-alias-label-primary,#111827)',
        'outline:none',
      ].join(';')
    }

    let settled = false

    /** 收尾：移除覆盖层、解除键盘监听、还焦点、兑现 Promise。 */
    function finish(ok: boolean): void {
      if (settled) return
      settled = true
      if (activeClose === finish) activeClose = null
      document.removeEventListener('keydown', onKeyDown, true)
      overlay.remove()
      const value = input !== null ? input.value : ''
      restoreFocus(previousFocus)
      resolve({ ok, value })
    }

    /** Esc=取消；Enter=确定。捕获阶段拦截，避免穿透到底下的编辑器。 */
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(false)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        finish(true)
      }
    }

    if (spec.cancelText !== undefined) {
      const cancelButton = button(spec.cancelText, false)
      cancelButton.addEventListener('click', () => finish(false))
      row.appendChild(cancelButton)
    }
    okButton.addEventListener('click', () => finish(true))
    row.appendChild(okButton)

    // 点遮罩空白处 = 取消；点卡片内部不关闭
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish(false)
    })
    card.addEventListener('click', (event) => event.stopPropagation())

    card.appendChild(text)
    if (input !== null) card.appendChild(input)
    card.appendChild(row)
    overlay.appendChild(card)

    activeClose = finish
    document.addEventListener('keydown', onKeyDown, true)
    document.body.appendChild(overlay)

    // 默认焦点：有输入框就落输入框并全选，否则落「确定」
    try {
      if (input !== null) {
        input.focus()
        input.select()
      } else {
        okButton.focus()
      }
    } catch {
      // 忽略
    }
  })
}

/**
 * 确认框（替代 window.confirm）。
 * @returns 点「确定」为 true，点「取消」/Esc/点遮罩为 false。
 */
export async function askConfirm(message: string, options: AskDialogOptions = {}): Promise<boolean> {
  const result = await openDialog({
    message,
    okText: options.okText ?? '确定',
    cancelText: options.cancelText ?? '取消',
  })
  return result.ok
}

/**
 * 提示框（替代 window.alert）：只有一个「知道了」按钮。
 * 不需要 await 时用 `void askAlert(msg)`，所在函数无需改成 async。
 */
export async function askAlert(message: string, options: AskDialogOptions = {}): Promise<void> {
  await openDialog({ message, okText: options.okText ?? '知道了' })
}

/**
 * 输入框（替代 window.prompt）。
 * @returns 点「确定」返回输入内容（可能是空串），取消/Esc 返回 null。
 */
export async function askPrompt(
  message: string,
  defaultValue = '',
  options: AskDialogOptions = {},
): Promise<string | null> {
  const result = await openDialog({
    message,
    okText: options.okText ?? '确定',
    cancelText: options.cancelText ?? '取消',
    input: { defaultValue },
  })
  return result.ok ? result.value : null
}

/** 全局兜底是否已装。 */
const GUARD_FLAG = '__memoryEvolveConfirmGuard'

/**
 * 兜底：包装 `window.confirm`，原生框返回后把焦点抢回页面。
 *
 * 幂等；万一仍有漏网的原生 confirm 调用点，可借此避免「永久失焦」。
 * 新代码请直接用 {@link askConfirm} / {@link askAlert} / {@link askPrompt}。
 */
export function installConfirmGuard(): void {
  if (typeof window === 'undefined') return
  const host = window as unknown as Record<string, unknown>
  if (host[GUARD_FLAG] === true) return
  host[GUARD_FLAG] = true

  const native = window.confirm.bind(window)
  window.confirm = (message?: string): boolean => {
    const previousFocus = (document.activeElement as HTMLElement | null) ?? null
    const result = native(message ?? '')
    try {
      window.focus()
    } catch {
      // 忽略
    }
    restoreFocus(previousFocus)
    return result
  }
}

// 模块加载即装兜底：本模块由记忆面板（MemoryTabView 等）import，插件一加载即生效。
installConfirmGuard()
