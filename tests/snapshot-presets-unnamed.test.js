/**
 * tests/snapshot-presets-unnamed.test.js — 储备文案允许"无名称"（2026-10-19）。
 *
 * 前端允许先存内容、后补名字，所以 host 不得因 `name === ''` 拒写或丢条目。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmproot } from './_tmp.js'
import {
  PRESET_NAME_MAX,
  loadPresets,
  normalizePresets,
  presetsFileOf,
  savePresets,
  upsertPreset,
} from '../lib/snapshot-presets.js'

const newDir = () => tmproot('dsh-preset-unnamed-')

test('upsertPreset 允许空 name：ok，落盘后读回 name === ""', () => {
  const dir = newDir()
  const created = upsertPreset(loadPresets(dir), { name: '', text: '未命名文案' })
  assert.equal(created.ok, true)
  assert.equal(created.item.name, '')
  assert.equal(created.item.text, '未命名文案')
  assert.ok(created.item.id.startsWith('p'))

  assert.equal(savePresets(dir, created.data), true)
  const reloaded = loadPresets(dir)
  assert.equal(reloaded.items.length, 1)
  assert.equal(reloaded.items[0].name, '')
  assert.equal(reloaded.items[0].text, '未命名文案')
  assert.equal(reloaded.items[0].id, created.item.id)
})

test('读盘时空 name 条目被保留（不被丢弃）', () => {
  const dir = newDir()
  const file = presetsFileOf(dir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({
    version: 1,
    items: [
      { id: 'p000001', name: '', text: 'a' },
      { id: 'p000002', name: '   ', text: 'b' },
      { id: 'p000003', name: '有名字', text: 'c' },
    ],
  }))
  const loaded = loadPresets(dir)
  assert.equal(loaded.items.length, 3)
  assert.deepEqual(loaded.items.map((item) => item.name), ['', '', '有名字'])
  assert.deepEqual(loaded.items.map((item) => item.text), ['a', 'b', 'c'])
})

test('空 name + 空 text 也允许（host 不拒）', () => {
  const dir = newDir()
  const created = upsertPreset(loadPresets(dir), { name: '', text: '' })
  assert.equal(created.ok, true)
  assert.equal(savePresets(dir, created.data), true)
  const reloaded = loadPresets(dir)
  assert.equal(reloaded.items.length, 1)
  assert.deepEqual({ name: reloaded.items[0].name, text: reloaded.items[0].text }, { name: '', text: '' })
})

test('后续可按 id 把空名改成有名字（长名按 PRESET_NAME_MAX 截断）', () => {
  const dir = newDir()
  const created = upsertPreset(loadPresets(dir), { name: '', text: 'x' })
  assert.equal(created.ok, true)
  savePresets(dir, created.data)

  const longName = '长'.repeat(PRESET_NAME_MAX + 10)
  const renamed = upsertPreset(loadPresets(dir), { id: created.item.id, name: longName, text: 'x2' })
  assert.equal(renamed.ok, true)
  assert.equal(renamed.item.name.length, PRESET_NAME_MAX)
  assert.equal(renamed.item.text, 'x2')
  savePresets(dir, renamed.data)

  const reloaded = loadPresets(dir)
  assert.equal(reloaded.items.length, 1)
  assert.equal(reloaded.items[0].id, created.item.id)
  assert.equal(reloaded.items[0].name.length, PRESET_NAME_MAX)
})

test('normalizePresets：非对象条目仍丢弃，对象条目一律保留', () => {
  const normalized = normalizePresets({
    version: 1,
    items: [null, 'x', 42, { name: '', text: 'keep' }, {}],
  })
  assert.equal(normalized.items.length, 2)
  assert.equal(normalized.items[0].text, 'keep')
  assert.equal(normalized.items[1].name, '')
  assert.equal(normalized.items[1].text, '')
})

test('文件确实落在 .system/ 下（旧位置不留文件）', () => {
  const dir = newDir()
  const created = upsertPreset(loadPresets(dir), { name: '', text: 'x' })
  savePresets(dir, created.data)
  const file = presetsFileOf(dir)
  assert.equal(file, join(dir, '.system', 'snapshot-presets.json'))
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items[0].name, '')
})
