/**
 * dsh-memory-evolve — memory storage layer.
 *
 * Hermes-compatible persistent curated memory: plain-text files with `\n§\n`
 * entry delimiters, per-target character limits, a cross-process lock file,
 * atomic writes, and a drift guard that refuses full-file rewrites when the
 * on-disk content would not round-trip through the parser (manual edits,
 * shell appends, or sister-process writes).
 *
 * Write semantics mirror the Hermes memory tool:
 *   - add: append-only, skips the drift guard (never clobbers parsed entries),
 *     but refuses a file that exists and reads as empty (would wipe history);
 *   - replace / remove: match by a short unique substring, enforce the drift
 *     guard (full-file rewrite would discard un-roundtrippable content), back
 *     up drifted files to `<file>.bak.<timestamp>` before refusing.
 *
 * All operations are synchronous (files are tiny) and serialized through one
 * lock file per directory so multiple DSH processes or external editors
 * cannot interleave writes.
 *
 * Zero runtime dependencies (node:fs only).
 *
 * @module dsh-memory-evolve/store
 */

import { createHash } from 'node:crypto'
import { getLocale, translate, STORE_DICT, STORE_TAIL_DICT } from './i18n.js'

/** Translate through STORE_DICT in the active host locale. */
const st = (key, params) => translate(STORE_DICT, key, params, getLocale())
/** Translate through STORE_TAIL_DICT in the active host locale. */
const stt = (key, params) => translate(STORE_TAIL_DICT, key, params, getLocale())
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { findGroup, groupArchiveDirOf, groupDirOf, legacyDirOf, loadGroups, projectIdOf as projectIdFrom } from './groups.js'
import { extractEntryId, genEntryId, legacyIdFor, stripEntryId } from './sync/entryid.js'
import {
  deleteVaultEntry,
  newEntryId,
  nextSeq,
  readVault,
  readVaultDeep,
  sortEntries as sortVaultEntries,
  syncVault,
  vaultCount,
  writeVaultEntry,
  listVaultSubdirs,
} from './vault.js'

/** Entry delimiter, byte-compatible with Hermes MEMORY.md / USER.md. */
export const ENTRY_DELIMITER = '\n§\n'

/** A lock file older than this is considered abandoned (stale). */
const STALE_LOCK_MS = 10_000
/** How long to keep waiting for the lock before failing loud. */
const LOCK_TIMEOUT_MS = 5_000
/** Spin interval while waiting for the lock. */
const LOCK_RETRY_MS = 25

/**
 * Split raw file text into trimmed, non-empty entries.
 * @param {string} text - raw file content.
 * @returns {string[]} the entries.
 */
export function parseEntries(text) {
  return text
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Serialize entries into canonical file text (entries joined by the
 * delimiter plus a trailing newline).
 * @param {string[]} entries - the entries.
 * @returns {string} canonical file content.
 */
/** Extract the `YYYY-MM-DD` date from an entry's stamp prefix; null when absent. */
export function extractEntryDate(entry) {
  // 身份证 [id:…] 在最前（跨设备合并锚点）：先剥离再匹配日期，否则带 ID
  // 的条目全部判为"无日期"（审查 P1：since/until/earliest/latest 失效）
  const match = /^\[(\d{4}-\d{2}-\d{2})/.exec(stripEntryId(entry))
  return match ? match[1] : null
}

/**
 * Branch-scope tag inside a KEY entry: `[2026-08-06] [branch:main,dev] 内容`.
 * Absent = visible in EVERY branch ("全部"). Multiple branches are a
 * comma-separated list; the tag always follows the date stamp.
 */
export const BRANCH_TAG_RE = /(?:^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*)?\[branch:([^\]]*)\]\s*/

/**
 * Parse the branch scope of one KEY entry.
 * @param {string} entry - the full entry text.
 * @returns {string[] | null} the branch names, or null when the entry has no
 *   branch tag (meaning "all branches").
 */
export function parseEntryBranches(entry) {
  const match = BRANCH_TAG_RE.exec(entry)
  if (match === null) return null
  const branches = match[1].split(',').map((b) => b.trim()).filter(Boolean)
  return branches.length > 0 ? branches : null
}

/**
 * 「仅 DSH」标记（tag）：`[2026-08-06] [dsh-only] 内容`，属程序元数据 tag
 * 之一（位置在时间戳与 [branch:…] 之后、正文之前）。
 *
 * 语义：该条目只适用于 DSH 自身（DSH 纪律/规则/架构类事实——外部执行器
 * 不是 DSH，不必遵循 DSH 规则）。因此：
 *   - DSH 自身快照注入：照常注入（本来就是给 DSH 的）；
 *   - 注入外部执行器（COI 任务的 injectTracks 记忆注入）：整条跳过
 *     （buildMemoryContext 的 excludeDshOnly 选项负责过滤）。
 * 由记忆 Tab 的条目操作按钮（MemoryStore.setEntryDshOnly）维护；编辑正文
 * 时经 splitEntryHead 原样保留，与 [branch:…] 同等对待。
 */
export const DSH_ONLY_TAG = '[dsh-only]'

/** 条目内 [dsh-only] 标记的正则（任意位置出现即视为已标记，兼容手写文件）。 */
export const DSH_ONLY_RE = /\[dsh-only\]\s*/

/**
 * 判断一条记忆条目是否带「仅 DSH」标记。
 * @param {string} entry - 完整条目文本。
 * @returns {boolean} true = 该条目只适用于 DSH，注入外部执行器时跳过。
 */
export function parseEntryDshOnly(entry) {
  return DSH_ONLY_RE.test(String(entry ?? ''))
}

/**
 * 「摘要」标记（tag）：`[2026-08-15] [summary:一句话摘要] 内容`，属程序元数据 tag
 * 之一（位置在时间戳与 [branch:…]、[dsh-only] 之后、正文之前）。
 *
 * 语义：该条目的摘要，用于渐进式披露时注入系统提示词（减少 token）。
 * 由 memory 工具 add action 的 summary 参数写入；编辑条目时经 splitEntryHead
 * 原样保留，与 [branch:…]、[dsh-only] 同等对待。
 */
export const SUMMARY_TAG_RE = /\[summary:([^\]]*)\]/

/**
 * 条目头部（程序元数据前缀）的正则：[id:…] → 时间戳（日期 / 日期时间 /
 * 时分）→ [git …]×N → [branch:…] → [dsh-only]，按 splitEntryHead 的已知
 * token 顺序匹配。summary 解析与剥离都以它锚定头部——正文里出现的
 * [summary:…] 文本（如 "[foo] [summary:bar]"）不在 head 序列中，不会被
 * 误当显式摘要（审查修复：SUMMARY_TAG_RE 此前未锚定，正文含同名文本
 * 会被误解析）。
 */
const ENTRY_HEAD_RE = /^(?:\[id:[0-9a-f]{8}\]\s*)?(?:\[\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2}(?::\d{2})?)?\]\s*|\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?(?:\[git [^\]]+\]\s*)*(?:\[branch:[^\]]*\]\s*)?(?:\[dsh-only\]\s*)?/

/**
 * 解析一条记忆条目的摘要标签（只认头部位置的 [summary:…]）。
 * @param {string} entry - 完整条目文本。
 * @returns {string | null} 摘要文本，或 null（无显式摘要）。
 */
export function parseEntrySummary(entry) {
  const text = String(entry ?? '')
  const head = ENTRY_HEAD_RE.exec(text)
  if (head === null) return null
  const match = /^\[summary:([^\]]*)\]\s*/.exec(text.slice(head[0].length))
  return match ? match[1] : null
}

/**
 * 从条目正文自动生成摘要（无显式 [summary:...] 时的兜底）。
 * 剥离所有头部标记后取正文第一行，截断到 maxLen 字。
 * @param {string} entry - 完整条目文本。
 * @param {number} [maxLen=80] - 最大长度。
 * @returns {string} 自动生成的摘要。
 */
export function autoSummary(entry, maxLen = 80) {
  // 剥离头部标记：复用 ENTRY_HEAD_RE（与 splitEntryHead / stripEntrySummary
  // 同一 head 序列：[id] → 时间戳（日期/日期时间/时分）→ [git …]×N →
  // [branch:…] → [dsh-only] → [summary:…]）。审查修复：此前逐条 ^ 锚定
  // replace 漏了 [git …] 与 [HH:MM]，带这些标记的条目后续剥离失配，
  // 元数据（如 [git main]）会混进自动摘要注入提示词。
  let rest = String(entry ?? '').trim()
  const head = ENTRY_HEAD_RE.exec(rest)
  if (head !== null) rest = rest.slice(head[0].length)
  rest = rest.replace(/^\[summary:[^\]]*\]\s*/, '')

  // 取正文第一行
  const firstLine = rest.split('\n')[0].trim()
  if (firstLine.length <= maxLen) return firstLine
  return firstLine.slice(0, maxLen - 1) + '…'
}

/**
 * 展示剥离「摘要」标记：全量注入/读取全文时，正文已完整，[summary:...]
 * 是仅供摘要模式注入用的程序元数据，不应显示（避免与正文重复、浪费 token）。
 * 只剥离头部位置的 summary tag（时间戳/[id]/[branch]/[dsh-only] 之后、
 * 正文之前），正文中出现的同名文本不动。
 * @param {string} entry - 完整条目文本。
 * @returns {string} 无 summary 标记的条目文本。
 */
export function stripEntrySummary(entry) {
  // 只按已知 head token 顺序匹配（ENTRY_HEAD_RE，与 splitEntryHead 一致）：
  // [id] → 时间戳（日期 / 日期时间 / 时分）→ [git …]×N → [branch:…] →
  // [dsh-only] → [summary:…]。正文里出现的 [summary:…] 文本（如
  // "[foo] [summary:bar]"）不在 head 序列中，不会被误剥。
  const match = ENTRY_HEAD_RE.exec(String(entry ?? ''))
  const prefix = match === null ? '' : match[0]
  const rest = String(entry ?? '').slice(prefix.length)
  return prefix + rest.replace(/^\[summary:[^\]]*\]\s*/, '')
}

export function serializeEntries(entries) {
  return entries.join(ENTRY_DELIMITER) + '\n'
}

/**
 * 剥离一条目的全部前缀标记：时间戳 + `[git …]` 程序分支标记 + `[branch:…]`
 * 分支范围 + daily 项目 tag，返回前缀 head 与正文 body。与记忆 Tab 美观视图
 * 的解析规则保持一致——编辑条目时用 head + 新正文重写，时间戳与所有 tag
 * 原样保留（程序维护的元数据不可被编辑改动）。
 * @param {string} entry - 完整条目原文。
 * @param {string} target - 'memory' | 'user' | 'daily' | 'project' | 'key'。
 * @returns {{head: string, body: string}}
 */
