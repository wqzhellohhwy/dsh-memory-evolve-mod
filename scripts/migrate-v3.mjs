#!/usr/bin/env node
/**
 * scripts/migrate-v3.mjs — 记忆目录布局 v2 → v3 迁移 CLI。
 *
 * 用法：
 *   node scripts/migrate-v3.mjs [--memory-dir <路径>] [--dry-run]
 *   node scripts/migrate-v3.mjs [--memory-dir <路径>] --apply [--allow-sync]
 *   node scripts/migrate-v3.mjs [--memory-dir <路径>] --rollback <备份目录> [--dry-run]
 *
 * 缺省记忆根：`$DSH_MEMORY_DIR` → `<DSH_HOME 或 ~/.dsh>/memories`。
 * 迁移模式：不给 `--apply` 一律 dry-run（只出计划，不落盘）。
 * 回滚模式：给了 `--rollback` 就直接还原；要预演请显式加 `--dry-run`。
 * 退出码：0 = 成功（dry-run 也返回 0）/ 1 = 有错误 / 2 = 参数错误。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { LAYOUT_VERSION, migrateV3, normalizeMemoryDir, rollbackV3, syncGate } from '../lib/migrate-v3.js'

/** 默认记忆根。 */
export function defaultMemoryDir() {
  if (process.env.DSH_MEMORY_DIR) return process.env.DSH_MEMORY_DIR
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'memories')
}

/** 记忆根的特征条目（用来确认目标路径不是打错的空目录）。 */
const MEMORY_MARKERS = ['groups.json', 'global', 'sessions', 'projects', '.system', 'todo']

/** 目标是否像个记忆根。 */
export function looksLikeMemoryDir(dir) {
  return MEMORY_MARKERS.some((name) => existsSync(join(dir, name)))
}

/** 解析 argv（不含 node 与脚本名）。 */
export function parseArgs(argv) {
  const opts = { memoryDir: null, apply: false, dryRun: false, rollback: null, allowSync: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--memory-dir' || arg === '--rollback') {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} 需要路径参数`)
      }
      if (arg === '--memory-dir') opts.memoryDir = next
      else opts.rollback = next
      i += 1
    } else if (arg === '--apply') opts.apply = true
    else if (arg === '--allow-sync') opts.allowSync = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  if (opts.dryRun && opts.apply) throw new Error('--dry-run 与 --apply 互斥')
  return opts
}

const HELP = `用法：
  node scripts/migrate-v3.mjs [--memory-dir <路径>] [--dry-run]     只出计划（缺省行为）
  node scripts/migrate-v3.mjs [--memory-dir <路径>] --apply [--allow-sync]   先备份再迁移
  node scripts/migrate-v3.mjs [--memory-dir <路径>] --rollback <备份目录> [--dry-run]

--allow-sync  记忆同步开着时仍执行迁移（默认拒绝，退出码 2；同步与迁移互踩会损坏数据）。

--memory-dir 缺省 $DSH_MEMORY_DIR → <$DSH_HOME 或 ~/.dsh>/memories（自动转绝对路径、剥尾分隔符）。
退出码：0 成功 / 1 迁移或回滚出错 / 2 参数错误或目标不像记忆根。
`

/** 冲突原因的中文说明。 */
function reasonLabel(reason) {
  if (typeof reason !== 'string') return '目标被占'
  if (reason.startsWith('ancestor-is-file:')) return `祖先 ${reason.slice('ancestor-is-file:'.length)} 是文件`
  if (reason === 'target-exists') return '目标已存在且非空'
  return reason
}

