/**
 * 自建工具的动作分发（lib/custom-tools.js，2026-10-15 用户需求：
 * 「工具可自由增删，新建的工具绑定内置动作」）。
 *
 * 本测试覆盖两件事：
 *   1. **行为**：每个可绑定动作都能真正落地（add 写入指定分组、search 命中、
 *      read 返回全文、remove 删除、archive↔restore 往返、todo 增删、suggest
 *      只入队不落盘、缺固定分组时报错）；
 *   2. **输出契约**：每个动作的返回值都逐字段落进 output.schema——
 *      DSH 对工具输出做严格校验（additionalProperties:false），多一个键就会
 *      "returned invalid output" 让整个工具不可用。测试里用 assertMatchesSchema
 *      模拟这套校验（多键 / 类型不符 / 缺 required 都判失败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveStore, MemoryStore, SuggestionQueue } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'
import { loadGroups } from '../lib/groups.js'
import { buildCustomTools } from '../lib/custom-tools.js'
import { tmproot } from './_tmp.js'

/** 造一条自建工具配置（与 tools.json 的 custom[] 同形）。 */
function customTool(name, kind, fixed = {}) {
  return {
    id: `t${name}`.replace(/[^a-z0-9]/g, '').slice(0, 9),
    name,
    description: `${name}：绑定动作 ${kind}`,
    params: null,
    action: { kind, fixed },
  }
}

/** 递归校验：值必须完全落进 schema（无多余键、类型一致、required 齐全）。 */
function assertMatchesSchema(value, schema, path = '$') {
  if (schema.type === 'object') {
    assert.equal(typeof value, 'object', `${path} 应为对象`)
    assert.notEqual(value, null, `${path} 不应为 null`)
    const properties = schema.properties ?? {}
    for (const key of Object.keys(value)) {
      assert.ok(Object.hasOwn(properties, key), `${path}.${key} 未在 output schema 中声明（会触发 invalid output）`)
      if (value[key] === undefined) assert.fail(`${path}.${key} 的值为 undefined（schema 校验不通过）`)
    }
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(value, key), `${path}.${key} 缺失（required）`)
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) assertMatchesSchema(value[key], child, `${path}.${key}`)
    }
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path} 应为数组`)
    if (schema.items) value.forEach((item, index) => assertMatchesSchema(item, schema.items, `${path}[${index}]`))
    return
  }
  if (schema.type === 'string') assert.equal(typeof value, 'string', `${path} 应为字符串`)
  if (schema.type === 'integer') assert.ok(Number.isInteger(value), `${path} 应为整数`)
  if (schema.type === 'number') assert.equal(typeof value, 'number', `${path} 应为数字`)
  if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${path} 应为布尔`)
}

/**
 * 搭一个真实数据面：临时记忆目录 + tools.json + store/archive/todo/queue，
 * 再用 buildCustomTools 编译出自建工具。`call` 每次都会校验输出 schema。
 */
function setup(customTools, options = {}) {
  const dir = tmproot("dsh-custom-tools-")
  writeFileSync(join(dir, 'tools.json'), JSON.stringify({ version: 1, overrides: {}, custom: customTools }, null, 2))
  const store = new MemoryStore(dir, { entryIdMode: options.entryIdMode ?? 'off' })
  const archive = new ArchiveStore(dir)
  const todoStore = new TodoStore(dir)
  const queue = new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl'))
  const tools = buildCustomTools({
    memoryDir: dir,
    store,
    archive,
    todoStore,
    queue,
    getGroups: () => loadGroups(dir),
  })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return {
    dir,
    store,
    archive,
    todoStore,
    queue,
    tools,
    byName,
    async call(name, args = {}, agent) {
      const tool = byName.get(name)
      assert.ok(tool, `工具 ${name} 未注册`)
      const value = await tool.execute(args, { agent })
      assertMatchesSchema(value, tool.output.schema, `${name} 输出`)
      // render 也必须能跑（DSH 用渲染文本给模型看）
      const rendered = tool.output.render(args, value)
      assert.equal(rendered[0].type, 'text')
      assert.equal(typeof rendered[0].text, 'string')
      assert.ok(rendered[0].text.length > 0)
      return value
    },
  }
}

