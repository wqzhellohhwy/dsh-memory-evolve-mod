/**
 * dsh-memory-evolve — 「一条记忆 = 一个 md 文件」的存储底层（vault，2026-10-15）。
 *
 * ## 为什么有这一层
 * 2026-10-15 之前，一个分组 = 一个 `.md` 文件，条目之间用 `\n§\n` 分隔，
 * 没有任何结构化字段（日期是文本前缀、摘要是个 `[summary:…]` 标签）。
 * 用户拍板改成：**每一条记忆独立一个 md 文件，文件名为标题**，文件头用
 * YAML frontmatter 承载元数据（id / 标题 / 摘要 / 关键词 / 使用场景 /
 * 创建与修改时间 / 所属分组与类 / 归档时间），模型可用工具按元数据与摘要
 * 检索。
 *
 * 本模块**只负责文件层**：条目对象 ↔ md 文件的序列化与读写、标题 → 文件名
 * 的清洗与去重、目录列举与全量同步。标签解析（`[id:…]` `[日期]` `[git …]`
 * `[branch:…]` `[dsh-only]` `[summary:…]`）留在 `store.js`——它已经有全套正则，
 * 这样两边零重复、且依赖是单向的（store → vault）。
 *
 * ## 条目对象形状（vault entry）
 * ```js
 * {
 *   file: '/abs/path/标题.md' | undefined,  // 已落盘条目才有
 *   id: 'a1b2c3d4',        // 8 位十六进制，稳定不变（改名/改标题都不变）
 *   title: '标题',          // 人类可读名；文件名由它清洗而来
 *   summary: '一句话摘要',
 *   keywords: ['关键词'],   // 关键词（如「高成熟度」「编码」）
 *   scenario: '使用场景',
 *   created: '2026-10-15 02:54',  // 统一完整时间（显示时按轨截断）
 *   updated: '2026-10-15 02:54',
 *   group: 'kb',            // 所属分组 id
 *   klass: 'global',        // 所属类：session | project | global
 *   seq: 42,                // 组内单调序号（同 created 时保序）
 *   git: 'main',            // 可空：写入时 cwd 的 git 分支
 *   project: '标签',         // 可空：daily 轨的项目标签
 *   branches: ['main'],     // 可空：可见分支范围（key 轨）
 *   dshOnly: false,         // 「仅 DSH」标记
 *   archivedAt: null,       // 非空 = 该条在归档区
 *   body: '正文'            // 记忆内容本体
 * }
 * ```
 *
 * ## 文件名规则（用户拍板 2026-10-15）
 * 文件名 = 标题清洗后的结果：`\ / : * ? " < > |` 与控制字符换成 `_`、
 * 折叠空白、去掉首尾点与空格、截断 60 字；重名自动加 `-2` `-3` 后缀；
 * 改标题即改文件名（旧名进 `aliases` 由调用方维护）。
 *
 * 零运行时依赖（node:fs / node:path / node:crypto）。
 *
 * @module dsh-memory-evolve/vault
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'

/** vault frontmatter 的结构版本（将来不兼容改动时递增）。 */
export const VAULT_VERSION = 1

/** 文件名最大长度（不含 `.md`）——Windows 全路径限制下的保守值。 */
const MAX_SLUG_LEN = 60

/** 单条正文的软上限（防止一次写入把磁盘写爆；调用方另有字符配额）。 */
export const MAX_BODY_CHARS = 200_000

/** frontmatter 字段的固定输出顺序（只写有值的字段）。 */
const FIELD_ORDER = [
  'id',
  'title',
  'summary',
  'keywords',
  'scenario',
  'origin',
  'created',
  'updated',
  'group',
  'class',
  'seq',
  'git',
  'project',
  'branches',
  'flags',
  'archivedAt',
]

/** 文件名里不允许出现的字符（Windows 保留字符 + 控制字符）。 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

/** 生成一个新的条目身份证：8 位十六进制（与旧 `[id:xxxxxxxx]` 完全同形）。 */
export function newEntryId() {
  return randomBytes(4).toString('hex')
}

/** 校验条目身份证（旧格式 ID 与新格式必须同构，才能平滑迁移）。 */
export function isValidEntryId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}$/.test(id)
}

/**
 * 标题 → 安全文件名（不含扩展名）。
 *
 * 规则：非法字符换 `_` → 连续空白折成单个空格 → 去掉首尾空格与点 →
 * 截断到 60 字 → 结果为空时用 fallback（调用方给 `条目-<id前6位>`）。
 * @param {string} title - 原始标题。
 * @param {string} [fallback='entry'] - 清洗后为空时的兜底名。
 * @returns {string} 可直接当文件名用的字符串。
 */