export function splitEntryHead(entry, target) {
  let rest = String(entry ?? '').trim()
  const timeRe = target === 'project' ? /^\[(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?::\d{2})?)\]\s*/
    : target === 'daily' ? /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/
      // F-6：非日志型的文本视图戳精确到分钟（`[YYYY-MM-DD HH:MM]`，与
      // ENTRY_HEAD_RE / objectOf 同一形状）。只认 `[YYYY-MM-DD]` 的话，
      // memory/user/key 的新格式前缀会被当成正文——setEntryBranches /
      // setEntryDshOnly / updateEntryContent 重建条目时会再盖一个戳（双时间戳）。
      : /^\[(\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2}(?::\d{2})?)?)\]\s*/
  const tokens = []
  // [id:xxxxxxxx] 条目身份证（跨设备合并锚点，施工图 §4.1）：最优先剥离，
  // 先于时间戳 —— 它是"程序维护的元数据"，编辑条目时原样保留（head 里）。
  const idMatch = /^\[id:([0-9a-f]{8})\]\s*/.exec(rest)
  if (idMatch !== null) {
    tokens.push(idMatch[0])
    rest = rest.slice(idMatch[0].length)
  }
  const timeMatch = timeRe.exec(rest)
  if (timeMatch !== null) {
    tokens.push(timeMatch[0])
    rest = rest.slice(timeMatch[0].length)
  }
  // 程序分支标记 [git …]（daily / project 按会话 cwd 盖戳）
  for (;;) {
    const gitMatch = /^\[git ([^\]]+)\]\s*/.exec(rest)
    if (gitMatch === null) break
    tokens.push(gitMatch[0])
    rest = rest.slice(gitMatch[0].length)
  }
  // key 分支范围 [branch:…]
  const branchMatch = /^\[branch:[^\]]*\]\s*/.exec(rest)
  if (branchMatch !== null) {
    tokens.push(branchMatch[0])
    rest = rest.slice(branchMatch[0].length)
  }
  // 「仅 DSH」标记 [dsh-only]（branch 之后、正文之前；程序元数据，编辑保留）
  const dshOnlyMatch = /^\[dsh-only\]\s*/.exec(rest)
  if (dshOnlyMatch !== null) {
    tokens.push(dshOnlyMatch[0])
    rest = rest.slice(dshOnlyMatch[0].length)
  }
  // 「摘要」标记 [summary:...]（dsh-only 之后、正文之前；程序元数据，编辑保留）
  const summaryMatch = /^\[summary:[^\]]*\]\s*/.exec(rest)
  if (summaryMatch !== null) {
    tokens.push(summaryMatch[0])
    rest = rest.slice(summaryMatch[0].length)
  }
  // daily 项目 tag（时间戳后的第一个任意 [...]）
  if (target === 'daily') {
    const tagMatch = /^\[([^\]]+)\]\s*/.exec(rest)
    if (tagMatch !== null) {
      tokens.push(tagMatch[0])
      rest = rest.slice(tagMatch[0].length)
    }
  }
  return { head: tokens.join(''), body: rest }
}

/**
 * 读取项目 PROVENANCE（记忆同步身份记录，一行 JSON）。容错：不存在/损坏
 * 返回 null。存于 store.js 而非 sync 层——避免循环依赖（repo.js imports
 * store.js），且 MemoryStore 判定 syncedTrack 需要它。
 * @param {string} dir - 项目记忆目录。
 * @returns {object | null} { projectId, displayName, enabled, tracks, ... }。
 */
export function readProvenance(dir) {
  const p = join(dir, 'PROVENANCE')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8').trim())
  } catch {
    return null
  }
}

/**
 * 项目同步开关判定（2026-08-11 用户拍板三层开关）：项目已初始化（PROVENANCE
 * 存在）**且** enabled !== false 才算参与同步。项目开关关闭后新条目不再
 * 生成身份证（维持"未启用"的本地状态）。
 * @param {string} dir - 项目记忆目录。
 * @returns {boolean}
 */
export function isProjectSyncEnabled(dir) {
  // 三层开关第 2 层语义（2026-08-11 用户拍板 + Codex 终审 P1-5 修正）：
  // **PROVENANCE 缺失 = 未初始化 = 未 opt-in = 不启用**——只有显式初始化
  // 过（setup 写入 PROVENANCE）且 enabled !== false 的项目才参与同步。
  // 此前"缺失=默认启用"会让全局模块开关一开就给未 opt-in 项目的 KEY/日志
  // 生成身份证，违背"未打开的项目保持纯本地状态、不生成身份证"的拍板。
  const meta = readProvenance(dir)
  return meta !== null && meta.enabled !== false
}

/**
 * 匹配用的归一化：剥掉**展示层不会显示的程序元数据**，只用于"这是不是同一条"
 * 的判定，绝不用于写盘内容（写盘一律用磁盘原文）。
 *
 * 必须与展示层剥离的元数据集合严格一致，否则前端把展示文本当 raw 回传时
 * 匹配必然失败（issue #59）：
 *   - `[id:…]`：跨设备合并锚点，展示剥离（2026-08-11 首次踩坑）；
 *   - `[summary:…]`：渐进式披露摘要，展示剥离（2026-08-17 引入，当时漏了
 *     匹配层）。同一个坑连踩两次，结论：**展示层每剥一种新元数据，匹配层
 *     必须同步扩展**——两处实现见 `memory-tab.js` 的 buildMemoryFiles()
 *     与 `src/client/MemoryTabView.tsx`。
 *
 * 两侧（磁盘原文 / 展示文本）都过同一个函数，因此比较天然对齐；两个 strip
 * 都只作用于条目头部的 token 序列，正文里的同名字面量不受影响。
 * @param {string} entry - 条目文本（磁盘原文或展示文本均可）。
 * @returns {string} 归一化后的可比文本。
 */
export function normalizeForMatch(entry) {
  return stripEntrySummary(stripEntryId(String(entry ?? '')))
}

/**
 * 精确匹配索引（对展示层剥离的程序元数据免疫）：用 normalizeForMatch 做
 * 相等比较——展示层剥掉 `[id:…]` / `[summary:…]` 后回传的文本仍能命中磁盘
 * 原文（审查 P0：Tab/API 精确操作在启用 sync 后失效；issue #59：带
 * `[summary:…]` 的条目删不掉/改不了/归档不了）。
 * @param {string[]} entries - 磁盘上的条目数组。
 * @param {string} exact - 待匹配的整条文本。
 * @param {object} [options]
 * @param {boolean} [options.first=false] - 多条命中时的取舍：false 报歧义
 *   （主轨用——重复条目属数据异常，保守拒绝）；true 取首条（归档轨用——
 *   归档本来就允许同一内容重复出现，且归档页只可能点到其中一条）。
 * @returns {number} 命中下标；未命中返回 -1。
 */
function findExactIndex(entries, exact, { first = false } = {}) {
  const target = normalizeForMatch(exact)
  let found = -1
  for (let i = 0; i < entries.length; i++) {
    if (normalizeForMatch(entries[i]) === target) {
      if (found !== -1 && !first) return -1 // 多条命中 → 歧义，拒绝
      if (found === -1) found = i
    }
  }
  return found
}

/**
 * Whether raw text is the canonical serialization of its own entries.
 * Blank text counts as canonical (an empty store).
 * @param {string} text - raw file content.
 * @returns {boolean} true when the file would round-trip through the parser.
 */
export function isCanonical(text) {
  return text.trim() === '' || serializeEntries(parseEntries(text)) === text
}

/** Blocking sleep used by the lock retry loop (synchronous). */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Directories whose lock this process currently holds (reentrancy guard). */
const heldLocks = new Set()

/**
 * Acquire the directory lock exclusively (cross-process), run `fn`, release.
 * Reentrant within this process: a nested withLock on the same directory
 * proceeds directly (all mutations are synchronous, so the outer section is
 * still exclusive against other processes).
 * @param {string} dir - the directory whose lock to take.
 * @param {() => T} fn - the critical section.
 * @returns {T} the section's return value.
 * @template T
 */
/** 锁文件内容（pid/token）：断电中断后残留锁可凭 pid 存活检测立即识别。 */
const LOCK_JSON = () => JSON.stringify({ pid: process.pid, at: Date.now() })

/**
 * stale 锁判断（导出供 worker 异步锁复用）：mtime 超时，或锁文件里的
 * pid 已不存活（进程被 kill/断电——残留锁立即清除，不用等 stale 超时）。
 * @param {string} lockPath - 锁文件路径。
 * @returns {boolean}
 */
export function isStaleLock(lockPath) {
  try {
    const info = statSync(lockPath)
    // **先查 pid 存活（Codex 终审 P1-7 修正）**：有合法 pid 时进程活着就是
    // 有效锁（即使持锁超过 mtime 阈值——锁内操作虽为毫秒级，但长任务不应
    // 被误抢）；只有 pid 已死或无 pid 的旧格式锁才按 mtime 判定。
    try {
      const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (typeof owner.pid === 'number') {
        try {
          process.kill(owner.pid, 0) // 信号 0 = 只探测存活
          return false // 持有者还活着 → 锁有效
        } catch {
          return true // 持有者已死（断电/中断残留）→ stale
        }
      }
    } catch {
      // 旧格式锁文件（无 pid/不可解析）→ 按 mtime 判断
    }
    return Date.now() - info.mtimeMs > STALE_LOCK_MS
  } catch {
    return false // 锁文件不存在/不可读 → 不 stale（下轮重试）
  }
}

/**
 * Acquire the directory lock exclusively (cross-process), run `fn`, release.
 * Reentrant within this process: a nested withLock on the same directory
 * proceeds directly (all mutations are synchronous, so the outer section is
 * still exclusive against other processes).
 * @param {string} dir - the directory whose lock to take.
 * @param {() => T} fn - the critical section.
 * @returns {T} the section's return value.
 * @template T
 */
export function withLock(dir, fn) {
  if (heldLocks.has(dir)) return fn()
  const lockPath = join(dir, '.memory.lock')
  mkdirSync(dir, { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    let acquired = false
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeFileSync(lockPath, LOCK_JSON())
      } finally {
        closeSync(fd)
      }
      acquired = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (acquired) break
    if (isStaleLock(lockPath)) rmSync(lockPath, { force: true })
    if (Date.now() >= deadline) {
      throw new Error('dsh-memory-evolve: timed out waiting for the memory lock')
    }
    sleep(LOCK_RETRY_MS)
  }
  heldLocks.add(dir)
  try {
    return fn()
  } finally {
    heldLocks.delete(dir)
    rmSync(lockPath, { force: true })
  }
}

/** Minimal prompt-injection scan applied to tool-written memory content. */
const THREAT_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|earlier|above|your)\s+(instructions?|prompts?|messages?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|earlier|above|your)\s+(instructions?|prompts?|messages?|rules?)/i,
  /forget\s+(all|everything|your\s+instructions)/i,
  /忽略(所有|之前|以上|先前)(的)?(指令|指示|提示|规则)/,
  /无视(所有|之前|以上|先前)(的)?(指令|指示|提示|规则)/,
]

/**
 * Scan one memory entry for prompt-injection phrasing.
 * @param {string} text - the content to scan.
 * @returns {string | undefined} a human-readable block reason, or undefined.
 */
export function scanThreat(text) {
  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(text)) {
      return '内容包含疑似提示注入的表述（如"忽略指令"），已拒绝写入。若确为有意内容，请直接编辑记忆文件。'
    }
  }
  return undefined
}

/** Today's date as `YYYY-MM-DD` (local time). */
export function todayStamp() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** Stable 12-hex project key for one working directory. */
export function projectHash(cwd) {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 12)
}

/**
 * A short, stable project label for one working directory: the basename, or
 * the last two path segments when the basename is too short or purely
 * numeric (e.g. `/data/260805/1` → `260805/1`). Tags daily-log entries with
 * their originating project — the program knows the session cwd, so the LLM
 * never has to write it.
 * @param {string | undefined} cwd - the session working directory.
 * @returns {string | undefined} the label, or undefined without a cwd.
 */
