/**
 * 同步模块的布局门禁（v3，2026-10-19）。
 *
 * 判据：`<memoryDir>/.layout-version` 内容 === 3。迁移器**最后一步**才写这个
 * 标记（`migrate-v3.js`），所以「有标记=3」与 `lib/index.js` 的
 * `layoutStatusOf().state === 'v3'` 等价（迁移中必然还没有标记）。
 *
 * 为什么不用 `layoutStatusOf`：worker 跑在独立子进程（`scripts/sync-worker.mjs`），
 * 引 `lib/index.js` 会把整个插件拖进去；这里只依赖 groups.js 的路径函数。
 *
 * 返回形状与既有各层一致：
 *   - ops / 命令层：`{kind:'error', text}`
 *   - worker / repo 层：`{ok:false, code:2, message}`
 *
 * @module dsh-memory-evolve/sync/layout-gate
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { layoutVersionFileOf, systemDirOf } from '../groups.js'
import { getLocale } from '../i18n.js'

/** 门禁失败码（worker 退出码；与迁移 CLI 的 2 语义不同，都是"被门挡"）。 */
export const LAYOUT_GATE_CODE = 2

/** 布局要求的目标版本。 */
export const REQUIRED_LAYOUT_VERSION = 3

/** 门禁文案（zh/en；措辞对齐 i18n.js 的同步字典）。 */
const LAYOUT_GATE_DICT = {
  'sync.layoutBlocked': [
    '记忆布局未迁移到 v3，同步已停用：请先运行 scripts/migrate-v3.mjs 迁移记忆目录（这不是开关问题，--allow-sync 也不适用）',
    'Memory layout is not migrated to v3, so sync is disabled: run scripts/migrate-v3.mjs to migrate the memory directory first (this is not a switch issue — --allow-sync does not apply)',
  ],
  'sync.layoutRolledBack': [
    '记忆根已回退到旧布局（v3 标记已消失），同步已停用：请重启插件并重新运行 scripts/migrate-v3.mjs',
    'The memory root has rolled back to the old layout (the v3 marker is gone), so sync is disabled: restart the plugin and re-run scripts/migrate-v3.mjs',
  ],
}

/**
 * 门禁文案（按宿主语言选 zh/en）。
 * @returns {string} 提示文本。
 */
export function layoutBlockedMessage() {
  const [zh, en] = LAYOUT_GATE_DICT['sync.layoutBlocked']
  return getLocale() === 'en' ? en : zh
}

/**
 * 「装配后回退」文案：插件装配时是 v3，之后标记消失（回滚不重启 / 手删标记）。
 * @returns {string} 提示文本。
 */
export function layoutRollbackMessage() {
  const [zh, en] = LAYOUT_GATE_DICT['sync.layoutRolledBack']
  return getLocale() === 'en' ? en : zh
}

/**
 * 记忆目录是否已是 v3 布局。
 * @param {string} memoryDir - 记忆根目录。
 * @returns {boolean} `.layout-version` 内容为 3 时 true；缺失/不可读/其它值 false。
 */
export function isLayoutV3(memoryDir) {
  if (typeof memoryDir !== 'string' || memoryDir === '') return false
  try {
    return Number(readFileSync(layoutVersionFileOf(memoryDir), 'utf8').trim()) === REQUIRED_LAYOUT_VERSION
  } catch {
    return false
  }
}

/**
 * 门禁检查（通用）：放行返回 null。
 * @param {string} memoryDir - 记忆根目录。
 * @returns {string|null} 拒绝文案，或 null（放行）。
 */
export function layoutBlockedReason(memoryDir) {
  return isLayoutV3(memoryDir) ? null : layoutBlockedMessage()
}

/**
 * ops / 命令层门禁：被挡时返回 `{kind:'error', text}`，放行返回 null。
 * @param {string} memoryDir - 记忆根目录。
 * @returns {{kind: 'error', text: string}|null} 命令结果形状。
 */
export function layoutGateError(memoryDir) {
  const reason = layoutBlockedReason(memoryDir)
  return reason === null ? null : { kind: 'error', text: reason }
}

