/**
 * 能力清单（`GET /memory-evolve/api/features`）。
 *
 * 以前每个模块各发一个"探测式"请求（开关关闭时端点 404 → 控制台一片 404）。
 * 现在宿主始终提供一张布尔表，前端启动读一次，按布尔值决定注册哪些 Tab/按钮/
 * 观察器。只列本模块用到的键；缺失键按 **出厂默认**（这些模块默认关闭 = false）。
 *
 * 缓存规则：
 *   - 成功才进内存缓存（同一页面生命周期内不重复请求）；
 *   - **失败不缓存**（下次调用可重试），且失败时本函数自己会重试一次；
 *   - 订阅 RUNTIME_CONFIG_CHANGED 清缓存（模块开关变化需刷新页面才反映到 Tab）。
 * 不写 localStorage（避免跨版本残留错误能力表）。
 */
import { RUNTIME_CONFIG_CHANGED } from './todo-tab-lifecycle.js'

/** 前端关心的模块开关键（与宿主 runtime 键名一致）。 */
export type FeatureKey =
  | 'notify'
  | 'coi'
  | 'broadcast'
  | 'uiSettings'
  | 'prompts'
  | 'bookmarks'
  | 'canvas'

/** 全量解析后的能力表。 */
export type Features = Record<FeatureKey, boolean>

/** 出厂默认（与宿主默认一致；本模块用到的键全部默认关闭）。 */
const DEFAULTS: Features = {
  notify: false,
  coi: false,
  broadcast: false,
  uiSettings: false,
  prompts: false,
  bookmarks: false,
  canvas: false,
}

/** 成功结果的内存缓存（失败不写）。 */
let cached: Features | null = null

/** 进行中的请求（并发调用共享同一个请求；settle 后清空）。 */
let pending: Promise<Features> | null = null

/** 把宿主返回的 features 对象收窄成本模块的固定键集；缺失键取出厂默认。 */
function pick(raw: unknown): Features {
  const table = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: Features = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS) as FeatureKey[]) {
    const value = table[key]
    if (typeof value === 'boolean') out[key] = value
  }
  return out
}

/** 单次请求；非 200 或解析失败都抛错（交给 loadFeatures 重试）。 */
async function fetchOnce(): Promise<Features> {
  const res = await fetch('/memory-evolve/api/features')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { features?: unknown }
  return pick(body?.features)
}

/**
 * 读能力清单。
 * 成功 → 缓存；失败重试一次，仍失败 → 返回出厂默认（不缓存，下次可重试）。
 * 并发调用共享同一个 in-flight 请求（首屏多处调用只发一次 GET）。
 * @returns 永不 reject 的 Promise。
 */
export function loadFeatures(): Promise<Features> {
  if (cached !== null) return Promise.resolve(cached)
  if (pending !== null) return pending
  pending = (async (): Promise<Features> => {
    const first = await fetchOnce().catch(() => null)
    const features = first ?? await fetchOnce().catch(() => null)
    if (features === null) return DEFAULTS
    cached = features
    return features
  })()
  void pending.finally(() => { pending = null })
  return pending
}

/** 运行时配置变化 → 能力表缓存作废（下次 loadFeatures 重新拉）。 */
if (typeof window !== 'undefined') {
  window.addEventListener(RUNTIME_CONFIG_CHANGED, () => { cached = null })
}
