/**
 * T-3 配套：更新 4 个断言旧文案的测试文件（「项目」→「工作区」）。
 *
 * T-3 只改源码、按约定没碰测试，于是这 4 个文件里写死的旧文案失败。
 * 这里**只在这 4 个文件**里做字面替换，不动任何断言逻辑与强度。
 * 默认干跑，--write 才写。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const FILES = ['tests/coi.test.js', 'tests/i18n.test.js', 'tests/plugin.test.js', 'tests/memory-tab.test.js']
const PAIRS = [
  ['本项目关键记忆', '本工作区关键记忆'],
  ['本项目的关键记忆', '本工作区的关键记忆'],
  ['重要项目事实', '重要工作区事实'],
  ['项目日志', '工作区日志'],
  ['Project log', 'Workspace log'],
  ['Key project facts', 'Key workspace facts'],
  ["This project's key memories", "This workspace's key memories"],
]

const write = process.argv.includes('--write')
let total = 0
for (const path of FILES) {
  const src = readFileSync(path, 'utf8')
  let next = src
  const hits = []
  for (const [from, to] of PAIRS) {
    const count = next.split(from).length - 1
    if (count > 0) {
      hits.push(`${from}×${count}`)
      next = next.split(from).join(to)
    }
  }
  if (hits.length === 0) continue
  total += hits.length
  console.log(`${write ? '写入' : '命中'} ${path}: ${hits.join(' / ')}`)
  if (write) writeFileSync(path, next, 'utf8')
}
console.log(`\n共 ${total} 组替换${write ? '（已写入）' : '（干跑；加 --write 才写）'}`)
