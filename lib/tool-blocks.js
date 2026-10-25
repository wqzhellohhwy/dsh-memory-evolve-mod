/**
 * 工具定义分块（2026-10-16 用户需求）：每个工具的定义拆成若干**块**，可逐块启用。
 *
 * 两类块：
 *   1. **静态块**（本文件的 `TOOL_BLOCKS`）：动作用法、元数据参数、批量写、情绪反馈；
 *   2. **分组块**（`group.<分组id>`，运行时从分组配置生成）：**每个分组一块**，
 *      内置分组与用户自建分组完全平等 —— 没有"必须存在"的分组，插件自带分组只是
 *      不能删、不能改 id，其余与自建分组一样，都能单独开关。
 *
 * 关掉一块的效果（三件事同时发生）：
 *   - 描述里那一段消失；
 *   - `target` 的候选值（enum）里那个分组消失；
 *   - 该块专属的参数从 schema 里删掉。
 *
 * 启用状态存运行时配置 `toolBlocks`（形如 `{ "memory.group.kb": false }`），缺省全开；
 * `normalizeToolBlocks` 只认已知静态键与 `<工具>.group.<分组id>` 形式的分组键。
 *
 * @module dsh-memory-evolve/tool-blocks
 */

/**
 * 静态块表（分组块是动态的，不在这里）。`tool` = 工具 id；`id` = 块 id；
 * `label` 进配置页，一眼看出关掉会失去什么。
 */
export const TOOL_BLOCKS = [
  // ---- memory（写入目标 = 分组，逐分组开关，见 groupBlockId）----
  { tool: 'memory', id: 'actions.write', label: '动作：add / replace / remove' },
  { tool: 'memory', id: 'actions.query', label: '动作：list / expand 与其筛选参数' },
  { tool: 'memory', id: 'actions.archive', label: '动作：archive 与查归档' },
  { tool: 'memory', id: 'meta', label: '元数据参数：title / summary / keywords / scenario' },
  { tool: 'memory', id: 'batch', label: '收尾批量写：entries（每日 + 工作区一次调用）' },
  { tool: 'memory', id: 'feedback', label: '情绪反馈：feedback 参数' },
  // ---- dtodo（待办目标 = 分组，同样逐分组开关）----
  { tool: 'dtodo', id: 'quadrant', label: '四象限：important / urgent / quadrant' },
  { tool: 'dtodo', id: 'due', label: '截止日期：due' },
  { tool: 'dtodo', id: 'past', label: '过往与过期：past / expired' },
  { tool: 'dtodo', id: 'batch', label: '批量添加：items' },
  // ---- memory_search ----
  { tool: 'memory_search', id: 'core', label: '基础检索（按元数据与摘要）' },
  { tool: 'memory_search', id: 'filters', label: '筛选参数：limit / includeArchived' },
  // ---- 其余工具各一块 ----
  { tool: 'memory_suggest', id: 'core', label: '提交待确认建议' },
  { tool: 'memory_review_status', id: 'core', label: '记忆审查状态' },
  { tool: 'memory_library', id: 'core', label: '记忆库管理动作' },
]

/** 分组块的 id 前缀（`group.<分组id>`）。 */
export const GROUP_BLOCK_PREFIX = 'group.'

/** 分组块的块 id。 */
export function groupBlockId(groupId) {
  return `${GROUP_BLOCK_PREFIX}${groupId}`
}

/** 分组块键的形状：`<工具>.group.<分组id>`。 */
const GROUP_BLOCK_KEY_RE = /^[a-z0-9_]+\.group\.[a-z0-9][a-z0-9._-]*$/

/** 是否是分组块键。 */
export function isGroupBlockKey(key) {
  return GROUP_BLOCK_KEY_RE.test(String(key ?? ''))
}

/** 块键：`<工具>.<块>`（运行时配置里的键）。 */
export function blockKeyOf(tool, id) {
  return `${tool}.${id}`
}

/** 某工具的静态块。 */
export function blocksOfTool(tool) {
  return TOOL_BLOCKS.filter((block) => block.tool === tool)
}

/**
 * 归一运行时配置里的 `toolBlocks`：只保留已知静态键与形状正确的分组键，值布尔化。
 * @param {unknown} raw - 运行时配置里的原始值。
 * @returns {Record<string, boolean>} 归一后的启用表。
 */
export function normalizeToolBlocks(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  const known = new Set(TOOL_BLOCKS.map((block) => blockKeyOf(block.tool, block.id)))
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'boolean') continue
    if (!known.has(key) && !isGroupBlockKey(key)) continue
    out[key] = value
  }
  return out
}

/**
 * 归一「块文案覆盖」表（2026-10-17 用户需求：块的文案可写、可恢复默认）。
 *
 * 只保留字符串值；去首尾空白；**空串 = 恢复默认**（直接丢弃该键，不写进配置）。
 * 键的合法性同 `normalizeToolBlocks`（静态块键或 `<工具>.group.<分组id>`）。
 * @param {unknown} raw - 运行时配置里的原始值。
 * @returns {Record<string, string>} 归一后的文案覆盖表。
 */