export function slugifyTitle(title, fallback = 'entry') {
  let slug = String(title ?? '')
    .replace(ILLEGAL_FILE_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows 不允许文件名以点结尾；开头的点会变隐藏文件
    .replace(/^[.\s]+/, '')
    // 尾部的句读（含中文）也去掉：标题直接当文件名时"…。.md"很难看
    .replace(/[.。，、；：！？,;:!?\s]+$/, '')
  if (slug.length > MAX_SLUG_LEN) slug = slug.slice(0, MAX_SLUG_LEN).trim()
  return slug === '' ? fallback : slug
}

/**
 * 在目录里为一条记忆挑一个不冲突的文件名。
 *
 * 候选名已存在（且不是自己）时依次尝试 `<slug>-2.md`、`<slug>-3.md`…
 * @param {string} dir - 目标目录（不存在也能算，调用方负责建）。
 * @param {string} slug - 已清洗的基础名。
 * @param {string} [excludeFile] - 排除的现有文件绝对路径（更新自己的场景）。
 * @returns {string} 该目录下可用的绝对文件路径。
 */
export function uniqueFilePath(dir, slug, excludeFile) {
  const taken = new Set()
  try {
    for (const name of readdirSync(dir)) taken.add(name.toLowerCase())
  } catch {
    // 目录还不存在：任何名字都可用
  }
  const excluded = typeof excludeFile === 'string' ? basename(excludeFile).toLowerCase() : null
  for (let i = 1; i <= 999; i += 1) {
    const name = `${i === 1 ? slug : `${slug}-${i}`}.md`
    const lower = name.toLowerCase()
    if (lower === excluded) return join(dir, name)
    if (!taken.has(lower)) return join(dir, name)
  }
  return join(dir, `${slug}-${Date.now().toString(36)}.md`)
}

/** YAML 标量转义：需要时用双引号包裹（含 `: `、`#`、引号、首尾空白等）。 */
function yamlScalar(value) {
  const text = String(value)
  if (text === '') return '""'
  if (/^[\s]|[\s]$/.test(text) || /[:#"'\\\n]/.test(text) || /^[[\]{}&*!|>%@`-]/.test(text)) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
  }
  return text
}

/** 关键词数组 → 内联 YAML 数组（`[a, b]`）；空数组返回空串。 */
function yamlKeywords(list) {
  const items = (Array.isArray(list) ? list : [])
    .map((item) => String(item ?? '').trim())
    .filter((item) => item !== '')
  if (items.length === 0) return ''
  return `[${items.map((item) => (/[,[\]{}:#'"]/.test(item) ? yamlScalar(item) : item)).join(', ')}]`
}

/** 解析 frontmatter 里的内联数组（支持 `[a, b]` 与裸逗号分隔）。 */
function parseKeywords(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return []
  const inner = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  const out = []
  let buf = ''
  let quoted = false
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (ch === ',' && !quoted) {
      if (buf.trim() !== '') out.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim() !== '') out.push(buf.trim())
  return out
}

/**
 * 条目对象 → md 文件全文（frontmatter + 正文）。
 * @param {object} entry - vault 条目对象。
 * @returns {string} 文件内容（UTF-8，LF 行尾，结尾一个换行）。
 */
export function renderEntryFile(entry) {
  const fields = {
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    keywords: yamlKeywords(entry.keywords),
    scenario: entry.scenario,
    origin: entry.origin,
    created: entry.created,
    updated: entry.updated,
    group: entry.group,
    class: entry.klass,
    seq: entry.seq,
    git: entry.git,
    project: entry.project,
    branches: yamlKeywords(entry.branches),
    flags: entry.dshOnly === true ? '[dsh-only]' : '',
    archivedAt: entry.archivedAt,
  }
  const lines = ['---']
  for (const key of FIELD_ORDER) {
    const value = fields[key]
    if (value === undefined || value === null || value === '') continue
    // keywords / branches 已经是渲染好的内联数组；其余走标量转义
    if (key === 'keywords' || key === 'branches') lines.push(`${key}: ${value}`)
    else lines.push(`${key}: ${yamlScalar(value)}`)
  }
  lines.push('---', '')
  const body = String(entry.body ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '')
  return `${lines.join('\n')}\n${body}\n`
}

/**
 * md 文件全文 → `{meta, body}`。解析失败（无 frontmatter）时 meta 为空对象，
 * body 为原文——调用方据此判定"这是不是一条新格式记忆"。
 * @param {string} text - 文件内容。
 * @returns {{meta: object, body: string}}
 */
export function parseEntryFile(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '')
  if (!raw.startsWith('---')) return { meta: {}, body: raw.replace(/\s+$/, '') }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: raw.replace(/\s+$/, '') }
  const head = raw.slice(3, end)
  // frontmatter 与正文之间允许一个空行（渲染时固定写一个），全部吃掉
  const rest = raw.slice(end + 4).replace(/^(\r?\n)+/, '')
  const meta = {}
  for (const line of head.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_]*):\s?(.*)$/.exec(line.trim())
    if (match === null) continue
    let value = match[2].trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
    }
    meta[match[1]] = value
  }
  // 数组字段直接给数组（调用方拿到的 meta 就是可用的形状，不必再解析一次）
  meta.keywords = parseKeywords(meta.keywords)
  meta.branches = parseKeywords(meta.branches)
  return { meta, body: rest.replace(/\s+$/, '') }
}