export function projectLabel(cwd) {
  if (!cwd) return undefined
  const parts = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  const base = parts[parts.length - 1]
  if (base.length < 3 || /^\d+$/.test(base)) {
    return parts.length > 1 ? parts.slice(-2).join('/') : base
  }
  return base
}

/**
 * git 分支查询的短 TTL 缓存（2026-10-11「无感进入」优化）。
 *
 * 为什么需要：git 进程在 Windows 上启动一次要 200~500ms，而记忆 Tab 每次
 * 打开都会请求 /api/memory-files（该接口要返回「当前分支 + 全部分支」），
 * 一回合快照渲染也要查一次分支。改造前接口要跑两次 git（实测 750~1300ms），
 * 现在**合并为一次**（%(HEAD) 列同时给出当前分支）并加 3 秒 TTL 缓存——
 * Tab 重挂/快速切换/同轮多处查询都不再重复付 git 启动成本。
 * TTL 取 3s：分支切换远低于此频率，过期重查足够及时。
 */
const GIT_CACHE_TTL_MS = 3000
/** cwd → { at: number, branch: string|undefined, branches: string[] } */
const gitBranchCache = new Map()

/**
 * 真正跑 git：一次调用同时取「全部分支」与「当前分支」。
 * 格式里 `%(HEAD)` 对当前分支输出 `*`（detached HEAD 时全为空格）。
 * @param {string} cwd - the working directory to query.
 * @returns {{branch: string|undefined, branches: string[]}}
 */