test('add：把内容写进 action.fixed.group 指定的分组', async () => {
  const h = setup([customTool('kb_add', 'add', { group: 'kb' })])
  try {
    const value = await h.call('kb_add', { body: '某 API 的鉴权流程：先取 token 再带 Bearer 头' })
    assert.equal(value.ok, true)
    assert.equal(value.action, 'add')
    assert.equal(value.target, 'kb')
    assert.equal(value.count, 1)
    assert.notEqual(value.id, '')
    assert.equal(h.store.entriesOf('kb').length, 1)
    assert.equal(h.store.entriesOf('memory').length, 0)
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('search：命中已写入条目并返回规范化结果行', async () => {
  const h = setup([
    customTool('kb_add', 'add', { group: 'kb' }),
    customTool('kb_search', 'search', { group: 'kb' }),
  ])
  try {
    await h.call('kb_add', { body: '某 API 的鉴权流程：先取 token 再带 Bearer 头' })
    const value = await h.call('kb_search', { query: 'Bearer' })
    assert.equal(value.ok, true)
    assert.equal(value.action, 'search')
    assert.equal(value.count, 1)
    assert.equal(value.results.length, 1)
    assert.equal(value.results[0].group, 'kb')
    assert.ok(value.results[0].title.length > 0)
    assert.ok(value.results[0].snippet.includes('Bearer'))
    // 不命中的关键词：仍 ok=true，但 0 条
    const miss = await h.call('kb_search', { query: '不存在的关键词xyz' })
    assert.equal(miss.count, 0)
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('read：按 match 与 id 都能取回条目全文', async () => {
  const h = setup([
    customTool('kb_add', 'add', { group: 'kb' }),
    customTool('kb_read', 'read', { group: 'kb' }),
  ])
  try {
    const added = await h.call('kb_add', { body: '某 API 的鉴权流程：先取 token 再带 Bearer 头' })
    const byMatch = await h.call('kb_read', { match: '鉴权流程' })
    assert.equal(byMatch.ok, true)
    assert.equal(byMatch.count, 1)
    assert.equal(byMatch.entries.length, 1)
    assert.match(byMatch.entries[0], /先取 token 再带 Bearer 头/)
    // 展示剥离：身份证不出现在模型可见输出里
    assert.equal(byMatch.entries[0].includes(`[id:${added.id}]`), false)
    // 按 id 也能定位同一条（add 返回的 id 就是条目身份证）
    const byId = await h.call('kb_read', { id: added.id })
    assert.equal(byId.ok, true)
    assert.equal(byId.entries[0], byMatch.entries[0])
    assert.equal(byId.id, added.id)
    // 没给定位参数 → 明确报错而不是静默返回空
    const nothing = await h.call('kb_read', {})
    assert.equal(nothing.ok, false)
    assert.match(nothing.message, /定位/)
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('remove：按唯一子串删除条目', async () => {
  const h = setup([
    customTool('kb_add', 'add', { group: 'kb' }),
    customTool('kb_remove', 'remove', { group: 'kb' }),
  ])
  try {
    await h.call('kb_add', { body: '待删除的条目：临时结论' })
    await h.call('kb_add', { body: '保留的条目：永久结论' })
    const value = await h.call('kb_remove', { match: '临时结论' })
    assert.equal(value.ok, true)
    assert.equal(value.count, 1)
    const left = h.store.entriesOf('kb').map((entry) => entry).join('\n')
    assert.match(left, /永久结论/)
    assert.equal(left.includes('临时结论'), false)
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('archive → restore：归档后主轨为空，转正后回到主轨且归档清空', async () => {
  const h = setup([
    customTool('kb_add', 'add', { group: 'kb' }),
    customTool('kb_archive', 'archive', { group: 'kb' }),
    customTool('kb_restore', 'restore', { group: 'kb' }),
  ])
  try {
    await h.call('kb_add', { body: '冷知识：某库的默认超时是 30 秒' })
    const archived = await h.call('kb_archive', { match: '默认超时' })
    assert.equal(archived.ok, true)
    assert.equal(archived.count, 1)
    assert.equal(h.store.entriesOf('kb').length, 0)
    assert.equal(h.archive.entriesOf('kb').length, 1)

    const restored = await h.call('kb_restore', { match: '默认超时' })
    assert.equal(restored.ok, true)
    assert.equal(h.store.entriesOf('kb').length, 1)
    assert.equal(h.archive.entriesOf('kb').length, 0)
    assert.match(h.store.entriesOf('kb')[0], /默认超时是 30 秒/)
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('输出 schema 与返回值字段完全一致（每个动作都不出现 invalid output 的形状）', async () => {
  const h = setup([
    customTool('kb_add', 'add', { group: 'kb' }),
    customTool('kb_search', 'search', { group: 'kb' }),
    customTool('kb_list', 'list', { group: 'kb' }),
    customTool('kb_read', 'read', { group: 'kb' }),
    customTool('kb_update', 'update', { group: 'kb' }),
    customTool('kb_archive', 'archive', { group: 'kb' }),
    customTool('kb_restore', 'restore', { group: 'kb' }),
    customTool('kb_remove', 'remove', { group: 'kb' }),
    customTool('todo_global', 'todo', { group: 'global' }),
    customTool('kb_suggest', 'suggest', { group: 'kb' }),
  ])
  try {
    await h.call('kb_add', { body: '契约用条目：关键词 ZEBRA' })
    // 每个动作都跑一遍：h.call 内部即做 schema 校验（多余键 / 类型 / required）
    const outcomes = [
      await h.call('kb_search', { query: 'ZEBRA' }),
      await h.call('kb_list', {}),
      await h.call('kb_read', { match: 'ZEBRA' }),
      await h.call('kb_update', { match: 'ZEBRA', body: '契约用条目：关键词 ZEBRA 已改写' }),
      await h.call('kb_suggest', { body: '契约用建议' }),
      await h.call('todo_global', { body: '契约用待办' }),
      await h.call('todo_global', {}),
      await h.call('kb_archive', { match: 'ZEBRA' }),
      await h.call('kb_restore', { match: 'ZEBRA' }),
      await h.call('kb_remove', { match: 'ZEBRA' }),
      // 失败路径同样要过 schema
      await h.call('kb_read', {}),
      await h.call('kb_remove', {}),
    ]
    for (const value of outcomes) {
      assert.equal(typeof value.ok, 'boolean')
      assert.equal(typeof value.message, 'string')
      assert.notEqual(value.message, '')
    }
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('promote：条目从固定分组搬到目标分组（源清空、目标到位）', async () => {
  const h = setup([
    customTool('kb_add', 'add', { group: 'kb' }),
    customTool('kb_promote', 'promote', { group: 'kb' }),
  ])
  try {
    await h.call('kb_add', { body: '值得提升的事实：生产库只读' })
    // 目标分组用 query 传（通用 schema 只有五个参数，promote 里 query 不作他用）
    const value = await h.call('kb_promote', { match: '生产库只读', query: 'memory' })
    assert.equal(value.ok, true)
    assert.equal(value.target, 'memory')
    assert.equal(value.count, 1)
    assert.equal(h.store.entriesOf('kb').length, 0)
    assert.equal(h.store.entriesOf('memory').length, 1)
    assert.match(h.store.entriesOf('memory')[0], /生产库只读/)
    // 目标分组缺失 → 报错路径
    const missing = await h.call('kb_promote', { match: '生产库只读' })
    assert.equal(missing.ok, false)
    assert.match(missing.message, /目标分组/)
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('缺 action.fixed.group：写入类动作走报错路径而不是瞎写', async () => {
  const h = setup([
    customTool('loose_add', 'add'),
    customTool('loose_read', 'read'),
    customTool('loose_todo', 'todo'),
  ])
  try {
    const added = await h.call('loose_add', { body: '不该被写入的内容' })
    assert.equal(added.ok, false)
    assert.match(added.message, /未指定写入分组/)
    assert.equal(h.store.entriesOf('kb').length, 0)
    assert.equal(h.store.entriesOf('memory').length, 0)

    const read = await h.call('loose_read', { match: 'x' })
    assert.equal(read.ok, false)
    assert.match(read.message, /未指定分组/)

    const todo = await h.call('loose_todo', { body: 'x' })
    assert.equal(todo.ok, false)
    assert.match(todo.message, /未指定待办分组/)
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('todo：新增 / 列表 / 完成 / 删除', async () => {
  const h = setup([customTool('todo_global', 'todo', { group: 'global' })])
  try {
    const added = await h.call('todo_global', { body: '写自建工具测试' })
    assert.equal(added.ok, true)
    assert.notEqual(added.id, '')

    const listed = await h.call('todo_global', {})
    assert.equal(listed.ok, true)
    assert.equal(listed.count, 1)
    assert.match(listed.entries[0], /写自建工具测试/)

    const done = await h.call('todo_global', { id: added.id, match: 'done' })
    assert.equal(done.ok, true)

    const removed = await h.call('todo_global', { id: added.id, match: 'remove' })
    assert.equal(removed.ok, true)
    const after = await h.call('todo_global', {})
    assert.equal(after.count, 0)
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('suggest：只进待确认队列，不直接落盘', async () => {
  const h = setup([customTool('kb_suggest', 'suggest', { group: 'kb' })])
  try {
    const value = await h.call('kb_suggest', { body: '值得记住的候选事实' })
    assert.equal(value.ok, true)
    assert.equal(value.count, 1)
    assert.equal(h.queue.read().length, 1)
    assert.equal(h.store.entriesOf('kb').length, 0)
    // 缺 body → 明确报错
    const empty = await h.call('kb_suggest', {})
    assert.equal(empty.ok, false)
    assert.match(empty.message, /body/)
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('名字与内置工具冲突的自建定义被跳过（不覆盖内置工具）', async () => {
  const h = setup([
    customTool('memory', 'add', { group: 'kb' }),
    customTool('kb_add', 'add', { group: 'kb' }),
  ])
  try {
    assert.equal(h.byName.has('memory'), false)
    assert.equal(h.byName.has('kb_add'), true)
    assert.equal(h.tools.length, 1)
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})

test('底层异常转成结构化失败（不把错误抛给 DSH）', async () => {
  // project 类分组需要会话 cwd；不给 cwd 时 store 会抛错，分发层必须兜住
  const h = setup([customTool('key_add', 'add', { group: 'key' })])
  try {
    const value = await h.call('key_add', { body: '项目关键记忆' })
    assert.equal(value.ok, false)
    assert.equal(typeof value.message, 'string')
    assert.notEqual(value.message, '')
  } finally {
    rmSync(h.dir, { recursive: true, force: true })
  }
})