/** meta → vault 条目对象（字段归一，坏数据只降级不抛）。 */
function metaToEntry(meta, body, file) {
  const flags = String(meta.flags ?? '')
  return {
    file,
    // 没有 id（手写文件、无 frontmatter 的旧文件）：按**文件名**派生稳定 id。
    // 用随机 id 的话，同一个文件每次读盘都换一个身份 —— 调用方会把它当成新
    // 条目，写入时按正文首行改名，看起来像"文件自己重命名自己"。
    id: isValidEntryId(meta.id) ? meta.id : deriveIdFromName(file),
    title: String(meta.title ?? '').trim(),
    summary: String(meta.summary ?? '').trim(),
    keywords: parseKeywords(meta.keywords),
    scenario: String(meta.scenario ?? '').trim(),
    origin: String(meta.origin ?? '').trim(),
    created: String(meta.created ?? '').trim(),
    updated: String(meta.updated ?? '').trim(),
    group: String(meta.group ?? '').trim(),
    klass: String(meta.class ?? '').trim(),
    seq: Number.isFinite(Number(meta.seq)) ? Number(meta.seq) : 0,
    git: String(meta.git ?? '').trim(),
    project: String(meta.project ?? '').trim(),
    branches: parseKeywords(meta.branches),
    dshOnly: flags.includes('dsh-only'),
    archivedAt: String(meta.archivedAt ?? '').trim() || null,
    body,
  }
}

/** 由文件名派生一个稳定 id（无 frontmatter 的手写文件用；同文件恒定）。 */
function deriveIdFromName(file) {
  const base = basename(String(file ?? ''), '.md')
  if (base === '') return newEntryId()
  return createHash('sha1').update(base, 'utf8').digest('hex').slice(0, 8)
}

/** 目录里是否是「一条记忆」的 md 文件。 */
function isEntryFileName(name) {
  if (!name.toLowerCase().endsWith('.md')) return false
  // 旧格式的整组单文件与备份不属于分片仓库
  if (/\.bak\.|\.tmp\./.test(name)) return false
  return true
}

/**
 * 读一个分组目录下的全部条目（按 `created` 升序、`seq` 升序、文件名兜底排序）。
 *
 * 目录不存在 = 空分组（返回空数组，不抛）。单个文件读失败（被占用/编码坏）
 * 只跳过该文件，绝不让整个分组读不出来。
 * @param {string} dir - 分组目录绝对路径。
 * @returns {object[]} 条目对象数组（每条带 `file`）。
 */
export function readVault(dir) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!isEntryFileName(name)) continue
    const file = join(dir, name)
    let text
    try {
      if (!statSync(file).isFile()) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const { meta, body } = parseEntryFile(text)
    const entry = metaToEntry(meta, body, file)
    if (entry.title === '') entry.title = basename(name, '.md')
    out.push(entry)
  }
  return sortEntries(out)
}

/** 条目排序：created 升序 → seq 升序 → file 名兜底（稳定、与旧行序一致）。 */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const ca = String(a.created ?? '')
    const cb = String(b.created ?? '')
    if (ca !== cb) return ca < cb ? -1 : 1
    const sa = Number(a.seq ?? 0)
    const sb = Number(b.seq ?? 0)
    if (sa !== sb) return sa - sb
    return String(a.file ?? '').localeCompare(String(b.file ?? ''))
  })
}

/** 目录里的下一个序号（同组内单调递增，保证同分钟写入的顺序稳定）。 */
export function nextSeq(entries) {
  let max = 0
  for (const entry of entries) {
    const value = Number(entry?.seq ?? 0)
    if (Number.isFinite(value) && value > max) max = value
  }
  return max + 1
}