function queryGitBranches(cwd) {
  const branches = []
  let branch
  try {
    const result = spawnSync('git', ['branch', '--format=%(refname:short)\t%(HEAD)'], {
      cwd, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (!result.error && result.status === 0) {
      for (const line of String(result.stdout ?? '').split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        const [name, head] = trimmed.split('\t')
        if (name === undefined || name === '') continue
        branches.push(name)
        if (head === '*') branch = name
      }
    }
  } catch { /* 非 git 目录 / 无 git：按「无分支」处理 */ }
  // 刚 `git init`、还没有任何提交的仓库：`git branch` 列不出引用（分支 ref
  // 尚未生成），但 HEAD 已经指向某个分支名——此时回退问 `--show-current`，
  // 否则新建仓库的记忆会丢掉分支标签（单元测试正是这个场景）。
  if (branch === undefined) branch = currentBranchFallback(cwd)
  return { branch, branches }
}

/** 回退查询当前分支（仅在 `git branch` 解析不出时调用，多付一次 git 启动）。 */
function currentBranchFallback(cwd) {
  try {
    const result = spawnSync('git', ['branch', '--show-current'], {
      cwd, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) return undefined
    const name = String(result.stdout ?? '').trim()
    return name === '' ? undefined : name
  } catch {
    return undefined
  }
}

/** 取（带 TTL 缓存的）分支信息；缓存项含时间戳。 */
function gitBranches(cwd) {
  const now = Date.now()
  const hit = gitBranchCache.get(cwd)
  if (hit !== undefined && now - hit.at < GIT_CACHE_TTL_MS) return hit
  const fresh = { at: now, ...queryGitBranches(cwd) }
  gitBranchCache.set(cwd, fresh)
  // 防缓存无限增长（长会话 + 大量项目目录）：顺手清理过期项
  if (gitBranchCache.size > 64) {
    for (const [key, entry] of gitBranchCache) {
      if (now - entry.at >= GIT_CACHE_TTL_MS) gitBranchCache.delete(key)
    }
  }
  return fresh
}

/**
 * Resolve the current git branch of a working directory (same pattern as the
 * DSH TUI's prompt-context helper). Outside a git worktree, without `git`,
 * or on a detached HEAD (no `*` row) this returns undefined — callers then
 * fall back to the no-branch behavior.
 * @param {string} cwd - the working directory to query.
 * @returns {string | undefined} the branch name, or undefined.
 */
export function gitBranch(cwd) {
  if (!cwd) return undefined
  return gitBranches(cwd).branch
}

/**
 * List all local branch names of a working directory (for the memory tab's
 * branch-scope pickers). Empty on any failure. Shares one cached git call
 * with gitBranch (they are always queried together by the memory tab).
 * @param {string} cwd - the working directory to query.
 * @returns {string[]} the branch names ([] = not a git repo / no git).
 */
export function gitBranchList(cwd) {
  if (!cwd) return []
  return gitBranches(cwd).branches
}

/**
 * 清空 git 分支查询缓存（3s TTL 的逃生口）。
 * 用途：调用方刚对目录做 git 操作（`git init` / 新增 remote）后需要立即看到
 * 新状态；单元测试在同一目录里先后模拟「非 git → git 仓库」两个阶段时也用它，
 * 否则第二次查询会命中刚才写入的「无分支」缓存。
 * @param {string} [cwd] - 只清某个目录；缺省清空全部。
 */
export function clearGitBranchCache(cwd) {
  if (cwd === undefined) gitBranchCache.clear()
  else gitBranchCache.delete(cwd)
}

/**
 * Persistent curated memory store over the six tracks: global facts
 * (MEMORY.md / USER.md), the global knowledge base (KB.md — never injected,
 * queried on demand), the daily log (daily/YYYY-MM-DD.md), the per-project
 * log (projects/<hash>/MEMORY.md, keyed by the session cwd) and per-project
 * KEY facts (projects/<hash>/KEY.md — the project's long-term memory, which
 * IS injected into the context like the global tracks).
 */
/** 当前时间戳（`YYYY-MM-DD HH:MM`，本地时区）。 */
export function nowStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 各种历史写法的时间戳 → 统一的 `YYYY-MM-DD HH:MM`。 */
function normalizeStamp(raw, today) {
  const fallback = `${today} 00:00`
  if (raw === null || raw === undefined || raw === '') return fallback
  const text = String(raw).trim()
  const full = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/.exec(text)
  if (full !== null) return `${full[1]} ${full[2].padStart(2, '0')}:${full[3]}`
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text} 00:00`
  const timeOnly = /^(\d{1,2}):(\d{2})/.exec(text)
  if (timeOnly !== null) return `${today} ${timeOnly[1].padStart(2, '0')}:${timeOnly[2]}`
  return fallback
}

/**
 * 条目对象 → 该轨惯用的时间戳标签。
 *
 * 今日日志用 `[HH:MM]`（日期在它所在的日期目录里），**其余一律 `[YYYY-MM-DD HH:MM]`**
 * ——2026-10-15（F-6，用户要求）把非日志型从 `[YYYY-MM-DD]` 统一到分钟级：
 * 同一天里写好几条时，只到日期根本分不出先后。
 */
function timeStampOf(entry, target) {
  const stamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(entry?.created ?? ''))
    ? String(entry.created)
    : nowStamp()
  if (target === 'daily') return `[${stamp.slice(11, 16)}]`
  return `[${stamp.slice(0, 16)}]`
}

/**
 * 条目对象 → 兼容文本（store 的对外契约，也是 upsert 的输入）。
 *
 * **导出**：归档页等展示侧必须用它渲染，才能与 `ArchiveStore.entriesOf` /
 * `removeExact` / `promoteArchived` 的匹配基准完全同形（2026-10-15 修的 P1：
 * 展示侧自己渲染成"完整时间戳 + 块头"导致归档删除/移回一律匹配失败）。
 */
export function textOfEntry(entry, target) {
  const parts = []
  if (entry.id) parts.push(`[id:${entry.id}]`)
  parts.push(timeStampOf(entry, target))
  if (entry.git) parts.push(`[git ${entry.git}]`)
  if (Array.isArray(entry.branches) && entry.branches.length > 0) parts.push(`[branch:${entry.branches.join(',')}]`)
  if (entry.dshOnly === true) parts.push(DSH_ONLY_TAG)
  // 摘要只在「与正文自动兜底摘要不同」时才写成标签——即 AI 显式给过摘要。
  // 兜底摘要等于正文前 80 字，写成标签只会让正文在文本视图里出现两遍
  // （浪费 token，也不好看）；显式摘要保留标签，渐进式披露照旧可用。
  if (entry.summary && entry.summary !== autoTitleSummary(entry.body)) {
    parts.push(`[summary:${String(entry.summary).replace(/[[\]\n]/g, ' ')}]`)
  }
  // 项目标签（daily 轨）紧贴正文之前——与改造前的书写习惯一致，且它是
  // ENTRY_HEAD_RE 之外的 token，放最后才不会挡住 branch/dsh-only/summary。
  const label = entry.project ? `[${String(entry.project).replace(/[[\]\n]/g, ' ')}] ` : ''
  return `${parts.join(' ')} ${label}${entry.body ?? ''}`.trimEnd()
}

/** 条目文本的正文首行 → 标题（剥掉 markdown 记号，超 40 字截断）。 */
function titleFromBody(body) {
  const first = String(body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '') ?? ''
  const cleaned = first.replace(/^#+\s*/, '').replace(/^[-*+]\s+/, '').trim()
  if (cleaned === '') return ''
  return cleaned.length <= 40 ? cleaned : `${cleaned.slice(0, 39)}…`
}

/** 正文 → 兜底摘要（折叠空白，超 80 字截断）。 */
function autoTitleSummary(body) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  return text.length <= 80 ? text : `${text.slice(0, 79)}…`
}

/** 日志型的日期目录名（条目 created 的日期部分）。 */
function dateDirOf(created) {
  const stamp = String(created ?? '')
  return /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0, 10) : todayStamp()
}

/**
 * 条目的元数据检索串（标题 / 摘要 / 关键词 / 使用场景）。
 *
 * 2026-10-15 起这些字段住在 frontmatter 里，不在条目正文中——`memory` 工具的
 * `list` + `filter` 必须一并搜它们，否则「按关键词找记忆」只能翻正文。
 */
function entryMetaText(entry) {
  return [
    entry?.title,
    entry?.summary,
    entry?.scenario,
    Array.isArray(entry?.keywords) ? entry.keywords.join(' ') : '',
  ].filter((part) => typeof part === 'string' && part !== '').join(' ').toLowerCase()
}

/**
 * 兼容文本 → 条目对象（`write()` 的解析入口，迁移器也直接用它）。
 *
 * 只信头部标签（`[id] [时间戳] [git …] [branch:…] [dsh-only] [summary:…]`）；
 * 正文里长得像标签的文本原样留在 body。已存在的条目（`byId` 命中）保留它的
 * 标题 / 关键词 / 使用场景 / 归档时间——`write()` 只负责改正文与顺序，
 * 元数据的增删改由 `addEntry` / `updateEntryMeta` 负责。
 * @param {string} text - 条目文本。
 * @param {string} target - 分组 id。
 * @param {{dir: string, group: object}} loc - 定位结果（只需 dir 与 group）。
 * @param {Map<string, object>} byId - 已存在条目（按 id 索引）。
 * @param {number} seq - 组内序号。
 * @param {{today?: string}} [hints] - `today` 覆盖"今天"（迁移时用旧文件日期）。
 */
export function objectOf(text, target, loc, byId, seq, hints = {}) {
  let rest = String(text ?? '').trim()
  let id = null
  const idMatch = /^\[id:([0-9a-f]{8})\]\s*/.exec(rest)
  if (idMatch !== null) {
    id = idMatch[1]
    rest = rest.slice(idMatch[0].length)
  }
  let stamp = null
  const timeMatch = /^\[(\d{4}-\d{2}-\d{2}(?: \d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}:\d{2}(?::\d{2})?)\]\s*/.exec(rest)
  if (timeMatch !== null) {
    stamp = timeMatch[1]
    rest = rest.slice(timeMatch[0].length)
  }
  let git = ''
  for (;;) {
    const gitMatch = /^\[git ([^\]]+)\]\s*/.exec(rest)
    if (gitMatch === null) break
    git = gitMatch[1]
    rest = rest.slice(gitMatch[0].length)
  }
  let branches = []
  const branchMatch = /^\[branch:([^\]]*)\]\s*/.exec(rest)
  if (branchMatch !== null) {
    branches = branchMatch[1].split(',').map((b) => b.trim()).filter(Boolean)
    rest = rest.slice(branchMatch[0].length)
  }
  let dshOnly = false
  const dshMatch = /^\[dsh-only\]\s*/.exec(rest)
  if (dshMatch !== null) {
    dshOnly = true
    rest = rest.slice(dshMatch[0].length)
  }
  let summary = null
  const sumMatch = /^\[summary:([^\]]*)\]\s*/.exec(rest)
  if (sumMatch !== null) {
    summary = sumMatch[1]
    rest = rest.slice(sumMatch[0].length)
  }
  // 项目标签（daily 轨的程序标注，如 `[DeepSeekHarnessChat]`）：它不是
  // ENTRY_HEAD_RE 认识的 token，所以一直紧贴正文；这里把它收进 frontmatter，
  // 免得它混进标题与摘要（否则文件名会变成"[项目] 正文…"）。
  let project = null
  if (target === 'daily') {
    const labelMatch = /^\[([^\]\n]{1,40})\]\s+/.exec(rest)
    if (labelMatch !== null && !/^(git|branch|dsh-only|summary|id)\b/.test(labelMatch[1])) {
      project = labelMatch[1].trim()
      rest = rest.slice(labelMatch[0].length)
    }
  }
  const body = rest.trim()
  const prev = id !== null && byId.has(id) ? byId.get(id) : null
  const today = hints.today ?? todayStamp()
  const created = stamp !== null ? normalizeStamp(stamp, today) : (prev?.created ?? normalizeStamp(null, today))
  const sameBody = prev !== null && prev.body === body
  const now = nowStamp()
  // 摘要：显式标签优先；否则——旧摘要本来就是"自动兜底"（等于旧正文头 80 字）
  // 就跟着新正文重算，旧的显式摘要则保留（改正文不该悄悄抹掉人写的摘要）。
  const prevSummaryAuto = prev !== null && prev.summary === autoTitleSummary(prev.body)
  const nextSummary = summary ?? ((prev === null || prevSummaryAuto) ? autoTitleSummary(body) : prev.summary)
  const entry = {
    file: prev?.file,
    id: id ?? prev?.id ?? newEntryId(),
    // 标题：旧标题本来就是"自动取自正文首行"时跟着新正文走（改正文=改文件名，
    // 符合"文件名就是标题"的直觉）；旧标题是显式给过的则保留。
    title: (prev === null || prev.title === titleFromBody(prev.body))
      ? titleFromBody(body)
      : prev.title,
    summary: nextSummary,
    keywords: prev?.keywords ?? [],
    scenario: prev?.scenario ?? '',
    created,
    updated: sameBody ? (prev?.updated ?? now) : now,
    group: target,
    klass: loc.group.klass,
    daily: loc.group.daily === true,
    seq,
    git: git !== '' ? git : (prev?.git ?? ''),
    project: project ?? prev?.project ?? '',
    // branches / dshOnly 等**标记类元数据一律以文本为准**（2026-10-15 修正）：
    // 此前"文本里没有就从旧条目复活"，导致 `setEntryBranches(entry, [])` /
    // `setEntryDshOnly(entry, false)` 报成功却清不掉标记——用文本当唯一真相，
    // 清标记才真的生效（replace 会自己把旧标记搬过去，见 replace()）。
    branches,
    dshOnly,
    archivedAt: prev?.archivedAt ?? null,
    body,
  }
  if (entry.title === '') entry.title = `entry-${String(entry.id).slice(0, 6)}`
  return entry
}

export class MemoryStore {
  /**
   * @param {string} dir - the memory directory (created on demand).
   * @param {object} [options] - scan and stamping switches.
   * @param {boolean} [options.injectionScan=true] - enable the threat scan.
   * @param {boolean} [options.entryDatePrefix=true] - stamp entries with a
   *   `[YYYY-MM-DD] ` prefix on add, refreshed on replace (idempotent for
   *   content that already carries a date stamp).
   * @param {'off'|'on'} [options.entryIdMode='off'] - 条目身份证开关（施工图
   *   §4.2）：'on' 时 add 为每个新条目前置随机 `[id:xxxxxxxx]`、replace 继承
   *   旧条目 ID（"替换不换身份"）。**只有启用了 Git 同步的项目才开**——
   *   未启用项目保持 'off'，行为与现状逐字节一致。默认 'off'。
   * @param {(cwd: string) => string} [options.projectDirResolver] - 项目解析器
   *   （记忆同步装配层注入）：返回 `.system/projects/<项目id>` **元数据**目录，
   *   只用来取项目 id（v3 数据目录由 groups.js 的路径函数产出）。
   */
  constructor(dir, options = {}) {
    this.dir = dir
    this.injectionScan = options.injectionScan ?? true
    this.entryDatePrefix = options.entryDatePrefix ?? true
    this.entryIdMode = options.entryIdMode === 'on' ? 'on' : 'off'
    this.projectDirResolver = typeof options.projectDirResolver === 'function' ? options.projectDirResolver : null
    // 分组解析器（2026-10-13 分组化）：target 不是内置六轨时，用它拿到
    // 分组实体（lib/groups.js 的 findGroup）。装配层传入的函数每次读最新
    // 配置——用户在设置面板新建/改名的分组立刻可用，无需重启。
    this.groupResolver = typeof options.groupResolver === 'function' ? options.groupResolver : null
  }

  /**
   * Resolve one target to its file location.
   * @param {string} target - 'memory' | 'user' | 'daily' | 'project' | 'key'.
   * @param {object | undefined} agent - the calling agent; required for
   *   'project' and 'key' (its session cwd selects the project directory).
   * @returns {{dir: string, file: string} | undefined}
   *   the location, or undefined when it cannot be resolved (e.g. project
   *   memory without a session cwd).
   */
  /**
   * 取一个 target 对应的分组实体（内置或自建）。
   *
   * 装配层（lib/index.js）注入的 groupResolver 每次读最新的 groups.json，
   * 用户在设置面板新建/改名分组立刻生效；未注入时（单元测试直接 new）
   * 从 memoryDir 现场读盘，行为一致。
   * @param {string} target - 分组 id。
   * @returns {object|null} 分组实体，或 null（未知 target）。
   */
  groupOf(target) {
    if (this.groupResolver !== null) {
      const group = this.groupResolver(target)
      return group === undefined ? null : group
    }
    return findGroup(loadGroups(this.dir), 'memory', target)
  }

  /**
   * 项目 id（v3）：`projectDirResolver` 返回的是 `.system/projects/<项目id>`
   * **元数据**目录，不是数据目录——只取末段作项目 id，数据目录一律由
   * `lib/groups.js` 的路径函数产出。
   * @param {string|undefined} cwd - 会话工作目录。
   * @returns {string|null} 项目 id；无 cwd 时 null。
   */
  projectIdOf(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return null
    const resolved = this.projectDirResolver !== null ? this.projectDirResolver(cwd) : projectHash(cwd)
    return projectIdFrom({ projectDir: resolved })
  }

  /**
   * 分组的路径上下文：`{ memoryDir, projectId, sessionId }`（v3 只传 id，
   * 不传任何路径）。
   * @param {object} group - 分组实体。
   * @param {object|undefined} agent - 调用方 agent。
   * @returns {{memoryDir: string, projectId: string|null, sessionId: string|null}}
   */
  ctxOf(group, agent) {
    return {
      memoryDir: this.dir,
      projectId: group.klass === 'project' ? this.projectIdOf(agent?.session?.header?.cwd) : null,
      sessionId: group.klass === 'session' ? (agent?.session?.id ?? null) : null,
    }
  }

  /**
   * 把一个 target 解析到它的**分组目录**（2026-10-15 起：一条记忆一个 md
   * 文件，所以定位的粒度是目录而不是文件）。
   *
   * 目录规则见 lib/groups.js 的 `groupDirOf`：`<kind 根>/<组id>/<类段>`
   * （类段 = `global` / `project/<项目id>` / `session/<会话id>`）。
   * @param {string} target - 分组 id。
   * @param {object | undefined} agent - 调用方 agent（项目类要 cwd、会话类要 session id）。
   * @returns {{dir: string, file: string, group: object} | undefined}
   *   定位结果，或 undefined（无法解析，如项目类缺 cwd、会话类缺 session id）。
   */
  locate(target, agent) {
    const group = this.groupOf(target)
    if (group === null) throw new Error(`dsh-memory-evolve: 无效的记忆轨 "${target}"`)
    const dir = groupDirOf(group, this.ctxOf(group, agent))
    if (dir === null) return undefined
    // file 固定为空串：调用方 join(dir, file) 拿到的仍是目录本身
    return { dir, file: '', group }
  }

  /** Resolve a target or fail loud with a locatable message. */
  resolveTarget(target, agent) {
    const loc = this.locate(target, agent)
    if (!loc) {
      throw new Error(`dsh-memory-evolve: 无法定位记忆轨 "${target}"（项目记忆需要有效的会话工作目录）`)
    }
    return loc
  }

  /**
   * Stamp one entry with a time prefix: date stamp for the long-term tracks
   * (global memory/user AND the per-project KEY track — a `[YYYY-MM-DD]`
   * prefix, same shape as the injected global tracks), date+time for the
   * per-project log (project entries need hour granularity to reconstruct
   * when something happened), time-of-day for the daily log (its file name
   * already carries the date). Idempotent for content that already carries
   * the matching prefix; a bare `[YYYY-MM-DD]` project entry is upgraded to
   * the dated-time form on replace.
   *
   * For daily/project/key, a hand-written date-like prefix (`[2026-08-05]`,
   * `[2026-08-05 深夜]`) is STRIPPED first: writers (review subagents) do
   * not know the current date and guess — dates belong to the file name
   * (daily) or the program stamp (project/key), so the canonical stamp wins.
   *
   * Daily entries additionally carry a program-tagged project label
   * (`[HH:MM] [git branch] [label] …`) derived from the calling agent's
   * cwd, so the log shows which project each entry belongs to without the
   * LLM writing it. Daily AND project entries carry a program-tagged git
   * branch (`[git main]`, right after the time stamp) whenever the session
   * cwd is a git worktree — logs stay branch-reliable without any LLM
   * cooperation.
   * @param {string} target - the memory track.
   * @param {string} content - trimmed entry text.
   * @param {object | undefined} agent - the calling agent (its cwd selects
   *   the project label for the daily track).
   * @returns {string} the stamped entry.
   */
  stampEntry(target, content, agent) {
    // 身份证（跨设备合并锚点）**永远在条目最前**：先暂存剥离，盖完所有
    // 程序前缀（时间戳/git 分支/项目标签）后统一装回（审查 P0——此前盖在
    // 日期前导致"自带 ID 的 add/转正"产生双 ID 且合并锚点断裂）。
    const entryId = extractEntryId(content)
    if (entryId !== null) content = stripEntryId(content)
    let stamped
    if (target === 'daily' || target === 'project' || target === 'key') {
      content = content.replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, '')
      // 分支 tag 是程序专属标注：剥离模型手写的 [git 分支] 前缀，防止与
      // 程序盖的 tag 重复（模型不知道分支名，也不该写）
      content = content.replace(/^\[git [^\]]+\]\s*/, '')
    }
    if (target === 'daily') {
      if (!this.entryDatePrefix || /^\[\d{2}:\d{2}\]\s/.test(content)) {
        stamped = content
      } else {
        const d = new Date()
        const hh = String(d.getHours()).padStart(2, '0')
        const mm = String(d.getMinutes()).padStart(2, '0')
        const label = projectLabel(agent?.session?.header?.cwd)
        const branch = gitBranch(agent?.session?.header?.cwd)
        const branchTag = branch !== undefined ? `[git ${branch}] ` : ''
        stamped = `[${hh}:${mm}] ${branchTag}${label ? `[${label}] ` : ''}${content}`
      }
    } else if (target === 'project') {
      // 幂等判断与 splitEntryHead / ENTRY_HEAD_RE 同形：小时允许 1~2 位、可选秒。
      // 此前写死 `\d{2}:\d{2}`，手写的 `[2026-08-05 9:30]` 会被判成"没有戳"再盖一层。
      if (!this.entryDatePrefix || /^\[\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?::\d{2})?\]\s/.test(content)) {
        stamped = content
      } else {
        const d = new Date()
        const hh = String(d.getHours()).padStart(2, '0')
        const mm = String(d.getMinutes()).padStart(2, '0')
        const branch = gitBranch(agent?.session?.header?.cwd)
        const branchTag = branch !== undefined ? `[git ${branch}] ` : ''
        stamped = `[${todayStamp()} ${hh}:${mm}] ${branchTag}${content}`
      }
    } else if (!this.entryDatePrefix || /^\[\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?\]\s/.test(content)) {
      // 自带日期戳（旧格式 `[YYYY-MM-DD]` 或已带时分）的文本原样吃下，不重复盖戳。
      stamped = content
    } else {
      // F-6：非日志型同样精确到分钟。这里必须与 timeStampOf 的渲染**同形**，
      // 否则展开读回（textOfEntry）与 stamped 不相等，add 的判重（stripEntryId
      // 后整条比对）永不命中——同内容会被反复写成新分片。
      stamped = `[${nowStamp()}] ${content}`
    }
    // 统一出口：身份证装回最前（程序前缀之前）
    if (entryId !== null) stamped = `[id:${entryId}] ${stamped}`
    return stamped
  }

  /**
   * 一个分组的**目录**绝对路径（2026-10-15 起：一条记忆一个 md 文件，
   * 所以定位粒度是目录而非文件；记忆 Tab 的「打开目录」、文件计数、
   * Git 同步的白名单都按目录工作）。
   */
  pathOf(target, agent) {
    const loc = this.resolveTarget(target, agent)
    return loc.dir
  }


  /** Current character usage of one target (delimiter-joined length). */
  charsOf(target, agent) {
    return this.entriesOf(target, agent).join(ENTRY_DELIMITER).length
  }

  /** Read one target's entries without locking (snapshot reads). */
  entriesOf(target, agent) {
    return parseEntries(this.readRaw(target, agent).text)
  }

  /**
   * Query entries with LLM-friendly lookups: keyword `filter`
   * (case-insensitive substring), date range `since`/`until`
   * (`YYYY-MM-DD`; the daily track spans multiple files, so a range reads
   * every day's log in between), `recent` newest-first ordering and a
   * `limit` cap. Entries without a date stamp survive date filters.
   * @param {string} target - the memory track.
   * @param {object | undefined} agent - the calling agent (required for
   *   'project').
   * @param {{filter?: string, since?: string, until?: string, limit?: number, recent?: boolean}} [opts]
   * @returns {string[]} the matching entries (raw text with stamps).
   */
  query(target, agent, opts = {}, stats = {}) {
    const { filter, since, until, limit, recent } = opts
    // 2026-10-15：所有轨（含日志型）统一从分组目录读——日志型的日期来自
    // 每条的 frontmatter，不再靠"一天一个文件"的文件名，所以原先 daily
    // 专用的跨日期枚举分支被 rowsOf 统一掉了。
    let rows = this.rowsOf(target, agent)
    if (filter !== undefined && String(filter) !== '') {
      const q = String(filter).toLowerCase()
      // 正文 + 元数据（标题/摘要/关键词/使用场景）：2026-10-15 起元数据在
      // frontmatter 里，不搜它的话"按关键词找记忆"只能翻正文。
      rows = rows.filter((row) => row.text.toLowerCase().includes(q) || entryMetaText(row.entry).includes(q))
    }
    if (since !== undefined || until !== undefined) {
      rows = rows.filter((row) => {
        if (row.date === null) return true // 无日期条目不参与日期过滤
        if (since !== undefined && row.date < since) return false
        if (until !== undefined && row.date > until) return false
        return true
      })
    }
    // 统计日期无法解析的条目（旧格式/手写前缀）——调用方可据此提醒模型读全文
    stats.undated = rows.filter((row) => row.date === null).length
    stats.total = rows.length
    if (recent) rows.reverse() // 升序收集后整体反转 = 日期倒序 + 组内倒序
    if (limit !== undefined && Number.isFinite(Number(limit)) && Number(limit) > 0) {
      rows = rows.slice(0, Math.floor(Number(limit)))
    }
    return rows.map((row) => row.text)
  }

  /**
   * 读一个分组的条目为「带日期的行」（query 与 readRaw 的共同底座）。
   *
   * 日期直接取自条目 frontmatter 的 `created`（不再从文本前缀猜），所以
   * 日志型的 since/until 跨日期查询与其它分组走同一条路径。
   * @param {string} target - 分组 id。
   * @param {object|undefined} agent - 调用方 agent。
   * @returns {{date: string|null, text: string, entry: object}[]}
   */
  rowsOf(target, agent) {
    return this.rowsOfLoc(this.resolveTarget(target, agent), target)
  }

  /** `rowsOf` 的已定位版本（调用方已有 loc 时省一次解析）。 */
  rowsOfLoc(loc, target) {
    const group = loc.group
    const objs = group.daily === true ? readVaultDeep(loc.dir) : readVault(loc.dir)
    return objs.map((entry) => ({
      date: /^\d{4}-\d{2}-\d{2}/.test(entry.created ?? '') ? String(entry.created).slice(0, 10) : null,
      text: textOfEntry(entry, target),
      entry,
    }))
  }

  /**
   * 读一个分组的全部条目为纯文本（`§` 连接），保持 store 的既有文本契约。
   *
   * 「磁盘是一条一 md，内存表示仍是标签化文本」——这是本次改造把改动面
   * 压到最小一层的核心：add / replace / remove / query / 注入 / 工具输出
   * 全部继续按老契约工作，只有落盘格式变了。
   * @param {string} target - 分组 id。
   * @param {object|undefined} agent - 调用方 agent。
   * @returns {{text: string, size: number}} 该分组全部条目的文本视图。
   */
  readRaw(target, agent) {
    const rows = this.rowsOf(target, agent)
    if (rows.length === 0) return { text: '', size: 0 }
    const text = serializeEntries(rows.map((row) => row.text))
    return { text, size: text.length }
  }

  /**
   * Reload one target under the caller's lock.
   * @returns {{kind:'ok', entries: string[]} | {kind:'read-failed'} | {kind:'drift', backup: string}}
   */
  reload(target, agent) {
    const { text, size } = this.readRaw(target, agent)
    // Only a truly unreadable file is refused (non-empty size yet zero bytes
    // read back — e.g. a broken encoding). A whitespace-only file is a normal
    // empty store: rewriting it cannot wipe history.
    if (text === '' && size > 0) return { kind: 'read-failed' }
    if (!isCanonical(text)) {
      const backup = `${this.pathOf(target, agent)}.bak.${Date.now()}`
      writeFileSync(backup, text)
      return { kind: 'drift', backup }
    }
    return { kind: 'ok', entries: parseEntries(text) }
  }

  /**
   * 把一个分组的分条目文本全量落盘（增 / 改 / 删）。
   *
   * 语义与旧的"整文件覆盖"完全等价：`entries` 是权威列表，磁盘上多出来的
   * 条目文件会被删除。条目靠 `[id:…]` 与磁盘上的文件对应——这既让 replace
   * 能"改一条而不动其他"，也让 remove 能真正删掉文件。
   * @param {string} target - 分组 id。
   * @param {string[]} entries - 条目文本列表（顺序 = 组内顺序）。
   * @param {object|undefined} agent - 调用方 agent。
   */
  write(target, entries, agent) {
    const loc = this.resolveTarget(target, agent)
    const prev = this.rowsOfLoc(loc, target).map((row) => row.entry)
    const byId = new Map(prev.map((entry) => [entry.id, entry]))
    const objs = entries.map((text, index) => objectOf(text, target, loc, byId, index + 1))
    this.persist(loc, loc.group, objs)
  }

  /**
   * 把条目对象列表按分组规则写进磁盘。
   *
   * 日志型分组（`daily: true`）多一层日期目录，所以按目标目录分桶后逐桶
   * 全量同步；磁盘上存在、本次却没有内容的日期桶会被清空（否则 remove
   * 删不掉隔天的日志）。
   * @param {{dir: string, group: object}} loc - 定位结果。
   * @param {object} group - 分组实体。
   * @param {object[]} objs - 条目对象列表。
   */
  persist(loc, group, objs) {
    const buckets = new Map()
    for (const obj of objs) {
      const dir = group.daily === true ? join(loc.dir, dateDirOf(obj.created)) : loc.dir
      if (!buckets.has(dir)) buckets.set(dir, [])
      buckets.get(dir).push(obj)
    }
    const dirs = new Set(buckets.keys())
    if (group.daily === true) {
      for (const name of listVaultSubdirs(loc.dir)) dirs.add(join(loc.dir, name))
    } else {
      dirs.add(loc.dir)
    }
    for (const dir of dirs) syncVault(dir, buckets.get(dir) ?? [])
  }

  /**
   * 直接以结构化元数据写入一条记忆（新增，2026-10-15）。
   *
   * 与 `add()` 的区别：`add()` 收的是文本（元数据只能从文本前缀反推），
   * 本方法收对象——标题 / 摘要 / 关键词 / 使用场景由调用方（memory 工具）
   * 直接给出，缺失项自动兜底（标题取正文首行、摘要取正文前段、时间取当下）。
   * @param {string} target - 分组 id。
   * @param {{title?: string, summary?: string, keywords?: string[], scenario?: string, body: string, git?: string, project?: string, branches?: string[]}} input
   * @param {object|undefined} agent - 调用方 agent。
   * @returns {object} 写入结果（含落盘文件的条目对象）。
   */
  addEntry(target, input, agent) {
    const loc = this.resolveTarget(target, agent)
    const group = loc.group
    let body = String(input?.body ?? '').trim()
    if (body === '') return { ok: false, message: st('store.emptyContent'), target }
    // 兼容「标签写在文本里」的调用方式（key 轨的 [branch:…]、显式 [summary:…]）：
    // 解析进结构化字段后从正文剥离，正文只留真正的内容。
    let inlineBranches = []
    const branchMatch = /^\[branch:([^\]]*)\]\s*/.exec(body)
    if (branchMatch !== null) {
      inlineBranches = branchMatch[1].split(',').map((b) => b.trim()).filter(Boolean)
      body = body.slice(branchMatch[0].length)
    }
    let inlineSummary = null
    const summaryMatch = /^\[summary:([^\]]*)\]\s*/.exec(body)
    if (summaryMatch !== null) {
      inlineSummary = summaryMatch[1]
      body = body.slice(summaryMatch[0].length)
    }
    // 程序前缀归程序管：剥掉模型手写的日期戳与 [git …]（模型不知道当前时间，
    // 猜出来的日期会把条目排到错误的位置）。
    if (group.daily === true || target === 'key') {
      body = body
        .replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, '')
        .replace(/^\[git [^\]]+\]\s*/, '')
        .trim()
    }
    if (body === '') return { ok: false, message: st('store.emptyContent'), target }
    if (this.injectionScan) {
      const threat = scanThreat(body)
      if (threat) return { ok: false, message: threat, target }
    }
    return withLock(loc.dir, () => {
      const prev = this.rowsOfLoc(loc, target).map((row) => row.entry)
      // 去重（与文本路径 add 同语义）：正文完全相同就不再写第二条。
      if (prev.some((entry) => String(entry.body ?? '').trim() === body)) {
        return {
          ok: true, duplicate: true, message: st('store.duplicate'), target,
          chars: this.charsOf(target, agent),
        }
      }
      const cwd = agent?.session?.header?.cwd
      const created = nowStamp()
      const entry = {
        id: newEntryId(),
        title: String(input?.title ?? '').trim() || titleFromBody(body),
        summary: String(inlineSummary ?? input?.summary ?? '').trim() || autoTitleSummary(body),
        keywords: Array.isArray(input?.keywords) ? input.keywords.map((k) => String(k).trim()).filter(Boolean) : [],
        scenario: String(input?.scenario ?? '').trim(),
        created,
        updated: created,
        group: target,
        klass: group.klass,
        daily: group.daily === true,
        seq: nextSeq(prev),
        git: String(input?.git ?? '') || (group.daily === true ? (gitBranch(cwd) ?? '') : ''),
        project: String(input?.project ?? '') || (target === 'daily' ? (projectLabel(cwd) ?? '') : ''),
        branches: Array.isArray(input?.branches) && input.branches.length > 0 ? input.branches : inlineBranches,
        dshOnly: false,
        archivedAt: null,
        body,
      }
      const dir = group.daily === true ? join(loc.dir, dateDirOf(created)) : loc.dir
      writeVaultEntry(dir, entry)
      return {
        ok: true,
        message: st('store.added', { target, before: prev.length, after: prev.length + 1 }),
        target,
        entry,
        chars: body.length,
        // 兼容既有调用方读取的字段
        entries: [textOfEntry(entry, target)],
      }
    })
  }

  /**
   * Reload one target under the caller's lock, skipping the drift guard.
   * Append-only mutations never clobber parsed entries, so an un-roundtrippable
   * file is tolerated (Hermes semantics); an unreadable file is not
   * (rewriting it would wipe history). A whitespace-only file is a normal
   * empty store — only a file that exists with a size yet reads back as the
   * empty string is treated as unreadable.
   * @returns {{kind:'ok', entries: string[]} | {kind:'read-failed'}}
   */
  reloadForAppend(target, agent) {
    const { text, size } = this.readRaw(target, agent)
    if (text === '' && size > 0) return { kind: 'read-failed' }
    return { kind: 'ok', entries: parseEntries(text) }
  }

  /**
   * Append one entry. Skips the drift guard (append-only), rejects empty
   * content, exact duplicates, over-limit additions, and unreadable files.
   * @param {string} target - 'memory' or 'user'.
   * @param {string} content - the entry text.
   * @returns {object} a tool-friendly result object.
   */
  add(target, content, agent) {
    const loc = this.resolveTarget(target, agent)
    const text = String(content).trim()
    if (!text) return { ok: false, message: st('store.emptyContent'), target }
    if (this.injectionScan) {
      const threat = scanThreat(text)
      if (threat) return { ok: false, message: threat, target }
    }
    const stamped = this.stampEntry(target, text, agent)
    return withLock(loc.dir, () => {
      const reload = this.reloadForAppend(target, agent)
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      // entryIdMode=on（启用了 Git 同步的项目）：新条目前置随机身份证
      // （施工图 §4.2；未启用项目不处理，行为零变化）。一期同步范围 = 项目
      // 轨（key + project 日志），全局轨（memory/user/daily）二期才共享，
      // 一期不生成 ID —— 磁盘格式保持现状。PROVENANCE 存在 = 该项目已完成
      // bootstrap（未初始化项目即使全局开关打开也不生成 ID）。
      const syncedTrack = this.entryIdMode === 'on' && (target === 'key' || target === 'project')
        && isProjectSyncEnabled(loc.dir)
      const withId = syncedTrack && !/^\[id:[0-9a-f]{8}\]\s*/.test(stamped)
        ? `[id:${genEntryId()}] ${stamped}`
        : stamped
      // 去重比较：**两种模式都剥离身份证后再比**（2026-10-15 修正）。
      // readRaw 返回的是渲染文本（带 `[id:…] [日期]` 前缀），而 stamped 不带
      // —— 直接 includes 永不命中，同内容会被反复写成 `abc.md` 与 `abc-2.md`。
      const dup = entries.some((entry) => stripEntryId(entry) === stripEntryId(withId))
      if (dup) {
        return {
          ok: true, duplicate: true, message: st('store.duplicate'), target,
          entries: [...entries], chars: this.charsOf(target, agent),
        }
      }
      const next = [...entries, withId]
      this.write(target, next, agent)
      return {
        ok: true, message: st('store.added', { target, before: entries.length, after: next.length }), target,
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * Replace the whole entry containing the unique substring `match`.
   * Enforces the drift guard (full-file rewrite).
   * @param {string} target - 'memory' or 'user'.
   * @param {string} match - a short substring uniquely identifying one entry.
   * @param {string} content - the replacement entry text.
   * @returns {object} a tool-friendly result object.
   */
  replace(target, match, content, agent) {
    const loc = this.resolveTarget(target, agent)
    const oldText = String(match ?? '').trim()
    const newContent = String(content ?? '').trim()
    if (!oldText) return { ok: false, message: st('store.emptyMatch'), target }
    if (!newContent) return { ok: false, message: st('store.emptyNewContent'), target }
    if (this.injectionScan) {
      const threat = scanThreat(newContent)
      if (threat) return { ok: false, message: threat, target }
    }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardWrite', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      const matches = entries.filter((entry) => entry.includes(oldText))
      if (matches.length === 0) {
        return { ok: false, message: st('store.noMatch', { match: oldText }), target, entries: [...entries] }
      }
      if (matches.length > 1) {
        return {
          ok: false,
          message: st('store.multiMatch', { match: oldText, count: matches.length }),
          target, matches: [...matches], entries: [...entries],
        }
      }
      const index = entries.indexOf(matches[0])
      const next = [...entries]
      // 替换不换身份（施工图 §4.3；Codex 二轮 P1-3 扩展）：
      //   - **旧条目已有身份证（任何轨）→ 必须保留**——全局轨开启后
      //     memory/user 也会补发 [id:xxxx]，replace 删掉 ID 会让双设备
      //     修改同一条时无法对齐（被当成两条新增）；
      //   - 旧条目无 ID：项目轨（key/project）且同步启用 → 按旧内容确定性
      //     补发（legacyIdFor，双设备一致）；未启用同步的 memory/user 无
      //     ID → 不加（保持纯本地状态）。
      let replacement = this.stampEntry(target, newContent, agent)
      const oldId = extractEntryId(matches[0])
      // 2026-10-15：id 在新存储模型下是**每条的永久身份**（文件名与跨设备
      // 合并都锚在它上面），所以无条件保留旧 id——不再受 entryIdMode 影响。
      if (oldId !== null) {
        replacement = `[id:${oldId}] ${stripEntryId(replacement)}`
      } else if (target === 'key' || target === 'project') {
        // 旧数据没有 id：按旧内容确定性补发（双设备一致，legacyIdFor 是纯函数）
        const legacyId = legacyIdFor(stripEntryId(matches[0]))
        replacement = `[id:${legacyId}] ${stripEntryId(replacement)}`
      }
      // 标记类元数据搬运（2026-10-15）：`objectOf` 现在以文本为唯一真相，
      // 而 replace 只改正文、生成的新文本不含旧标记——不搬的话
      // `[branch:…]`（分支范围）与 `[dsh-only]` 会被静默丢掉。
      const keptBranches = parseEntryBranches(matches[0])
      const keptDshOnly = parseEntryDshOnly(matches[0])
      if (keptBranches !== null || keptDshOnly) {
        const tags = [
          keptBranches !== null ? `[branch:${keptBranches.join(',')}]` : '',
          keptDshOnly ? DSH_ONLY_TAG : '',
        ].filter(Boolean).join(' ')
        // 插进头部序列的正确位置：`[id] 时间戳 [git …]*` 之后、正文之前
        replacement = replacement.replace(
          /^((?:\[id:[0-9a-f]{8}\]\s*)?(?:\[\d{4}-\d{2}-\d{2}[^\]]*\]|\[\d{1,2}:\d{2}(?::\d{2})?\])\s*(?:\[git [^\]]+\]\s*)*)/,
          `$1${tags} `,
        )
      }
      next[index] = replacement
      this.write(target, next, agent)
      return {
        ok: true, message: st('store.replaced', { target, count: entries.length }), target,
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * Remove the entry containing the unique substring `match`.
   * Enforces the drift guard (full-file rewrite).
   * @param {string} target - 'memory' or 'user'.
   * @param {string} match - a short substring uniquely identifying one entry.
   * @returns {object} a tool-friendly result object.
   */
  remove(target, match, agent) {
    const loc = this.resolveTarget(target, agent)
    const oldText = String(match ?? '').trim()
    if (!oldText) return { ok: false, message: st('store.emptyMatch'), target }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardOp', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      const matches = entries.filter((entry) => entry.includes(oldText))
      if (matches.length === 0) {
        return { ok: false, message: st('store.noMatch', { match: oldText }), target, entries: [...entries] }
      }
      if (matches.length > 1) {
        return {
          ok: false,
          message: st('store.multiMatch', { match: oldText, count: matches.length }),
          target, matches: [...matches], entries: [...entries],
        }
      }
      const index = entries.indexOf(matches[0])
      const next = [...entries]
      next.splice(index, 1)
      this.write(target, next, agent)
      return {
        ok: true, message: st('store.removed', { target, before: entries.length, after: next.length }), target,
        // removed：被删的整条原文（含时间戳）——供归档等"移动"场景直接
        // 追加到归档文件，避免二次匹配
        removed: matches[0],
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * Preview the single entry containing the unique substring `match`,
   * WITHOUT writing anything. 与 remove 同一匹配语义（唯一子串命中、
   * drift guard 前置校验），供「先归档、后删除」的移动场景使用：
   * 先用 peek 拿到命中原文写入归档文件，归档成功后再执行删除——
   * 替代旧「先删后加」顺序，避免归档写入失败时主轨条目直接丢失。
   * @param {string} target - 'memory' or 'user'.
   * @param {string} match - a short substring uniquely identifying one entry.
   * @returns {object} a tool-friendly result object ({ ok, entry } on success).
   */
  peek(target, match, agent) {
    const loc = this.resolveTarget(target, agent)
    const oldText = String(match ?? '').trim()
    if (!oldText) return { ok: false, message: st('store.emptyMatch'), target }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardOp', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableOp'), target }
      }
      const matches = reload.entries.filter((entry) => entry.includes(oldText))
      if (matches.length === 0) {
        return { ok: false, message: st('store.noMatch', { match: oldText }), target }
      }
      if (matches.length > 1) {
        return {
          ok: false,
          message: st('store.multiMatch', { match: oldText, count: matches.length }),
          target,
        }
      }
      return { ok: true, entry: matches[0], target }
    })
  }

  /**
   * Preview whether an EXACT whole-entry match exists (same matching
   * semantics as removeExact, read-only, writes nothing). 供「先归档、
   * 后删除」场景在写入归档文件前校验目标条目确实存在于主轨——避免
   * 无效请求（非整条子串、已删除条目）先把垃圾内容写进归档文件。
   *
   * 匹配走 findExactIndex（对展示层剥离的 `[id:…]` / `[summary:…]` 免疫，
   * issue #59），但**返回的是磁盘原文**而不是入参：归档文件因此保留
   * `[id:…]` 与 `[summary:…]`，转正回主轨时不丢元数据（`store.add` 的
   * stampEntry 会把身份证装回最前、时间戳重新盖）。
   * @param {string} target - the memory track ('memory' | 'user' | 'daily' |
   *   'project' | 'key').
   * @param {string} entry - the FULL entry text (with its stamp) to check.
   * @returns {object} a tool-friendly result object ({ ok, entry } on success);
   *   `entry` is the on-disk original, not the caller's text.
   */
  peekExact(target, entry, agent) {
    const loc = this.resolveTarget(target, agent)
    const exact = String(entry ?? '').trim()
    if (!exact) return { ok: false, message: st('store.emptyEntry'), target }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardOp', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableOp'), target }
      }
      const index = findExactIndex(reload.entries, exact)
      if (index === -1) {
        return { ok: false, message: stt('storetail.mainMissing'), target }
      }
      return { ok: true, entry: reload.entries[index], target }
    })
  }

  /**
   * Remove the entry that EXACTLY equals `entry` (whole-entry match, not a
   * substring). Used by the memory tab's per-entry delete button: the UI
   * sends the full entry text it rendered, and this deletes precisely that
   * entry — a substring match could hit a longer entry that merely contains
   * the text (e.g. deleting "喜欢简洁" must not remove "喜欢简洁，也喜欢
   * 详细"). Enforces the drift guard; a missing exact entry is reported
   * without touching anything.
   * @param {string} target - the memory track ('memory' | 'user' | 'daily' |
   *   'project' | 'key').
   * @param {string} entry - the FULL entry text (with its stamp) to delete.
   * @returns {object} a tool-friendly result object.
   */
  removeExact(target, entry, agent) {
    const loc = this.resolveTarget(target, agent)
    const exact = String(entry ?? '').trim()
    if (!exact) return { ok: false, message: st('store.emptyEntry'), target }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardOp', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      // 精确匹配对身份证免疫（审查 P0）：展示层剥离 [id:…] 后回传的文本
      // 也能命中磁盘原文（strip 相等比较）；多条命中报歧义（防御）。
      const index = findExactIndex(entries, exact)
      if (index === -1) {
        return {
          ok: false,
          message: stt('storetail.entryMissing'),
          target, entries: [...entries],
        }
      }
      const next = [...entries]
      next.splice(index, 1)
      this.write(target, next, agent)
      return {
        ok: true, message: st('store.removed', { target, before: entries.length, after: next.length }), target,
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * Set the branch scope of one KEY entry (whole-entry exact match). An
   * empty `branches` array means "all branches" — the tag is REMOVED
   * ("全部" has the highest weight: it wins over any branch selection).
   * The date stamp is preserved; the tag is (re)inserted right after it.
   * @param {string} target - 'key' (other tracks are rejected).
   * @param {string} entry - the FULL entry text to update.
   * @param {string[]} branches - the branch names ([] = all branches).
   * @returns {object} a tool-friendly result object.
   */
  setEntryBranches(target, entry, branches, agent) {
    const loc = this.resolveTarget(target, agent)
    const exact = String(entry ?? '').trim()
    if (!exact) return { ok: false, message: st('store.emptyEntry'), target }
    if (target !== 'key') return { ok: false, message: stt('storetail.branchKeyOnly'), target }
    const list = (Array.isArray(branches) ? branches : [])
      .map((b) => String(b).trim())
      .filter((b) => b.length > 0)
    const tag = list.length > 0 ? `[branch:${list.join(',')}] ` : ''
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardOp', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      const index = findExactIndex(entries, exact)
      if (index === -1) {
        return {
          ok: false,
          message: stt('storetail.entryMissing'),
          target, entries: [...entries],
        }
      }
      // 用**磁盘原文**（含身份证）重建（审查 P1：基于剥离文本重建会丢 ID）；
      // splitEntryHead 拆出全部程序前缀（id/日期/git/branch/dsh-only），
      // 去掉旧 [branch:] 后插入新标记
      const diskEntry = entries[index]
      const { head, body } = splitEntryHead(diskEntry, target)
      const headNoBranch = head.replace(/\[branch:[^\]]*\]\s*/, '')
      const next = [...entries]
      next[index] = `${headNoBranch}${tag}${body}`
      this.write(target, next, agent)
      return {
        ok: true, message: list.length > 0 ? `已设置分支范围（${list.join('、')}）` : '已设为全部分支可见',
        target, entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * 设置/取消一条目的「仅 DSH」标记（整条精确匹配，与 setEntryBranches
   * 同款校验：drift guard + 精确相等 + 不存在的条目拒绝）。
   *
   * 标记为 `[dsh-only]`（时间戳与 [branch:…] 之后、正文之前）：打标记后
   * 该条目仍注入 DSH 自身会话，但注入外部执行器（COI 任务的 injectTracks
   * 记忆注入）时会被 buildMemoryContext 的 excludeDshOnly 整条跳过——
   * 用于存放只对 DSH 有意义的纪律/规则/架构类事实（外部 CLI 代理不是
   * DSH，强行遵循 DSH 规则只会困惑）。取消标记 = 移除该 tag（条目恢复
   * 对外部执行器可见）。
   * @param {string} target - 'memory' | 'user' | 'key'（其他轨拒绝）。
   * @param {string} entry - 完整条目原文（整条精确匹配）。
   * @param {boolean} on - true=打标记，false=取消标记。
   * @returns {object} a tool-friendly result object.
   */
  setEntryDshOnly(target, entry, on, agent) {
    const loc = this.resolveTarget(target, agent)
    const exact = String(entry ?? '').trim()
    if (!exact) return { ok: false, message: st('store.emptyEntry'), target }
    if (target !== 'memory' && target !== 'user' && target !== 'key') {
      return { ok: false, message: stt('storetail.dshOnlyTrackLimit'), target }
    }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardOp', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      const index = findExactIndex(entries, exact)
      if (index === -1) {
        return {
          ok: false,
          message: stt('storetail.entryMissing'),
          target, entries: [...entries],
        }
      }
      // 用磁盘原文重建（保身份证）；splitEntryHead 拆出全部程序前缀，
      // 去掉旧 [dsh-only] 后按需插入——位置固定：程序元数据之后、正文之前
      const diskEntry = entries[index]
      const bare = diskEntry.replace(DSH_ONLY_RE, '')
      const { head, body } = splitEntryHead(bare, target)
      const next = [...entries]
      next[index] = on ? `${head}${DSH_ONLY_TAG} ${body}` : `${head}${body}`
      this.write(target, next, agent)
      return {
        ok: true,
        message: on ? '已标记为仅 DSH 适用（注入外部执行器时跳过）' : '已取消仅 DSH 标记（外部执行器可见）',
        target, entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }

  /**
   * 只更新一条目的正文（整条精确匹配）——记忆 Tab 美观视图的「编辑」入口。
   * 时间戳与全部 tag（[git …] / [branch:…] / daily 项目标签）原样保留：
   * 程序维护的元数据不可被编辑改动。内容禁止包含条目分隔符 §（防破坏
   * § 分割格式）。Enforces the drift guard (full-file rewrite).
   * @param {string} target - 'memory' | 'user' | 'daily' | 'project' | 'key'。
   * @param {string} entry - 完整条目原文（与删除/归档同一份，UI 渲染时持有）。
   * @param {string} content - 新正文（可多行；空内容请用删除）。
   * @returns {object} a tool-friendly result object.
   */
  updateEntryContent(target, entry, content, agent) {
    const loc = this.resolveTarget(target, agent)
    const exact = String(entry ?? '').trim()
    const newContent = String(content ?? '').trim()
    if (!exact) return { ok: false, message: st('store.emptyEntry'), target }
    if (!newContent) return { ok: false, message: stt('storetail.emptyContentTab'), target }
    if (newContent.includes('§')) {
      return { ok: false, message: stt('storetail.sectionDelimiter'), target }
    }
    if (this.injectionScan) {
      const threat = scanThreat(newContent)
      if (threat) return { ok: false, message: threat, target }
    }
    return withLock(loc.dir, () => {
      const reload = this.reload(target, agent)
      if (reload.kind === 'drift') {
        return {
          ok: false,
          message: st('store.driftGuardWrite', { file: loc.file, backup: reload.backup }),
          target, backup: reload.backup,
        }
      }
      if (reload.kind === 'read-failed') {
        return { ok: false, message: st('store.fileUnreadableWrite'), target }
      }
      const entries = reload.entries
      const index = findExactIndex(entries, exact)
      if (index === -1) {
        return {
          ok: false,
          message: stt('storetail.entryMissing'),
          target, entries: [...entries],
        }
      }
      const { head } = splitEntryHead(entries[index], target) // 磁盘原文（保身份证）
      // 防御：完全解析不出前缀的异常条目，编辑会破坏其原有格式——拒绝并提示手动处理
      if (head === '') {
        return {
          ok: false,
          message: stt('storetail.unrecognizedPrefix'),
          target, entries: [...entries],
        }
      }
      const next = [...entries]
      next[index] = `${head}${newContent}`
      this.write(target, next, agent)
      return {
        ok: true, message: stt('storetail.updated', { target }), target,
        entries: [...next], chars: next.join(ENTRY_DELIMITER).length,
      }
    })
  }
}

/**
 * Append-only JSONL queue of background-review memory suggestions
 * (the "learned track" awaiting user confirmation).
 */
export class SuggestionQueue {
  /**
   * @param {string} file - the JSONL file path.
   */
  constructor(file) {
    this.file = file
  }

  /** Read all suggestions; a missing file reads as empty. */
  read() {
    try {
      const text = readFileSync(this.file, 'utf8')
      return text
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line))
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  /** Atomically write the full suggestion list. */
  write(entries) {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp.${process.pid}`
    writeFileSync(tmp, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''))
    renameSync(tmp, this.file)
  }

  /** Append one suggestion under the directory lock. */
  append(entry) {
    return withLock(dirname(this.file), () => {
      const entries = this.read()
      entries.push(entry)
      this.write(entries)
      return { ok: true, queued: entries.length }
    })
  }

  /**
   * Mutate the suggestion list under the directory lock.
   * @param {(entries: object[]) => T} fn - the mutation; return value is passed through.
   * @returns {T} the mutation's return value.
   * @template T
   */
  mutate(fn) {
    return withLock(dirname(this.file), () => {
      const entries = this.read()
      const result = fn(entries)
      this.write(entries)
      return result
    })
  }
}

