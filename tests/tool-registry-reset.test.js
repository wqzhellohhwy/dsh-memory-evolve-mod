/**
 * dsh-memory-evolve — 「工具定义」恢复默认（2026-10-15 用户需求）。
 *
 * 覆盖 lib/tool-registry.js 的 resetToolsConfig：all / builtin / 具体工具名
 * 三个 scope 分支，外加「内置工具定义确实回到出厂值」「自建工具确实消失」
 * 「tools.json 里的未来扩展字段不被删」三条断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listToolCatalog, loadToolsConfig, resetToolsConfig, saveToolsConfig, toolsFileOf,
} from '../lib/tool-registry.js'
import { tmproot } from './_tmp.js'

/** 出厂内置工具定义（与 index.js 传给 /api/tools 的形状一致）。 */
function builtinTools() {
  return [
    { id: 'memory', name: 'memory', description: '记忆工具出厂描述', params: [{ key: 'action', description: '要执行的操作' }] },
    { id: 'skill_manage', name: 'skill_manage', description: '技能工具出厂描述', params: [] },
  ]
}

/** 建一个临时记忆目录；`raw` 给了就写一份 tools.json。 */
function setupFile(raw) {
  const dir = tmproot("dsh-tools-reset-")
  if (raw !== undefined) writeFileSync(toolsFileOf(dir), `${JSON.stringify(raw, null, 2)}\n`)
  return dir
}

/** 磁盘原始 JSON（不经过归一，看未来扩展字段还在不在）。 */
function rawOf(dir) {
  return JSON.parse(readFileSync(toolsFileOf(dir), 'utf8'))
}

/** 一份「用户改过」的配置：两个内置覆盖 + 两个自建工具 + 未来扩展字段。 */
function dirtyConfig() {
  return {
    version: 1,
    futureField: { note: '未来扩展字段，reset 不能删' },
    overrides: {
      memory: {
        enabled: false,
        name: 'mem',
        description: '改过的描述',
        params: { action: '改过的参数说明' },
        futureOverrideKey: '未来扩展子字段',
      },
      skill_manage: { name: 'skill2' },
    },
    custom: [
      { id: 't0001', name: 'search_kb', description: '查知识库', params: ['query'], action: { kind: 'search', fixed: { group: 'kb' } } },
      { id: 't0002', name: 'keep_archive', description: '归档条目', params: null, action: { kind: 'archive', fixed: {} } },
    ],
  }
}

/** 内置工具此刻是不是出厂样子（名字 / 描述 / 启用态 / 参数说明全一致）。 */
function assertFactoryBuiltins(dir) {
  const catalog = listToolCatalog(dir, builtinTools())
  for (const tool of catalog.builtin) {
    assert.equal(tool.name, tool.defaultName, `${tool.id} 名字未回到出厂值`)
    assert.equal(tool.description, tool.defaultDescription, `${tool.id} 描述未回到出厂值`)
    assert.equal(tool.enabled, true, `${tool.id} 未回到启用态`)
    for (const param of tool.params) {
      assert.equal(param.description, param.defaultDescription, `${tool.id}.${param.key} 参数说明未回到出厂值`)
    }
  }
}