/** 原子写一个文件（tmp + rename）。 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/**
 * 写一条记忆：新建文件，或更新已有文件（含标题改名）。
 *
 * 标题变化时新文件名按当前标题生成，旧文件在成功写入新文件后删除——
 * 「先写新的、再删旧的」，任何一步失败都不会让条目消失。
 * @param {string} dir - 分组目录（自动创建）。
 * @param {object} entry - 条目对象（可带 `file` 表示更新）。
 * @returns {string} 落盘后的文件绝对路径。
 */
export function writeVaultEntry(dir, entry) {
  mkdirSync(dir, { recursive: true })
  const target = entry.title
    ? uniqueFilePath(dir, slugifyTitle(entry.title, `entry-${String(entry.id).slice(0, 6)}`), entry.file)
    : uniqueFilePath(dir, `entry-${String(entry.id).slice(0, 6)}`, entry.file)
  writeAtomic(target, renderEntryFile(entry))
  if (entry.file && entry.file !== target) {
    try {
      rmSync(entry.file, { force: true })
    } catch {
      // 旧文件删不掉不影响正确性（只是留个孤儿文件）
    }
  }
  entry.file = target
  return target
}

/**
 * 删除一条记忆文件。
 * @param {object} entry - 条目对象（须带 `file`）。
 * @returns {boolean} true = 本次真的删掉了一个文件；false = 文件本来就不在。
 */
export function deleteVaultEntry(entry) {
  if (!entry?.file) return false
  if (!existsSync(entry.file)) return false
  try {
    rmSync(entry.file, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 把一组条目全量同步到一个目录（增 / 改 / 删）。
 *
 * 语义：`entries` 是调用方的权威列表——目录里多出来的 `.md` 会被删除
 * （这就是旧 `write(target, entries)` 的"整文件覆盖"语义在分片模型下的
 * 等价物，也是 `replace` / `remove` 能继续工作的原因）。
 *
 * 「先写后删」：所有新增/修改都落盘成功后才清理多余文件，中途抛错不会
 * 丢内容（最坏情况是留下几个孤儿文件，下次同步清掉）。
 * @param {string} dir - 分组目录。
 * @param {object[]} entries - 权威条目列表。
 * @returns {{added: number, updated: number, removed: number, files: string[]}}
 */
export function syncVault(dir, entries) {
  mkdirSync(dir, { recursive: true })
  const keep = new Set()
  let added = 0
  let updated = 0
  for (const entry of entries) {
    if (entry.title === '') entry.title = `entry-${String(entry.id).slice(0, 6)}`
    const before = entry.file
    const file = writeVaultEntry(dir, entry)
    keep.add(file)
    if (before === undefined || before === null) added += 1
    else if (before !== file) updated += 1
  }
  let removed = 0
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    names = []
  }
  for (const name of names) {
    if (!isEntryFileName(name)) continue
    const file = join(dir, name)
    if (keep.has(file)) continue
    try {
      rmSync(file, { force: true })
      removed += 1
    } catch {
      // 删不掉就留着（不静默吞掉用户内容）
    }
  }
  return { added, updated, removed, files: [...keep] }
}

/** 目录是否存在且含有至少一个记忆文件。 */
export function vaultExists(dir) {
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).some((name) => isEntryFileName(name))
  } catch {
    return false
  }
}

/** 目录里记忆文件的数量（不含子目录与备份）。 */
export function vaultCount(dir) {
  try {
    return readdirSync(dir).filter((name) => isEntryFileName(name)).length
  } catch {
    return 0
  }
}

/** 目录下的子目录名（日志型的日期目录用；不存在返回空数组）。 */
export function listVaultSubdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 读一个分组目录下的全部条目，**含一层日期子目录**（日志型分组用）。
 *
 * 日志型分组（会话日志 / 项目日志 / 今日日志）把条目按 `created` 的日期
 * 分进 `<日期>/` 子目录；记忆型直接放分组目录下。两种一起读出来，调用方
 * 不必区分——排序仍按 `created`（日期目录的存在只是为了让一天几百条日志
 * 不把目录撑爆）。
 * @param {string} dir - 分组目录绝对路径。
 * @returns {object[]} 条目对象数组（按 created 升序）。
 */
export function readVaultDeep(dir) {
  const out = [...readVault(dir)]
  for (const name of listVaultSubdirs(dir)) {
    out.push(...readVault(join(dir, name)))
  }
  return sortEntries(out)
}