/**
 * 归档存储：低优先级记忆的冷存储——"丢了可惜但不够格进主记忆"的建议
 * 落在这里。不注入任何会话；条目可在记忆 Tab「移回主记忆」（转正，写回
 * 对应主轨）或删除。文件与主轨同格式（§ 分隔 + `[YYYY-MM-DD]` 时间戳），
 * 按原 target 分文件：`MEMORY-archive.md` / `USER-archive.md`，以及项目级
 * `projects/<cwd-hash>/KEY-archive.md`（key 轨的归档，随项目走，需 cwd）。
 */
export class ArchiveStore {
  /**
   * @param {string} dir - the memory directory (archive files live beside
   *   the main track files).
   * @param {object} [options]
   * @param {(cwd: string) => string} [options.projectDirResolver] - 项目解析器
   *   （记忆同步装配层注入）：返回元数据目录，只取末段作项目 id（v3 归档目录
   *   由 groups.js 的 `groupArchiveDirOf` 产出）。
   */
  constructor(dir, options = {}) {
    this.dir = dir
    this.projectDirResolver = typeof options.projectDirResolver === 'function' ? options.projectDirResolver : null
    // 分组解析器（2026-10-15 三类改造）：归档目录由分组的类决定，且**自建分组
    // 也能归档**（用户拍板）。装配层注入后每次读最新配置。
    this.groupResolver = typeof options.groupResolver === 'function' ? options.groupResolver : null
    // 待办分组解析器（2026-10-15 B2）：待办归档也走目录模型，归档轨写作
    // `todo-<组id>`。记忆与待办的 id 会重名（session / project / daily 两类
    // 都有），所以必须带前缀区分、并各用各的解析器。
    this.todoGroupResolver = typeof options.todoGroupResolver === 'function' ? options.todoGroupResolver : null
  }

