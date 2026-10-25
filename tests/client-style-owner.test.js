/**
 * 客户端样式归属护栏（2026-10-10 桌面版「整页变裸控件」事故的回归测试）。
 *
 * DSH 的客户端模块系统（@deepseek-ai/dsh-client-modules）用 `<style>` 上的
 * `data-plugin` 维护归属账本：
 *
 *   - 物化一个插件后 `claimStyles(ownerId)` 会**把所有没有 data-plugin 的
 *     `<style>` 认领给刚物化的那个插件**；
 *   - 该插件被 HMR 重载 / 图重组回收时 `removeOwnedStyles(ownerId)` 删除
 *     data-plugin === ownerId 的全部 `<style>`。
 *
 * 所以本插件注入的每个 `<style>` 都必须在注入时就带
 * `data-plugin="dsh-memory-evolve"`（= 包名 = Loader 条目 id）。缺了它会出现
 * 两个方向的连带损坏：自己的样式被别的插件认领走并在对方重载时删除；自己
 * 认领来别人的无主样式、自己重载时把别人的样式一起删掉（用户看到的就是
 * 「点记忆相关操作后整页 UI 变成没有 CSS 的裸控件」）。
 *
 * 这些用例有意做成**静态护栏**（扫源码 + 扫构建产物），因为这是构建产物
 * 层面的性质，跑一次真实浏览器反而更难覆盖「未来新增注入点又忘了打标」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = 'dsh-memory-evolve-mod'
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

test('样式归属统一入口存在，且归属键等于包名', () => {
  const pkg = JSON.parse(read('package.json'))
  const helper = read('src/client/style-tag.ts')
  assert.equal(pkg.name, OWNER, '样式归属键必须等于 package.json 的 name（claimStyles 用的 ownerId）')
  assert.match(helper, new RegExp(`STYLE_OWNER_ID\\s*=\\s*'${OWNER}'`), 'style-tag.ts 里的归属键应与包名一致')
  assert.match(helper, /data-plugin/, 'style-tag.ts 必须写 DSH 账本读的 data-plugin 属性')
})

test('src/client 下不再有「裸注入」的 <style>（必须经过 injectOwnedStyle 或显式打标）', () => {
  const clientEntry = read('src/client/index.ts')
  assert.equal(
    /createElement\('style'\)/.test(clientEntry),
    false,
    'src/client/index.ts 不应再出现裸 createElement(\'style\')，请改用 injectOwnedStyle()',
  )
  assert.match(clientEntry, /injectOwnedStyle\('data-memory-evolve-css'/, '主样式必须走 injectOwnedStyle')
  const calls = clientEntry.match(/injectOwnedStyle\(/g) ?? []
  // 阈值下限 = 当下走统一入口的注入处数（2026-10-15 删掉技能管理页签后为 9）。
  // 新增样式注入时同步上调；下跌说明有模块的样式不再注入，别默默放过。
  assert.ok(calls.length >= 9, `主入口应有 >=9 处样式注入走统一入口，实际 ${calls.length}`)

  // 画板模块保持自包含（不跨目录 import），因此允许自己 createElement，
  // 但必须在同一个函数里显式写 data-plugin。
  const canvas = read('src/client/canvas-grok/index.ts')
  assert.match(canvas, /setAttribute\('data-plugin',\s*STYLE_OWNER\)/, '画板样式必须显式打归属')
  assert.match(canvas, new RegExp(`const STYLE_OWNER = '${OWNER}'`), '画板的归属常量必须等于包名')
})

test('构建产物 lib/client.js：每个 createElement("style") 都带上了 data-plugin', () => {
  const bundle = read('lib/client.js')
  const windows = []
  const needle = 'createElement("style")'
  let at = bundle.indexOf(needle)
  while (at !== -1) {
    windows.push(bundle.slice(Math.max(0, at - 400), at + 600))
    at = bundle.indexOf(needle, at + needle.length)
  }
  assert.ok(windows.length > 0, 'lib/client.js 里应能找到样式创建点（拿不到说明产物格式变了，请更新本用例）')
  for (const [index, window] of windows.entries()) {
    assert.match(
      window,
      /setAttribute\((?:OWNER_ATTR|"data-plugin"),\s*(?:STYLE_OWNER|STYLE_OWNER_ID|OWNER_ATTR|"dsh-memory-evolve")/,
      `lib/client.js 第 ${index + 1} 个样式创建点缺少 data-plugin 归属（会被别的插件认领并在其重载时删除）`,
    )
  }
})

test('构建产物 lib/client.js：归属键字面量就是包名（防产物与源码漂移）', () => {
  const bundle = read('lib/client.js')
  assert.match(bundle, /"dsh-memory-evolve"/, '产物里应出现归属键字面量')
  assert.equal(
    /setAttribute\("data-plugin",\s*"@deepseek-ai\/dsh-memory-evolve"/.test(bundle),
    false,
    '归属键不能被写成带 scope 的形式（Loader 条目 id 就是裸包名）',
  )
})

test('样式账本说明没有从统一入口里丢失（防止后人"简化"掉打标）', () => {
  const helper = join(ROOT, 'src', 'client', 'style-tag.ts')
  assert.equal(existsSync(helper), true, 'src/client/style-tag.ts 必须存在')
  const text = readFileSync(helper, 'utf8')
  assert.match(text, /claimStyles/, '注释里应保留 claimStyles 的来龙去脉')
  assert.match(text, /removeOwnedStyles/, '注释里应保留 removeOwnedStyles 的来龙去脉')
})
