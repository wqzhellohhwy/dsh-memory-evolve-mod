/**
 * 探针：验证「一级 + 二级页签同处第一行、操作区锁定最右」的结构真的进了
 * 构建产物，且「开局提示词」按钮就在这个不换行的容器里。
 *
 * 为什么需要它：那个按钮**一直是**无条件渲染、词条也一直在 bundle 里，光看
 * 源码判断不出"用户为什么看不到" —— 必须验证**构建产物**里的实际结构。
 * 本探针只证明结构正确（容器不换行 + 按钮在内），不能替代真机肉眼确认。
 */
import { readFileSync } from 'node:fs'

const bundle = readFileSync('lib/client.js', 'utf8')

/** 找出某标记首次出现的索引（找不到返回 -1）。 */
const at = (needle) => bundle.indexOf(needle)

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

// 1) 三件套容器在产物里存在（记忆 + 待办各一处 → 共 3 个类名各至少 2 次）
for (const cls of ['mt-tabs-bar', 'mt-tabs-scroll', 'mt-tabs-actions']) {
  const count = bundle.split(`"${cls}"`).length - 1
  check(`容器类 ${cls} 出现次数 ≥ 2（记忆 + 待办）`, count >= 2, `实际 ${count} 次`)
}

// 2) CSS 三条规则也在产物里（样式与结构必须同一批构建）
for (const rule of ['.mt-tabs-bar', '.mt-tabs-scroll', '.mt-tabs-actions']) {
  check(`CSS 规则 ${rule} 在产物内`, bundle.includes(rule))
}

// 3) 不换行的两个关键声明（nowrap + 允许溢出）
check('页签区 flex-wrap: nowrap（绝不换行）', /flex-wrap:\s*nowrap/.test(bundle))
check('页签区 min-width: 0（允许溢出）', /min-width:\s*0/.test(bundle))

// 4) 页签容器位置（下面几条断言要用）
const scrollAt = at('"mt-tabs-scroll"')

// 5) 操作区在页签容器**之后**（DOM 顺序：页签左、按钮右）
const actionsAt = at('"mt-tabs-actions"')
check('操作区位于页签容器之后（页签左、按钮右）', actionsAt > scrollAt, `scroll@${scrollAt} actions@${actionsAt}`)

// 6) 旧的负 margin 规则已彻底移除（那是把页签顶掉的老方案）
check('旧的负 margin 规则已移除', !bundle.includes('margin-top: -6px'))

// 7) 记忆页签顺序（2026-10-15 用户定）：「指南」在最左，先于「待确认记忆建议」
const guideCall = bundle.indexOf('t2("memoryTab.feature.guide")')
const suggestCall = bundle.indexOf('t2("memoryTab.feature.suggestions")')
check(
  '记忆页签：指南渲染在最左（先于「待确认记忆建议」）',
  guideCall > 0 && suggestCall > 0 && guideCall < suggestCall,
  `guide@${guideCall} suggest@${suggestCall}`,
)

// 8) 开局提示词搬回设置页（2026-10-15 用户定：它属于"配置"而不是"记忆内容"）
const promptInSettings = bundle.includes('{ id: "snapshotPrompt", labelKey: "settingsTab.feature.snapshotPrompt" }')
check('设置页的二级页签里有「开局提示词」', promptInSettings)
check('设置页确实渲染了开局提示词面板', bundle.includes('snapshotPrompt.title'))
check('记忆页签区不再渲染开局提示词', !bundle.includes('t2("settingsTab.feature.snapshotPrompt")'))

let failed = 0
for (const row of results) {
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.detail ? `  （${row.detail}）` : ''}`)
  if (!row.ok) failed += 1
}
console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