  /**
   * 归档轨对应的分组实体。两种写法：
   *   - `todo-<组id>` → 该待办分组（2026-10-15 起待办归档也走目录模型）；
   *   - 其它 → 记忆分组 id。
   * 返回 null 表示"这条轨没有对应分组"（只有旧的单文件轨 `todo-archive` 是这种情况）。
   */
  groupOf(target) {
    if (typeof target === 'string' && target.startsWith('todo-')) {
      const id = target.slice(5)
      if (this.todoGroupResolver !== null) {
        const group = this.todoGroupResolver(id)
        return group === undefined || group === null ? null : group
      }
      return findGroup(loadGroups(this.dir), 'todo', id)
    }
    if (this.groupResolver !== null) {
      const group = this.groupResolver(target)
      return group === undefined ? null : group
    }
    return findGroup(loadGroups(this.dir), 'memory', target)
  }

  /**
   * 项目 id（v3）：解析器给的是 `.system/projects/<项目id>` 元数据目录，
   * 只取末段；数据目录由 `groupArchiveDirOf` 产出。
   * @param {string|undefined} cwd - 会话工作目录。
   * @returns {string|null} 项目 id；无 cwd 时 null。
   */
  projectIdOf(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return null
    const resolved = this.projectDirResolver !== null ? this.projectDirResolver(cwd) : projectHash(cwd)
    return projectIdFrom({ projectDir: resolved })
  }

