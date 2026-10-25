/**
 * 工具定义分块（2026-10-16 用户需求）：每个工具的定义可按块启用/关闭。
 *
 * 覆盖两层：
 *   1. 纯函数（块表归一 / 按块拼描述 / target 过滤）；
 *   2. 装配级实测 —— 真的 apply 一遍插件，读注册出去的 memory / dtodo 工具定义，
 *      断言「关掉的块不出现在描述与参数 schema 里」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setLocale } from '../lib/i18n.js'
import { apply, resolveConfig } from '../lib/index.js'
import {
  TOOL_BLOCKS, blockKeyOf, composeDescription, isBlockEnabled, normalizeToolBlocks, trackEnabled,
} from '../lib/tool-blocks.js'
import { tmproot } from './_tmp.js'

setLocale('zh')

/** 最小 fake ctx（只保留 apply 注册工具需要的服务，与 plugin.test.js 同构）。 */
function fakeCtx() {
  const state = { tools: [], contexts: [], commands: [], listeners: [], routes: [] }
  const services = {
    tools: {
      register: (def) => {
        state.tools.push(def)
        return () => {
          const i = state.tools.indexOf(def)
          if (i >= 0) state.tools.splice(i, 1)
        }
      },
      get: () => undefined,
    },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    webServer: { register: (route) => { state.routes.push(route); return () => {} } },
  }
  const settingsService = { get: (ns) => (ns === 'locale' ? { preference: 'zh' } : undefined) }
  const ctx = {
    state,
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    commands: services.commands,
    webServer: services.webServer,
    on: (name, listener) => { (state.listeners[name] ??= []).push(listener); return () => {} },
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      const disposer = callback(ctx)
      return { dispose: disposer ?? (() => {}) }
    },
    effect: (fn) => fn() ?? (() => {}),
    get: (key) => services[key] ?? (key === 'settings' ? settingsService : undefined),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return ctx
}

/** 建一个带指定块开关的记忆目录。 */
function memoryDirWith(blocks) {
  const dir = tmproot('dsh-tool-blocks-')
  mkdirSync(dir, { recursive: true })
  if (blocks !== undefined) {
    writeFileSync(join(dir, 'plugin-state.json'), JSON.stringify({ toolBlocks: blocks }))
  }
  return dir
}

/** 装配一次插件并取回注册的工具定义。 */
function registerTools(blocks) {
  const dir = memoryDirWith(blocks)
  const config = resolveConfig({ memoryDir: dir, skillDir: join(dir, 'no-skills') })
  const ctx = fakeCtx()
  apply(ctx, config)
  return { config, tools: ctx.state.tools }
}

test('块表：键唯一，归一丢弃未知键与非布尔值', () => {
  const keys = TOOL_BLOCKS.map((block) => blockKeyOf(block.tool, block.id))
  assert.equal(new Set(keys).size, keys.length, '块键必须唯一')
  const normalized = normalizeToolBlocks({
    'memory.group.project': false,
    'memory.desc.nope': false,
    'memory.meta': 'yes',
  })
  assert.deepEqual(normalized, { 'memory.group.project': false })
})

test('按块拼描述：只拼启用块，缺省全开', () => {
  const dict = { 'memory.desc': 'HEAD', 'memory.desc.meta': 'META', 'memory.desc.feedback': 'FB' }
  const t = (key) => dict[key] ?? key
  const all = composeDescription({}, 'memory', t)
  assert.ok(all.startsWith('HEAD'))
  assert.ok(all.includes('META'))
  assert.ok(all.includes('FB'))
  const off = composeDescription({ 'memory.meta': false }, 'memory', t)
  assert.equal(off.includes('META'), false)
  assert.equal(off.includes('FB'), true)
  assert.equal(isBlockEnabled({ 'memory.meta': false }, 'memory', 'meta'), false)
  assert.equal(isBlockEnabled({}, 'memory', 'meta'), true)
})

test('target 过滤：关掉某个分组块，该 target 从前端 enum 里消失（逐分组、内置与自建平等）', () => {
  assert.equal(trackEnabled({}, 'memory', 'project'), true)
  assert.equal(trackEnabled({ 'memory.group.project': false }, 'memory', 'project'), false)
  assert.equal(trackEnabled({ 'memory.group.project': false }, 'memory', 'daily'), true)
  assert.equal(trackEnabled({ 'dtodo.group.daily': false }, 'dtodo', 'daily'), false)
  assert.equal(trackEnabled({ 'dtodo.group.daily': false }, 'dtodo', 'my-own-group'), true)
})

test('装配实测：默认全开，memory 描述含六轨与各动作', () => {
  const { config, tools } = registerTools(undefined)
  const tool = tools.find((item) => item.name === config.toolName)
  assert.ok(tool, 'memory 工具已注册')
  const desc = tool.description
  for (const marker of ['【全局关键记忆】', '【用户档案】', '【记忆知识库】', '【今日日志】', '【工作区日志】', '【工作区关键记忆】', '【写】', '【读】', '【归档】']) {
    assert.ok(desc.includes(marker), `默认描述应含 ${marker}`)
  }
  const params = tool.parameters
  assert.ok(params.properties.feedback, '默认有 feedback 参数')
  assert.ok(params.properties.entries, '默认有 entries 参数')
  assert.ok(params.properties.target.enum.includes('project'), '默认 enum 含 project')
})

test('装配实测：关掉「工作区日志」分组与「情绪反馈」块后，描述与参数同步消失', () => {
  const { config, tools } = registerTools({
    'memory.group.project': false,
    'memory.feedback': false,
  })
  const tool = tools.find((item) => item.name === config.toolName)
  assert.ok(tool)
  const desc = tool.description
  assert.equal(desc.includes('【工作区日志】'), false, '关掉的块不该出现在描述里')
  assert.ok(desc.includes('【今日日志】'), true, '没关的块照旧')
  const params = tool.parameters
  assert.equal(params.properties.feedback, undefined, '关掉的块专属参数应被裁掉')
  assert.equal(params.properties.target.enum.includes('project'), false, 'target enum 不该再有 project')
  assert.ok(params.properties.target.enum.includes('daily'), '其它轨照旧')
})

test('装配实测：dtodo 关掉「批量添加」块后 items 参数消失', () => {
  const { config, tools } = registerTools({ 'dtodo.batch': false })
  const tool = tools.find((item) => item.name === config.todoToolName)
  assert.ok(tool, 'dtodo 工具已注册')
  assert.equal(tool.parameters.properties.items, undefined)
  assert.ok(tool.parameters.properties.content, '其它参数照旧')
  assert.equal(tool.description.includes('【批量添加】'), false)
  // 反面校验：描述不能是空的（否则上面那句「不包含」会假通过）。
  assert.ok(tool.description.includes('【本会话】'), '默认开启的块仍应在描述里')
  assert.ok(tool.description.length > 50)
})