export function normalizeToolBlockTexts(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  const known = new Set(TOOL_BLOCKS.map((block) => blockKeyOf(block.tool, block.id)))
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text === '') continue
    if (!known.has(key) && !isGroupBlockKey(key)) continue
    out[key] = text
  }
  return out
}

/**
 * 取某个块的文案覆盖。
 * @param {Record<string, string>|undefined} texts - 文案覆盖表。
 * @param {string} tool - 工具 id。
 * @param {string} id - 块 id。
 * @returns {string|null} 覆盖文案；没有覆盖返回 null（调用方用默认词条）。
 */
export function blockTextOf(texts, tool, id) {
  const value = texts?.[blockKeyOf(tool, id)]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 某块是否启用（缺省 = 启用；只有显式 false 才算关掉）。
 * @param {Record<string, boolean>|undefined} blocks - 归一后的启用表。
 * @param {string} tool - 工具 id。
 * @param {string} id - 块 id（静态块 id 或 `group.<分组id>`）。
 * @returns {boolean} 是否启用。
 */
export function isBlockEnabled(blocks, tool, id) {
  return blocks?.[blockKeyOf(tool, id)] !== false
}

/**
 * 某个分组（写入目标）是否可用 —— 就是它的分组块有没有被关掉。
 * @param {Record<string, boolean>|undefined} blocks - 启用表。
 * @param {string} tool - 工具 id（memory / dtodo）。
 * @param {string} groupId - 分组 id。
 * @returns {boolean} 该分组是否仍出现在 enum 与描述里。
 */
export function trackEnabled(blocks, tool, groupId) {
  return isBlockEnabled(blocks, tool, groupBlockId(groupId))
}

/**
 * 按块拼装工具描述：总述 → 分组段（启用中的才拼）→ 静态块段。
 *
 * 词条约定：总述 = `<prefix>.desc`，静态块 = `<prefix>.desc.<块id>`；词条缺失
 * （翻译函数原样返回键名）就跳过该块。
 * @param {Record<string, boolean>|undefined} blocks - 启用表。
 * @param {string} tool - 工具 id（块表里的 tool）。
 * @param {(key: string) => string} t - 词条函数（如 `mt` / `tt`）。
 * @param {string} [prefix] - 词条前缀，缺省与 tool 相同（dtodo 的词条前缀是 `todo.`）。
 * @param {Array<{id: string, text: string}>} [groupSections] - 分组段（id = `group.<分组id>`）。
 * @param {Record<string, string>} [texts] - 块文案覆盖表（用户在配置页改过的文案）。
 * @returns {string} 描述文本。
 */
/**
 * 把 tools.json 里的 description 覆盖归一成「头段覆盖」。
 *
 * 旧版（2026-10-19 之前）语义是"整段替换"：保存进去的是**当时的完整合成结果**。
 * 新版语义是"只替换头段"。识别旧数据用**精确比对**（覆盖值 === 不含头段覆盖的完整合成），
 * 不用长度/段落数之类的启发式 —— 那会静默吞掉用户自己追加的内容。
 *
 * @param {string|undefined} raw - tools.json 里的覆盖值。
 * @param {string} fullDefault - 不含头段覆盖时的完整合成结果（`composeDescription(...)` 不带第 7 参）。
 * @returns {string|undefined} undefined = 没覆盖（含"内容与完整默认合成逐字相同"）；'' = 显式置空；其它 = 头段文本。
 */
export function normalizeHeadOverride(raw, fullDefault) {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === '') return ''
  const full = typeof fullDefault === 'string' ? fullDefault.trim() : ''
  if (full !== '' && text === full) return undefined
  return text
}

export function composeDescription(blocks, tool, t, prefix = tool, groupSections = [], texts = {}, headOverride) {
  const parts = []
  // 头段（通用定义）：headOverride 有值就用它（空串 = 用户把它清空了，不输出头段）。
  // 注意 undefined 才是"没覆盖"；空串是"显式置空"（2026-10-19 用户需求）。
  const head = headOverride !== undefined ? headOverride : t(`${prefix}.desc`)
  if (typeof head === 'string' && head !== '' && head !== `${prefix}.desc`) parts.push(head)
  for (const section of groupSections) {
    if (!isBlockEnabled(blocks, tool, section.id)) continue
    if (typeof section.text === 'string' && section.text !== '') parts.push(section.text)
  }
  for (const block of blocksOfTool(tool)) {
    if (!isBlockEnabled(blocks, tool, block.id)) continue
    // 用户改过这块的文案就用它，否则回落到默认词条。
    const override = blockTextOf(texts, tool, block.id)
    if (override !== null) {
      parts.push(override)
      continue
    }
    const key = `${prefix}.desc.${block.id}`
    const text = t(key)
    if (typeof text === 'string' && text !== key) parts.push(text)
  }
  return parts.join('\n\n')
}

/**
 * 一组块里是否有任一启用（用于「这一整块参数该不该出现」的判断）。
 * @param {Record<string, boolean>|undefined} blocks - 启用表。
 * @param {string} tool - 工具 id。
 * @param {string[]} ids - 块 id 列表。
 * @returns {boolean} 只要有启用就 true。
 */
export function anyBlockEnabled(blocks, tool, ids) {
  return ids.some((id) => isBlockEnabled(blocks, tool, id))
}