/** 标记文件存在且版本号 < 3（显式声明"旧布局"）。 */
function markerExistsBelow3(memoryDir) {
  if (typeof memoryDir !== 'string' || memoryDir === '') return false
  try {
    const value = Number(readFileSync(layoutVersionFileOf(memoryDir), 'utf8').trim())
    return Number.isFinite(value) && value < REQUIRED_LAYOUT_VERSION
  } catch {
    return false
  }
}

/** 迁移器是否进行中（半迁移状态文件存在）。 */
function migrationInProgress(memoryDir) {
  if (typeof memoryDir !== 'string' || memoryDir === '') return false
  return existsSync(join(systemDirOf(memoryDir), 'migrate-v3.state'))
}

/**
 * 软门禁（repo / worker 层）：只在**能证明是旧布局**时拒绝。
 *
 * - 标记 = 3 → 放行；
 * - 标记存在且 < 3 → 拒绝（明确是旧布局）；
 * - 无标记但正在迁移（`.system/migrate-v3.state` 存在）→ 拒绝；
 * - 无标记且无迁移状态 = v2 旧仓库 / 测试夹具 → 放行（保持既有兼容路径）。
 * @param {string} memoryDir - 记忆根目录（或 v2 项目目录）。
 * @returns {string|null} 拒绝文案，或 null（放行）。
 */
export function layoutBlockedReasonSoft(memoryDir) {
  if (isLayoutV3(memoryDir)) return null
  if (markerExistsBelow3(memoryDir)) return layoutBlockedMessage()
  if (migrationInProgress(memoryDir)) return layoutBlockedMessage()
  return null
}

/**
 * 软门禁的 worker/repo 返回形状：被挡时 `{ok:false, code:2, message}`，放行 null。
 * @param {string} memoryDir - 记忆根目录。
 * @returns {{ok: false, code: number, message: string}|null} worker 结果形状。
 */
export function layoutGateFailureSoft(memoryDir) {
  const reason = layoutBlockedReasonSoft(memoryDir)
  return reason === null ? null : { ok: false, code: LAYOUT_GATE_CODE, message: reason }
}

/**
 * 软门禁的 ops / 命令返回形状：被挡时 `{kind:'error', text}`，放行 null。
 * 生产上 ops 只在 `state==='v3'` 时装配，所以这一层用软口径（无 marker 的 v2
 * 旧目录放行）不降低安全性：迁移中与 marker<3 仍拒。
 * @param {string} memoryDir - 记忆根目录。
 * @returns {{kind: 'error', text: string}|null} 命令结果形状。
 */
export function layoutGateErrorSoft(memoryDir) {
  const reason = layoutBlockedReasonSoft(memoryDir)
  return reason === null ? null : { kind: 'error', text: reason }
}

/**
 * 「装配后回退」门禁：装配时是 v3、现在标记消失 → 拒。
 *
 * 场景：`migrate-v3.mjs --rollback` 后不重启（syncCtrl 仍装配），或运行中手删
 * `.layout-version`。此时软门禁会因"标记缺失"放行，但工作树已回到 v2 →
 * 必须在入口挡住，否则会在 v2 根上 init 仓库、写同步元数据。
 * @param {boolean} assembledV3 - 装配时记忆根是否已是 v3。
 * @param {string} memoryDir - 记忆根目录。
 * @returns {{kind: 'error', text: string}|null} 命令结果形状（未回退返回 null）。
 */
export function layoutGateErrorIfRolledBack(assembledV3, memoryDir) {
  if (assembledV3 !== true || isLayoutV3(memoryDir)) return null
  return { kind: 'error', text: layoutRollbackMessage() }
}

/**
 * worker / repo 层门禁：被挡时返回 `{ok:false, code:2, message}`，放行返回 null。
 * @param {string} memoryDir - 记忆根目录。
 * @returns {{ok: false, code: number, message: string}|null} worker 结果形状。
 */
export function layoutGateFailure(memoryDir) {
  const reason = layoutBlockedReason(memoryDir)
  return reason === null ? null : { ok: false, code: LAYOUT_GATE_CODE, message: reason }
}