  /**
   * 归档**目录**（一条归档记忆 = 一个 md，与主轨同格式）。
   *
   * 位置：`<kind 根>/<组id>/archive/<类段>`（见 lib/groups.js 的
   * groupArchiveDirOf），日志型分组再套一层日期目录。待办分组同样落在这里
   * （归档轨 `todo-<组id>`）。
   * @returns {string|null} 目录；只有旧的单文件轨 `todo-archive` 返回 null。
   */
  dirOf(target, cwd, sessionId) {
    // 旧的待办建议归档（单文件 TODO-archive.md）保留**只读兼容**：它没有
    // 对应的分组实体，所以继续走 fileOf。新写入一律进目录模型。
    if (target === 'todo-archive') return null
    const group = this.groupOf(target)
    if (group === null) throw new Error(`dsh-memory-evolve: 无效的归档轨 "${target}"`)
    const projectId = group.klass === 'project' ? this.projectIdOf(cwd) : null
    if (group.klass === 'project' && projectId === null) {
      throw new Error('dsh-memory-evolve: 项目类归档需要会话工作目录')
    }
    // 会话类分组的归档目录带会话 id —— 必须由调用方传下来（此前硬编码 null，
    // 会话类分组的归档根本无法定位）。
    const dir = groupArchiveDirOf(group, {
      memoryDir: this.dir,
      projectId,
      sessionId: sessionId === undefined ? null : sessionId,
    })
    if (dir === null) {
      throw new Error(`dsh-memory-evolve: 无法定位归档轨 "${target}"（会话类需要会话 id，项目类需要会话工作目录）`)
    }
    return dir
  }