test('resetToolsConfig: 缺省 scope=all 恢复出厂（清覆盖 + 删自建工具）并返回被删清单', () => {
  const dir = setupFile(dirtyConfig())
  try {
    const result = resetToolsConfig(dir)
    assert.equal(result.ok, true)
    assert.equal(result.scope, 'all')
    assert.deepEqual(result.cleared.sort(), ['memory', 'skill_manage'])
    assert.deepEqual(result.removedCustom.sort(), ['keep_archive', 'search_kb'])

    const config = loadToolsConfig(dir)
    assert.deepEqual(config.overrides, {}, 'all 应清空全部内置覆盖')
    assert.deepEqual(config.custom, [], 'all 应删掉全部自建工具')
    assertFactoryBuiltins(dir)

    const raw = rawOf(dir)
    assert.deepEqual(raw.custom, [], '文件里的自建工具应确实消失')
    assert.deepEqual(raw.futureField, { note: '未来扩展字段，reset 不能删' }, '顶层未来扩展字段被破坏了')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resetToolsConfig: scope=builtin 只清内置覆盖，自建工具与未知字段都留着', () => {
  const dir = setupFile(dirtyConfig())
  try {
    const result = resetToolsConfig(dir, { scope: 'builtin' })
    assert.equal(result.ok, true)
    assert.equal(result.scope, 'builtin')
    assert.deepEqual(result.cleared.sort(), ['memory', 'skill_manage'])
    assert.deepEqual(result.removedCustom, [], 'builtin 不该删自建工具')

    const config = loadToolsConfig(dir)
    assert.deepEqual(config.overrides, {})
    assert.deepEqual(config.custom.map((tool) => tool.name).sort(), ['keep_archive', 'search_kb'])
    assertFactoryBuiltins(dir)

    const raw = rawOf(dir)
    assert.equal(raw.futureField.note, '未来扩展字段，reset 不能删')
    assert.equal(raw.custom.length, 2, '自建工具条目应原样保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resetToolsConfig: 传具体工具名只清该工具的覆盖，其余覆盖与自建工具不动', () => {
  const dir = setupFile(dirtyConfig())
  try {
    const result = resetToolsConfig(dir, { scope: 'memory' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.cleared, ['memory'])
    assert.deepEqual(result.removedCustom, [])

    const config = loadToolsConfig(dir)
    assert.deepEqual(Object.keys(config.overrides), ['skill_manage'], '只该清掉 memory 的覆盖')
    assert.equal(config.custom.length, 2)
    assert.equal(config.custom[0].name, 'search_kb')

    // memory 回到出厂定义，skill_manage 的改名覆盖仍在
    const catalog = listToolCatalog(dir, builtinTools())
    const memory = catalog.builtin.find((tool) => tool.id === 'memory')
    const skill = catalog.builtin.find((tool) => tool.id === 'skill_manage')
    assert.equal(memory.name, 'memory')
    assert.equal(memory.description, '记忆工具出厂描述')
    assert.equal(memory.enabled, true)
    assert.equal(skill.name, 'skill2')

    const raw = rawOf(dir)
    assert.equal(raw.overrides.memory, undefined)
    assert.equal(raw.overrides.skill_manage.futureOverrideKey ?? null, null)
    assert.equal(raw.futureField.note, '未来扩展字段，reset 不能删')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resetToolsConfig: 指定工具名没有覆盖时返回空清单（不报错、不写坏文件）', () => {
  const dir = setupFile(dirtyConfig())
  try {
    const before = rawOf(dir)
    const result = resetToolsConfig(dir, { scope: 'nope' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.cleared, [])
    assert.deepEqual(result.removedCustom, [])
    assert.deepEqual(rawOf(dir), before, '没有改动时配置内容应保持一致')
    assert.equal(loadToolsConfig(dir).custom.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resetToolsConfig: tools.json 缺失时按出厂状态返回空清单并落盘', () => {
  const dir = setupFile(undefined)
  try {
    const result = resetToolsConfig(dir)
    assert.equal(result.ok, true)
    assert.deepEqual(result.cleared, [])
    assert.deepEqual(result.removedCustom, [])
    const config = loadToolsConfig(dir)
    assert.deepEqual(config.overrides, {})
    assert.deepEqual(config.custom, [])
    assertFactoryBuiltins(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resetToolsConfig: scope 类型非法（数字 / null）回落 all', () => {
  const dir = setupFile(dirtyConfig())
  try {
    const result = resetToolsConfig(dir, { scope: 123 })
    assert.equal(result.scope, 'all')
    assert.deepEqual(result.cleared.sort(), ['memory', 'skill_manage'])
    assert.deepEqual(result.removedCustom.sort(), ['keep_archive', 'search_kb'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resetToolsConfig: 全部清完后再恢复一次不报错（幂等）', () => {
  const dir = setupFile(undefined)
  try {
    saveToolsConfig(dir, { version: 1, overrides: { memory: { name: 'mem' } }, custom: [] })
    assert.equal(resetToolsConfig(dir, { scope: 'all' }).ok, true)
    const again = resetToolsConfig(dir, { scope: 'all' })
    assert.equal(again.ok, true)
    assert.deepEqual(again.cleared, [])
    assert.deepEqual(again.removedCustom, [])
    assertFactoryBuiltins(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
