/**
 * 开局提示词的「储备文案」（2026-10-19 用户需求）。
 *
 * 每轮注入的那段固定指导文案，用户除了当前生效的一份，还能**备多份**：
 * 存成列表，需要时一键启用其中一份（启用 = 把它的 text 写进运行时配置
 * `snapshotPrompt`，注入逻辑完全不用改）。
 *
 * 存储：`<memoryDir>/snapshot-presets.json`
 *   { "version": 1, "items": [ { "id": "p3f2a1", "name": "长版", "text": "…" } ] }
 *
 * 不校验"当前启用的是哪一份"——启用状态由 `snapshotPrompt` 与 item.text 是否
 * 相同来体现（用户在设置面板直接改文本时，启用态自然失效，符合直觉）。
 *
 * @module dsh-memory-evolve/snapshot-presets
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { systemDirOf } from './groups.js'

export const PRESETS_VERSION = 1

/** 名字长度上限。 */
export const PRESET_NAME_MAX = 60

/** 文案长度上限（与运行时配置 snapshotPrompt 的校验一致）。 */
export const PRESET_TEXT_MAX = 20000

/**
 * 储备文案文件路径。
 * @param {string} memoryDir - 记忆根目录。
 */
export function presetsFileOf(memoryDir) {
  return join(systemDirOf(memoryDir), 'snapshot-presets.json')
}

/** 新 id（`p` + 6 位十六进制）。 */
export function newPresetId() {
  return `p${randomBytes(3).toString('hex')}`
}

/**
 * 归一化一条：名字/文案都裁空白。**允许空名字**（前端允许"未命名"储备文案），
 * 只有不是对象的条目才丢弃。
 */
function normalizeItem(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, PRESET_NAME_MAX) : ''
  const text = typeof raw.text === 'string' ? raw.text.slice(0, PRESET_TEXT_MAX) : ''
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : newPresetId()
  return { id, name, text }
}

/**
 * 把磁盘数据归一成可信形状（坏数据只降级不抛）。
 * @param {unknown} raw - 解析后的 JSON。
 * @returns {{version: number, items: Array<{id: string, name: string, text: string}>}}
 */
export function normalizePresets(raw) {
  const empty = { version: PRESETS_VERSION, items: [] }
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.items)) return empty
  const items = []
  const seen = new Set()
  for (const entry of raw.items) {
    const item = normalizeItem(entry)
    if (item === null) continue
    if (seen.has(item.id)) item.id = newPresetId()
    seen.add(item.id)
    items.push(item)
  }
  return { version: PRESETS_VERSION, items }
}

/**
 * 读储备文案（文件缺失/损坏 → 空表，绝不抛）。
 * @param {string} memoryDir - 记忆根目录。
 */
export function loadPresets(memoryDir) {
  const file = presetsFileOf(memoryDir)
  if (!existsSync(file)) return { version: PRESETS_VERSION, items: [] }
  try {
    return normalizePresets(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { version: PRESETS_VERSION, items: [] }
  }
}

/**
 * 原子写（失败返回 false，不抛）。
 * @param {string} memoryDir - 记忆根目录。
 * @param {object} data - normalizePresets 形状。
 */
export function savePresets(memoryDir, data) {
  const file = presetsFileOf(memoryDir)
  try {
    mkdirSync(systemDirOf(memoryDir), { recursive: true })
    const tmp = `${file}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(normalizePresets(data), null, 2) + '\n')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 新建或更新一条储备文案。
 * @param {object} data - loadPresets 结果。
 * @param {{id?: string, name?: string, text?: string}} input - 带 id 则更新，否则新建。
 * @returns {{ok: boolean, error?: string, item?: object, data?: object}}
 */
export function upsertPreset(data, input) {
  const current = normalizePresets(data)
  const id = typeof input?.id === 'string' && input.id.trim() !== '' ? input.id.trim() : null
  const name = typeof input?.name === 'string' ? input.name.trim().slice(0, PRESET_NAME_MAX) : ''
  if (typeof input?.text === 'string' && input.text.length > PRESET_TEXT_MAX) return { ok: false, error: 'TEXT_TOO_LONG' }
  const text = typeof input?.text === 'string' ? input.text : ''
  if (id === null) {
    const item = { id: newPresetId(), name, text }
    return { ok: true, item, data: { version: PRESETS_VERSION, items: [...current.items, item] } }
  }
  const index = current.items.findIndex((entry) => entry.id === id)
  if (index < 0) return { ok: false, error: 'NOT_FOUND' }
  const items = current.items.map((entry) => (entry.id === id ? { ...entry, name, text } : entry))
  return { ok: true, item: items[index], data: { version: PRESETS_VERSION, items } }
}

/**
 * 删除一条储备文案。
 * @param {object} data - loadPresets 结果。
 * @param {string} id - 条目 id。
 */
export function removePreset(data, id) {
  const current = normalizePresets(data)
  const key = typeof id === 'string' ? id.trim() : ''
  if (!current.items.some((entry) => entry.id === key)) return { ok: false, error: 'NOT_FOUND' }
  return {
    ok: true,
    data: { version: PRESETS_VERSION, items: current.items.filter((entry) => entry.id !== key) },
  }
}

/**
 * 取某条储备文案（找不到返回 null）。
 * @param {object} data - loadPresets 结果。
 * @param {string} id - 条目 id。
 */
export function findPreset(data, id) {
  const key = typeof id === 'string' ? id.trim() : ''
  return normalizePresets(data).items.find((entry) => entry.id === key) ?? null
}