  /**
   * 旧单文件待办建议归档：v3 下只从 `.system/legacy/` 读（迁移后旧文件在那里），
   * 记忆根下不再允许出现该文件。
   * @returns {string} 路径。
   */
  fileOf(target) {
    return join(legacyDirOf(this.dir), 'TODO-archive.md')
  }

  /** 读一个归档轨的全部条目（记忆侧 = 目录里的 md；`todo-*` = 单文件）。 */
  entriesOf(target, cwd, sessionId) {
    const dir = this.dirOf(target, cwd, sessionId)
    if (dir === null) {
      try {
        return parseEntries(readFileSync(this.fileOf(target), 'utf8'))
      } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
      }
    }
    return readVaultDeep(dir).map((entry) => textOfEntry(entry, target))
  }

  /** 追加一条归档条目（记忆侧写成一个 md 文件；`todo-*` 仍整文件重写）。 */
  append(target, content, cwd, sessionId) {
    const dir = this.dirOf(target, cwd, sessionId)
    if (dir === null) {
      // 锁文件所在目录（key 归档=项目目录，与主轨写/合并互斥；全局归档=记忆根）
      const lockDir = dirname(this.fileOf(target))
      return withLock(lockDir, () => {
        const entries = this.entriesOf(target, cwd, sessionId)
        entries.push(content)
        const path = this.fileOf(target)
        const tmp = `${path}.tmp.${process.pid}`
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(tmp, serializeEntries(entries))
        renameSync(tmp, path)
        return { ok: true, total: entries.length }
      })
    }
    return withLock(dir, () => {
      const group = this.groupOf(target)
      const loc = { dir, group }
      const existing = readVaultDeep(dir)
      const obj = objectOf(String(content), target, loc, new Map(), nextSeq(existing), { today: todayStamp() })
      obj.archivedAt = nowStamp()
      const targetDir = group.daily === true ? join(dir, dateDirOf(obj.created)) : dir
      writeVaultEntry(targetDir, obj)
      return { ok: true, total: readVaultDeep(dir).length }
    })
  }

  /**
   * Remove the single entry containing the unique substring `match`.
   *
   * 两侧都过 normalizeForMatch（issue #59）：归档页回传的是**展示文本**
   * （已剥 `[id:…]` / `[summary:…]`），而归档文件里存的是含元数据的原文——
   * 直接在原文上 `includes(展示文本)` 会因为中间插了元数据而断链。这条路径
   * 是 `promoteArchived()` 转正成功后清理归档文件用的，不修就会出现
   * 「转正成功但归档那条删不掉 → 同一内容同时留在主轨与归档」且不报错。
   */
  remove(target, match, cwd, sessionId) {
    const dir = this.dirOf(target, cwd, sessionId)
    if (dir === null) {
      const lockDir = dirname(this.fileOf(target))
      return withLock(lockDir, () => {
        const entries = this.entriesOf(target, cwd, sessionId)
        const needle = normalizeForMatch(match)
        const matches = entries.filter((entry) => normalizeForMatch(entry).includes(needle))
        if (matches.length === 0) return { ok: false, message: stt('storetail.archiveNoMatch', { match }) }
        if (matches.length > 1) {
          return { ok: false, message: stt('storetail.archiveMultiMatch', { match, count: matches.length }) }
        }
        const next = entries.filter((entry) => !normalizeForMatch(entry).includes(needle))
        const path = this.fileOf(target)
        const tmp = `${path}.tmp.${process.pid}`
        writeFileSync(tmp, serializeEntries(next))
        renameSync(tmp, path)
        return { ok: true, removed: matches[0] }
      })
    }
    return withLock(dir, () => {
      const entries = readVaultDeep(dir)
      const needle = normalizeForMatch(match)
      const matches = entries.filter((entry) => normalizeForMatch(textOfEntry(entry, target)).includes(needle))
      if (matches.length === 0) return { ok: false, message: stt('storetail.archiveNoMatch', { match }) }
      if (matches.length > 1) {
        return { ok: false, message: stt('storetail.archiveMultiMatch', { match, count: matches.length }) }
      }
      deleteVaultEntry(matches[0])
      return { ok: true, removed: textOfEntry(matches[0], target) }
    })
  }

  /**
   * Remove the entry that EXACTLY equals `content` (whole-entry match).
   *
   * 走与主轨同一套 findExactIndex（issue #59）：此前是 `entries.indexOf()`
   * 严格相等，**连 `[id:…]` 都不免疫**——启用 Git 同步后写入身份证的归档
   * 条目（`[id:…]` 前缀）在归档页一律删不掉。归档允许同一内容重复出现，
   * 因此多条命中取首条（`first: true`）而不是报歧义。
   */
  removeExact(target, content, cwd, sessionId) {
    const dir = this.dirOf(target, cwd, sessionId)
    if (dir === null) {
      return withLock(this.dir, () => {
        const entries = this.entriesOf(target, cwd, sessionId)
        const index = findExactIndex(entries, content, { first: true })
        if (index === -1) {
          return { ok: false, message: stt('storetail.archiveEntryMissing') }
        }
        const next = [...entries]
        next.splice(index, 1)
        const path = this.fileOf(target)
        const tmp = `${path}.tmp.${process.pid}`
        writeFileSync(tmp, serializeEntries(next))
        renameSync(tmp, path)
        return { ok: true, removed: entries[index] }
      })
    }
    return withLock(dir, () => {
      const entries = readVaultDeep(dir)
      const needle = normalizeForMatch(content)
      // 归档页回传的是**展示文本**（可能已剥 `[id:…]` / `[summary:…]`），所以
      // 先找完全相等的，找不到再退回"包含"（归档允许重复，命中即删首条）。
      const hit = entries.find((entry) => normalizeForMatch(textOfEntry(entry, target)) === needle)
        ?? entries.find((entry) => normalizeForMatch(textOfEntry(entry, target)).includes(needle))
      if (hit === undefined) return { ok: false, message: stt('storetail.archiveEntryMissing') }
      deleteVaultEntry(hit)
      return { ok: true, removed: textOfEntry(hit, target) }
    })
  }
}