/** 打印迁移报告。 */
export function renderReport(report) {
  const lines = []
  const { dryRun } = report
  lines.push(`记忆根：${report.memoryDir}`)
  if (report.alreadyMigrated) {
    lines.push(`布局版本：${report.layoutVersion}（已是 v${LAYOUT_VERSION}，无需迁移）`)
    return lines.join('\n')
  }
  lines.push(`当前布局版本：${report.layoutVersion === null ? '缺失（旧结构）' : report.layoutVersion}`)
  lines.push(`模式：${dryRun ? 'dry-run（只出计划，不落盘）' : 'apply（先备份再迁移）'}`)

  if (report.sync.enabled) {
    lines.push('')
    lines.push(`⚠ 检测到记忆同步已开启（syncEnabled=true，${report.sync.source}）：`)
    lines.push('  迁移期间同步可能与本操作互相覆盖。建议先关闭同步再迁移。')
    if (!dryRun) lines.push('  本次已用 --allow-sync 明确承担风险。')
  }

  if (report.planned !== null) {
    const p = report.planned
    lines.push('')
    lines.push('计划：')
    lines.push(`  建根目录                    ${p.mkdir}`)
    lines.push(`  搬迁目录                    ${p.directories}`)
    lines.push(`  搬迁文件                    ${p.files}`)
    lines.push(`  旧结构 → .system/legacy/    ${p.legacy}`)
    lines.push(`  归档 .keep                  ${p.keep}`)
    lines.push(`  合计步骤                    ${p.total}（已完成跳过 ${report.skipped}，待执行 ${report.pending}）`)
    lines.push(`  模块数据（原地保留，不迁）   ${p.moduleData}`)
    lines.push(`  未知顶层条目（搬 legacy）    ${p.legacyEntries}`)
  }

  if (report.moduleData.length > 0) {
    lines.push('')
    lines.push(`模块数据 ${report.moduleData.length} 项（本次重构不迁，原地保留）：`)
    lines.push(`  ${report.moduleData.join('、')}`)
  }

  if (report.legacyEntries.length > 0) {
    lines.push('')
    lines.push(`未知顶层条目 ${report.legacyEntries.length} 项（搬进 .system/legacy/）：`)
    lines.push(`  ${report.legacyEntries.join('、')}`)
  }

  if (report.conflicts.length > 0) {
    lines.push('')
    lines.push(`冲突 ${report.conflicts.length} 条（目标被占，不覆盖、源保留、跳过）：`)
    for (const item of report.conflicts.slice(0, 20)) {
      lines.push(`  ${item.from} → ${item.to}（${reasonLabel(item.reason)}）`)
    }
    if (report.conflicts.length > 20) lines.push(`  …还有 ${report.conflicts.length - 20} 条`)
    lines.push('  冲突项已记 done，不会自动重试；如需重试请删除 .system/migrate-v3.state。')
  }

  if (dryRun && report.planned !== null) {
    const sample = report.steps.filter((step) => step.kind === 'move').slice(0, 10)
    if (sample.length > 0) {
      lines.push('')
      lines.push('搬迁样例：')
      for (const step of sample) lines.push(`  ${step.from} → ${step.to}`)
    }
    lines.push('')
    lines.push('未写入任何文件。要真正执行：加 --apply（会先整目录备份到 <记忆根>..bak-<时间戳>）。')
    return lines.join('\n')
  }

  lines.push('')
  lines.push(`备份：${report.backup === null ? '（无需备份）' : report.backup}`)
  if (report.backupRecreated) lines.push('注意：原备份已不在，本次重新备份了完整目录。')
  if (report.skippedSymlinks.length > 0) {
    lines.push(`跳过符号链接 ${report.skippedSymlinks.length} 个（不跟随、未复制）：`)
    for (const link of report.skippedSymlinks.slice(0, 10)) lines.push(`  ${link}`)
    if (report.skippedSymlinks.length > 10) lines.push(`  …还有 ${report.skippedSymlinks.length - 10} 个`)
  }
  if (report.notes !== undefined && report.notes.length > 0) {
    for (const note of report.notes) lines.push(`提示：${note}`)
  }
  lines.push(`已执行步骤：${report.executed}`)
  lines.push(`布局版本：${report.layoutVersion === null ? '未写入' : report.layoutVersion}`)
  lines.push(`根下多余条目：${report.rootExtras.length === 0 ? '无' : report.rootExtras.join('、')}`)
  if (report.errors.length > 0) {
    lines.push('')
    lines.push(`错误 ${report.errors.length} 条：`)
    for (const error of report.errors) lines.push(`  ${error}`)
  }
  lines.push('')
  lines.push(report.ok
    ? '完成。回滚：node scripts/migrate-v3.mjs --rollback <备份目录>'
    : '未完成（磁盘未丢失数据，可修好后重跑 --apply 续跑）')
  return lines.join('\n')
}

/** 打印回滚报告。 */
export function renderRollback(report) {
  const lines = [`记忆根：${report.memoryDir}`, `备份源：${report.backup}`]
  if (report.dryRun) {
    lines.push('模式：dry-run（只确认目标，不动盘）')
  } else {
    lines.push(`原目录挪到：${report.movedTo}`)
  }
  if (report.errors.length > 0) {
    lines.push('')
    for (const error of report.errors) lines.push(`错误：${error}`)
  } else if (!report.dryRun) {
    lines.push('已用备份整体还原记忆根（备份本身保留，可重复回滚）。')
  }
  if (report.skippedSymlinks !== undefined && report.skippedSymlinks.length > 0) {
    lines.push(`跳过符号链接 ${report.skippedSymlinks.length} 个（不跟随、未复制）。`)
  }
  return lines.join('\n')
}

/** 入口。 */
export function main(argv = process.argv.slice(2)) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (opts.help) {
    process.stdout.write(HELP)
    return 0
  }
  const memoryDir = normalizeMemoryDir(opts.memoryDir ?? defaultMemoryDir())

  if (opts.rollback !== null) {
    const report = rollbackV3(memoryDir, opts.rollback, { dryRun: opts.dryRun })
    process.stdout.write(`${renderRollback(report)}\n`)
    return report.ok ? 0 : 1
  }

  // 目标路径必须像个记忆根，否则 apply 会静默建出一个空 v3（打错盘符/目录名的典型事故）
  if (!looksLikeMemoryDir(memoryDir)) {
    process.stderr.write(
      `目标不像记忆根（缺 groups.json / global / sessions / projects / .system）：${memoryDir}\n`,
    )
    return 2
  }

  // 同步门禁：开着就要求显式 `--allow-sync`（不改 lib/sync，只拦迁移本身）
  const sync = syncGate(memoryDir)
  if (opts.apply && sync.enabled && !opts.allowSync) {
    process.stderr.write(
      `检测到记忆同步已开启（${sync.source}）：迁移期间同步可能与本操作互相覆盖。\n`
      + '请先关闭同步（plugin-state.json 的 syncEnabled），或加 --allow-sync 明确承担风险。\n'
      + '未做任何改动。\n',
    )
    return 2
  }

  const report = migrateV3(memoryDir, { dryRun: !opts.apply, allowSync: opts.allowSync })
  process.stdout.write(`${renderReport(report)}\n`)
  return report.ok ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
