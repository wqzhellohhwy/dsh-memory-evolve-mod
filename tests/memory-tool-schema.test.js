/**
 * memory 工具的返回值必须严格落在自己的 output.schema 内。
 *
 * 回归背景（用户实测报错）：
 *   `Error: tool "memory" returned invalid output: "value.entry" is not a declared
 *    property (additionalProperties: false)`
 * `store.addEntry()` 是库内部 API，返回里带 `entry`（新条目对象，`lib/custom-tools.js`
 * 要取 `entry.id`）；`addOne()` 的 `outcomeOnly()` 只剥了 entries/removed/matches，
 * 于是 `entry` 原样透给模型 —— DSH 严格校验直接判 invalid output，对模型表现为
 * 「kb 写入失败」，而单元测试只断言 `ok` /`message`，静默漏过。
 *
 * 同类风险：以后给 store 的返回加字段，又会静默再踩一次。所以这里不逐个断言
 * 字段，而是按 schema 递归校验**每个 action 的真实返回**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, SuggestionQueue } from '../lib/store.js'
import { memoryTool, resolveConfig } from '../lib/index.js'
import { setLocale } from '../lib/i18n.js'
import { tmproot } from './_tmp.js'

setLocale('zh')

/**
 * 按 JSON Schema 子集（type / properties / required / additionalProperties /
 * items）递归校验一个值。
 * @param {unknown} value
 * @param {object} schema
 * @param {string} path - 报错用的位置描述。
 */
function assertFitsSchema(value, schema, path) {
  if (value === undefined || value === null) return
  const type = schema.type
  if (type === 'object') {
    assert.equal(typeof value, 'object', `${path}: 期望对象`)
    assert.equal(Array.isArray(value), false, `${path}: 期望对象而不是数组`)
    const props = schema.properties ?? {}
    for (const key of Object.keys(value)) {
      if (!(key in props)) {
        assert.equal(
          schema.additionalProperties,
          true,
          `${path}.${key} 未在 output.schema 中声明（additionalProperties:false 下真模型会报 invalid output）`,
        )
        continue
      }
      assertFitsSchema(value[key], props[key], `${path}.${key}`)
    }
    for (const req of schema.required ?? []) {
      assert.ok(req in value, `${path}.${req} 是 required 但返回里没有`)
    }
    return
  }
  if (type === 'array') {
    assert.ok(Array.isArray(value), `${path}: 期望数组`)
    if (schema.items) value.forEach((item, i) => assertFitsSchema(item, schema.items, `${path}[${i}]`))
    return
  }
  if (type === 'boolean') assert.equal(typeof value, 'boolean', `${path}: 期望布尔`)
  else if (type === 'string') assert.equal(typeof value, 'string', `${path}: 期望字符串`)
  else if (type === 'integer') assert.ok(Number.isInteger(value), `${path}: 期望整数`)
  else if (type === 'number') assert.equal(typeof value, 'number', `${path}: 期望数字`)
}

function harness() {
  const dir = tmproot("dsh-mem-tool-schema-")
  const config = resolveConfig({ memoryDir: dir })
  const store = new MemoryStore(config.memoryDir, config)
  const queue = new SuggestionQueue(join(dir, 'suggestions.json'))
  const tool = memoryTool({}, config, store, queue, () => config, undefined)
  const exec = { agent: { id: 'a1', session: { id: 's1', header: { cwd: join(dir, 'proj') } } } }
  return { dir, tool, exec, store }
}

test('memory 工具：各 action 的真实返回都落在 output.schema 内', async () => {
  const { dir, tool, exec } = harness()
  try {
    const cases = [
      // add 走 store.addEntry（返回里原本带 entry）
      { action: 'add', target: 'project', content: '项目轨道一条' },
      { action: 'add', target: 'daily', content: '今日轨道一条' },
      // add 走建议队列（confirm 分组）
      { action: 'add', target: 'kb', content: '知识库一条', title: '主题', keywords: '编码', scenario: '需要时' },
      { action: 'add', target: 'user', content: '用户事实一条' },
      // 读路径
      { action: 'list', target: 'project' },
      { action: 'list', target: 'kb' },
      { action: 'list', target: 'memory' },
      // 出错路径也要合规（同样的 schema 校验）
      { action: 'add', target: 'project', content: '   ' },
      { action: 'list', target: 'nope' },
    ]
    for (const args of cases) {
      const label = `${args.action}:${args.target}`
      const value = await tool.execute(args, exec)
      assert.ok(value && typeof value === 'object', `${label}: execute 应返回对象`)
      assertFitsSchema(value, tool.output.schema, `memory(${label})`)
      // 库内部字段绝不能透给模型（回归点）
      assert.equal('entry' in value, false, `${label}: 返回里不应出现内部字段 entry`)
      assert.equal('removed' in value, false, `${label}: 返回里不应出现内部字段 removed`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
