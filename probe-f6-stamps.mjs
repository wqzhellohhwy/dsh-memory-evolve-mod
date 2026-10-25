/**
 * F-6 配套：把测试里「只到日期」的时间戳正则放宽为「日期 + 可选时分」。
 *
 * 背景：lib/store.js 的 timeStampOf 从 2026-10-15 起对**所有**记忆条目输出
 * `[YYYY-MM-DD HH:MM]`（此前非日志型只有 `[YYYY-MM-DD]`），于是断言旧格式的
 * 用例批量失败。这里只动**测试里的字面正则**，不动任何断言逻辑。
 *
 * 默认**干跑**：只报告每个文件命中几处；加 --write 才真写。
 * 用 String.raw 写模式串，避免转义地狱（这就是当初要这个脚本的原因）。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const FROM = String.raw`\[\d{4}-\d{2}-\d{2}\]`
const TO = String.raw`\[\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?\]`
const write = process.argv.includes('--write')

let totalFiles = 0
let totalHits = 0
for (const name of readdirSync('tests').filter((f) => f.endsWith('.test.js'))) {
  const path = `tests/${name}`
  const src = readFileSync(path, 'utf8')
  const hits = src.split(FROM).length - 1
  if (hits === 0) continue
  totalFiles += 1
  totalHits += hits
  console.log(`${write ? '写入' : '命中'} ${name}: ${hits} 处`)
  if (write) writeFileSync(path, src.split(FROM).join(TO), 'utf8')
}
console.log(`\n合计 ${totalFiles} 个文件 / ${totalHits} 处${write ? '（已写入）' : '（干跑，未写入；加 --write 才写）'}`)
