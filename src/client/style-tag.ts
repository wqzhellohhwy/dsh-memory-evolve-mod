/**
 * dsh-memory-evolve — 客户端样式标签的归属标记（DSH 样式账本的硬要求）。
 *
 * ## 背景（2026-10-10 定位：桌面版「页面失去全部样式」的根因之一）
 *
 * DSH 的客户端模块系统（@deepseek-ai/dsh-client-modules）用 `<style>` 上的
 * `data-plugin` 属性维护样式归属账本：
 *
 *   - 物化一个插件 bundle 之后调用 `claimStyles(ownerId)`：
 *     **把所有没有 data-plugin 的 `<style>` 认领给刚物化的那个插件**；
 *   - 该插件被 HMR 重载 / 图重组回收时调用 `removeOwnedStyles(ownerId)`：
 *     **删除 data-plugin === ownerId 的全部 `<style>`**。
 *
 * DSH 官方客户端插件（ui-layout / ui-conversation / ui-theme …）在 bundle
 * 顶层注入样式时就显式写 `tag.dataset.plugin = 包名`，所以账本始终正确。
 * memory-evolve 原先只在标签上写自己的自定义属性（data-memory-evolve-css 等），
 * 没有 data-plugin，于是这个账本会出错：
 *
 *   1. 自己的样式是「无主标签」→ 会被**随后物化的别的插件**认领走；那个插件
 *      一旦重载/被回收，这里注入的样式就被连带删除，而且不会恢复（守卫只在
 *      标签不存在时才注入，apply 未必再跑）。
 *   2. 反过来，自己物化时 `claimStyles` 会把页面上**所有**无主标签（其它不
 *      守约插件的样式）认领到自己名下；memory-evolve 一被重载，
 *      `removeOwnedStyles('dsh-memory-evolve')` 就把它们一起删掉 ——
 *      用户看到的就是「点了记忆相关操作，页面变成没有 CSS 的裸控件」
 *      （只有 `<link>` 引入的 shell 基础样式还在）。
 *
 * 所以本模块统一本插件所有样式注入：**注入即打 data-plugin**，并且对已经
 * 存在、但归属被误认领的标签**抢回归属**（只针对本插件专属标记的标签，
 * 不会碰别人的样式）。
 *
 * @module dsh-memory-evolve/client/style-tag
 */

/**
 * 样式账本键 —— 必须等于插件包名。
 *
 * `claimStyles` / `removeOwnedStyles` 用的 ownerId 是
 * `stripClientSuffix(registration.id)`，也就是 package.json 的 `name`。
 * 官方插件（如 @deepseek-ai/dsh-client-ui-layout）用的同样是包名。
 */
export const STYLE_OWNER_ID = 'dsh-memory-evolve-mod'

/** 归属属性名（DSH 账本读的属性）。 */
const OWNER_ATTR = 'data-plugin'

/**
 * 注入（或校正）一段属于本插件的 `<style>`。
 *
 * 幂等：同 marker 的标签已存在时不重复注入，只修正归属。若本插件此前被
 * claimStyles 误认领过，这里会把归属抢回，使它不会被「新主人」的重载删掉。
 *
 * @param markerAttr - 本插件为该样式设定的专属标记属性（如 'data-memory-evolve-css'）。
 * @param css - 样式文本（构建时经 esbuild 的 .css=text loader 内联）。
 * @returns 卸载函数：移除本次注入的标签；标签是复用已有的话什么也不做。
 */
export function injectOwnedStyle(markerAttr: string, css: string): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[${markerAttr}]`)
  if (existing !== null) {
    if (existing.getAttribute(OWNER_ATTR) !== STYLE_OWNER_ID) existing.setAttribute(OWNER_ATTR, STYLE_OWNER_ID)
    return () => {}
  }
  const tag = document.createElement('style')
  tag.setAttribute(OWNER_ATTR, STYLE_OWNER_ID)
  tag.setAttribute(markerAttr, '1')
  tag.textContent = css
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
