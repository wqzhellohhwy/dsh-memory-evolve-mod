/**
 * dsh-memory-evolve — persistent long-term memory and background memory
 * review for DeepSeek Harness. Pure plugin: only public seams
 * (`systemPrompt`, `tools`, `commands`, `subagents`, `approval`), zero DSH
 * core changes, zero runtime dependencies.
 *
 * Two memory tracks:
 *   - user track (MEMORY.md / USER.md): written only by explicit user action
 *     (the `memory` tool call) or by user-confirmed suggestions;
 *   - learned track (SUGGESTIONS.jsonl): background reviews propose, the
 *     user confirms through `/memory_review`.
 *
 * The snapshot is injected as a `systemPrompt` context: DSH materializes it
 * as a user-role tail message and only re-appends when the rendered text
 * changes, so the stable system/history prefix (and its cache) is preserved.
 * @module dsh-memory-evolve
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ArchiveStore, MemoryStore, SuggestionQueue, extractEntryDate, gitBranch, gitBranchList, parseEntryBranches, parseEntryDshOnly, parseEntrySummary, autoSummary, stripEntrySummary, todayStamp } from './store.js'
import { stripEntryId, extractEntryId, legacyIdFor } from './sync/entryid.js'
import { readAliases } from './aliases.js'
import { reviewCommand, reviewStatusTool, reviewTurnCounter, writeGapCounter, enqueueSuggestion, suggestToolDefinition, promoteArchived } from './review.js'
// skills.js 的 skill_manage 工具已下线（2026-10-16 用户要求），不再 import。
import {
  TOOL_BLOCKS, blockTextOf, composeDescription, groupBlockId, isBlockEnabled, normalizeHeadOverride,
  normalizeToolBlocks, normalizeToolBlockTexts, trackEnabled,
} from './tool-blocks.js'
import { memorySearchTool } from './memory-search.js'
// 工具描述的用户覆盖（tools.json）：注册与配置页共用同一个出口，覆盖优先（含显式置空）。
import { loadToolsConfig, resolveToolDefs, toolDescriptionOf, toolOverride } from './tool-registry.js'
// 自建工具的动作分发（tools.json 的 custom[] → 真正注册给模型的工具）
import { buildCustomTools } from './custom-tools.js'
import { migrateToVault } from './migrate-v2.js'
import { installApi } from './api.js'
import { TodoStore, createTodoController } from './todo.js'
import {
  GROUPS_VERSION, LAYOUT_VERSION, advisorDirOf, defaultGroupsConfig, deleteGroup, findGroup,
  groupArchiveDirOf, groupDirOf, groupLabel, groupsFileOf, isInjected, layoutVersionFileOf,
  listEnabledGroups, listGroups, loadGroups, memoryRootOf, needsConfirmation, newGroupId,
  normalizeGroupsConfig, projectMetaDirOf, saveGroups, stateFileOf, suggestionsFileOf, todoRootOf,
  upsertGroup,
} from './groups.js'
import { readMigrationState } from './migrate-v3.js'
import { installMemorySync, makeProjectDirResolver } from './sync/index.js'
import { createSearchDocsController, searchDocsCommand } from './search-docs.js'
import { installBroadcast, installCoi } from './coi/index.js'
import { syncBuiltinSkillsIfEnabled } from './coi/skills-sync.js'
import { installNotify, installChannelSend, installSessionImages } from './notify.js'
import { buildWsCoordBlock, installWsCoord } from './coi/ws-coord.js'
import { installSession } from './session-orch.js'
import { AliasStore } from './aliases.js'
import { installSessionSearch } from './search/index.js'
import { installPrompts, sanitizeSnapshotBody } from './prompts.js'
import { installModels, buildModelsSnapshotAsync } from './models.js'
import { installUiSettings } from './ui-settings.js'
import { installMermaid } from './mermaid.js'
import { installBookmarks } from './bookmarks.js'
import { installCanvas } from './canvas.js'
import { getUpdateChecker } from './update.js'
import { installAdvisor } from './advisor/index.js'
import { resolveLocale, setLocale, getLocale, translate, MEMORY_DICT, REVIEW_DICT, TODO_DICT, SKILL_DICT, SNAPSHOT_DICT, MISC_DICT, MISC2_DICT, LIBRARY_DICT } from './i18n.js'
import { libraryToolDefinition } from './library-tools.js'
// DSH 0.2.0 settings 服务兼容层（get→describe、事件改名）：详见 settings-compat.js 头注释
import { hasSettingsRead, SETTINGS_CHANGE_EVENTS } from './settings-compat.js'

/** Translate through the MEMORY dictionary in the active locale. */
const mt = (key, params) => translate(MEMORY_DICT, key, params)
/** Translate through the SNAPSHOT dictionary in the active locale. */
const st = (key, params) => translate(SNAPSHOT_DICT, key, params)

/**
 * 关键词参数归一：接受 `"编码, 高成熟度"` 或 `["编码","高成熟度"]`。
 *
 * 工具 schema 里 keywords 是字符串（模型写起来最省事），但库里存数组。
 * @param {string|string[]|undefined|null} value - 原始值。
 * @returns {string[]} 清洗后的关键词（去空、去重、单条 ≤ 40 字、最多 12 条）。
 */
function normalizeKeywordList(value) {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? value.split(/[,，、;；]/) : [])
  const out = []
  for (const item of raw) {
    const text = String(item ?? '').replace(/[\n\r\t]/g, ' ').trim().slice(0, 40)
    if (text === '' || out.includes(text)) continue
    out.push(text)
    if (out.length >= 12) break
  }
  return out
}

// Re-exported for the web API layer (api.js imports them from here).
export { gitBranch, gitBranchList } from './store.js'

export const name = 'dsh-memory-evolve-mod'
// 插件级服务声明：声明过的服务 ctx.xxx 直接可用（cordis 限制：未声明的
// 服务直接读会抛 "cannot get property 'xxx' without inject"）。
// tools/systemPrompt 是历史声明；agents 于 2026-08-09 加入——会话编排
// 模块（de_session）需要它创建/唤醒会话（曾用 ctx.inject(['agents'])
// 动态注入导致工具未注册，改为声明式注入后与 tools 同款可靠）；
// workspaceRegistry 刻意不做插件级硬依赖：headless bundle 不提供该
// web-only 服务，而默认的记忆工具与提示词注入并不需要它。需要工作区的
// 可选能力通过 ctx.get() / 局部 ctx.inject() 读取并明确降级。
// sessionTitle 同日加入——de_session rename 改会话名称（左侧列表标题）。
// sessionPersistence 于 2026-08-11 加入——de_session wake 恢复离线会话时
// 需读该会话 log 里自己最后使用的模型（request/header），否则恢复的
// agent.options 为空、{{model}} 变量无值导致被唤醒会话回合失败。
// settings / llm 于 2026-08-11 加入——模型配置模块（de_models 工具 +
// 「模型设置」Tab）需要读取模型目录（settings.get）与供应商/思考等级
// 元数据（llm.listConfigurableProviders / resolveModelInfo）。
export const inject = ['tools', 'systemPrompt', 'agents', 'sessionTitle', 'sessionPersistence', 'settings', 'llm']

/** Plugin config defaults (conservative: review off, memory on). */
export const DEFAULTS = {
  // storage
  memoryDir: null, // null → <dshHome>/memories
  entryDatePrefix: true,
  // daily / project memory (per-turn proactive writes — never injected, see renderSnapshot)
  perTurnProjectWrites: true, // snapshot hint requires a per-turn project write check
  perTurnDailyWrites: true,   // snapshot hint requires a per-turn daily write check
  perTurnKeyWrites: true,     // snapshot hint: importance-gated project KEY writes (injected)
  // 写入看门狗（2026-08-31 设计；用户拍板 2026-09-04：**默认关闭**）：
  // 长会话指令稀释——固定提示词逐渐失效，模型连续多轮不写 daily/project
  // 且程序侧毫无反馈，遗漏被静默吞掉（根源是模型指令遵循能力，强模型
  // 不需要这个功能，故默认关、用户按需打开）。开启后程序按会话统计
  // "连续完成多少个用户回合未写 daily/project"，缺口达到 writeGuardThreshold
  // 时快照注入置顶提醒（粘性，写入即消）；threshold=2 意为容忍 1 轮遗漏、
  // 第 2 轮起提醒。可在「Memory Evolve 设置 → 配置」打开。
  perTurnWriteGuard: false,  // false（默认）= 不计数、不提醒；true = 启用看门狗
  writeGuardThreshold: 2,    // 连续 N 轮未写入触发提醒（正整数，>=1）
  keyBranchFilter: true,      // static (config.yaml only): inject only KEY entries whose branch scope matches the session's git branch
  // key 轨渐进式披露（2026-08-15）：摘要注入减少 token，按需展开加载全文
  keyProgressiveDisclosure: 'off', // 'auto' | 'off' | 'on' — auto=小数据量全量注入、大数据量摘要注入；off=始终全量（默认）；on=始终摘要
  keyFullInjectThreshold: 3,  // auto 模式：条目数 ≤ 此值 → 全量注入
  keyFullInjectCharLimit: 1500, // auto 模式：总字符数 ≤ 此值 → 全量注入
  // snapshot injection
  injectMemory: true,
  snapshotOrder: 500,
  // 开局提示词（2026-10-14 用户需求）：记忆插件每轮注入的那段「固定指导
  // 文案」（工具说明 + 收尾职责清单）可以在设置面板里看到并改写。
  // 空串（默认）= 用内置文案；非空 = 整段替换，支持 {branch} / {memoryTool} /
  // {todoTool} / {targets} / {reviewInterval} / {sessionId} 占位符。
  snapshotPrompt: '',
  // 工具定义联动（2026-10-19 用户需求）：**默认关**。
  // 开启后 tools.json 里的「改名 / 停用」才真正作用于注册（进入模型的工具面）；
  // 关闭时配置页可改但不影响模型 —— 因为改工具面会让老会话的 KV 缓存失效。
  toolDefsLive: false,
  // 记忆库管理工具（memory_library，2026-10-15 用户需求）：**默认关** ——
  // 可选工具默认关是本仓库惯例（searchDocs / canvas / sessionSearch 同款），
  // 打开后 agent 能对记忆库做库级操作（批量删除/归档、跨级搬移、查重）。
  memoryLibraryEnabled: false,
  // 注入方式（2026-10-14 用户需求）：'context' = 运行时上下文快照（默认，
  // 升级前行为，前缀缓存最友好）；'section' = 作为 **系统提示词段** 注入
  // （systemPrompt.section，与 dsh-system-prompts 同一条通道）。对**全部
  // 注入内容**生效：各记忆分组、内置指导文案、待办注入。
  injectMode: 'context',
  // 内置文案是否启用（2026-10-14 用户需求）：false = 不再注入插件内置的那段
  // 固定指导（{section}/{readHint}/{分支/待办提示} + 收尾职责清单）；分组内容
  // 与用户自定义的「开局提示词」照常注入。
  builtinGuidance: true,
  injectionScan: true,
  // tools / command names
  toolName: 'memory',
  suggestToolName: 'memory_suggest',
  commandName: 'memory_review',
  skillManageToolName: 'skill_manage',
  todoToolName: 'dtodo',
  // 待办能力运行时开关（默认开；关闭时 dtodo 工具、待办 Tab、到期提醒
  // 一并退出，数据与同步轨保留）。向后兼容：旧配置/state 文件缺失该键时
  // 视为启用，保持既有行为。
  todoEnabled: true,
  // 待办注入 / 收尾检查（2026-10-13 用户需求）：
  //   todoInject = 把「需要关注的未完成待办」注入快照（默认关——绝大多数
  //                会话不需要每轮看待办；注入哪些分组由每个待办分组自己的
  //                inject 决定，见 lib/groups.js）；
  //   todoCheck  = 每轮收尾提示模型检查到期待办（默认开，即原有行为；
  //                关掉后快照不再出现 snap.todoHint 指导行）。
  todoInject: false,
  todoCheck: true,
  // 待确认记忆的界面行为（2026-10-13 用户需求）：
  //   pendingBadge    = 会话页「记忆」标签是否显示待确认红点（默认显示）
  //   jumpToPending   = 有待确认记忆时，点进记忆 Tab 直接落在「待确认记忆
  //                     建议」子页（默认关，保持原来看文件视图的习惯）
  //   allAutoApprove  = 全局自动通过：所有记忆分组的写入都跳过待确认队列
  //                     直接落盘（默认关；单分组可在分组设置里各自打开）
  pendingBadge: true,
  jumpToPending: false,
  allAutoApprove: false,
  // 停用分组的显示三态（2026-10-15 用户需求）：'hidden' 不显示（默认）/
  // 'dim' 灰显 / 'shown' 正常显示。用户原话："默认不显示。不过灰显这个设置
  // 不错，选项改成显示/灰显/不显示"。
  showDisabled: 'hidden',
  // 三类记忆的条目数显示（2026-10-15 用户需求 UI-16）：
  //   countShow* = 会话 / 工作区 / 全局三类页签与分组页签是否显示条目数（默认显示）；
  //   countIncludeDisabled = 数字是否算上已停用分组的条目（默认算）；
  //   countIncludeArchived = 数字是否算上已归档条目（默认不算）。
  countShowSession: true,
  countShowProject: true,
  countShowGlobal: true,
  countIncludeDisabled: true,
  countIncludeArchived: false,
  // 条目的展开形态（2026-10-15 用户 F-8）：
  //   entryExpandMode = 'collapsed'（**默认**：只显示标题行，便于浏览）/ 'preview'
  //     （展开前 entryPreviewLines 行）/ 'full'（整条撑开）；
  //   entryPreviewLines = preview 模式显示多少行（默认 3）；
  //   entryRememberHeight = 记住每条手动拖拽过的高度（localStorage，默认开）。
  entryExpandMode: 'collapsed',
  entryPreviewLines: 3,
  entryRememberHeight: true,
  // 条目元数据行（F-7，2026-10-16 用户）：记忆 / 待办各自的显示开关（默认都开）。
  entryMetaMemory: true,
  entryMetaTodo: true,
  // 工具定义分块启用（2026-10-16 用户：工具定义严重冗杂）：
  // `{ "<工具>.<块>": false }` —— 只存显式关掉的项，缺省全开。块表见 lib/tool-blocks.js。
  toolBlocks: {},
  // 块文案覆盖（2026-10-17 用户：块的文案可写、可恢复默认）：
  // `{ "<工具>.<块>": "自定义文案" }` —— 空串不存（= 恢复默认）。
  toolBlockTexts: {},
  // 分组文本字段的自动保存（2026-10-16 用户）：**统一开关**，不再按分组各配一个。
  // 打开后分组页的名称与提示词离开输入框即提交，界面上的「保存」按钮变灰。
  groupAutoSave: false,
  // skill management
  skillDir: null, // null → ~/.agents/skills (the DSH skill library)
  skillMaxBytes: 65536,
  // background review (in-turn, prompt-driven: the main LLM reviews itself
  // when the turn counter reaches the interval)
  reviewEnabled: false,
  reviewInterval: 5,
  reviewMode: 'suggest', // 'suggest' | 'auto' — suggest = global facts go through memory_suggest (user confirms); auto = direct memory writes
  skillReviewEnabled: false, // off by default: skill creations queue for user confirmation (on = direct, no approval)
  memoryTabEnabled: true, // session memory tab in the web GUI (default ON — the settings-panel entry is gone, the tab is the only surface)
  suggestionsFile: null, // null → <memoryDir>/.system/SUGGESTIONS.jsonl
  stateFile: null, // null → <memoryDir>/.system/plugin-state.json (runtime config overrides)
  // local file search (search_local_files; default OFF — the tool is not
  // registered at all, so the model never sees it)
  searchDocsEnabled: false,
  // 四档模式（2026-08-09 用户拍板）：all=文件名+内容 / filename=仅文件名 /
  // content=仅内容 / off=工具不注册。**null = 未设置**——实际生效值由
  // controller 按「运行时 mode → 配置 mode → 旧布尔开关推断」三级解析
  // （不在此推断，避免推断值压过运行时 Web 面板/slash 命令的切换）。
  searchDocsMode: null,
  searchDocsToolName: 'memory_evolve_search_local_files',
  searchDocsCommandName: 'memory_evolve_search_files',
  searchDocsExts: ['md'],
  searchDocsProviders: 'auto', // 'auto' | ['mdfind','es','rg','walk'] — replaceable implementations
  searchDocsCacheTtlMs: 3600000, // walk 缓存 TTL（1h）
  searchDocsTimeoutMs: 60000, // 每层搜索超时上限
  // 记忆检索工具（2026-10-15 用户需求）：按元数据（标题/摘要/关键词/使用
  // 场景）与正文跨三类检索记忆。true = 注册工具；工具名可改（可运行时改）。
  searchMemoryEnabled: true,
  searchMemoryToolName: 'memory_search',
  searchDocsCacheFile: null, // null → <memoryDir>/search-docs-index.json
  // COI 调度（de_coi：统一调度 kimi/codex/grok/hermes 等 CLI 代理）
  coiEnabled: false,          // COI 调度总开关（默认禁用，与本地搜索一致；记忆 Tab 运行时配置可随时切换，工具/命令即时生效，Tab 刷新后出现）
  coiDataDir: null,           // null → <memoryDir>/coi
  coiSummaryEnabled: true,    // 任务完成自动沉淀摘要到 project/daily 记忆
  coiSyncSkills: true,        // 启动时把内置适配器技能（skills/ 目录）同步到技能库（源头在插件）
  coiNotifyCommand: null,     // 完成通知命令模板（占位符 {taskId}{coi}{status}{summary}；null=不通知）
  coiRetentionDays: 90,       // 任务留档保留天数（超期自动清理）
  coiTaskTimeoutMs: 43200000, // 任务默认超时（12 小时；AI 代理任务动辄数小时，超时仅作兜底防线）
  coiMaxLogBytes: 2097152,    // 单任务留档上限（2 MiB）
  // 会话广播（de_broadcast）：**独立子模块**（用户拍板 2026-08-08：明显
  // 独立的子模块不挂在别的模块下——曾跟随 coiEnabled 导致开关联动、工具
  // 上下文污染），独立开关与存储目录；开启后注册 de_broadcast 工具 +
  // 快照「会话广播」段 + 会话头部复制会话 ID 按钮；默认关
  broadcastEnabled: false,
  broadcastDataDir: null,     // null → <memoryDir>/broadcast
  // 广播图片附件子开关（P3 2026-08-11，随 260810 快照图片机制）：de_broadcast
  // send 支持图片附件（path/url/base64 三来源，存 <广播目录>/attachments/，
  // 消息 JSON 只存元数据；GUI 收件箱缩略图 + AI read 拿文件路径）。**依赖
  // broadcastEnabled 大开关**（广播关=附件整体不生效）；默认开（发图是聊天
  // 基本能力，随广播启用即可用；关闭时 send 带附件明确报错不静默忽略）。
  broadcastImageEnabled: true,
  // 工作区冲突协调（ws-coord）：**会话广播模块的子功能组**（用户拍板
  // 2026-08-09——语义上属于"通知的一部分"，归入广播，不做独立模块）。
  // 同工作区多会话并行时的资源占用协调：声明锁（de_ws_declare）+
  // 自动登记（fs/observed 写后自动进占用集）+ 写前冲突检测（软模式：
  // 警告不拦截，先信任 AI；enforceWrite 打开升级为硬拦截）+ 冲突定向
  // 通知 + 活动感知（de_ws_status 概览 / 快照【工作区活动】段）。依赖
  // broadcastEnabled 大开关（广播关 = 本功能全部不注册）。默认关。
  wsCoordEnabled: false,
  wsCoordEnforceWrite: false, // 硬拦截模式（true=冲突时 deny 拒绝写入；默认软模式只警告）
  wsCoordSnapshot: true,      // 活动感知快照段【工作区活动】（活跃会话 ≥2 时注入一行，带时间）
  wsCoordAutoRegister: true,  // fs/observed 自动登记（false=只有声明式锁）
  wsCoordNotifyConflict: true,// 冲突时给占用方发定向通知（走广播通道）
  // 会话搜索（de_session_search）：**独立子模块**（与广播同一纪律——不挂
  // 在任何模块下）。独立开关；零常驻状态（无索引/缓存/定时器，每次调用
  // 实时只读扫描）；当前支持 Codex 源（~/.codex/sessions + archived_sessions
  // 的明文 JSONL，rg 预筛后毫秒级），DSH 会话（zstd 拼接帧）暂不实现。
  // 默认关：注册即占模型工具列表，需要时才开。
  sessionSearchEnabled: false,
  sessionSearchRoots: null,   // 每源根目录覆盖（当前仅 codex，如 { codex: '/path' }）；null=各源默认
  // 会话编排（de_session）：**独立子模块**（用户拍板纪律——独立领域
  // 不挂别的模块下）。程序化创建/唤醒 DSH 会话（spawn 新会话派长提示词、
  // wake 唤醒已有会话等价替用户发消息、status/list 查状态）。独立开关
  // 与存储目录；默认关（注册即占模型工具列表）。依赖 DSH agents 服务，
  // 仅同进程会话可唤醒；spawn 加房间经广播模块松耦合桥接。
  sessionEnabled: false,
  sessionDataDir: null,       // null → <memoryDir>/session-orch
  promptsEnabled: false,      // 提示词管理器总开关（默认禁用，与本地搜索/COI 一致；开启后「提示词」Tab、注入轨与 de_prompts 工具生效）
  promptToolName: 'de_prompts', // 提示词库工具名（AI 查询/注入提示词；随 promptsEnabled 开关注册/注销）
  // 模型配置（de_models + 「模型设置」Tab）：**独立子模块**（与其他模块
  // 同款独立开关）。表格展示 DSH 供应商/模型 + 每模型启用/备注/思考等级
  // 配置；de_models 工具给 AI 查询可用模型清单。**默认关闭**（与其他
  // 独立模块一致：注册即占模型工具列表，需要时再开；且本模块的配置
  // 只对插件自身有用——不修改也不影响 DSH 的模型设置，DSH 侧仍以官方
  // 「设置 → 模型」为准）。
  modelsEnabled: false,
  // DSH UI 设置（dsh-ui-settings）：**独立子模块**（与广播/COI 同一纪律——
  // 独立领域不挂别的模块下）。对 DSH web 界面做样式级小功能（第一版：左侧
  // 会话列表「仅显示进行中」筛选，默认只显示进行中的会话、可一键切回全部；
  // 后期扩展：主题更换等）。纯客户端实现（CSS + DOM 增强），宿主端只提供
  // 开关与状态端点；**默认关闭**（与其他独立模块一致，需要时再开）。
  uiSettingsEnabled: false,
  // 会话书签（session bookmarks）：**独立子模块**（与广播/UI 设置同一纪律——
  // 独立领域不挂别的模块下）。每轮星标 + 书签列表 + 跳转定位（第一阶段）；
  // 第二阶段才做「从此处新建官方分支」。纯 UI + 宿主 API（不注册 AI 工具）；
  // 存储独立 sidecar <memoryDir>/session-bookmarks.json；**默认关闭**。
  bookmarkEnabled: false,
  // 渠道通知（de_notify）：**独立子模块**（与广播/COI 同一纪律——独立领域
  // 不挂别的模块下）。AI 完成任务后通过 IM 渠道（一期：飞书）**主动发通知**
  // 给用户。渠道能力来自渠道插件（dsh-feishu 等**公共插件**）在 apply 时
  // 登记的 globalThis 注册表（用户拍板方案 A）——本模块**零依赖**渠道插件
  // （没装/旧版无钩子 → 如实报"渠道不可用"，主插件零影响）。两种触发：
  // ①de_notify 手动工具（随时可发、无频率约束——用户拍板）；
  // ②COI 完成自动通知（COI 运行时配置 coiNotifyChannels，经 sendChannelNotify
  // 回调松耦合桥接，notify 未启用时 COI 侧静默跳过）。**默认关闭**（与其他
  // 独立模块一致：注册即占模型工具列表，需要时再开）。
  notifyEnabled: false,
  // 渠道直发（de_channel_send）：**独立子模块**（2026-08-10 用户拍板——与
  // notify 同一纪律：独立领域独立开关；当天由 de_feishu_send 泛化为四渠道：
  // feishu/qq/weixin/wecom）。AI 主动发送文本/图片/文件到 IM 渠道（DSH→渠道
  // 单向，不带「非对话」通知标注）。渠道能力来自各渠道插件（dsh-feishu /
  // dsh-qqbot / dsh-weixin / dsh-wecombot）的 globalThis 注册表（sendMedia
  // 槽位，插件版本需支持附件）。**默认开启**（用户拍板要的功能，开箱即用；
  // 与 notifyEnabled 互不影响：直发 vs 通知，语义不同、开关粒度独立）。
  channelSendEnabled: true,
  // 本会话图片查询（de_session_images）：**独立子模块**（2026-08-11 P1 任务——
  // 与渠道发送同一家族但语义独立：列出当前会话最近的图片引用，AI 先查再发）。
  // 独立开关 sessionImageQueryEnabled（默认**关**，与其他独立模块一致：注册即
  // 占模型工具列表，需要时再开；且依赖 DSH 260810+ 快照的 attachments 服务，
  // 旧版本查询会如实报错）。开启时注册 de_session_images 工具；关闭时整体卸载。
  sessionImageQueryEnabled: false,
  // 项目记忆跨设备同步（/memory_sync）：**独立子模块**（独立领域独立开关
  // 纪律）。syncEnabled 默认**关**——不开的项目/电脑行为与现状逐字节一致；
  // 开启后：setup 初始化记忆 git 仓库（模式 A 复用主仓库 dsh-shared/memory
  // 分支 / 模式 B 私有仓库）、sync 拉取合并（fetch 锁外/合并锁内/双父提交）、
  // sync --push 显式推送（**push 永远需用户同意**，需求 #12）。一期范围 =
  // 项目轨（KEY + 项目日志 + KEY-archive），全局轨二期。
  syncEnabled: false,
  // Advisor 评审能力（lib/advisor/）：**独立子模块**（与广播/COI 同一纪律
  // ——独立领域不挂别的模块下）。按会话运行的独立评审模型：观察主会话、
  // 以"用户前台可见文本表面"为输入（不含思考/工具调用）、实时评审、
  // steer 投递建议、右侧悬浮面板实时展示输入/输出、用户可发指令、评审
  // 记录 JSONL 持久化（<advisorDataDir>/records.jsonl）。**默认关闭**（与
  // 其他独立模块一致，需要时再开）；provider/model 缺省为空=继承会话
  // 模型（agent.options），只配其中一个=门禁禁用（config-incomplete）。
  advisorEnabled: false,
  advisorDataDir: null,           // null → <memoryDir>/.system/advisor
  advisorProvider: null,          // 评审供应商路由（双空=继承会话模型）
  advisorModel: null,             // 评审模型 id（双空=继承会话模型）
  advisorSystemPrompt: '',        // 覆盖内置评审提示词（≤8KB；空=内置默认）
  advisorPanelEnabled: true,      // 悬浮面板显示开关（与评审运行解耦）
  advisorImmuneTurns: 0,          // 冷却回合数（0=不限制，用户拍板；fence 路径保留）
  advisorSteerSeverities: ['nit', 'concern', 'blocker'], // 全量 steer（用户拍板），保留可收紧
  // Q1（2026-08-12 用户拍板）：info 级建议默认仅记录不注入（面板可见、
  // 会话流不受打扰）；开启后 info 走 inject（永不 steer）
  advisorInfoInject: false,
  advisorMaxMessages: 60,         // 评审输入有界窗口（0=无上限）
  advisorMaxQueued: 32,           // 评审队列上限（满=drop-newest）
  advisorCallTimeoutMs: 60000,    // 单次评审调用超时（正整数）
  // 无限画板（de_canvas + 画板 Tab）：**独立子模块**（用户拍板纪律——
  // 独立领域不挂别的模块下）。本地路径引用 + 单板+视角筛选 + AI 双向
  // 拉取式（不注入快照）+ AI 只加/查/改不碰摆放 + AI 产物默认便签写
  // 会话板中央区 + 写入免确认（仅加会话便签）+ 安全从简（AI 只读已上板
  // 节点）。存储 <memoryDir>/canvas/boards.json（整板原子写 + rev 乐观锁
  // 防多会话并发覆盖）。默认关（与其他独立模块一致）。
  canvasEnabled: false,
}

/** Keys the Web UI may change at runtime (persisted to stateFile). */
export const RUNTIME_KEYS = [
  'reviewEnabled', 'reviewInterval', 'reviewMode', 'skillReviewEnabled',
  'perTurnProjectWrites', 'perTurnDailyWrites', 'perTurnKeyWrites',
  'perTurnWriteGuard', 'writeGuardThreshold',
  'keyProgressiveDisclosure', 'keyFullInjectThreshold', 'keyFullInjectCharLimit',
  'searchDocsEnabled', 'coiEnabled', 'broadcastEnabled', 'promptsEnabled',
  'sessionSearchEnabled', 'sessionEnabled', 'modelsEnabled', 'uiSettingsEnabled',
  'bookmarkEnabled', 'searchDocsMode', 'todoEnabled',
  // 分组化相关运行时开关（2026-10-13）：待办注入/检查、待确认红点、
  // 进 Tab 直接跳待确认、全局自动通过
  'todoInject', 'todoCheck', 'pendingBadge', 'jumpToPending', 'allAutoApprove',
  // 开局提示词（可编辑的固定指导文案；空串 = 用内置文案）
  'snapshotPrompt',
  'memoryLibraryEnabled',
  // 注入方式与内置文案开关（2026-10-14）
  'injectMode', 'builtinGuidance', 'showDisabled',
  // 三类条目数显示（2026-10-15 UI-16）
  'countShowSession', 'countShowProject', 'countShowGlobal',
  'countIncludeDisabled', 'countIncludeArchived',
  // 条目展开形态（2026-10-15 F-8）
  'entryExpandMode', 'entryPreviewLines', 'entryRememberHeight',
  // 条目元数据行开关（2026-10-16 F-7）
  'entryMetaMemory', 'entryMetaTodo',
  // 工具定义分块启用（2026-10-16）
  'toolBlocks',
  // 工具定义联动（2026-10-19）：改名/停用是否作用于注册（默认关）。
  // **必须在这里**，否则写盘了重启不读回，开关会静默回落 false。
  'toolDefsLive',
  // 块文案覆盖（2026-10-17）
  'toolBlockTexts',
  // 分组文本字段的自动保存（2026-10-16，统一开关）
  'groupAutoSave',
  'wsCoordEnabled', 'wsCoordEnforceWrite', 'wsCoordSnapshot',
  'notifyEnabled', 'channelSendEnabled', 'broadcastImageEnabled',
  'sessionImageQueryEnabled', 'syncEnabled',
  'advisorEnabled', 'advisorProvider', 'advisorModel', 'advisorSystemPrompt',
  'advisorPanelEnabled', 'advisorImmuneTurns', 'advisorSteerSeverities',
  'advisorInfoInject',
  'advisorMaxMessages', 'advisorMaxQueued', 'advisorCallTimeoutMs',
  'canvasEnabled',
  // 记忆检索工具（2026-10-15 三类改造）：开关与工具名都可运行时改
  'searchMemoryEnabled', 'searchMemoryToolName',
]

/** Validate one runtime-config patch value against its key. */
export function validateRuntimePatch(key, value) {
  switch (key) {
    case 'reviewEnabled':
    case 'skillReviewEnabled':
    case 'perTurnProjectWrites':
    case 'perTurnDailyWrites':
    case 'perTurnKeyWrites':
    case 'perTurnWriteGuard':
    case 'searchDocsEnabled':
    case 'searchDocsMode':
      if (key === 'searchDocsMode') {
        // null = 未设置（controller 按 searchDocsEnabled 推断生效档）。
        // ⚠️ GET /api/config 回显的就是 null（runtime={...config} 的
        // DEFAULTS 占位），保存必须允许它，否则设置面板一保存就报错。
        if (value !== null && !['all', 'filename', 'content', 'off'].includes(value)) {
          throw new Error('dsh-memory-evolve: searchDocsMode 必须是 all / filename / content / off 之一（或 null 恢复默认推断）')
        }
        return
      }
      if (typeof value !== 'boolean') throw new Error(`dsh-memory-evolve: ${key} 必须是布尔值`)
      return
    case 'coiEnabled':
    case 'broadcastEnabled':
    case 'promptsEnabled':
    case 'sessionSearchEnabled':
    case 'sessionEnabled':
    case 'modelsEnabled':
    case 'uiSettingsEnabled':
    case 'bookmarkEnabled':
    case 'todoEnabled':
    // 分组化开关（2026-10-13）：待办注入/收尾检查、待确认红点、进 Tab 跳
    // 待确认、全局自动通过——都是纯布尔
    case 'todoInject':
    case 'todoCheck':
    case 'pendingBadge':
    case 'jumpToPending':
    case 'allAutoApprove':
    case 'wsCoordEnabled':
    case 'wsCoordEnforceWrite':
    case 'wsCoordSnapshot':
    case 'notifyEnabled':
    case 'channelSendEnabled':
    case 'broadcastImageEnabled':
    case 'sessionImageQueryEnabled':
    case 'syncEnabled':
    case 'canvasEnabled':
    // 三类条目数显示（2026-10-15 UI-16）
    case 'countShowSession':
    case 'countShowProject':
    case 'countShowGlobal':
    case 'countIncludeDisabled':
    case 'countIncludeArchived':
    case 'entryRememberHeight':
    case 'groupAutoSave':
    case 'entryMetaMemory':
    case 'entryMetaTodo':
      if (typeof value !== 'boolean') throw new Error(`dsh-memory-evolve: ${key} 必须是布尔值`)
      return
    case 'toolBlocks':
      // 工具定义分块启用表（2026-10-16）：对象，值必须是布尔；未知块键在归一里丢弃。
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('dsh-memory-evolve: toolBlocks 必须是对象')
      }
      for (const [blockKey, enabled] of Object.entries(value)) {
        if (typeof enabled !== 'boolean') throw new Error(`dsh-memory-evolve: toolBlocks["${blockKey}"] 必须是布尔值`)
      }
      return
    case 'toolBlockTexts':
      // 块文案覆盖（2026-10-17）：对象，值必须是字符串；未知块键在归一里丢弃。
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('dsh-memory-evolve: toolBlockTexts 必须是对象')
      }
      for (const [blockKey, text] of Object.entries(value)) {
        if (typeof text !== 'string') throw new Error(`dsh-memory-evolve: toolBlockTexts["${blockKey}"] 必须是字符串`)
      }
      return
    case 'entryExpandMode':
      // 条目默认展开形态（F-8）
      if (value !== 'collapsed' && value !== 'preview' && value !== 'full') {
        throw new Error('dsh-memory-evolve: entryExpandMode 必须是 "collapsed" / "preview" / "full"')
      }
      return
    case 'entryPreviewLines':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 50) {
        throw new Error('dsh-memory-evolve: entryPreviewLines 必须是 1..50 的整数')
      }
      return
    case 'memoryLibraryEnabled':
      // 记忆库管理工具开关（2026-10-15 B3/F-5）
      if (typeof value !== 'boolean') throw new Error('dsh-memory-evolve: memoryLibraryEnabled 必须是布尔值')
      return
    case 'snapshotPrompt':
      // 开局提示词（2026-10-14）：任意字符串，**空串合法**（= 恢复内置文案）；
      // 限长 20000 字符，防误贴大文件把 state 文件撑爆。
      if (typeof value !== 'string') throw new Error('dsh-memory-evolve: snapshotPrompt 必须是字符串')
      if (value.length > 20000) throw new Error('dsh-memory-evolve: snapshotPrompt 过长（≤20000 字符）')
      return
    case 'toolDefsLive':
      // 工具定义联动开关（2026-10-19）：开启后改名/停用才真正改工具面。
      if (typeof value !== 'boolean') throw new Error('dsh-memory-evolve: toolDefsLive 必须是布尔值')
      return
    case 'injectMode':
      // 注入方式（2026-10-14）：context = 运行时上下文快照；section = 系统提示词段
      if (value !== 'context' && value !== 'section') {
        throw new Error('dsh-memory-evolve: injectMode 必须是 "context" 或 "section"')
      }
      return
    case 'builtinGuidance':
      // 内置文案开关（2026-10-14）
      if (typeof value !== 'boolean') throw new Error('dsh-memory-evolve: builtinGuidance 必须是布尔值')
      return
    case 'showDisabled':
      // 停用分组的显示二态（2026-10-15 起）：hidden=不显示（默认）/ shown=显示（灰字）。
      // 历史值 dim（灰显）已废弃——它与 shown 视觉上分不出来（用户实测"灰显根本看不出来"）；
      // 旧配置文件里的 dim 由读取侧归一为 shown，这里不再接受新写入。
      if (value !== 'hidden' && value !== 'shown') {
        throw new Error('dsh-memory-evolve: showDisabled 必须是 "hidden" 或 "shown"')
      }
      return
    case 'reviewInterval':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
        throw new Error('dsh-memory-evolve: reviewInterval 必须 >= 1')
      }
      return
    case 'writeGuardThreshold':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error('dsh-memory-evolve: writeGuardThreshold 必须是 >= 1 的整数')
      }
      return
    case 'reviewMode':
      if (value !== 'suggest' && value !== 'auto') throw new Error('dsh-memory-evolve: reviewMode 必须是 "suggest" 或 "auto"')
      return
    case 'advisorEnabled':
    case 'advisorPanelEnabled':
    case 'advisorInfoInject':
      if (typeof value !== 'boolean') throw new Error(`dsh-memory-evolve: ${key} 必须是布尔值`)
      return
    case 'advisorProvider':
    case 'advisorModel':
      if (value !== null && (typeof value !== 'string' || value.trim() === '')) {
        throw new Error(`dsh-memory-evolve: ${key} 必须是 null（继承会话模型）或非空字符串`)
      }
      return
    case 'advisorSystemPrompt':
      if (typeof value !== 'string') throw new Error('dsh-memory-evolve: advisorSystemPrompt 必须是字符串')
      if (value.length > 8192) throw new Error('dsh-memory-evolve: advisorSystemPrompt 超长（上限 8192 字符）')
      return
    case 'advisorImmuneTurns':
    case 'advisorMaxMessages':
    case 'advisorMaxQueued':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`dsh-memory-evolve: ${key} 必须是非负整数`)
      }
      return
    case 'advisorCallTimeoutMs':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error('dsh-memory-evolve: advisorCallTimeoutMs 必须是正整数')
      }
      return
    case 'advisorSteerSeverities':
      if (!Array.isArray(value) || value.length === 0 || !value.every((s) => s === 'nit' || s === 'concern' || s === 'blocker')) {
        throw new Error('dsh-memory-evolve: advisorSteerSeverities 必须是非空数组且元素为 nit/concern/blocker')
      }
      return
    case 'keyProgressiveDisclosure':
      if (value !== 'auto' && value !== 'off' && value !== 'on') {
        throw new Error('dsh-memory-evolve: keyProgressiveDisclosure 必须是 "auto" / "off" / "on"')
      }
      return
    case 'keyFullInjectThreshold':
    case 'keyFullInjectCharLimit':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error(`dsh-memory-evolve: ${key} 必须是正整数`)
      }
      return
    default:
      throw new Error(`dsh-memory-evolve: 不可运行的配置项 "${key}"`)
  }
}

/** Load persisted runtime overrides (stateFile); a missing file is empty. */
function loadState(stateFile) {
  try {
    const text = readFileSync(stateFile, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

/** Atomically persist runtime overrides. */
function saveState(stateFile, state) {
  writeFileSync(`${stateFile}.tmp.${process.pid}`, JSON.stringify(state, null, 2) + '\n')
  renameSync(`${stateFile}.tmp.${process.pid}`, stateFile)
}

const POSITIVE_NUMBER_KEYS = [
  'snapshotOrder', 'reviewInterval', 'writeGuardThreshold', 'skillMaxBytes',
  'searchDocsCacheTtlMs', 'searchDocsTimeoutMs',
  'coiRetentionDays', 'coiTaskTimeoutMs', 'coiMaxLogBytes',
  'advisorCallTimeoutMs',
]
const BOOLEAN_KEYS = [
  'injectMemory', 'injectionScan', 'reviewEnabled', 'skillReviewEnabled',
  'entryDatePrefix', 'memoryTabEnabled', 'keyBranchFilter',
  'perTurnProjectWrites', 'perTurnDailyWrites', 'perTurnKeyWrites',
  'perTurnWriteGuard',
  'searchDocsEnabled', 'coiEnabled', 'coiSummaryEnabled', 'coiSyncSkills',
  'promptsEnabled', 'sessionSearchEnabled', 'sessionEnabled', 'todoEnabled',
  'todoInject', 'todoCheck', 'pendingBadge', 'jumpToPending', 'allAutoApprove',
  'builtinGuidance',
  'notifyEnabled', 'channelSendEnabled', 'broadcastImageEnabled',
  'sessionImageQueryEnabled', 'syncEnabled',
  'advisorEnabled', 'advisorPanelEnabled',
  'canvasEnabled',
  'searchMemoryEnabled',
]
const STRING_KEYS = [
  'toolName', 'suggestToolName', 'commandName', 'reviewMode',
  'skillManageToolName', 'searchDocsToolName', 'searchDocsCommandName',
  'promptToolName', 'searchMemoryToolName',
]

/**
 * Validate raw config and fill defaults. Throws loud on invalid values so
 * misconfiguration fails at load.
 * @param {object} [raw] - the raw cordis config.
 * @returns {object} the resolved config.
 */
export function resolveConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-memory-evolve: 配置必须是对象')
  }
  const config = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (!(key in DEFAULTS)) throw new Error(`dsh-memory-evolve: 未知配置项 "${key}"`)
    config[key] = value
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  config.memoryDir = resolve(config.memoryDir ?? join(home, 'memories'))
  config.suggestionsFile = resolve(config.suggestionsFile ?? suggestionsFileOf(config.memoryDir))
  config.skillDir = resolve(config.skillDir ?? join(homedir(), '.agents', 'skills'))
  for (const key of POSITIVE_NUMBER_KEYS) {
    const value = config[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`dsh-memory-evolve: ${key} 必须是正数`)
    }
  }
  // writeGuardThreshold 额外要求整数（与运行时 validateRuntimePatch 口径
  // 一致，评审 P2-1：静态配置 1.5 之类的小数必须拒绝——轮次计数不存在小数）。
  if (!Number.isInteger(config.writeGuardThreshold)) {
    throw new Error('dsh-memory-evolve: writeGuardThreshold 必须是 >= 1 的整数')
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof config[key] !== 'boolean') {
      throw new Error(`dsh-memory-evolve: ${key} 必须是布尔值`)
    }
  }
  for (const key of STRING_KEYS) {
    if (typeof config[key] !== 'string' || config[key].length === 0) {
      throw new Error(`dsh-memory-evolve: ${key} 必须是非空字符串`)
    }
  }
  if (config.reviewMode !== 'suggest' && config.reviewMode !== 'auto') {
    throw new Error('dsh-memory-evolve: reviewMode 必须是 "suggest" 或 "auto"')
  }
  // MAJOR-4（复审）：Advisor 静态配置校验（与 validateRuntimePatch 同规则，
  // 防非法静态值/损坏 state 绕过运行时校验）
  if (!Number.isInteger(config.advisorMaxMessages) || config.advisorMaxMessages < 0) {
    throw new Error('dsh-memory-evolve: advisorMaxMessages 必须是非负整数（0=无上限）')
  }
  if (!Number.isInteger(config.advisorMaxQueued) || config.advisorMaxQueued < 1) {
    throw new Error('dsh-memory-evolve: advisorMaxQueued 必须是正整数')
  }
  if (!Number.isInteger(config.advisorImmuneTurns) || config.advisorImmuneTurns < 0) {
    throw new Error('dsh-memory-evolve: advisorImmuneTurns 必须是非负整数')
  }
  if (typeof config.advisorSystemPrompt !== 'string' || config.advisorSystemPrompt.length > 8192) {
    throw new Error('dsh-memory-evolve: advisorSystemPrompt 必须是字符串（≤8192 字符）')
  }
  // Q1（第一轮优化）：info 注入布尔
  if (typeof config.advisorInfoInject !== 'boolean') {
    throw new Error('dsh-memory-evolve: advisorInfoInject 必须是布尔值')
  }
  if (!Array.isArray(config.advisorSteerSeverities) || config.advisorSteerSeverities.length === 0
    || !config.advisorSteerSeverities.every((s) => s === 'nit' || s === 'concern' || s === 'blocker')) {
    throw new Error('dsh-memory-evolve: advisorSteerSeverities 必须是非空数组且元素为 nit/concern/blocker')
  }
  for (const key of ['advisorProvider', 'advisorModel']) {
    if (config[key] !== null && (typeof config[key] !== 'string' || config[key].trim() === '')) {
      throw new Error(`dsh-memory-evolve: ${key} 必须是 null 或非空字符串`)
    }
  }
  if (config.reviewInterval < 1) {
    throw new Error('dsh-memory-evolve: reviewInterval 必须 >= 1')
  }
  if (!Array.isArray(config.searchDocsExts) || config.searchDocsExts.length === 0
    || config.searchDocsExts.some((ext) => typeof ext !== 'string' || !/^[a-z0-9]{1,10}$/.test(ext.toLowerCase().replace(/^\./, '')))) {
    throw new Error('dsh-memory-evolve: searchDocsExts 必须是非空扩展名数组（如 ["md","docx"]）')
  }
  config.searchDocsExts = config.searchDocsExts.map((ext) => ext.toLowerCase().replace(/^\./, ''))
  config.coiDataDir = resolve(config.coiDataDir ?? join(config.memoryDir, 'coi'))
  config.advisorDataDir = resolve(config.advisorDataDir ?? advisorDirOf(config.memoryDir))
  config.sessionDataDir = resolve(config.sessionDataDir ?? join(config.memoryDir, 'session-orch'))
  if (config.coiNotifyCommand !== null && (typeof config.coiNotifyCommand !== 'string' || config.coiNotifyCommand.trim() === '')) {
    throw new Error('dsh-memory-evolve: coiNotifyCommand 必须是字符串或 null')
  }
  if (config.searchDocsProviders !== 'auto'
    && (!Array.isArray(config.searchDocsProviders) || config.searchDocsProviders.length === 0
      || config.searchDocsProviders.some((name) => typeof name !== 'string' || name.length === 0))) {
    throw new Error('dsh-memory-evolve: searchDocsProviders 必须是 "auto" 或非空 provider 名数组')
  }
  return config
}

/**
 * 旧布局（v2 及更早）在记忆根下留下的顶层条目名（只用于探测，不用于取路径）：
 * 目录容器 + v1 的单文件轨 + v1 的 daily/groups 目录。
 */
const LEGACY_LAYOUT_ENTRIES = [
  'global', 'sessions', 'projects', 'archive', 'daily', 'groups',
  'MEMORY.md', 'USER.md', 'KB.md', 'MEMORY-archive.md', 'USER-archive.md',
  'TODOS-life.md', 'TODOS-work.md',
]

/** v3 待办分组目录下允许的类段（其它形状的 md 一律是旧布局残留）。 */
const TODO_CLASS_SEGMENTS = new Set(['global', 'project', 'session', 'archive'])

/**
 * 旧待办残留探测（v3 的待办 md 只在 `<id>/<类段>/` 下）：
 * `todo/<文件名>.md`（v1 的 `TODOS-<id>.md`）或 `todo/<id>/<日期>.md`。
 * @param {string} memoryDir - 记忆根。
 * @returns {string[]} 命中的相对路径（如 `todo/TODOS-life.md`）。
 */
function legacyTodoEntries(memoryDir) {
  const root = todoRootOf(memoryDir)
  let items = []
  try {
    items = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const item of items) {
    if (item.isFile() && item.name.endsWith('.md')) {
      found.push(`todo/${item.name}`)
      continue
    }
    if (!item.isDirectory() || TODO_CLASS_SEGMENTS.has(item.name)) continue
    let inner = []
    try {
      inner = readdirSync(join(root, item.name), { withFileTypes: true })
    } catch {
      inner = []
    }
    if (inner.some((child) => child.isFile() && child.name.endsWith('.md'))) found.push(`todo/${item.name}/`)
  }
  return found
}

/**
 * 探测旧布局残留（v2 的 `global/ sessions/ projects/ archive/` 容器、v1 的
 * 单文件轨与 `daily/ groups/` 目录、以及旧形状的待办文件）。
 * @param {string} memoryDir - 记忆根。
 * @returns {string[]} 命中的条目名。
 */
function detectLegacyLayout(memoryDir) {
  const hits = LEGACY_LAYOUT_ENTRIES.filter((name) => existsSync(join(memoryDir, name)))
  return [...hits, ...legacyTodoEntries(memoryDir)]
}

/** 布局未到 v3 时的写入拒绝文案。 */
export const LAYOUT_WRITE_BLOCKED_MESSAGE = '记忆目录仍是旧布局（未迁移到 v3），写入已暂停：请先运行迁移 scripts/migrate-v3.mjs，完成后重启插件'

/**
 * 布局状态（v3 门禁）：只读，绝不迁移。
 *
 * - `state: 'v3'` —— `.layout-version` 已是 3；
 * - `state: 'needs-migration'` —— 版本未到 3，且探测到旧结构或已有半迁移状态文件
 *   （写操作一律拒绝，读操作照常）；
 * - `state: 'unknown'` —— 全新目录（无标记、无旧结构）：按 v3 用，不拦写入。
 * @param {string} memoryDir - 记忆根。
 * @returns {{memoryDir: string, version: number|null, expected: number, state: string,
 *   migrating: boolean, needsMigration: boolean, writesBlocked: boolean, legacyEntries: string[]}}
 */
export function layoutStatusOf(memoryDir) {
  let version = null
  try {
    const parsed = Number(readFileSync(layoutVersionFileOf(memoryDir), 'utf8').trim())
    if (Number.isFinite(parsed)) version = parsed
  } catch { /* 文件缺失/不可读 = 未迁移 */ }
  const base = { memoryDir, version, expected: LAYOUT_VERSION, migrating: false, legacyEntries: [] }
  if (version === LAYOUT_VERSION) {
    return { ...base, state: 'v3', needsMigration: false, writesBlocked: false }
  }
  const legacyEntries = detectLegacyLayout(memoryDir)
  const migrating = readMigrationState(memoryDir) !== null
  const needsMigration = migrating || legacyEntries.length > 0
  return {
    ...base,
    state: needsMigration ? 'needs-migration' : 'unknown',
    migrating,
    needsMigration,
    writesBlocked: needsMigration,
    legacyEntries,
  }
}

/**
 * 渲染快照里的「固定指导段」（2026-10-14 抽出）。
 *
 * 为什么单独抽出来：设置面板要把这段提示词**原样显示给用户编辑**，它必须
 * 能脱离 renderSnapshot 的上下文单独渲染。两段都只依赖配置与少量上下文
 * （分支名、是否子代理、评审是否到期、写入看门狗是否告警），**不含任何记忆
 * 条目内容**：
 *   ① fixedText —— 工具与读法说明（section + readHint + 分支提示 + 待办提示）
 *   ② dutiesText —— 收尾职责清单（写入口令 + 评审 + 到期/欠账提醒）
 * 用户在设置面板写了 `config.snapshotPrompt` 时，用它整段替换这两段。
 * @param {object} config - resolved/runtime config.
 * @param {{branch?: string, isSubagent?: boolean, due?: boolean, writeGapDue?: boolean}} [ctx]
 * @returns {{fixedText: string, dutiesText: string, writeTargets: string[], keyDuty: boolean, reviewOn: boolean}}
 */
export function buildGuidance(config, ctx = {}) {
  const isSubagent = ctx.isSubagent === true
  const branch = ctx.branch
  const due = ctx.due === true
  const writeGapDue = ctx.writeGapDue === true
  const reviewOn = !isSubagent && config.reviewEnabled
  const keyDuty = config.perTurnKeyWrites !== false
  const writeTargets = [
    config.perTurnDailyWrites !== false ? 'target=daily' : null,
    config.perTurnProjectWrites !== false ? 'target=project' : null,
  ].filter(Boolean)

  // ① 工具与读法说明段
  const todoEnabled = config.todoEnabled !== false
  const todoCheck = config.todoCheck !== false
  const branchHint = branch !== undefined ? st('snap.branchHint', { branch }) : ''
  const todoHint = todoEnabled && todoCheck && !isSubagent ? `\n${st('snap.todoHint')}` : ''
  const fixedText = `${todoEnabled ? st('snap.section') : st('snap.sectionNoTodo')}
${st('snap.readHint')}${branchHint}${todoHint}`

  // ② 收尾职责段
  let dutiesText = ''
  if (writeTargets.length > 0 || keyDuty || reviewOn) {
    const steps = []
    if (writeTargets.length > 0 || keyDuty) {
      if (isSubagent) {
        const base = st('snap.subagentWrite', { targets: writeTargets.join(st('snap.and')) })
        steps.push(keyDuty
          ? `${base}${st('snap.subagentKeyTail')}`
          : `${base}${st('snap.subagentSkipTail')}`)
      } else {
        const duties = []
        if (writeTargets.length > 0) {
          duties.push(st('snap.batchWriteDuty', { targets: writeTargets.join(st('snap.and')) }))
        }
        if (keyDuty) duties.push(st('snap.keyDuty'))
        if (writeTargets.length > 0) {
          duties.push(st('snap.feedbackDuty'))
        }
        steps.push(st('snap.writeStep', { duties: duties.join('；') }))
      }
    }
    if (reviewOn) {
      const n = steps.length + 1
      steps.push(st('snap.reviewStep', { n }))
    }
    const tail = st('snap.noTimestampTail')
    const dueWarning = due
      ? st('snap.dueWarning', { interval: config.reviewInterval, mode: config.reviewMode })
      : ''
    const writeGuardThreshold = config.writeGuardThreshold ?? 2
    const writeWarning = writeGapDue
      ? st('snap.writeGuardWarning', { threshold: writeGuardThreshold, tracks: writeTargets.join(st('snap.and')) })
      : ''
    const head = isSubagent
      ? st('snap.subagentTurnEndHead')
      : st('snap.turnEndHead')
    dutiesText = `${head}
${steps.map((step) => `  ${step}`).join('\n')}
${tail}${dueWarning}${writeWarning}`
  }
  return { fixedText, dutiesText, writeTargets, keyDuty, reviewOn }
}

/**
 * 把用户在设置面板写的「开局提示词」里的占位符换成实际值。
 * 只认这一组变量（未命中的 `{xxx}` 原样保留，避免误伤正文里的花括号）；
 * 双花括号 `{{...}}` 由 sanitizeSnapshotBody 兜底处理（宿主会当模板变量）。
 * 支持：{branch} {memoryTool} {todoTool} {targets} {reviewInterval} {sessionId}
 * @param {string} text - 用户文本。
 * @param {object} vars - 变量表。
 * @returns {string} 替换后的文本。
 */
export function renderPromptTemplate(text, vars) {
  return String(text ?? '').replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null
      ? String(vars[name])
      : match
  ))
}

/**
 * Build the `memory` tool definition module-level helper scope marker.
 * @param {object} config - resolved config.
 * @param {object} store - the memory store.
 * @param {object} agent - the calling agent.
 * @returns {object} the placeholder vars exposed to a custom snapshot prompt.
 */
export function snapshotPromptVars(config, agent, ctx = {}) {
  return {
    branch: ctx.branch ?? '',
    // 工具名可被 tools.json 覆盖（toolDefsLive 开启时），调用方传生效名进来。
    memoryTool: ctx.memoryTool ?? config.toolName,
    todoTool: ctx.todoTool ?? config.todoToolName,
    targets: (ctx.writeTargets ?? []).join(' '),
    reviewInterval: config.reviewInterval,
    sessionId: agent?.session?.id ?? '',
  }
}

/**
 * Render the memory snapshot injected into the model context. Live reads are
 * intentional: DSH's runtime-context materialization only appends when the
 * rendered text changes, so mid-session memory writes surface at the next
 * step as a tail message while the stable prefix stays cached. The slow-
 * moving tracks are rendered here — global memory/user AND the per-project
 * KEY track (projects/<hash>/KEY.md, scoped to this agent's cwd): KEY facts
 * change rarely (only when something important happens, never per-turn), so
 * injecting them with live reads gives real-time change monitoring at a
 * cache-friendly cost, exactly like the global tracks. The project log and
 * the daily log change on every write, and injecting them would append a
 * new tail snapshot per turn and defeat prefix caching — they stay on-demand
 * via the memory tool, with a fixed per-turn write duty in the hint below.
 * @param {object} config - resolved config.
 * @param {MemoryStore} store - the memory store.
 * @param {object|null} [sessionTitleService] - DSH sessionTitle 服务（可选，
 *   会话名称显示用；不可用/未传时名称不显示——兼容降级）。
 * @returns {string} the snapshot text (empty when nothing is stored).
 */
export function renderSnapshot(config, store, agent, counter, sessionTitleService = null, writeGap = null, todoStore = null, opts = {}) {
  const parts = []
  // ── 注入通道分流（2026-10-15 用户需求）────────────────────────────────
  // 每个记忆 / 待办分组可以自选「运行时上下文快照」还是「系统提示词段」；
  // **全局 injectMode='section' 覆盖一切**（用户原话："选择开启全局全部使用
  // 系统提示词注入会覆盖此配置"）。
  //
  // 实现方式：同一个渲染函数注册两次（两个通道各一次），靠 `opts.channel`
  // 只输出属于该通道的段；公共段（会话 ID / 指南 / 收尾职责）跟随全局通道。
  const globalSection = config.injectMode === 'section'
  const channelOf = (group) => {
    if (globalSection) return 'section'
    return group?.injectMode === 'section' ? 'section' : 'context'
  }
  const want = typeof opts.channel === 'string' ? opts.channel : null
  const keepGroup = (group) => want === null || channelOf(group) === want
  const keepCommon = () => want === null || (globalSection ? 'section' : 'context') === want
  // 会话 ID 段（快照最前面的独立输出端，常驻注入，不随任何模块开关）：
  // AI 始终知道"我是谁"——广播消息判断 sender/recipients 谁是谁、回复时
  // 把此 ID 告知对方，以及未来其他模块的消费者都要用它。固定文本（会话
  // 生命周期内不变，缓存友好）；无会话视角（subagent 等）不注入。
  // 会话名称/别名（2026-08-12 用户要求）：同款"有就显示、没有就不显示"
  // 的兼容逻辑——名称来自 DSH sessionTitle 服务（自动生成/用户 rename，
  // 更新粒度为"用户消息后"，不是每步渲染——符合快照段状态驱动稳定铁律；
  // live 会话可读，服务不可用/无标题时置 null 不显示）；别名来自本插件
  // aliases.json（用户手动设置，≤10 字）。两者都无时输出与旧版完全一致
  // （只有 ID），零变化兼容。
  if (keepCommon() && agent?.session?.id) {
    const aliases = readAliases(config.memoryDir ?? '')
    const alias = aliases[agent.session.id]
    let title = null
    try {
      title = sessionTitleService?.get?.(agent.session)?.title ?? null
    } catch { /* 标题读取失败置 null（兼容降级） */ }
    if (alias || title) {
      const bits = []
      if (title) bits.push(st('snap.yourName', { title }))
      if (alias) bits.push(st('snap.yourAlias', { alias }))
      bits.push(st('snap.yourId', { id: agent.session.id }))
      parts.push(`${st('snap.sessionNamed')}\n${bits.join('\n')}`)
    } else {
      parts.push(`${st('snap.sessionPlain')}\n${st('snap.yourId', { id: agent.session.id })}`)
    }
  }
  // ⚠️ 2026-08-13 设计反转：不再注入「评审员机制说明」快照段——注入消息
  // 伪装成用户指令（Agent 不知道评审员存在），快照段介绍 Advisor 会暴露
  // 身份、让 Agent 质疑注入来源（实测执行力下降）。
  // ── 分组化注入（2026-10-13 用户需求）────────────────────────────────
  // 每个记忆分组自己决定两件事：**是否注入**（group.inject）与**注入哪段
  // 抬头提示词**（group.prompt，用户可在设置面板编辑）。规则：
  //   - group.enabled=false 或 inject=false → 该分组完全不进上下文（kb
  //     出厂即如此，只有模型主动用 memory 工具查时才可见）；
  //   - group.prompt 非空 → 用用户编辑的文本当抬头；
  //   - 否则内置分组沿用原有 i18n 抬头（文案逐字节不变，行为零漂移），
  //     自建分组用通用抬头「## {名称}」。
  // 自建分组的文件名由作用域决定（全局 / 项目级），store.entriesOf 已按
  // 分组解析（见 lib/store.js 的 locate 默认分支）。
  // 容错：renderSnapshot 也被单元测试/嵌入方以不完整的 config 调用（缺
  // memoryDir），此时按"没有分组配置"处理（出厂默认），绝不因配置不全抛错。
  const groupData = loadGroups(typeof config.memoryDir === 'string' ? config.memoryDir : '')
  const memGroups = listEnabledGroups(groupData, 'memory')
  const groupOf = (id) => memGroups.find((g) => g.id === id) ?? null
  const groupHead = (group, fallbackKey) => {
    if (typeof group?.prompt === 'string' && group.prompt.trim() !== '') return group.prompt.trim()
    if (fallbackKey !== undefined) return st(fallbackKey)
    return st('snap.groupHead', { label: groupLabel(group) })
  }
  const memoryGroup = groupOf('memory')
  const memoryEntries = isInjected(memoryGroup) ? store.entriesOf('memory') : []
  if (keepGroup(memoryGroup) && memoryEntries.length > 0) {
    // 展示剥离身份证（Codex 二轮 P1-4）：全局轨启用后补发的 [id:xxxx]
    // 不得进入模型上下文（与 KEY 段同规则）
    parts.push(`${groupHead(memoryGroup, 'snap.memoryHead')}\n${memoryEntries.map((entry) => `- ${stripEntrySummary(stripEntryId(entry))}`).join('\n')}`)
  }
  const userGroup = groupOf('user')
  const userEntries = isInjected(userGroup) ? store.entriesOf('user') : []
  if (keepGroup(userGroup) && userEntries.length > 0) {
    parts.push(`${groupHead(userGroup, 'snap.userHead')}\n${userEntries.map((entry) => `- ${stripEntrySummary(stripEntryId(entry))}`).join('\n')}`)
  }
  // 其余「注入中」的分组：kb / project / daily / 自建分组统一渲染（key 在
  // 下面单独走分支过滤 + 渐进披露的特殊通道）。
  for (const group of memGroups) {
    if (!isInjected(group)) continue
    if (!keepGroup(group)) continue
    if (group.id === 'memory' || group.id === 'user' || group.id === 'key') continue
    let entries = []
    try {
      entries = store.entriesOf(group.id, agent)
    } catch {
      continue // 项目级分组缺 cwd / 文件不可读 → 跳过该组，不影响其余注入
    }
    if (entries.length === 0) continue
    parts.push(`${groupHead(group)}\n${entries.map((entry) => `- ${stripEntrySummary(stripEntryId(entry))}`).join('\n')}`)
  }
  // Project KEY facts are injected for the agent's own project only (its
  // session cwd). Same live-read/change-detected mechanism as the global
  // tracks: a KEY write (tool or web tab) surfaces in the next step's tail.
  // When the project is a git worktree and keyBranchFilter is on, the
  // current branch is resolved live and ONLY entries whose scope covers it
  // are injected (untagged entries = "全部" always qualify). Outside git,
  // or when the branch cannot be resolved, every entry is injected — the
  // conservative choice that never hides memory. The branch name itself is
  // injected alongside, so the model knows which branch it is on.
  const keyAgent = agent?.session?.header?.cwd ? agent : undefined
  const keyGroup = groupOf('key')
  const branch = keyAgent && config.keyBranchFilter !== false ? gitBranch(keyAgent.session.header.cwd) : undefined
  let keyEntries = isInjected(keyGroup) && keyAgent ? store.entriesOf('key', keyAgent) : []
  if (branch !== undefined) {
    keyEntries = keyEntries.filter((entry) => {
      const scope = parseEntryBranches(entry)
      return scope === null || scope.includes(branch)
    })
  }
  if (keepGroup(keyGroup) && keyEntries.length > 0) {
    // 分组提示词（可编辑，2026-10-13）：用户在设置面板给 key 分组写了注入
    // 提示词时，用它整段替换内置抬头（分支信息由用户自己在 prompt 里表达）。
    const keyPrompt = typeof keyGroup?.prompt === 'string' && keyGroup.prompt.trim() !== '' ? keyGroup.prompt.trim() : null
    // 渐进式披露：根据配置决定全量注入还是摘要注入
    const totalChars = keyEntries.reduce((sum, e) => sum + e.length, 0)
    const mode = config.keyProgressiveDisclosure ?? 'off'
    const useFullInject = mode === 'off' || 
      (mode === 'auto' && keyEntries.length <= (config.keyFullInjectThreshold ?? 3) && totalChars <= (config.keyFullInjectCharLimit ?? 1500))
    
    if (useFullInject) {
      // 全量注入（现状逻辑）
      const head = keyPrompt ?? (branch !== undefined
        ? st('snap.keyBranchHead', { branch })
        : st('snap.keyHead'))
      // 全量注入展示剥离：身份证 [id:…] + 摘要标记 [summary:…]（2026-08-15：
      // 正文已完整，summary 是仅供摘要模式注入用的元数据，不应再显示）
      parts.push(`${head}\n${keyEntries.map((entry) => `- ${stripEntrySummary(stripEntryId(entry))}`).join('\n')}`)
    } else {
      // 摘要注入（渐进式披露）
      const head = keyPrompt ?? (branch !== undefined
        ? st('snap.keySummaryBranchHead', { branch })
        : st('snap.keySummaryHead'))
      parts.push(`${head}\n${keyEntries.map((entry) => {
        const shortId = extractEntryId(entry) ?? legacyIdFor(entry)
        const summary = parseEntrySummary(entry) || autoSummary(entry)
        return `- [${shortId}] ${summary}`
      }).join('\n')}`)
    }
  }
  // The project log (MEMORY.md under projects/<hash>/) and the daily log are
  // deliberately NOT rendered into the snapshot: they change on every write,
  // and each change would append a new runtime-context tail message,
  // defeating LLM prefix caching. Instead the stable hint below (fixed text
  // for a given config, never varies with content) requires the model to
  // CHECK every turn for record-worthy facts and write them via the memory
  // tool right away — the program stamps timestamps, so daily/project stay
  // current without waiting for a review round. Both tracks are
  // user-toggleable at runtime (perTurnProjectWrites / perTurnDailyWrites):
  // a disabled track drops its write duty and the hint falls back to
  // on-demand reads. KEY writes are importance-gated (perTurnKeyWrites):
  // only durable project facts (long-lived conventions/decisions/architecture
  // pitfalls) qualify — never per-turn progress. Subagent sessions get a
  // restrained variant: record one entry per independent achievement instead
  // of a per-turn duty, so bulk delegation does not flood the tracks.
  const isSubagent = agent?.session?.header?.origin === 'subagent'
  const reviewOn = !isSubagent && config.reviewEnabled
  // Due warning: when the review is due, the snapshot itself tells the model
  // (the sticky counter is the authority). Low-frequency text change — one
  // extra tail snapshot per review cycle is a fair cache price for closing
  // the 'never checks' hole of weak-following models.
  const due = reviewOn && counter !== undefined && counter.turnsOf(agent) >= config.reviewInterval
  const keyDuty = config.perTurnKeyWrites !== false
  const writeTargets = [
    config.perTurnDailyWrites !== false ? 'target=daily' : null,
    config.perTurnProjectWrites !== false ? 'target=project' : null,
  ].filter(Boolean)
  // 固定指导段（2026-10-14 抽出为 buildGuidance）：
  //   - 默认：内置文案照旧渲染（逐字节不变，拆分理由见 buildGuidance 注释）；
  //   - 用户在设置面板写了「开局提示词」（config.snapshotPrompt）→ 整段替换，
  //     支持 {branch}/{memoryTool}/{todoTool}/{targets}/{reviewInterval}/{sessionId}
  //     占位符（未命中的 {xxx} 原样保留）。
  const todoEnabled = config.todoEnabled !== false
  // 内置文案开关（2026-10-14）：关掉后不再注入插件自带的固定指导段；用户
  // 自定义的「开局提示词」不受影响（自定义优先），分组内容与待办注入照旧。
  const builtinGuidanceOn = config.builtinGuidance !== false
  const guidance = buildGuidance(config, { branch, isSubagent, due })
  const customGuidance = typeof config.snapshotPrompt === 'string' && config.snapshotPrompt.trim() !== ''
    ? renderPromptTemplate(
      config.snapshotPrompt.trim(),
      snapshotPromptVars(config, agent, {
        branch,
        writeTargets: guidance.writeTargets,
        // 由调用方传进来（renderSnapshot 是模块级函数，拿不到 apply 的闭包）。
        memoryTool: typeof opts.memoryTool === 'string' && opts.memoryTool !== '' ? opts.memoryTool : config.toolName,
        todoTool: typeof opts.todoTool === 'string' && opts.todoTool !== '' ? opts.todoTool : config.todoToolName,
      }),
    )
    : null
  // 优先级：用户自定义「开局提示词」 > 内置指导段（开关打开时） > 不注入
  const guidanceHead = customGuidance ?? (builtinGuidanceOn ? guidance.fixedText : '')
  if (keepCommon() && guidanceHead !== '') parts.push(guidanceHead)

  // ── 待办注入（2026-10-13 用户需求）──────────────────────────────────
  // 总开关 todoInject（默认关）+ 每个待办分组自己的 inject 开关；注入的是
  // 「需要关注的未完成项」（与 dtodo list 的默认智能视图同源，最多 8 条），
  // 不是全量清单——上下文开销可控。分组名即抬头（多分组混注时用通用抬头）。
  if (config.todoInject === true && todoEnabled && !isSubagent && todoStore !== null) {
    const injectTodoGroups = listEnabledGroups(groupData, 'todo').filter((g) => isInjected(g) && keepGroup(g))
    if (injectTodoGroups.length > 0) {
      let items = []
      try {
        // status='pending' 关掉"默认智能视图"过滤（注入是用户显式要求看到
        // 这些分组的内容），返回该分组的全部未完成项，再由 formatList 同款
        // 的 8 条上限截断——既尊重用户意图又不让上下文被清单淹没。
        const result = todoStore.listTodos(injectTodoGroups.map((g) => g.id), { status: 'pending' }, agent?.session?.header?.cwd, undefined, agent?.session?.id)
        items = Array.isArray(result?.items) ? result.items : []
      } catch {
        items = [] // 分组文件不可读 / 项目级分组缺 cwd → 本轮不注入待办，不影响其余快照
      }
      if (items.length > 0) {
        const head = injectTodoGroups.length === 1
          ? groupHead(injectTodoGroups[0])
          : st('snap.todoInjectHead')
        const lines = items.map((item) => {
          const text = String(item.text ?? '').split('\n')[0].trim()
          const bits = [item.due !== null && item.due !== undefined ? `(${item.due})` : null, text].filter(Boolean)
          return `- ${bits.join(' ')}`
        })
        parts.push(`${head}\n${lines.join('\n')}`)
      }
    }
  }

  // Turn-final duties, as one minimal checklist (write → review when the
  // snapshot says so). No per-turn status check: the program injects a
  // due warning into the snapshot the moment a review is due (sticky until
  // completed), so the model never has to poll — and weak followers cannot
  // skip a review silently. No mechanism explanation: the interval and mode
  // ride on the due warning; `memory_review_status` is only for completing
  // a review (or manual progress checks).
  // 用户自定义了「开局提示词」时，内置的收尾职责段整段让位（否则会在用户
  // 文本之后又追加一份内置职责，用户改不干净）。
  if (keepCommon() && customGuidance === null && builtinGuidanceOn && (writeTargets.length > 0 || keyDuty || reviewOn)) {
    const steps = []
    if (writeTargets.length > 0 || keyDuty) {
      if (isSubagent) {
        const base = st('snap.subagentWrite', { targets: writeTargets.join(st('snap.and')) })
        steps.push(keyDuty
          ? `${base}${st('snap.subagentKeyTail')}`
          : `${base}${st('snap.subagentSkipTail')}`)
      } else {
        const duties = []
        if (writeTargets.length > 0) {
          // 一次调用批量写（entries 数组含各轨一项），省一次工具往返。
          // writeTargets 元素形如 'target=daily'，直接 join(' 与 ') 拼进提示。
          duties.push(st('snap.batchWriteDuty', { targets: writeTargets.join(st('snap.and')) }))
        }
        if (keyDuty) duties.push(st('snap.keyDuty'))
        // 用户情绪反馈记录（2026-08-10）：真人用户本回合输入有明显情绪时，
        // 给 daily/project 条目都带 feedback 参数（程序拼接【反馈】行，格式
        // 固定可检索）；分类按轨区分：daily 通用分层、project 项目内分层。
        if (writeTargets.length > 0) {
          duties.push(st('snap.feedbackDuty'))
        }
        steps.push(st('snap.writeStep', { duties: duties.join('；') }))
      }
    }
    if (reviewOn) {
      const n = steps.length + 1
      steps.push(st('snap.reviewStep', { n }))
    }
    const tail = st('snap.noTimestampTail')
    const dueWarning = due
      ? st('snap.dueWarning', { interval: config.reviewInterval, mode: config.reviewMode })
      : ''
    // 写入看门狗提醒：本会话连续 writeGuardThreshold 个用户回合未写
    // daily/project（writeGapCounter 计数、写入即归零）→ 快照注入置顶
    // 提醒，粘性直到下一次成功写入。文案刻意静态（不嵌实时计数）——
    // 一次欠账最多产生两条尾部快照（出现 + 消失），与 dueWarning 同款
    // 缓存代价；阈值从配置读取（随配置变化，不随回合变化）。
    // ⚠️ P1-4 修复：文案按实际启用的写入轨参数化（writeTargets）——只开着
    // 一轨时不允许命令模型补写已关闭的轨（否则违背 perTurn*Writes 配置）。
    const writeGuardThreshold = config.writeGuardThreshold ?? 2
    const writeGapDue = writeGap !== null
      && !isSubagent
      && writeTargets.length > 0
      && config.perTurnWriteGuard !== false
      && writeGap.gapOf(agent) >= writeGuardThreshold
    const writeWarning = writeGapDue
      ? st('snap.writeGuardWarning', { threshold: writeGuardThreshold, tracks: writeTargets.join(st('snap.and')) })
      : ''
    const head = isSubagent
      ? st('snap.subagentTurnEndHead')
      : st('snap.turnEndHead')
    parts.push(`${head}
${steps.map((step) => `  ${step}`).join('\n')}
${tail}${dueWarning}${writeWarning}`)
  }

  // COI 状态通知（2026-08-13 用户拍板重构）：**不再注入快照列表**——
  // 状态变化改为向发起会话投递独立消息（启动=【COI 任务已发起】，终态=
  // 【COI 任务完成】，由 coi/scheduler.js 在状态跳变时经 agents 服务
  // inject/followup 投递）。快照段移除的原因：①与其他模块注入段混在
  // 一起噪音大；②终态摘要截取无价值（日志长时落在中段）；③与完成唤醒
  // 消息双通道重复提醒同一任务。需要看后台任务用 de_coi_status / GUI 任务页。
  // 会话广播（2026-08-13 用户拍板）：**移出整体快照**——新消息/房间动态
  // 改为独立消息投递（installBroadcast 内 send 后投递 + 首次会话补投未读
  // 汇总），收件箱语义不变（de_broadcast read 处理）。DSH 快照按整体文本
  // diff 注入，广播段高频变化会连带其他段重注入（噪声）。
  // 记忆同步（2026-08-13 用户拍板）：**无 AI 侧入口**——命令组与快照状态
  // 行均已删除。记忆同步完全由用户在 Web GUI（记忆同步 Tab）主动操作，
  // AI 不参与执行，快照不再显示同步状态。
  //
  // 修复（issue #53，2026-09-14）：整段快照在离开插件前必须净化 `{{...}}`。
  // 宿主（@deepseek-ai/dsh-system-prompt）的段渲染器把段正文里的 `{{name}}`
  // 当模板变量解析，**未注册变量直接 throw**（宿主只注册 provider/model/cwd，
  // memory:snapshot 段不注册任何变量）→ 整段渲染失败 = preStep 失败 = 该会话
  // 每一步、每一轮都起不来，且**无法用 memory 工具自救**（工具调用需要回合，
  // 而回合已经起不来），只能手改记忆文件。
  //
  // 记忆正文由模型/用户写入，天然可能包含 `{{xxx}}`（真实案例：记录
  // 「x-opencode-session: {{session}}」这条事实）。此前净化只做在
  // `prompt:injections` 轨（lib/prompts.js 的 renderInjectionSnapshot），
  // 而本函数把会话标题/别名、memory/user 轨、项目 KEY 轨（全量与摘要两种
  // 模式）的**原文**直接拼进同一段——这条注入路径没有任何净化，构成单点：
  // 记忆里出现一个 `{{` 就等价于给所有注入该轨的会话埋雷。
  //
  // 用 expand:false 只降级不展开：记忆里的 `{{date}}` 是字面事实（不是待
  // 展开的模板），展开会篡改内容；降级为 `{date}` 既保留语义又让宿主不再
  // 解析。插件自身静态文案用的是单花括号（`{branch}`/`{title}`），不含
  // `{{` 字面量，故整段净化零语义损失。
  return sanitizeSnapshotBody(parts.join('\n\n'), { expand: false })
}

/**
 * Resolve one reveal target to an openable path. Every target is a fixed
 * path derived from the memory dir, the skill dir, or the dsh home — never
 * an arbitrary path. Directories open as-is; a missing file falls back to
 * its containing directory (e.g. AGENTS.md before DSH created it, or
 * today's daily log before the first write) instead of failing with an
 * unknown target.
 * @param {object} config - resolved plugin config.
 * @param {string} target - the reveal target name.
 * @returns {string | undefined} the path to open, or undefined for an
 *   unknown target.
 */
export function resolveRevealTarget(config, target) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  // v3：分组数据目录一律由 groups.js 的路径函数产出（全局类分组目录 =
  // `<memoryDir>/memory/<组id>/global`，归档 = `.../archive/global`）。
  const data = loadGroups(config.memoryDir)
  const groupDirById = (id) => {
    const group = findGroup(data, 'memory', id)
    return group === null ? config.memoryDir : (groupDirOf(group, { memoryDir: config.memoryDir }) ?? config.memoryDir)
  }
  const groupArchiveById = (id) => {
    const group = findGroup(data, 'memory', id)
    return group === null ? config.memoryDir : (groupArchiveDirOf(group, { memoryDir: config.memoryDir }) ?? config.memoryDir)
  }
  const table = {
    memoryDir: config.memoryDir,
    memoryRoot: memoryRootOf(config.memoryDir),
    todoRoot: todoRootOf(config.memoryDir),
    // v2（2026-10-15）：一条记忆一个 md、按类分目录。这些入口给的是**分组
    // 目录**而不是单个文件——打开目录能看到这一组的全部记忆（文件名叫标题），
    // 比打开一个已经不存在的旧文件名有用；目录不存在时下面统一 ensureDir 兜住。
    memoryFile: groupDirById('memory'),
    userFile: groupDirById('user'),
    kbFile: groupDirById('kb'),
    archiveMemoryFile: groupArchiveById('memory'),
    archiveUserFile: groupArchiveById('user'),
    dailyDir: groupDirById('daily'),
    dailyFile: groupDirById('daily'),
    projectsDir: projectMetaDirOf(config.memoryDir, ''),
    skillDir: config.skillDir,
    agentsFile: join(dshHome, 'AGENTS.md'),
  }
  if (typeof target !== 'string' || !(target in table)) return undefined
  const path = table[target]
  // Directories open as-is; the plugin's own storage directories are
  // created on demand so the reveal buttons work on a fresh install before
  // any memory was ever written.
  //
  // v2（2026-10-15）：记忆入口全是**目录**（分组目录 / 今天的日志目录），
  // 所以它们统一按目录处理；文件型入口只剩 AGENTS.md 与技能目录。
  const dirTargets = [
    'memoryDir', 'memoryRoot', 'todoRoot', 'dailyDir', 'dailyFile', 'projectsDir',
    'memoryFile', 'userFile', 'kbFile', 'archiveMemoryFile', 'archiveUserFile',
  ]
  if (dirTargets.includes(target)) {
    return existsSync(path) ? path : ensureDir(path)
  }
  if (target === 'agentsFile') {
    return existsSync(path) ? path : dshHome
  }
  if (target === 'skillDir') {
    return existsSync(path) ? path : dirname(config.skillDir)
  }
  return existsSync(path) ? path : ensureDir(config.memoryDir)
}

/**
 * Convert a Linux/WSL path to a Windows path for `explorer.exe`, using
 * `wslpath` (bundled with WSL itself). Falls back to the original path when
 * wslpath is missing or fails — e.g. on pure Linux, where the explorer.exe
 * attempt will fail anyway and the command chain moves on.
 * @param {string} path - the Linux path to convert.
 * @returns {string} the Windows path, or the input when not convertible.
 */
export function toWindowsPath(path) {
  const result = spawnSync('wslpath', ['-w', path], { encoding: 'utf8' })
  const converted = result.error ? '' : String(result.stdout ?? '').trim()
  return converted || path
}

/** Create a directory (recursively) and return its path. */
function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}

/** Render the memory tool result as model/UI text. */
function renderMemoryResult(value) {
  const lines = [value.message ?? '']
  if (Array.isArray(value.entries) && value.entries.length > 0) {
    lines.push(mt('render.currentEntries', { count: value.entries.length }))
    value.entries.forEach((entry, index) => lines.push(`${index + 1}. ${entry}`))
  }
  if (Array.isArray(value.matches) && value.matches.length > 0) {
    lines.push(mt('render.matches'))
    value.matches.forEach((entry, index) => lines.push(`${index + 1}. ${entry}`))
  }
  // entries 多轨批量写：逐轨渲染结果，模型一眼看清哪轨成功/失败
  if (Array.isArray(value.multi) && value.multi.length > 0) {
    lines.push(mt('render.batchResults'))
    value.multi.forEach((m) => lines.push(`- ${m.target}: ${m.message}`))
  }
  return lines.join('\n')
}

/**
 * Strip the full entry list and store-internal fields from a write result:
 * add/replace/remove return the whole track (and `removed` 原文) for internal
 * bookkeeping, but the model only needs the outcome (list is the read path
 * that returns entries). `removed` / `entry` 不在 output schema 内
 * （additionalProperties:false 下多字段会被模型 API 拒：曾报
 * `"value.entry" is not a declared property`），必须一并剥除。
 * 注意：`entry`（新条目对象）库内部有消费者（`lib/custom-tools.js` 取 `entry.id`），
 * 所以只在**本工具的返回值**上剥，不动 `store.addEntry` / `store.peek` 的返回。
 * @param {object} result - the store result.
 * @returns {object} the same result without `entries` / `removed` / `entry`.
 */
function outcomeOnly(result) {
  if (result && typeof result === 'object') {
    const { entries, removed, matches, entry, ...rest } = result
    // matches（replace/remove 匹配不唯一的展示）也剥身份证（审查 P1-5）
    if (Array.isArray(matches)) rest.matches = matches.map((entry) => stripEntrySummary(stripEntryId(entry)))
    return rest
  }
  return result
}

/**
 * Build the `memory` tool definition.
 * @param {object} ctx - the plugin context (for optional approval).
 * @param {object} config - resolved config.
 * @param {MemoryStore} store - the memory store.
 * @param {import('./store.js').SuggestionQueue} queue - the suggestion queue
 *   (key-track writes go through it for user confirmation).
 * @param {() => object} getRuntime - runtime config getter.
 * @param {ArchiveStore} archive - the archive store (archive action 用：
 *   主轨条目移动到对应归档文件）。
 * @param {{gapOf?: (agent?: object) => number, noteWrite?: (agent?: object) => void}|null} [writeGap]
 *   写入看门狗计数器（可选，兼容降级）：daily/project 写入成功后调
 *   noteWrite 重置该会话的连续未写计数（见 review.js writeGapCounter）。
 * @returns {object} a ToolDefinition-shaped object.
 */
/**
 * 工具定义里的「写入目标」段（2026-10-16 用户：定义细化到**每一个分组**）。
 *
 * 每个启用中的分组一段，内置与自建一视同仁：内置分组取词条
 * `memory.groupDesc.<id>`，自建分组用它自己的「提示词」，都没写就退回 `target=<id>`。
 * 被关掉的分组块直接跳过 —— 描述与 target enum 一起消失。
 * @param {object} config - 插件配置（用 memoryDir 读分组表）。
 * @param {Record<string, boolean>} blocks - 工具定义块启用表。
 * @returns {Array<{id: string, text: string}>} 分组段（id = `group.<分组id>`）。
 */
function memoryGroupSections(config, blocks, texts = {}) {
  const data = loadGroups(config.memoryDir)
  const out = []
  for (const group of listEnabledGroups(data, 'memory')) {
    const id = groupBlockId(group.id)
    if (!isBlockEnabled(blocks, 'memory', id)) continue
    // 用户改过这段文案就先用它。
    const override = blockTextOf(texts, 'memory', id)
    if (override !== null) {
      out.push({ id, label: `写入目标：${groupLabel(group)}`, text: override })
      continue
    }
    const key = `memory.groupDesc.${group.id}`
    const text = mt(key)
    const label = groupLabel(group)
    out.push({
      id,
      label: `写入目标：${label}`,
      text: text !== key
        ? text
        : (typeof group.prompt === 'string' && group.prompt.trim() !== ''
          ? `【${label}】${group.prompt.trim()}`
          : `【${label}】target=${group.id}`),
    })
  }
  return out
}

/**
 * todo 分组段（配置页用的默认文案；与 lib/todo.js 的 todoGroupSections 同规则）。
 */
function todoGroupSectionsFor(config, blocks) {
  const data = loadGroups(config.memoryDir)
  const out = []
  for (const group of listEnabledGroups(data, 'todo')) {
    const id = groupBlockId(group.id)
    if (!isBlockEnabled(blocks, 'dtodo', id)) continue
    const label = groupLabel(group)
    const key = `todo.groupDesc.${group.id}`
    const text = translate(TODO_DICT, key, undefined, getLocale())
    out.push({
      id,
      label: `待办目标：${label}`,
      text: text !== key
        ? text
        : (typeof group.prompt === 'string' && group.prompt.trim() !== ''
          ? `【${label}】${group.prompt.trim()}`
          : `【${label}】target=${group.id}`),
    })
  }
  return out
}

/**
 * 配置页用的「块目录」（2026-10-17 用户需求：块的文案可写、可恢复默认）。
 *
 * 每块带 `label`（给人看的名字）、`defaultText`（出厂文案）、`text`（用户覆盖，空 = 用默认）；
 * 分组块同样在内（内置与自建一视同仁）。
 * @param {object} config - 插件配置。
 * @param {() => object} getRuntime - 运行时配置读取器。
 * @returns {Array<{tool: string, id: string, label: string, defaultText: string, text: string}>} 块目录。
 */
function toolBlockCatalog(config, getRuntime) {
  const runtime = getRuntime()
  const texts = normalizeToolBlockTexts(runtime.toolBlockTexts)
  const blocks = normalizeToolBlocks(runtime.toolBlocks)
  const out = []
  for (const block of TOOL_BLOCKS) {
    const prefix = block.tool === 'dtodo' ? 'todo' : block.tool
    const dict = block.tool === 'dtodo' ? TODO_DICT : MEMORY_DICT
    out.push({
      tool: block.tool,
      id: block.id,
      label: block.label,
      defaultText: translate(dict, `${prefix}.desc.${block.id}`, undefined, getLocale()),
      text: blockTextOf(texts, block.tool, block.id) ?? '',
    })
  }
  for (const section of memoryGroupSections(config, blocks, {})) {
    out.push({
      tool: 'memory',
      id: section.id,
      label: section.label ?? section.id,
      defaultText: section.text,
      text: blockTextOf(texts, 'memory', section.id) ?? '',
    })
  }
  for (const section of todoGroupSectionsFor(config, blocks)) {
    out.push({
      tool: 'dtodo',
      id: section.id,
      label: section.label ?? section.id,
      defaultText: section.text,
      text: blockTextOf(texts, 'dtodo', section.id) ?? '',
    })
  }
  return out
}

/**
 * memory 工具的完整描述（按块拼装 + 块文案覆盖）。
 *
 * 工具注册与配置页**共用同一个出口** —— 2026-10-17 实测踩过：配置页那边只显示总述，
 * 于是"改了块文案却看不到变化"。
 * @param {object} config - 插件配置。
 * @param {() => object} getRuntime - 运行时配置读取器。
 * @returns {string} 描述文本。
 */
/**
 * 完整的工具描述（通用定义 + 分组段 + 各启用块），注册给模型用。
 * 描述覆盖只替换**头段**（旧版的"整段覆盖"由 normalizeHeadOverride 兜底识别）。
 */
function memoryComposed(config, getRuntime) {
  const blocks = normalizeToolBlocks(getRuntime().toolBlocks)
  const texts = normalizeToolBlockTexts(getRuntime().toolBlockTexts)
  const sections = memoryGroupSections(config, blocks, texts)
  const full = composeDescription(blocks, 'memory', mt, 'memory', sections, texts)
  const head = normalizeHeadOverride(toolOverride(loadToolsConfig(config.memoryDir), 'memory').description, full)
  return head === undefined ? full : composeDescription(blocks, 'memory', mt, 'memory', sections, texts, head)
}

/** dtodo 的完整描述（同上，词条前缀是 `todo.`）。 */
function todoComposed(config, getRuntime) {
  const blocks = normalizeToolBlocks(getRuntime().toolBlocks)
  const texts = normalizeToolBlockTexts(getRuntime().toolBlockTexts)
  const tt = (key) => translate(TODO_DICT, key, undefined, getLocale())
  const sections = todoGroupSectionsFor(config, blocks)
  const full = composeDescription(blocks, 'dtodo', tt, 'todo', sections, texts)
  const head = normalizeHeadOverride(toolOverride(loadToolsConfig(config.memoryDir), 'dtodo').description, full)
  return head === undefined ? full : composeDescription(blocks, 'dtodo', tt, 'todo', sections, texts, head)
}

export function memoryTool(ctx, config, store, queue, getRuntime, archive, writeGap = null, writesBlocked = () => null) {  /**
   * 程序拼接【反馈】行（用户情绪反馈记录，2026-08-10 上线）。
   * sentiment 必填（positive/negative）；category/quote/note 可缺省
   * （缺省段不输出，category 缺省标"未分类"）。所有字段清洗
   * |、换行、§、引号（防破坏 § 分隔的 MD 条目格式）；quote 强制截断
   * ≤20 字（用户原话摘录，可溯源证据）。返回 '' 表示不生成行。
   * @param {object|null} feedback - 工具的 feedback 参数（或 entries 项内的）。
   * @returns {string} 【反馈】行文本，或 ''。
   */
  function buildFeedbackLine(feedback) {
    if (!feedback || typeof feedback !== 'object') return ''
    const sent = feedback.sentiment === 'positive' ? mt('feedback.positive') : feedback.sentiment === 'negative' ? mt('feedback.negative') : null
    if (sent === null) return ''
    const clean = (s) => String(s ?? '').replace(/[|\n\r§"]/g, '').trim()
    const cat = clean(feedback.category) || mt('feedback.uncategorized')
    const quote = clean(feedback.quote).slice(0, 20)
    const note = clean(feedback.note)
    const tag = feedback.manual === true ? mt('feedback.tagManual') : mt('feedback.tag')
    const parts = [`${mt('feedback.sentiment')}:${sent}`, `${mt('feedback.category')}:${cat}`]
    if (quote) parts.push(`${mt('feedback.quote')}:"${quote}"`)
    if (note) parts.push(`${mt('feedback.note')}:${note}`)
    return `${tag}${parts.join(' | ')}`
  }

  /**
   * 单轨 add 的公共实现（entries 批量与单轨 add 共用）：
   * - feedback 行由程序拼接后附加到条目末尾（仅 daily/project 轨生效；
   *   key 轨忽略 feedback，走建议队列；memory/user 也不生成行）；
   * - key 轨 add 进待确认队列（用户确认后写入并注入），不直接落盘；
   * - 结果统一 outcomeOnly（剥 entries/removed，严格对齐 output schema）。
   * @param {string} target - 记忆轨。
   * @param {string} content - 条目内容。
   * @param {object|null} feedback - feedback 参数（可为空）。
   * @param {object} exec - 工具执行上下文（agent 等）。
   * @returns {Promise<object>} 工具友好结果 {ok, message, target, ...}。
   */
  async function addOne(target, content, feedback, exec, summary, meta = {}) {
    const fbLine = target === 'daily' || target === 'project' ? buildFeedbackLine(feedback) : ''
    let finalContent = String(content ?? '').trim()
    if (fbLine !== '') finalContent = finalContent === '' ? fbLine : `${finalContent}\n${fbLine}`
    if (finalContent === '') return { ok: false, message: mt('msg.emptyContent'), target }
    // 摘要不再拼成 `[summary:…]` 文本标签，而是随结构化元数据一起落进条目的
    // frontmatter（2026-10-15「一条一 md」改造）。文本视图仍会在摘要**显式**
    // 给过时渲染出该标签，所以渐进式披露的既有行为不变。
    // 清洗沿用旧规则：换行让标签跨行、`]` 会让解析正则 `[^\]]*` 提前截断。
    const cleanSummary = summary === undefined || summary === null || String(summary).trim() === ''
      ? ''
      : String(summary).replace(/[\n\r\t\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
    // ── 待确认门槛（2026-10-13 分组化）────────────────────────────────
    // 每个记忆分组独立控制「写入是否要用户确认」：
    //   - group.confirm=true 且 autoApprove=false 且未开全局自动通过 →
    //     add 进待确认队列（用户在记忆 Tab 采纳后才落盘并注入）；
    //   - 出厂默认：memory / user / kb / key 需要确认（会进上下文，谨慎），
    //     project / daily 不需要（每轮收尾的进展日志，每条都确认会淹没用户）；
    //     用户自建分组默认需要确认，可在设置面板逐个改。
    // key 轨的 summary 标签、reason 文案沿用原有分支（行为零漂移）。
    const addGroup = findGroup(loadGroups(config.memoryDir), 'memory', target)
    const forceAutoAll = getRuntime().allAutoApprove === true
    if (addGroup !== null && needsConfirmation(addGroup, forceAutoAll)) {
      const reason = target === 'key'
        ? mt('msg.keySuggestReason')
        : mt('msg.groupSuggestReason', { label: groupLabel(addGroup) })
      // 显式摘要随建议一起入队（2026-10-15 修 P1：此前只传内容，采纳后摘要
      // 被回落成"正文前 80 字"，AI 写的摘要静默丢失）。
      const outcome = enqueueSuggestion(queue, target, finalContent, reason, exec?.agent, cleanSummary)
      if (outcome.ok) {
        outcome.message = target === 'key'
          ? mt('msg.keySuggestionQueued', { queued: outcome.queued })
          : mt('msg.groupSuggestionQueued', { label: groupLabel(addGroup), queued: outcome.queued })
      }
      // queued 不在输出 schema 内（additionalProperties:false），剥离
      const { queued: _queued, ...rest } = outcome
      return outcomeOnly(rest)
    }
    const addResult = store.addEntry(target, {
      title: meta.title,
      summary: cleanSummary,
      keywords: normalizeKeywordList(meta.keywords),
      scenario: meta.scenario,
      body: finalContent,
    }, exec.agent)
    // 写入看门狗：daily/project 写入成功即重置该会话的连续未写计数
    // （memory/user/key 不算——看门狗盯的是每轮进展日志的欠账；key 走
    // 确认队列、memory/user 是慢变轨，都不承载"本轮做了什么"）。
    if (addResult.ok && (target === 'daily' || target === 'project')) {
      writeGap?.noteWrite?.(exec?.agent)
    }
    return outcomeOnly(addResult)
  }

  /** 当前启用中的工具定义块（运行时配置 toolBlocks，缺省全启用）。 */
  const blocksOf = () => normalizeToolBlocks(getRuntime().toolBlocks)

  return {
    name: config.toolName,
    // 描述按块拼装（2026-10-16 用户：工具定义分块启用）：关掉的块不进 schema。
    get description() { return memoryComposed(config, getRuntime) },
    // 参数同样按块裁剪：先构造完整定义，再删掉关闭块专属的字段。
    get parameters() {
      const params = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove', 'archive', 'list', 'expand'],
          get description() { return mt('param.action') },
        },
        target: {
          type: 'string',
          // 分组化（2026-10-13）：可写目标 = 启用中的记忆分组（内置六轨 +
          // 用户自建分组）。getter 每次读最新 groups.json，用户在设置面板
          // 新建/改名分组后立刻可用，无需重启插件。
          get enum() {
            // 关掉某条轨的块 → 该 target 直接从 enum 里消失（用户举例：不需要项目记忆）。
            return listEnabledGroups(loadGroups(config.memoryDir), 'memory')
              .map((g) => g.id)
              .filter((id) => trackEnabled(blocksOf(), 'memory', id))
          },
          get description() { return mt('param.target') },
        },
        content: {
          type: 'string',
          get description() { return mt('param.content') },
        },
        entries: {
          type: 'array',
          get description() { return mt('param.entries') },
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              target: {
                type: 'string',
                enum: ['daily', 'project'],
                get description() { return mt('param.entriesTarget') },
              },
              content: {
                type: 'string',
                get description() { return mt('param.entriesContent') },
              },
              feedback: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sentiment: {
                    type: 'string',
                    enum: ['positive', 'negative'],
                    get description() { return mt('param.sentiment') },
                  },
                  category: {
                    type: 'string',
                    get description() { return mt('param.category') },
                  },
                  quote: {
                    type: 'string',
                    get description() { return mt('param.quote') },
                  },
                  note: {
                    type: 'string',
                    get description() { return mt('param.note') },
                  },
                  manual: {
                    type: 'boolean',
                    get description() { return mt('param.manual') },
                  },
                },
                required: ['sentiment'],
                get description() { return mt('feedback.tag') },
              },
            },
            required: ['target', 'content'],
          },
        },
        feedback: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sentiment: {
              type: 'string',
              enum: ['positive', 'negative'],
              get description() { return mt('param.sentiment') },
            },
            category: {
              type: 'string',
              get description() { return mt('param.category') },
            },
            quote: {
              type: 'string',
              get description() { return mt('param.quote') },
            },
            note: {
              type: 'string',
              get description() { return mt('param.note') },
            },
            manual: {
              type: 'boolean',
              get description() { return mt('param.manual') },
            },
          },
          required: ['sentiment'],
          get description() { return mt('param.feedback') },
        },
        match: {
          type: 'string',
          get description() { return mt('param.match') },
        },
        archived: {
          type: 'boolean',
          get description() { return mt('param.archived') },
        },
        branches: {
          type: 'string',
          get description() { return mt('param.branches') },
        },
        branch: {
          type: 'string',
          get description() { return mt('param.branch') },
        },
        filter: {
          type: 'string',
          get description() { return mt('param.filter') },
        },
        since: {
          type: 'string',
          get description() { return mt('param.since') },
        },
        until: {
          type: 'string',
          get description() { return mt('param.until') },
        },
        limit: {
          type: 'integer',
          get description() { return mt('param.limit') },
        },
        recent: {
          type: 'boolean',
          get description() { return mt('param.recent') },
        },
        id: {
          type: 'string',
          get description() { return mt('param.id') },
        },
        summary: {
          type: 'string',
          get description() { return mt('param.summary') },
        },
        title: {
          type: 'string',
          get description() { return mt('param.title') },
        },
        keywords: {
          type: 'string',
          get description() { return mt('param.keywords') },
        },
        scenario: {
          type: 'string',
          get description() { return mt('param.scenario') },
        },
      },
      required: ['action', 'target'],
      }
      const b = blocksOf()
      if (!isBlockEnabled(b, 'memory', 'batch')) delete params.properties.entries
      if (!isBlockEnabled(b, 'memory', 'feedback')) delete params.properties.feedback
      if (!isBlockEnabled(b, 'memory', 'meta')) {
        for (const key of ['title', 'summary', 'keywords', 'scenario']) delete params.properties[key]
      }
      if (!isBlockEnabled(b, 'memory', 'actions.archive')) delete params.properties.archived
      if (!isBlockEnabled(b, 'memory', 'actions.query')) {
        for (const key of ['filter', 'since', 'until', 'limit', 'recent', 'branch', 'id']) delete params.properties[key]
      }
      if (!isBlockEnabled(b, 'memory', 'actions.write')) delete params.properties.match
      if (!isBlockEnabled(b, 'memory', 'tracks.key')) delete params.properties.branches
      return params
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          target: { type: 'string' },
          entries: { type: 'array', items: { type: 'string' } },
          matches: { type: 'array', items: { type: 'string' } },
          chars: { type: 'integer' },
          backup: { type: 'string' },
          // list 元数据：该轨总条目数与最早/最新日期（指导模型合理设置查询范围）
          total: { type: 'integer' },
          earliest: { type: 'string' },
          latest: { type: 'string' },
          // entries 多轨批量写的结果数组（每轨 {target, ok, message}）
          multi: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                target: { type: 'string' },
                ok: { type: 'boolean' },
                message: { type: 'string' },
              },
              required: ['target', 'ok', 'message'],
            },
          },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: renderMemoryResult(value) }],
    },
    async execute(args, exec) {
      const target = args.target
      const action = args.action
      // 布局门禁（v3）：迁移未完成时只允许 list / expand 这类读操作。
      if (action !== 'list' && action !== 'expand') {
        const blocked = writesBlocked()
        if (blocked !== null) return { ok: false, message: blocked, target }
      }
      const origin = exec?.agent?.session?.header?.origin
      // Layered gate for subagent-origin writes: global tracks (memory/user,
      // injected every session) are the high-risk surface — refused in
      // suggest mode, approval-gated in auto mode. The project-scoped tracks
      // (project/key, keyed to one cwd) and daily (never injected) are safe
      // for automatic writes. The main session is never gated here (the review
      // prompt disciplines its global writes instead).
      if (origin === 'subagent' && (target === 'memory' || target === 'user')) {
        if (getRuntime().reviewMode !== 'auto') {
          return {
            ok: false,
            message: mt('msg.subagentGlobalDenied', { suggestTool: getRuntime().suggestToolName }),
            target,
          }
        }
        const approval = ctx.get('approval')
        if (!approval) {
          return { ok: false, message: mt('msg.approvalUnavailable'), target }
        }
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: config.toolName,
          callId: exec.callId,
          reason: '记忆审查建议写入长期记忆',
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') {
          return { ok: false, message: mt('msg.notApproved', { outcome }), target }
        }
      }
      // target 兜底校验：required 已放宽为仅 ['action']（entries 批量模式
      // 不需要顶层 target），其他操作缺 target 时给出明确错误而非底层报错。
      const isEntriesAdd = action === 'add' && Array.isArray(args.entries) && args.entries.length > 0
      if (!target && !isEntriesAdd) {
        return { ok: false, message: mt('msg.missingTarget') }
      }
      let result
      try {
        switch (action) {
          case 'list': {
            // archived=true：查归档文件（MEMORY-archive.md / USER-archive.md /
            // 项目 KEY-archive.md）——归档内容不注入、主轨 list 看不到，
            // 需要时可在这里检索（移回主记忆走记忆 Tab 或人工转正）。
            if (args.archived === true) {
              if (target !== 'memory' && target !== 'user' && target !== 'key') {
                result = { ok: false, message: mt('msg.archivedQueryOnly'), target }
                break
              }
              const cwd = exec?.agent?.session?.header?.cwd
              if (target === 'key' && !cwd) {
                result = { ok: false, message: mt('msg.keyArchiveNeedsCwd'), target }
                break
              }
              let entries = archive.entriesOf(target, cwd)
              // 轻量过滤：filter 子串（大小写不敏感）、since/until 按时间戳
              // 前缀比较、recent 倒序、limit 截断——与主轨 list 语义对齐
              const q = String(args.filter ?? '').trim().toLowerCase()
              if (q) entries = entries.filter((e) => e.toLowerCase().includes(q))
              const stamp = (e) => { const m = /^\[(\d{4}-\d{2}-\d{2})\]/.exec(e); return m ? m[1] : null }
              if (args.since !== undefined) {
                const s = String(args.since)
                entries = entries.filter((e) => { const d = stamp(e); return d !== null && d >= s })
              }
              if (args.until !== undefined) {
                const u = String(args.until)
                entries = entries.filter((e) => { const d = stamp(e); return d !== null && d <= u })
              }
              if (args.recent === true) entries = [...entries].reverse()
              if (args.limit !== undefined && Number.isInteger(args.limit) && args.limit > 0) {
                entries = entries.slice(0, args.limit)
              }
              result = {
                ok: true,
                message: mt('msg.archiveList', { target, count: entries.length }),
                target,
                entries: entries.map((entry) => stripEntrySummary(stripEntryId(entry))), // 展示剥离身份证+摘要标记（§4.7）
                chars: entries.map((entry) => stripEntrySummary(stripEntryId(entry))).join('\n').length,
              }
              break
            }
            const stats = {}
            // ── 大文件轨查询保护（2026-08-10）──
            // project/daily 是追加增长型日志（一年可达几千条），模型无参数
            // list 会拉回全量 → 上下文 token 爆炸。未显式传 limit/recent 时
            // 默认"最近 50 条倒序"，并返回元数据（total/earliest/latest）让
            // 模型判断查询范围（日志就是给 AI 查的，信息越清楚查得越准）。
            // 显式传 limit/recent 时尊重显式值；memory/user/key 轨不设保护。
            // kb（记忆知识库，第六轨）同受保护：它是"按需查询"的参考库，
            // 条目数可达数百，无参 list 会把整库拉进上下文——默认只返回
            // 最近 50 条 + 库规模元数据，引导模型用 filter/since/until 检索。
            const isLog = target === 'project' || target === 'daily' || target === 'kb'
            const protectedView = isLog
              && args.limit === undefined
              && args.recent === undefined
              && args.since === undefined
              && args.until === undefined
            const queryOpts = {
              filter: args.filter,
              since: args.since,
              until: args.until,
              limit: protectedView ? 50 : args.limit,
              recent: protectedView ? true : args.recent,
            }
            let entries = store.query(target, exec.agent, queryOpts, stats)
            // 元数据：该轨文件的总条目数与最早/最新日期（用于指导查询范围）
            const allEntries = store.entriesOf(target, exec.agent)
            const dates = []
            for (const entry of allEntries) {
              const d = extractEntryDate(entry)
              if (d !== null) dates.push(d)
            }
            const total = allEntries.length
            const earliest = dates.length > 0 ? dates.reduce((a, b) => (a < b ? a : b)) : ''
            const latest = dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : ''
            // key 轨的 branch 过滤：只看该分支可见的条目（无标记=全部 + 标记含该分支）
            if (target === 'key' && args.branch !== undefined && String(args.branch).trim() !== '') {
              const b = String(args.branch).trim()
              entries = entries.filter((entry) => {
                const scope = parseEntryBranches(entry)
                return scope === null || scope.includes(b)
              })
            }
            let message = `${target}：${entries.length} 条匹配`
            if (protectedView) {
              // 默认保护视图：告知库规模与时间跨度，引导模型合理加条件查询
              message += `（该轨共 ${total} 条，时间跨度 ${earliest || '?'} ~ ${latest || '?'}，默认只返回最近 50 条——查询更早记录请加 since/until（如 since=${earliest || 'YYYY-MM-DD'}）或增大 limit）`
            } else if (entries.length === 0 && (args.filter !== undefined || args.since !== undefined || args.until !== undefined)) {
              // 查不到：提醒模型读全文，不要凭猜测下结论
              message += '（未找到匹配条目——可去掉过滤条件重新 list 读取全文核对）'
            } else if (stats.undated > 0 && (args.since !== undefined || args.until !== undefined)) {
              // 日期格式不兼容：提醒模型这些条目未参与日期过滤
              message += `（另有 ${stats.undated} 条日期无法解析的条目未参与日期过滤——可去掉 since/until 重新 list 读取全文核对）`
            }
            result = {
              ok: true,
              message,
              target,
              // 展示剥离：身份证 [id:…] 是内部合并机制，模型可见输出一律剥掉
              // （施工图 §4.7；内部匹配用原文，不受影响）。
              entries: entries.map((entry) => stripEntrySummary(stripEntryId(entry))),
              chars: entries.map((entry) => stripEntrySummary(stripEntryId(entry))).join('\n').length,
              total,
              earliest,
              latest,
            }
            break
          }
          case 'add': {
            // ── entries 多轨批量（每轮收尾合并写 daily+project）──
            // 仅支持 daily/project 两轨（schema enum 已限；此处程序再兜底，
            // 防绕过 memory/user 的 subagent 门禁与 key 的确认队列）。
            // 逐项独立执行、独立成败，汇总到 multi 返回。
            if (Array.isArray(args.entries) && args.entries.length > 0) {
              const multi = []
              for (const item of args.entries) {
                const t = item?.target
                const c = String(item?.content ?? '').trim()
                if (t !== 'daily' && t !== 'project') {
                  multi.push({ target: String(t ?? '?'), ok: false, message: mt('msg.batchUnsupportedTrack') })
                  continue
                }
                if (c === '') {
                  multi.push({ target: t, ok: false, message: mt('msg.emptyContent') })
                  continue
                }
                // 单轨容错（issue #18 建议第 3 条）：任何一轨写入抛异常
                // （如 Windows 上锁文件删除被占用、记忆目录无法创建等）
                // 只记为该轨失败，不中断循环、不丢弃其余轨道。
                let r
                try {
                  r = await addOne(t, c, item?.feedback, exec)
                } catch (error) {
                  r = { ok: false, message: mt('msg.writeError', { detail: error?.message ?? String(error) }) }
                }
                multi.push({ target: t, ok: r.ok, message: r.message })
              }
              const allOk = multi.every((m) => m.ok)
              result = {
                ok: allOk,
                message: mt('msg.batchSummary', { count: multi.length }) + multi.map((m) => `${m.target}=${m.ok ? mt('msg.ok') : mt('msg.failed')}`).join(' '),
                multi,
              }
              break
            }
            // ── 单轨 add（原逻辑 + feedback 参数）──
            let content = String(args.content ?? '').trim()
            let branchWarning = ''
            // key 轨的分支范围：branches=main,dev → 条目带 [branch:main,dev] 标记；
            // 缺省/空 = 全部（无标记）。对不存在的分支只警告、照常写入（分支以后可能创建）。
            if (target === 'key' && args.branches !== undefined && String(args.branches).trim() !== '') {
              const list = String(args.branches).split(',').map((b) => b.trim()).filter((b) => b.length > 0)
              if (list.length > 0) {
                content = `[branch:${list.join(',')}] ${content}`
                const known = gitBranchList(exec?.agent?.session?.header?.cwd)
                if (known.length > 0) {
                  const unknown = list.filter((b) => !known.includes(b))
                  if (unknown.length > 0) {
                    branchWarning = mt('msg.branchWarningUnknown', { branches: unknown.join(', ') })
                  }
                }
              }
            }
            const addOneResult = await addOne(target, content, args.feedback, exec, args.summary, {
              title: args.title,
              keywords: args.keywords,
              scenario: args.scenario,
            })
            if (addOneResult.ok && branchWarning !== '') addOneResult.message += branchWarning
            result = addOneResult
            break
          }
          case 'replace':
            result = outcomeOnly(store.replace(target, args.match, args.content, exec.agent))
            break
          case 'remove':
            result = outcomeOnly(store.remove(target, args.match, exec.agent))
            break
          case 'archive': {
            // 归档：主轨条目 → 对应归档文件（仅 memory/user/key 三轨）。
            // 与记忆 Tab「归档」按钮同一语义——按唯一子串片段从主轨移除
            // 整条，原文追加进 MEMORY-archive.md / USER-archive.md /
            // projects/<项目>/KEY-archive.md（key 需会话工作目录）。
            // 可逆：记忆 Tab 归档页「移回主记忆」可转正。
            // 顺序：先归档、后删除——先用 peek 预览命中原文并写入归档
            // 文件，归档写入成功后再从主轨删除；归档失败时主轨条目原样
            // 保留（绝不丢数据）。删除失败（并发下 match 已变化）时归档
            // 里会多出一条可手动清理的条目，但主轨数据仍在、可恢复——
            // 权衡取「宁可重复、不可丢失」。
            if (target !== 'memory' && target !== 'user' && target !== 'key') {
              result = { ok: false, message: mt('msg.archiveTracksOnly'), target }
              break
            }
            const match = String(args.match ?? '').trim()
            if (!match) {
              result = { ok: false, message: mt('msg.archiveEmptyMatch'), target }
              break
            }
            const cwd = exec?.agent?.session?.header?.cwd
            if (target === 'key' && !cwd) {
              result = { ok: false, message: mt('msg.archiveKeyNeedsCwd'), target }
              break
            }
            // 第一步：预览命中原文（只读，不写盘）
            const preview = store.peek(target, match, exec.agent)
            if (!preview.ok) {
              result = outcomeOnly(preview)
              break
            }
            // 第二步：先把原文写进归档文件（原子写 + 目录锁）
            const appended = archive.append(target, preview.entry, cwd)
            if (!appended.ok) {
              result = {
                ok: false,
                message: mt('msg.archiveAppendFailed', { detail: appended.message ?? '?' }),
                target,
              }
              break
            }
            // 第三步：归档成功后再从主轨删除
            const removed = store.remove(target, match, exec.agent)
            if (!removed.ok) {
              result = {
                ok: false,
                message: mt('msg.archivePartial', { total: appended.total, detail: removed.message }),
                target,
              }
              break
            }
            result = {
              ok: true,
              message: mt('msg.archivedDone', { target, total: appended.total }),
              target,
            }
            break
          }
          case 'expand': {
            // 渐进式披露：按 ID 加载 key 轨条目全文
            if (target !== 'key') {
              result = { ok: false, message: mt('msg.expandKeyOnly'), target }
              break
            }
            if (!args.id) {
              result = { ok: false, message: mt('msg.expandNeedsId'), target }
              break
            }
            const cwd = exec?.agent?.session?.header?.cwd
            if (!cwd) {
              result = { ok: false, message: mt('msg.expandNeedsCwd'), target }
              break
            }
            const keyAgent = { session: { header: { cwd } } }
            // 分支作用域过滤（审查修复）：与快照注入/key 轨 list 同一规则——
            // 只有当前分支可见的条目（无标记=全部 + [branch:…] 含当前分支）
            // 才能 expand，防止分支 A 的会话 expand 出仅限分支 B 的条目。
            const branch = config.keyBranchFilter !== false ? gitBranch(cwd) : undefined
            let keyEntries = store.entriesOf('key', keyAgent)
            if (branch !== undefined) {
              keyEntries = keyEntries.filter((entry) => {
                const scope = parseEntryBranches(entry)
                return scope === null || scope.includes(branch)
              })
            }
            const found = keyEntries.find(e => e.includes(`[id:${args.id}]`) || legacyIdFor(e) === args.id)
            if (!found) {
              result = { ok: false, message: mt('msg.expandNotFound', { id: args.id }), target }
              break
            }
            result = {
              ok: true,
              message: mt('msg.expandFullText'),
              target,
              entries: [stripEntrySummary(stripEntryId(found))],
            }
            break
          }
          default:
            result = { ok: false, message: mt('msg.unknownAction', { action }), target }
        }
      } catch (error) {
        // e.g. project memory without a session cwd
        result = { ok: false, message: error?.message ?? String(error), target }
      }
      return result
    },
  }
}


/**
 * 构建 COI 任务注入的记忆上下文文本（与 DSH 会话注入同源同规则）：
 *   长期记忆 + 用户档案（所有任务注入）；项目关键记忆仅在有 cwd 时注入，
 *   且按 git 分支过滤（与 keyBranchFilter 一致：只注入无标记或覆盖当前
 *   分支的条目）。**不注入 AGENTS.md**（用户决策：DSH 的每轮纪律/开发规则
 *   只约束 DSH 主模型，不应强加给外部 COI）。项目日志/每日日志不注入
 *   （流水太长，与 DSH 快照策略一致）。
 *   tracks 可只取部分轨（'memory'/'user'/'key' 子集，COI 调度由 AI 经
 *   injectTracks 自主选择）；缺省=全部三轨。
 *   excludeDshOnly：true = 跳过带「仅 DSH」标记（[dsh-only]）的条目——
 *   这些条目只适用于 DSH 自身（DSH 纪律/规则/架构类事实），外部执行器
 *   不必遵循 DSH 规则，注入只会让它们困惑。COI 调度注入时传 true；DSH
 *   自身快照注入不传（标记条目照常注入 DSH）。
 * @param {MemoryStore} store - 记忆 store。
 * @param {object} [opts] - { cwd, branch, tracks, excludeDshOnly }。
 * @returns {string} 拼接好的上下文文本（无内容返回空串）。
 */
export function buildMemoryContext(store, { cwd, branch: declaredBranch, tracks, excludeDshOnly } = {}) {
  // tracks 缺省=全部三轨（兼容快照等既有调用方）；COI 调度时由 AI 经
  // injectTracks 参数自主选择（scope 与注入无关，任何层级都能选轨注入）
  const want = (track) => tracks === undefined || tracks.includes(track)
  // 「仅 DSH」标记过滤：excludeDshOnly=true（外部执行器注入）时整条跳过
  // 带 [dsh-only] 的条目；DSH 自身注入（false/缺省）原样保留
  const dshOnlySafe = (entries) => (excludeDshOnly ? entries.filter((entry) => !parseEntryDshOnly(entry)) : entries)
  const parts = []
  if (want('memory')) {
    const memoryEntries = dshOnlySafe(store.entriesOf('memory'))
    if (memoryEntries.length > 0) parts.push(`${st('ctx.memoryGlobal')}\n${memoryEntries.join('\n')}`)
  }
  if (want('user')) {
    const userEntries = dshOnlySafe(store.entriesOf('user'))
    if (userEntries.length > 0) parts.push(`${st('ctx.userProfile')}\n${userEntries.join('\n')}`)
  }
  if (want('key') && cwd) {
    const keyAgent = { session: { header: { cwd } } }
    let keyEntries = dshOnlySafe(store.entriesOf('key', keyAgent))
    // 分支过滤：优先用任务声明的分支（scope=project 可挂 branch，如
    // feat/tag-question-paper）；任务未声明时回退到 cwd 目录当前 checkout
    // 的分支（git branch --show-current，与 DSH 会话注入同规则）。非 git
    // 仓库/获取失败 → 全部注入。
    const branch = declaredBranch ?? gitBranch(cwd)
    if (branch !== undefined) {
      keyEntries = keyEntries.filter((entry) => {
        const scope = parseEntryBranches(entry)
        return scope === null || scope.includes(branch)
      })
    }
    if (keyEntries.length > 0) {
      const head = branch !== undefined ? st('ctx.keyWithBranch', { branch }) : st('ctx.keyPlain')
      // 展示剥离：身份证 [id:…] 不注入（审查 P1-5：COI/外部执行器出口）
      // 展示剥离：身份证 + 摘要标记（与 DSH 快照全量注入同规则；正文完整时
      // [summary:…] 是仅供摘要模式用的元数据，不注入外部执行器）
      parts.push(`${head}\n${keyEntries.map((entry) => stripEntrySummary(stripEntryId(entry))).join('\n')}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * The plugin entrypoint.
 * @param {object} ctx - the plugin context (`tools`, `systemPrompt` injected).
 * @param {object} [rawConfig] - raw cordis config.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  // 布局门禁（v3，2026-10-19）：启动读 `<memoryDir>/.layout-version`。**不自动迁移**——
  // 版本未到 3 且探测到旧结构（或已有半迁移状态文件）时只记录状态（API/UI 据此提示），
  // 同时拒绝一切写操作（记忆 / 待办 / 分组增删改），避免把半迁移的目录写坏。
  // 读操作照常，所以插件启动不崩、界面能看到「需要迁移」。
  let layoutStatus = layoutStatusOf(config.memoryDir)
  // 全新目录（无 `.layout-version`、也无任何旧结构/module-data 以外的东西）：
  // 直接落 v3 标记。全仓除迁移 CLI 外没有别处写这个标记，不在这里补的话
  // 全新用户会永远停在 unknown（同步被门禁挡住）。落到 unknown 已排除存在
  // v2 数据的可能（否则会被探测成 needs-migration）。
  if (layoutStatus.state === 'unknown') {
    try {
      mkdirSync(config.memoryDir, { recursive: true })
      writeFileSync(layoutVersionFileOf(config.memoryDir), `${LAYOUT_VERSION}\n`)
      layoutStatus = layoutStatusOf(config.memoryDir)
    } catch (error) {
      console.warn('[memory-evolve] 写 .layout-version 失败（同步保持停用）：', error?.message ?? error)
    }
  }
  const layoutStatusNow = () => {
    if (layoutStatus.state !== 'v3') layoutStatus = layoutStatusOf(config.memoryDir)
    return layoutStatus
  }
  const writesBlocked = () => (layoutStatusNow().writesBlocked ? LAYOUT_WRITE_BLOCKED_MESSAGE : null)
  if (layoutStatus.needsMigration) {
    console.warn(`[memory-evolve] 记忆目录仍是旧布局（version=${layoutStatus.version ?? '缺失'}，检测到：${layoutStatus.legacyEntries.join('/') || '半迁移状态'}），写入已暂停；请先运行 scripts/migrate-v3.mjs`)
  }
  // Host-side locale (English support): resolve once at boot from the DSH
  // Language preference (default 'en' when unset), then follow live changes
  // through the settings commit event. Getter-based tool descriptions and
  // snapshot builders read the active locale per call, so a flip takes
  // effect on the next model request / injected turn without re-registering
  // anything. The 'locale' namespace belongs to DSH's own locale plugin —
  // we only read it here and never write to it.
  //
  // 2026-09-28（DSH 0.2.0 适配）：宿主把 settings 服务的 get() 移除、改为
  // describe()，并把提交事件从 'settings/updated' 改名为
  // 'settings/document-updated'。两个事件名都订阅（未知事件名在 cordis 里
  // 只是永不触发，不会报错），读值统一走 settings-compat 的版本兼容层，
  // 于是新老宿主都能就地跟随语言切换。
  setLocale(resolveLocale(ctx))
  ctx.effect(() => {
    const settings = ctx.get('settings')
    if (!hasSettingsRead(settings)) return () => {}
    const disposers = SETTINGS_CHANGE_EVENTS.map((event) => ctx.on(event, (ns) => {
      if (ns === 'locale') setLocale(resolveLocale(ctx))
    }))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-memory-evolve: locale watcher')
  // 分组配置（2026-10-13 分组化）：stroe/todoStore 的 target 解析、快照注入、
  // 记忆工具的 target 列表都从这里取。**每次读盘**（groups.json 只有几 KB），
  // 用户在设置面板改完立即生效，不需要重启或缓存失效逻辑。
  const groupsData = () => loadGroups(config.memoryDir)
  const findMemoryGroup = (id) => findGroup(groupsData(), 'memory', id)
  const findTodoGroup = (id) => findGroup(groupsData(), 'todo', id)
  // 存储格式迁移（v1 → v2，2026-10-15）：旧的「一个分组一个 .md、条目用 §
  // 分隔」升级成「一条记忆一个 md + frontmatter 元数据 + 按类分目录」。
  // 后台延后执行（不阻塞启动）；先全部解析进内存 → 复制备份 → 再写新位置 →
  // 最后删旧文件并写版本标记，任何一步失败都不丢内容、下次启动自动重试；
  // 配置页「数据」页也能手动触发或回滚（详见 lib/migrate-v2.js）。
  ctx.effect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      try {
        const report = migrateToVault(config.memoryDir)
        if (report.ok && report.entries + report.todos > 0) {
          console.log(`[memory-evolve] 存储格式升级到 v2：${report.entries} 条记忆、${report.todos} 个待办文件；备份 ${report.backup}`)
        } else if (!report.ok) {
          console.warn('[memory-evolve] 存储格式迁移未完成（旧数据未动）：', report.errors.join('；'))
        }
      } catch (error) {
        console.warn('[memory-evolve] 存储格式迁移失败（旧数据未动）：', error?.message ?? error)
      }
    }, 1500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, 'dsh-memory-evolve: vault migration')

  const store = new MemoryStore(config.memoryDir, {
    ...config,
    // 记忆同步接线（施工图 §4.2/§6）：entryIdMode 随 syncEnabled 动态开关
    // （syncCtrl.sync() 里同步）；projectDirResolver 让 sync 项目（迁移到
    // projectId 目录后）的 store 读写定位到新目录，未启用项目回退原逻辑。
    entryIdMode: config.syncEnabled ? 'on' : 'off',
    projectDirResolver: makeProjectDirResolver(config),
    // 自建记忆分组：target 不在内置六轨时由分组配置决定文件位置
    groupResolver: findMemoryGroup,
  })
  const archive = new ArchiveStore(config.memoryDir, {
    projectDirResolver: makeProjectDirResolver(config),
    // 归档轨也走分组模型（2026-10-15）：归档目录由分组的「类」决定，
    // 且用户自建分组同样可以归档。
    groupResolver: findMemoryGroup,
    // 待办归档同样走目录模型（归档轨写作 `todo-<组id>`）—— 两类的 id 会重名
    // （session / project / daily 都有），所以各用各的解析器。
    todoGroupResolver: findTodoGroup,
  })
  const queue = new SuggestionQueue(config.suggestionsFile)
  const todoStore = new TodoStore(config.memoryDir, makeProjectDirResolver(config), findTodoGroup)
  const stateFile = resolve(config.stateFile ?? stateFileOf(config.memoryDir))
  // 会话别名共享存储（aliases.json 单实例）：api 路由（/api/aliases）与
  // de_session rename 共用，避免多实例内存缓存互覆写
  const aliasStore = new AliasStore(config.memoryDir)

  // Runtime configuration: cordis config (static defaults) overlaid with the
  // persisted state file, which the Web settings panel updates live.
  const state = loadState(stateFile)
  const runtime = { ...config }
  // 记忆同步模块引用（声明提前：installApi 的 deps 对象在 apply 前部构造，
  // 而 syncCtrl 在尾部装配——TDZ 约束，2026-08-11 实测）
  let syncDispose = null
  let syncStatusRef = null
  let syncOpsRef = null
  for (const key of RUNTIME_KEYS) {
    if (state[key] !== undefined) runtime[key] = state[key]
  }
  const getRuntime = () => runtime
  // Review turn counter: created once, shared by the snapshot (due warning)
  // and the memory_review_status tool. Zero-cost when review is disabled
  // (the settled listener returns early unless reviewEnabled).
  const counter = reviewTurnCounter(ctx, getRuntime)
  // 写入看门狗计数器（2026-08-31）：按会话统计"连续完成多少个用户回合
  // 未写 daily/project"（subagent 不计）；快照在缺口达到 writeGuardThreshold
  // 时注入置顶提醒（renderSnapshot），memory 工具 addOne 写入成功即归零。
  // 与 counter 同款一次性创建、全局共享；perTurnWriteGuard 关闭时计数器
  // 早退（零成本），提醒渲染也独立复查开关（两半各自安全降级）。
  const writeGap = writeGapCounter(ctx, () => getRuntime().perTurnWriteGuard !== false)
  const updateRuntime = (patch) => {
    const entries = Object.entries(patch)
    for (const [key, value] of entries) validateRuntimePatch(key, value)
    const nextState = { ...state, ...patch }
    const nextRuntime = { ...runtime, ...patch }
    saveState(stateFile, nextState)
    Object.assign(state, nextState)
    Object.assign(runtime, nextRuntime)
    return { ...runtime }
  }

  // 3. In-turn review tools are one runtime-controlled capability. Register
  // and dispose the pair together so the snapshot never advertises a review
  // workflow with only half of its tools available.
  let reviewToolsDispose = null
  const reviewCtrl = {
    sync(desired = runtime.reviewEnabled === true) {
      const enabled = desired === true
      if (enabled && reviewToolsDispose === null) {
        reviewToolsDispose = ctx.effect(() => {
          // 工具定义联动：开启 toolDefsLive 后，改名/停用才作用于注册。
          const suggestDef = resolveToolDefs(config.memoryDir, getRuntime().toolDefsLive, 'memory_suggest',
            getRuntime().suggestToolName ?? config.suggestToolName)
          if (!suggestDef.enabled) return () => { /* 停用：连 review_status 一起不注册 */ }
          let suggestDispose = null
          try {
            suggestDispose = ctx.tools.register(suggestToolDefinition(
              { ...config, suggestToolName: suggestDef.name }, queue, () => getRuntime().todoEnabled !== false,
            ))
            const statusDispose = ctx.tools.register(reviewStatusTool(getRuntime, counter))
            return () => { try { statusDispose() } finally { suggestDispose() } }
          } catch (error) {
            suggestDispose?.()
            throw error
          }
        }, 'dsh-memory-evolve: review tools')
      } else if (!enabled && reviewToolsDispose !== null) {
        const dispose = reviewToolsDispose
        reviewToolsDispose = null
        dispose()
      }
    },
    /** 工具定义联动变化（改名/停用）：先卸再挂，让新名字/停用状态立刻生效。 */
    resync() {
      if (reviewToolsDispose !== null) {
        const dispose = reviewToolsDispose
        reviewToolsDispose = null
        dispose()
      }
      reviewCtrl.sync()
    },
  }

  // 2d. Local document search (search_local_docs): default OFF — the tool is
  // registered only while the runtime switch is on, so a disabled tool never
  // appears in the model's tool list (and its schema stays out of the prompt).
  // updateRuntime 联动：Web 设置面板 / slash 命令切换后即时注册或注销。
  const searchDocsCtrl = createSearchDocsController(ctx, config, getRuntime)
  const applyRuntimePatch = (patch) => {
    // Stage the tool transition before committing the settings patch. A tool
    // registration failure leaves every runtime/persisted key untouched; a
    // persistence failure restores the previous tool surface.
    const previousReviewEnabled = runtime.reviewEnabled === true
    const desiredReviewEnabled = Object.hasOwn(patch, 'reviewEnabled')
      ? patch.reviewEnabled
      : previousReviewEnabled
    if (Object.hasOwn(patch, 'reviewEnabled')) validateRuntimePatch('reviewEnabled', patch.reviewEnabled)
    let next
    try {
      reviewCtrl.sync(desiredReviewEnabled)
      next = updateRuntime(patch)
    } catch (error) {
      try {
        reviewCtrl.sync(previousReviewEnabled)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'dsh-memory-evolve: 运行时设置失败且审查工具回滚不完整')
      }
      throw error
    }
    notifyCtrl.sync() // 渠道通知随 notifyEnabled 即时安装/卸载（先于 COI——COI 依赖其 sendChannelNotify 回调）
    channelSendCtrl.sync() // 渠道直发随 channelSendEnabled 即时安装/卸载（独立开关，与 notify 互不影响）
    sessionImageCtrl.sync() // 本会话图片查询随 sessionImageQueryEnabled 即时安装/卸载（独立开关）
    searchDocsCtrl.sync()
    todoCtrl.sync() // 待办能力随 todoEnabled 即时注册/注销（dtodo 工具；数据与同步轨不动）
    // 工具定义联动（toolDefsLive）变化：改名/停用要立刻作用到工具面。
    if (Object.hasOwn(patch, 'toolDefsLive')) {
      syncToolDefs()
      reviewCtrl.resync()
      todoCtrl.resync()
    }
    coiCtrl.sync() // COI 模块随 coiEnabled 即时安装/卸载
    broadcastCtrl.sync() // 会话广播随 broadcastEnabled 即时安装/卸载
    sessionSearchCtrl.sync() // 会话搜索随 sessionSearchEnabled 即时安装/卸载
    sessionCtrl.sync() // 会话编排随 sessionEnabled 即时安装/卸载（曾漏掉导致开关打开工具不注册）
    promptsCtrl.sync() // 提示词模块随 promptsEnabled 即时安装/卸载
    modelsCtrl.sync() // 模型配置随 modelsEnabled 即时安装/卸载
    uiSettingsCtrl.sync() // DSH UI 设置随 uiSettingsEnabled 即时安装/卸载
    bookmarkCtrl.sync() // 会话书签随 bookmarkEnabled 即时安装/卸载
    syncCtrl.sync() // 记忆同步随 syncEnabled 即时安装/卸载（含 store.entryIdMode 动态切换）
    advisorCtrl.sync() // Advisor 评审随 advisorEnabled 即时安装/卸载（运行中键变化走 reconfigure）
    canvasCtrl.sync() // 无限画板随 canvasEnabled 即时安装/卸载（de_canvas 工具 + HTTP API）
    snapshotCtrl.sync() // 记忆注入方式（快照 / 系统提示词段）变化时换注册通道
    return next
  }

  // 1. 记忆注入：快照（运行时上下文）或 **系统提示词段**（2026-10-14 增设）。
  //    - 'context'（默认）：`systemPrompt.context()` —— 运行时上下文，文本变化
  //      时以尾部消息注入，前缀缓存最友好（升级前的唯一行为）；
  //    - 'section'：`systemPrompt.section()` —— 直接作为 **system 提示词段**
  //      参与 system 消息拼装（与 dsh-system-prompts 同一条通道），适合希望
  //      记忆"始终在系统提示词里"的场景；文本每轮重算，变化会重建该段。
  //    两者签名一致（name/order/text，text 支持函数），切换 = 换一个注册方法；
  //    该选项对**全部注入内容**生效：各记忆分组、内置指导文案、待办注入。
  let disposeSnapshotInject = null
  const installSnapshotInject = () => {
    disposeSnapshotInject?.()
    disposeSnapshotInject = null
    const snapshotRuntime = getRuntime()
    if (snapshotRuntime.injectMemory === false) return
    const order = Number.isFinite(snapshotRuntime.snapshotOrder)
      ? snapshotRuntime.snapshotOrder
      : config.snapshotOrder
    const disposers = []
    const registerOn = (channel, name, at) => {
      // 宿主没有这条通道时**跳过该段**而不是崩：装配失败会连带整个插件
      // （工具、API 全没了），远比少注册一段注入严重。真实 DSH 两条通道都
      // 有；单元测试的 mock 常常只造一条。
      const host = ctx.systemPrompt
      const fn = channel === 'section' ? host?.section : host?.context
      if (typeof fn !== 'function') {
        console.warn(`[memory-evolve] 宿主未提供 systemPrompt.${channel}，跳过 ${name}`)
        return
      }
      const register = fn.bind(host)
      try {
        disposers.push(register({
          name,
          order: at,
          text: (context) => renderSnapshot(
            getRuntime(), store, context.agent, counter, ctx.sessionTitle, writeGap, todoStore,
            {
              channel,
              // 工具名可能被 tools.json 覆盖（toolDefsLive 开启时），占位符要指向生效名。
              // 注意：renderSnapshot 是模块级函数，**不能**在里面引用 apply 的闭包变量。
              memoryTool: resolveToolDefs(config.memoryDir, getRuntime().toolDefsLive,
                'memory', getRuntime().toolName ?? config.toolName).name,
              todoTool: resolveToolDefs(config.memoryDir, getRuntime().toolDefsLive,
                'dtodo', getRuntime().todoToolName ?? config.todoToolName).name,
            },
          ),
        }))
      } catch (error) {
        // 幂等保护（issue #23）：DSH 0.1.x 的 loader 曾把插件在无 scope 标签的
        // ctx 上装配两次，system-prompt 的 global 层同名重复插入会抛
        // "already registered"（该层本就该只有一份注册，DSH 报错文案也提示应走
        // per-agent 注册）。命中重复时跳过并告警，避免整个 apply 失败连带
        // 快照注入失效 + /memory-evolve/api/* 404；其余异常照抛。
        if (error instanceof Error && error.message.includes('already registered')) {
          console.warn(`[memory-evolve] ${name} 已注册，跳过重复注册（issue #23 幂等保护）`)
          return
        }
        throw error
      }
    }
    // 全局模式决定"主通道"：section = 直接进系统提示词，context = 运行时快照。
    const globalSection = snapshotRuntime.injectMode === 'section'
    const mainChannel = globalSection ? 'section' : 'context'
    registerOn(mainChannel, 'memory:snapshot', order)
    // 分组级补充通道（2026-10-15）：全局是 context 时，个别记忆/待办分组可以
    // 单独要求走系统提示词段 —— 那就再注册一个 section 段，它只渲染这些分组。
    // **全局 section 时不需要补充**：全局开关覆盖所有分组设置（用户拍板）。
    if (!globalSection) {
      const wantsSection = (list) => list.some((group) => group.enabled === true
        && group.inject === true && group.injectMode === 'section')
      let groups = { groups: [] }
      try {
        groups = loadGroups(config.memoryDir)
      } catch { /* 配置读不动就不注册补充段（主段照常工作） */ }
      if (wantsSection(listGroups(groups, 'memory')) || wantsSection(listGroups(groups, 'todo'))) {
        registerOn('section', 'memory:snapshot-groups', order + 1)
      }
    }
    disposeSnapshotInject = () => {
      for (const dispose of disposers) dispose()
    }
  }
  const snapshotCtrl = { sync: installSnapshotInject }
  ctx.effect(() => {
    installSnapshotInject()
    return () => {
      disposeSnapshotInject?.()
      disposeSnapshotInject = null
    }
  }, 'dsh-memory-evolve: memory snapshot')

  // 2. memory 工具与 memory_search 的注册受「工具定义联动」控制（toolDefsLive）：
  //    开启后 tools.json 的改名/停用才作用于模型侧工具面；关闭时保持出厂名、始终注册。
  let toolDefsDispose = null
  const syncToolDefs = () => {
    const live = getRuntime().toolDefsLive === true
    const memoryDef = resolveToolDefs(config.memoryDir, live, 'memory', getRuntime().toolName ?? config.toolName)
    const searchDef = resolveToolDefs(config.memoryDir, live, 'memory_search',
      getRuntime().searchMemoryToolName ?? config.searchMemoryToolName)
    // 撞名先挡住：DSH 注册表对重名直接抛，抛在"已销旧、未挂新"中途会留下半套工具面。
    if (memoryDef.enabled && searchDef.enabled && memoryDef.name === searchDef.name) {
      throw new Error(`工具名冲突：「${memoryDef.name}」同时用于 memory 与 memory_search`)
    }
    if (toolDefsDispose !== null) {
      toolDefsDispose()
      toolDefsDispose = null
    }
    const registered = []
    const disposeRegistered = () => {
      for (const dispose of registered.splice(0)) {
        try { dispose() } catch { /* 已注销 */ }
      }
    }
    // 先挂可追加的 disposer 再注册：中途抛错也能销干净，不会卡到"必须重启插件"。
    toolDefsDispose = disposeRegistered
    try {
      if (memoryDef.enabled) {
        registered.push(ctx.tools.register(memoryTool(
          ctx, { ...config, toolName: memoryDef.name }, store, queue, getRuntime, archive, writeGap, writesBlocked,
        )))
      }
      if (searchDef.enabled) {
        registered.push(ctx.tools.register(memorySearchTool({
          name: searchDef.name,
          memoryDir: config.memoryDir,
          store,
          getGroups: () => loadGroups(config.memoryDir),
          t: (key, params) => translate(MISC2_DICT, key, params, getLocale()),
        })))
      }
    } catch (error) {
      disposeRegistered()
      toolDefsDispose = null
      // 回滚：用**出厂名**重建，保证工具面不空（用户填了非法/撞名的新名字时）。
      try {
        const fallbackMemory = ctx.tools.register(memoryTool(
          ctx, { ...config, toolName: config.toolName }, store, queue, getRuntime, archive, writeGap, writesBlocked,
        ))
        const fallbackSearch = ctx.tools.register(memorySearchTool({
          name: config.searchMemoryToolName,
          memoryDir: config.memoryDir,
          store,
          getGroups: () => loadGroups(config.memoryDir),
          t: (key, params) => translate(MISC2_DICT, key, params, getLocale()),
        }))
        toolDefsDispose = () => {
          try { fallbackSearch() } finally { fallbackMemory() }
        }
      } catch { /* 回滚也失败：宁可空着，也不留半套 */ }
      throw error
    }
  }
  ctx.effect(() => {
    syncToolDefs()
    return () => { toolDefsDispose?.() }
  }, 'dsh-memory-evolve: memory tools')

  // 2a4. 记忆库管理工具 memory_library（2026-10-15 B3/F-5 用户需求）：把**库级**
  //      操作开放给 agent —— 摸结构 / 扫全库标题 / 取文件路径 / 读一条 /
  //      新建 / 改写 / 批量删除 / 批量归档 / 移回 / 查重。单条 CRUD 仍走 memory、
  //      检索仍走 memory_search（工具描述里写明了"已知路径就用 read 更快"）。
  //      受运行时开关 `memoryLibraryEnabled` 控制，**默认关**（可选工具默认关是
  //      本仓库惯例）；开关在 execute 里现读，所以开关即时生效、不需重载插件。
  ctx.effect(() => ctx.tools.register(libraryToolDefinition({
    config,
    getRuntime,
    // 布局门禁（v3）：迁移未完成时库级写操作一律拒绝。
    writesBlocked,
    t: (key, params) => translate(LIBRARY_DICT, key, params, getLocale()),
    projectDirOf: makeProjectDirResolver(config),
    listGroups: () => listGroups(loadGroups(config.memoryDir), 'memory'),
    dirOf: (group, groupCtx) => groupDirOf(group, groupCtx),
    archiveDirOf: (group, groupCtx) => groupArchiveDirOf(group, groupCtx),
    titlesOf: (group, agent) => {
      try {
        return store.rowsOf(group.id, agent).map((row) => row.entry)
      } catch {
        // 分组目录不存在 / 定位不到（例如缺 cwd 的项目类）：当作空，别拖垮整次调用
        return []
      }
    },
    readEntry: (group, match, agent) => {
      const peeked = store.peek(group.id, match, agent)
      if (!peeked.ok) return null
      return {
        group: group.id,
        title: peeked.entry?.title ?? null,
        path: peeked.entry?.file ?? null,
        body: peeked.entry?.body ?? '',
      }
    },
    createEntry: (group, input, agent) => addOne(group.id, input.body, undefined, { agent }, input.summary, {
      title: input.title,
      keywords: input.keywords,
      scenario: input.scenario,
    }),
    updateEntry: (group, match, body, agent) => {
      const peeked = store.peek(group.id, match, agent)
      if (!peeked.ok) return null
      return store.updateEntryContent(group.id, peeked.entry, body, agent)
    },
    deleteEntry: (group, match, agent) => {
      const peeked = store.peek(group.id, match, agent)
      if (!peeked.ok) return null
      return store.remove(group.id, match, agent)
    },
    archiveEntry: (group, match, agent) => {
      const peeked = store.peek(group.id, match, agent)
      if (!peeked.ok) return null
      // 先写归档再删主轨：归档写失败绝不删主轨（宁可重复不可丢失），
      // 与 /api/memory/archive 同一套顺序与理由。
      const appended = archive.append(group.id, peeked.entry, agent?.session?.header?.cwd, agent?.session?.id)
      if (!appended.ok) return appended
      const removed = store.remove(group.id, match, agent)
      if (!removed.ok) return { ok: false, message: removed.message }
      return { ok: true, message: `已归档（现有 ${appended.total} 条）` }
    },
    promoteEntry: (group, match, agent) => promoteArchived(
      store, todoStore, archive, group.id, match, agent?.session?.header?.cwd, agent?.session?.id,
    ),
    normalizeTitle: (title) => String(title).toLowerCase().replace(/\s+/g, ''),
  })), 'dsh-memory-evolve: memory library tool')

  // 2a3. 自建工具（2026-10-15 用户需求：「工具可自由增删，新建的工具绑定内置
  //      动作」）。tool-registry 的数据层（`<memoryDir>/tools.json` 的 `custom[]`）
  //      在这里变成真正注册给模型的工具：名字/描述来自配置，行为由
  //      lib/custom-tools.js 按 `action.kind` 分发到内置实现（自建工具不新增
  //      任何行为，只换个名字/描述/固定分组）。
  //      **生效时机 = 插件重载**：新增/删除自建工具后要重载本插件，工具面才会
  //      变（不做进程内热更）。已注册工具每次调用都现读分组配置，用户改分组
  //      无需重启。清理函数把本 effect 内注册的全部自建工具一起注销。
  ctx.effect(() => {
    const tools = buildCustomTools({
      config,
      memoryDir: config.memoryDir,
      store,
      archive,
      queue,
      todoStore,
      getGroups: () => loadGroups(config.memoryDir),
      getRuntime,
      // 布局门禁（v3）：自建工具的写入动作同样受阻。
      writesBlocked,
    })
    const disposers = tools.map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'dsh-memory-evolve: custom tools')

  // 2b. 技能管理工具（skill_manage）已按用户要求**下线**（2026-10-16）：
  //     不再注册——没有技能管理这个功能，模型不该看到它。

  // 2c. The todo capability（todoEnabled 运行时开关）：控制器只负责工具注册；
  // 存储刻意留在控制器外——禁用完全可逆，不触碰既有待办数据文件，也不
  // 影响独立的同步轨；重新启用即刻恢复。
  const todoCtrl = createTodoController(ctx, config, getRuntime, todoStore, writesBlocked)

  // 3. In-turn review (opt-in): the live runtime value is the sole authority
  // for both the snapshot instructions and the paired tool surface.
  reviewCtrl.sync()

  // 3b. 模型配置模块（de_models 工具 + 「模型设置」Tab 数据面）：**独立
  //     子模块**，与其他模块同款独立开关 modelsEnabled（默认关）。开启时
  //     注册 de_models 工具 + 提供 /api/models 数据；关闭时工具注销、
  //     API 返回"未启用"（配置数据 models.json 保留）。开关在「设置」Tab
  //     的「配置」里切换（applyRuntimePatch sync 链即时生效）。
  let modelsDispose = null
  let modelsStore = null
  const modelsCtrl = {
    sync() {
      const enabled = runtime.modelsEnabled === true
      if (enabled && modelsDispose === null) {
        const installed = installModels(ctx, config)
        modelsDispose = installed.dispose
        modelsStore = installed.store
      } else if (!enabled && modelsDispose !== null) {
        modelsDispose()
        modelsDispose = null
        modelsStore = null
      }
    },
  }
  modelsCtrl.sync()

  /**
   * 能力表（`GET /api/features` 的唯一数据源）：每个布尔 = **该模块此刻是否
   * 真的装上了**（控制器/dispose 引用存在），与各模块 `xxxCtrl.sync()` 的安装
   * 条件同源，因此不会出现"features 说 true 但路由 404"。
   *
   * 没有装配引用的两项（`memoryLibrary` / `skillReview`）是纯行为开关
   * （工具常注册、execute 里现读），只能取运行时值——已在行尾注明。
   * 函数声明提升：下面的请求期调用远晚于这些 `let` 的初始化。
   * @returns {Record<string, boolean>} 能力表。
   */
  function installedFeatures() {
    return {
      uiSettings: uiSettingsDispose !== null,
      bookmarks: bookmarkDispose !== null,
      canvas: canvasDispose !== null,
      coi: coiDispose !== null,
      broadcast: broadcastDispose !== null,
      broadcastImage: broadcastDispose !== null && runtime.broadcastImageEnabled === true,
      prompts: promptsDispose !== null,
      notify: notifyDispose !== null,
      channelSend: channelSendDispose !== null,
      advisor: advisorRef?.ctrl !== null && advisorRef?.ctrl !== undefined,
      advisorPanel: advisorRef?.ctrl?.configSnapshot?.()?.advisorPanelEnabled === true,
      sync: syncDispose !== null,
      session: sessionDispose !== null,
      models: modelsStore !== null,
      todo: todoCtrl.enabled() === true,
      review: reviewToolsDispose !== null,
      sessionSearch: sessionSearchDispose !== null,
      searchDocs: searchDocsCtrl.status().enabled === true,
      memoryLibrary: runtime.memoryLibraryEnabled === true, // 无装配引用（工具常驻，execute 现读）
      skillReview: runtime.skillReviewEnabled === true, // 无装配引用（纯行为开关）
    }
  }

  // 4. Web API: the settings panel's data surface (web-only service; the
  //    plugin still loads on surfaces without httpServer).
  ctx.inject(['webServer'], (webCtx) => {
    // 版本检测与更新模块（lib/update.js，一期）：模块级单例——runningTag
    // 只在进程首次创建时探测；注入回调重跑（热装配/fiber 重放）复用同一
    // 实例，不会误清更新后的"等待重启"提示（CodeX 复审 P0-4）。
    // restartRequired 为派生语义（runningTag !== localTag），无需 init
    // 清除步骤。状态文件回退目录用 memoryDir。
    const updateOps = getUpdateChecker({ fallbackDir: config.memoryDir })
    // 启动后台静默检测（稳定版复审 P0-10）：badge 数据源是只读缓存，
    // 若用户从不打开版本页，检测永不触发、红点永不出现（卖点自锁）——
    // 插件启动时在后台跑一次 status()（fire-and-forget，不阻塞启动）。
    // status 自带 24h 成功 TTL + 30min 失败退避 + single-flight，多设备/
    // 多实例不会反复打远端；结果落缓存，设置 Tab 红点与版本页自动就位。
    void updateOps.status().catch(() => { /* 静默：检测失败不打扰启动 */ })
    const resolveReveal = (target) => resolveRevealTarget(config, target)
    // Open a path with the platform's reveal command; WSL/Linux falls back
    // from xdg-open to wslview so a missing xdg-utils does not silently
    // swallow the click. Rejects with a user-visible message when nothing
    // is available. Linux/WSL: xdg-open → wslview → explorer.exe (WSL ships
    // explorer.exe + wslpath even where wslu's wslview cannot be installed).
    const revealPath = (path) => new Promise((resolve, reject) => {
      const commands = process.platform === 'darwin' ? ['open']
        : process.platform === 'win32' ? ['explorer']
          : ['xdg-open', 'wslview', 'explorer.exe']
      const tryNext = (index) => {
        if (index >= commands.length) {
          reject(new Error('没有可用的打开命令（Linux/WSL 请安装 xdg-utils，或使用 Windows 自带的 explorer.exe）'))
          return
        }
        const command = commands[index]
        // 三个平台都定位到**所在文件夹**（用户要求："打开文件"应为"打开文件夹"）：
        //   - macOS `open -R`：在访达里选中该文件（-R = reveal，不加则打开文件本身）
        //   - Windows `explorer <file>`：打开所在文件夹并选中
        //   - Linux xdg-open 没有统一的 reveal 语义，仍传路径本身（打开所在目录）
        // explorer.exe 取 Windows 路径，其余取原路径。
        const args = command === 'open' && process.platform === 'darwin' ? ['-R', path]
          : command === 'explorer.exe' ? [toWindowsPath(path)]
            : [path]
        const child = spawn(command, args, { stdio: 'ignore' })
        child.on('error', () => tryNext(index + 1))
        child.on('spawn', () => resolve())
      }
      tryNext(0)
    })
    webCtx.effect(() => installApi(webCtx, {
      store, archive, queue, todoStore, getRuntime, updateRuntime: applyRuntimePatch, resolveRevealTarget: resolveReveal, revealPath,
      // 能力表（本轮降噪）：控制器引用存在性，供 GET /api/features
      features: installedFeatures,
      // 布局状态与写入门禁（v3）：API 侧据此提示「需要迁移 v3」并拒绝写操作。
      layoutStatus: layoutStatusNow,
      writesBlocked,
      // 工具定义联动：保存/恢复工具定义后重注册（改名/停用立刻生效）。
      syncToolDefs: () => {
        syncToolDefs()
        reviewCtrl.resync()
        todoCtrl.resync()
      },
      config,
      // 共享别名存储实例（aliases.json 单实例：api 路由与 de_session rename
      // 共用同一内存缓存，避免多实例互覆写；api.js 缺省自建）
      aliases: aliasStore,
      resolveCwd: (sessionId) => ctx.get('agents')?.get?.(sessionId)?.session?.header?.cwd,
      // 记忆同步状态（/memory-evolve/memory-sync/status）：syncEnabled 时由
      // syncCtrl 提供，否则恒未启用
      syncStatus: (cwd) => (syncStatusRef ? syncStatusRef(cwd) : { enabled: false, initialized: false }),
      // 记忆同步 UI 操作（/memory_sync 命令组的 API 化：setup/sync/off/
      // resolve/conflicts/migrate——记忆同步 Tab 用）
      syncOps: syncOpsRef ?? {
        setup: async () => ({ kind: 'error', text: translate(MISC_DICT, 'misc.syncNotReady', undefined, getLocale()) }),
        sync: async () => ({ kind: 'error', text: translate(MISC_DICT, 'misc.syncNotReady', undefined, getLocale()) }),
        off: () => ({ kind: 'error', text: translate(MISC_DICT, 'misc.syncNotReady', undefined, getLocale()) }),
        resolve: async () => ({ kind: 'error', text: translate(MISC_DICT, 'misc.syncNotReady', undefined, getLocale()) }),
        conflicts: () => [],
        migrate: () => null,
      },
      // 模型配置模块：store（models.json 读写）+ 快照聚合（供应商/模型/
      // 思考等级/备注/enabled 一站式返回给「模型设置」Tab 与外部查询）；
      // 模块未启用（modelsEnabled=false）时 store 为 null，API 拒绝访问。
      modelsStore,
      buildModelsSnapshot: () => buildModelsSnapshotAsync(ctx, modelsStore),
      // 版本检测与更新（/api/update/status、/api/update、badge.update 字段）
      updateOps,
      // 工具定义（2026-10-15 用户需求：工具定义可修改）：配置页「工具」页
      // 需要知道每个内置工具的当前名 / 描述 / 参数说明，才能让用户改。
      // 工具定义块目录（含默认文案与当前覆盖）——配置页的块编辑区用（2026-10-17）。
      listToolBlocks: () => toolBlockCatalog(config, getRuntime),
      listBuiltinTools: () => [
        {
          id: 'memory',
          name: getRuntime().toolName ?? config.toolName,
          // description = 「通用定义」的**出厂默认**（配置页描述框编辑这一层，listToolCatalog 再套覆盖）；
          // merged = 当前真正注册给模型的完整定义（通用定义 + 分组段 + 各启用块），只读展示。
          description: mt('memory.desc'),
          merged: memoryComposed(config, getRuntime),
          params: [
            { key: 'action', description: translate(MEMORY_DICT, 'param.action', undefined, getLocale()) },
            { key: 'target', description: translate(MEMORY_DICT, 'param.target', undefined, getLocale()) },
            { key: 'content', description: translate(MEMORY_DICT, 'param.content', undefined, getLocale()) },
            { key: 'summary', description: translate(MEMORY_DICT, 'param.summary', undefined, getLocale()) },
            { key: 'title', description: translate(MEMORY_DICT, 'param.title', undefined, getLocale()) },
            { key: 'keywords', description: translate(MEMORY_DICT, 'param.keywords', undefined, getLocale()) },
            { key: 'scenario', description: translate(MEMORY_DICT, 'param.scenario', undefined, getLocale()) },
            { key: 'filter', description: translate(MEMORY_DICT, 'param.filter', undefined, getLocale()) },
          ],
        },
        {
          id: 'memory_search',
          name: getRuntime().searchMemoryToolName ?? config.searchMemoryToolName,
          description: translate(MISC2_DICT, 'searchTool.desc', undefined, getLocale()),
          // 检索工具的描述目前是单段（未接分块合成），merged 与通用定义一致（含覆盖）。
          merged: toolDescriptionOf(loadToolsConfig(config.memoryDir), 'memory_search',
            translate(MISC2_DICT, 'searchTool.desc', undefined, getLocale())),
          params: [{ key: 'query', description: translate(MISC2_DICT, 'searchTool.query', undefined, getLocale()) }],
        },
        {
          id: 'memory_suggest',
          name: getRuntime().suggestToolName ?? config.suggestToolName,
          // 出厂描述必须与注册侧同源（review.js 的 REVIEW_DICT suggest.desc）：
          // 若这里留空，配置页判据会恒等成立 → 该工具永远置空不了。
          description: translate(REVIEW_DICT, 'suggest.desc', undefined, getLocale()),
          merged: toolDescriptionOf(loadToolsConfig(config.memoryDir), 'memory_suggest',
            translate(REVIEW_DICT, 'suggest.desc', undefined, getLocale())),
          params: [],
        },
        {
          id: 'dtodo',
          name: getRuntime().todoToolName ?? config.todoToolName,
          description: translate(TODO_DICT, 'todo.desc', undefined, getLocale()),
          merged: todoComposed(config, getRuntime),
          params: [],
        },
      ],
    }), 'dsh-memory-evolve: web api')
  })

  // 6. Commands: the review command works even with review off (users may
  //    want to inspect/clean leftover suggestions). Registered when the
  //    commands service exists.
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register(reviewCommand(config, store, todoStore, archive, queue, writesBlocked))
    cmdCtx.commands.register(searchDocsCommand(config, {
      status: () => searchDocsCtrl.status(),
      setEnabled: (enabled) => applyRuntimePatch({ searchDocsEnabled: enabled }),
    }))
  })

  // 7.4 通知模块（de_notify + web 站内通知）：2026-08-13 用户拍板把「渠道通知」
  //     与「web 通知」合并为**通知模块**——notifyEnabled 一个开关同时启用两者：
  //     de_notify 工具（手动触发，channels 含 feishu/qq/weixin/wecom/web/all）
  //     + web 站内通知（落盘存储 + 网页右上角铃铛）。sendChannelNotify ref 供
  //     COI 调度模块（coiNotifyChannels 自动通知）松耦合桥接——未启用时 ref
  //     为 null，COI 侧静默跳过。webStore ref 供直发模块复用（发 web 落盘）。
  let notifyDispose = null
  let notifySendRef = null
  let notifyWebStoreRef = null
  let channelSendDispose = null
  let channelSendWebStoreRef = null

  // 7.4.1 渠道直发（de_channel_send）：**独立子模块**（与通知模块同一家族但
  //     语义独立——直发 vs 通知，开关粒度独立）。channelSendEnabled 独立开关
  //     （默认**开**，用户拍板要的功能开箱即用）：开启时注册 de_channel_send
  //     工具（channels 同样含 web——直发也能发到网页站内）。与 notifyEnabled
  //     互不影响，但发 web 依赖通知模块的 webStore（notify 未开时 webStore 为
  //     null，发 web 如实报「渠道未启用」）。
  //     ⚠️ channelSendCtrl 定义在 notifyCtrl 之前：notifyCtrl.sync 会重装直发
  //     （web 存储就绪/释放时），引用 channelSendCtrl 必须已初始化（防 TDZ）。
  const channelSendCtrl = {
    sync() {
      const enabled = runtime.channelSendEnabled === true
      if (enabled) {
        // webStore 引用变化时重装：execute 闭包捕获了旧 webStore（发 web 的
        // 落盘目标变了），须 dispose 后重装刷新绑定。
        if (channelSendDispose === null || channelSendWebStoreRef !== notifyWebStoreRef) {
          if (channelSendDispose !== null) channelSendDispose()
          channelSendDispose = installChannelSend(ctx, { webStore: notifyWebStoreRef }).dispose
          channelSendWebStoreRef = notifyWebStoreRef
        }
      } else if (channelSendDispose !== null) {
        channelSendDispose()
        channelSendDispose = null
        channelSendWebStoreRef = null
      }
    },
  }

  // 通知发送方显示名解析（web 铃铛列表用）：别名优先 → 会话名称（sessionTitle
  // 服务实时取，用户可见的左侧列表标题）→ 短 ID 兜底。sessionId 空 = 系统自动。
  // ⚠️ 2026-08-14 防御加固：sessionTitle.get(session) 读 session.events，
  // 传 undefined 会崩（可选链不保护参数）——先判 agent?.session 存在。
  const resolveNotifySenderName = (sessionId) => {
    if (!sessionId) return 'system'
    const alias = aliasStore?.get?.(sessionId)
    if (alias) return alias
    const agent = ctx.get('agents')?.get?.(sessionId)
    const title = agent?.session ? (ctx.sessionTitle?.get?.(agent.session)?.title ?? null) : null
    if (title) return title
    return String(sessionId).slice(0, 8)
  }

  const notifyCtrl = {
    sync() {
      const enabled = runtime.notifyEnabled === true
      if (enabled && notifyDispose === null) {
        const installed = installNotify(ctx, { memoryDir: config.memoryDir, resolveSenderName: resolveNotifySenderName })
        notifyDispose = installed.dispose
        notifySendRef = installed.sendChannelNotify
        notifyWebStoreRef = installed.webStore
        // web 存储就绪：若直发已启用，重装它拿到 webStore（发 web 才能落盘）。
        channelSendCtrl.sync()
      } else if (!enabled && notifyDispose !== null) {
        notifyDispose()
        notifyDispose = null
        notifySendRef = null
        notifyWebStoreRef = null
        // web 存储释放：若直发仍启用，重装它失去 webStore（发 web 报未启用）。
        channelSendCtrl.sync()
      }
    },
  }
  notifyCtrl.sync()
  channelSendCtrl.sync()

  // 7.4.2 本会话图片查询（de_session_images）：**独立子模块**（2026-08-11 P1
  //     任务——与渠道发送同一家族但语义独立：列出当前会话最近的图片引用，
  //     AI 先查再发；独立开关 sessionImageQueryEnabled（默认关），不借
  //     channelSendEnabled/notifyEnabled 的开关——2026-08-08 用户纪律）。
  //     依赖 DSH 260810+ 快照的 attachments 服务与 agents 服务（agents 已
  //     声明式注入）；260809 及更早进程查询会如实报错（attachments 缺失）。
  let sessionImageDispose = null
  const sessionImageCtrl = {
    sync() {
      const enabled = runtime.sessionImageQueryEnabled === true
      if (enabled && sessionImageDispose === null) {
        sessionImageDispose = installSessionImages(ctx).dispose
      } else if (!enabled && sessionImageDispose !== null) {
        sessionImageDispose()
        sessionImageDispose = null
      }
    },
  }
  sessionImageCtrl.sync()

  // 6.5 内置技能同步（issue #58）：适配器使用指南的源头在插件包 `skills/`，
  //     启动时同步到技能库（`~/.agents/skills`）——默认启用、技能管理 Tab 可
  //     禁用、随插件升级更新（x-version 门控，用户编辑受保护）。
  //     **只受 coiSyncSkills 控制，与 coiEnabled 无关**：此前这个调用点在
  //     `installCoi()` 内，而 `installCoi` 由 coiEnabled 门控（默认 false），
  //     于是默认配置下内置技能永远不会进技能库——与 §7.5 broadcast 当初
  //     "独立子模块挂在 COI 下拆不开"是同款事故。
  //     同步失败不阻断启动（syncBuiltinSkillsIfEnabled 内部收口并 warn）。
  syncBuiltinSkillsIfEnabled(config)

  // 7. COI 调度模块（de_coi 工具/命令/API）：统一调度 kimi/codex/grok/hermes
  //    等 CLI 代理。模块边界：lib/coi/* 独立目录，只通过 memoryStore.add
  //    这一个薄接口沉淀摘要；未来拆独立插件时替换该回调即可。
  //    coiEnabled 为运行时开关（默认禁用）：开启时安装（工具/命令/API 注册、
  //    任务数据目录复用），关闭时整体卸载；Web Tab 在刷新后随 API 探测出现/隐藏。
  let coiDispose = null
  const coiCtrl = {
    sync() {
      const enabled = runtime.coiEnabled === true
      if (enabled && coiDispose === null) {
        const installed = installCoi(ctx, config, {
          memoryStore: store,
          resolveCwd: (sessionId) => ctx.get('agents')?.get?.(sessionId)?.session?.header?.cwd,
          // 记忆上下文注入（读 memory/user/key；tracks 由 AI 经 injectTracks
          // 自主选择）。excludeDshOnly=true：跳过带 [dsh-only] 标记的条目——
          // 外部执行器不是 DSH，不必遵循 DSH 纪律/规则，注入只会让其困惑
          memoryContext: ({ cwd, branch, tracks }) => buildMemoryContext(store, { cwd, branch, tracks, excludeDshOnly: true }),
          // 渠道通知回调（coiNotifyChannels 自动通知）：notify 模块未启用时
          // ref 为 null → 可选链返回 undefined，COI 侧静默跳过
          sendChannelNotify: (opts) => notifySendRef?.(opts),
        })
        coiDispose = installed.dispose
      } else if (!enabled && coiDispose !== null) {
        coiDispose()
        coiDispose = null
      }
    },
  }
  coiCtrl.sync()

  // 7.5 会话广播（de_broadcast）：**独立子模块**（用户拍板：明显独立的
  //     子模块不挂在别的模块下，曾跟随 coiEnabled 是事故）。broadcastEnabled
  //     独立开关（默认关）：开启时安装（de_broadcast 工具注册 + prune
  //     定时器 + 快照「会话广播」段 + 会话头部复制会话 ID 按钮），关闭时
  //     整体卸载；存储独立目录 broadcastDataDir（<memoryDir>/broadcast）。
  //     storeRef 供会话编排模块（de_session spawn 加房间）松耦合桥接——
  //     广播未启用时返回 undefined，编排模块只提示不阻断。
  //     7.55 工作区冲突协调（ws-coord）是**广播模块的子功能组**（用户拍板
  //     2026-08-09：语义上属于"通知的一部分"，归入广播，不做独立模块）：
  //     wsCoordEnabled 子开关（默认关），**依赖广播大开关**（广播关 =
  //     wsCoord 全部不注册）；开启时安装锁存储 + de_ws_* 工具 + 事件监听
  //     （fs/observed 自动登记 / pre-execute 冲突检测 / post-execute 软模式
  //     警告 / turn-stopping 释放），存储独立子目录 <broadcastDataDir>/ws-coord/，
  //     代码独立装配单元（installWsCoord）——防 08-08「广播挂 COI 拆不开」
  //     事故重演，将来若要拆出成本低。
  let broadcastDispose = null
  let broadcastStoreRef = null
  let wsCoordDispose = null
  const wsCoordCtrl = {
    sync() {
      // 子开关依赖广播大开关：broadcastEnabled 关 = wsCoord 不注册
      const enabled = runtime.wsCoordEnabled === true && broadcastDispose !== null
      if (enabled && wsCoordDispose === null) {
        const installed = installWsCoord(ctx, config, { broadcastStore: broadcastStoreRef })
        wsCoordDispose = installed.dispose
      } else if (!enabled && wsCoordDispose !== null) {
        wsCoordDispose()
        wsCoordDispose = null
      }
    },
  }
  const broadcastCtrl = {
    sync() {
      const enabled = runtime.broadcastEnabled === true
      if (enabled && broadcastDispose === null) {
        const installed = installBroadcast(ctx, config)
        broadcastDispose = installed.dispose
        broadcastStoreRef = installed.store
        // 广播装好后同步 wsCoord（wsCoordEnabled 已开时随广播一起装）
        wsCoordCtrl.sync()
      } else if (!enabled && broadcastDispose !== null) {
        // 广播卸载时 wsCoord 一并卸载（先子后父，依赖顺序）
        if (wsCoordDispose !== null) {
          wsCoordDispose()
          wsCoordDispose = null
        }
        broadcastDispose()
        broadcastDispose = null
        broadcastStoreRef = null
      }
    },
  }
  broadcastCtrl.sync()

  // 7.55 会话编排（de_session）：**独立子模块**（与广播同一纪律——独立
  //      领域不挂别的模块下）。sessionEnabled 独立开关（默认关）：开启时
  //      注册 de_session 工具（spawn 新建会话 / wake 唤醒已有会话 /
  //      status/list 查状态），关闭时整体卸载（并清理本模块 spawn 出的
  //      live agent，用户自己的会话不受影响）；存储独立目录
  //      sessionDataDir（<memoryDir>/session-orch）。依赖 DSH agents 服务，
  //      仅同进程会话可唤醒；spawn 加房间经 getBroadcastStore 桥接广播。
  let sessionDispose = null
  const sessionCtrl = {
    sync() {
      const enabled = runtime.sessionEnabled === true
      if (enabled && sessionDispose === null) {
        const installed = installSession(ctx, config, {
          getBroadcastStore: () => broadcastStoreRef,
          // 共享别名存储（与 /api/aliases 同一实例，rename 改别名即时一致）
          aliasStore,
        })
        sessionDispose = installed.dispose
      } else if (!enabled && sessionDispose !== null) {
        sessionDispose()
        sessionDispose = null
      }
    },
  }
  sessionCtrl.sync()

  // 7.6 会话搜索（de_session_search）：**独立子模块**（与广播同一纪律）。
  //     sessionSearchEnabled 独立开关（默认关）：开启时注册 de_session_search
  //     工具（实时只读扫描 Codex 会话，无索引/缓存/定时器），关闭时注销。
  //     存储零依赖——不建目录不落盘，root 覆盖走静态 config.sessionSearchRoots。
  let sessionSearchDispose = null
  const sessionSearchCtrl = {
    sync() {
      const enabled = runtime.sessionSearchEnabled === true
      if (enabled && sessionSearchDispose === null) {
        const installed = installSessionSearch(ctx, config)
        sessionSearchDispose = installed.dispose
      } else if (!enabled && sessionSearchDispose !== null) {
        sessionSearchDispose()
        sessionSearchDispose = null
      }
    },
  }
  sessionSearchCtrl.sync()

  // 8. 提示词管理器（Prompt Manager）：提示词库 CRUD + 注入轨（一次性/持续
  //    N 轮/每 M 回合一次，agent/turn-stopping 回合推进）+ 快照段 + Web API。
  //    复用「写后即时注入、不打断回复」通道；未来监测注入只对接注入轨 add
  //    入口。promptsEnabled 为运行时开关（默认禁用）：开启时安装，关闭时
  //    整体卸载（快照段/事件监听/API 全部移除，存储数据保留）。
  let promptsDispose = null
  const promptsCtrl = {
    sync() {
      const enabled = runtime.promptsEnabled === true
      if (enabled && promptsDispose === null) {
        const installed = installPrompts(ctx, config)
        promptsDispose = installed.dispose
      } else if (!enabled && promptsDispose !== null) {
        promptsDispose()
        promptsDispose = null
      }
    },
  }
  promptsCtrl.sync()

  // 9. DSH UI 设置（dsh-ui-settings）：**独立子模块**（用户拍板纪律——
  //    独立领域不挂别的模块下）。对 DSH web 界面做样式级小功能（第一版：
  //    左侧会话列表「仅显示进行中」筛选 + 折叠工作区运行徽标）。纯客户端
  //    实现（CSS + DOM 增强，注入逻辑在 src/client/session-filter.ts），
  //    宿主端提供独立开关 uiSettingsEnabled（默认关）、状态探测端点
  //    GET /api/ui-settings/state（关闭时 404，客户端探测失败即不注入任何
  //    东西）与**运行中会话快照** GET /api/ui-settings/running（折叠的
  //    工作区分组不渲染会话行、DOM 计数会漏，由宿主端精确统计——
  //    agents.roots 的 status + workspace.sessionIds 归属）。开关在
  //    「设置」Tab 的「配置」里切换（applyRuntimePatch sync 链即时安装/卸载）。
  //
  // 运行中会话快照构建：遍历所有顶层 live agent（roots，即用户可见的
  // 会话），status==='running' 的按 workspace.sessionIds 归属到工作区，
  // 归属不到的合并为未分组（title=null）。groups 保持 workspace.list()
  // 顺序，客户端按行标题前缀匹配（workspace title 全局唯一）。
  //
  // ⚠️ 踩坑（2026-08-09 用户实测 bug）：workspace.list() 返回的包装对象
  // 是 { host, id, record:{...} } 结构——title/sessionIds 经**原型 getter**
  // 暴露（可读），但**没有 workspaceId getter**（真实 id 在 .id）。
  // 之前用 owner.workspaceId 做 Map key 全是 undefined → 所有组 get(undefined)
  // 命中同一个计数 → 每个工作区都显示相同的运行数。修复：**用 workspace
  // 对象引用本身做 Map key**（不依赖任何字段名），归属与取数天然一一对应。
  const buildRunningSnapshot = () => {
    const agentsSvc = ctx.get('agents')
    const workspaceSvc = ctx.get('workspaceRegistry')
    const roots = agentsSvc?.roots?.() ?? []
    const workspaces = workspaceSvc?.list?.() ?? []
    // 按 workspace 对象引用统计 running 数（sessionIds getter 精确归属）。
    const runningByWorkspace = new Map()
    let ungrouped = 0
    for (const agent of roots) {
      if (agent.status !== 'running') continue
      const sessionId = agent.session?.id
      const owner = sessionId === undefined ? undefined
        : workspaces.find((w) => (w.sessionIds ?? []).includes(sessionId))
      if (owner === undefined) ungrouped += 1
      else runningByWorkspace.set(owner, (runningByWorkspace.get(owner) ?? 0) + 1)
    }
    const groups = []
    for (const w of workspaces) {
      const running = runningByWorkspace.get(w) ?? 0
      groups.push({ title: w.title, workspaceId: w.id ?? null, running })
    }
    if (ungrouped > 0) groups.push({ title: null, workspaceId: null, running: ungrouped })
    const total = groups.reduce((sum, g) => sum + g.running, 0)
    return { total, groups }
  }
  let uiSettingsDispose = null
  const uiSettingsCtrl = {
    sync() {
      const enabled = runtime.uiSettingsEnabled === true
      if (enabled && uiSettingsDispose === null) {
        const installed = installUiSettings(ctx, { getRunningSnapshot: buildRunningSnapshot })
        // Mermaid 静态端点（/memory-evolve/mermaid/mermaid.min.js）跟随
        // DSH UI 设置模块的生命周期：模块关闭时端点一并卸载（client 的
        // 「Mermaid 图表渲染」功能开关在其「综合」列表里，模块关了功能
        // 自然没有入口）。独立文件独立函数（lib/mermaid.js），不借开关。
        const installedMermaid = installMermaid(ctx)
        uiSettingsDispose = () => {
          installed.dispose()
          installedMermaid.dispose()
        }
      } else if (!enabled && uiSettingsDispose !== null) {
        uiSettingsDispose()
        uiSettingsDispose = null
      }
    },
  }
  uiSettingsCtrl.sync()

  // 10. 会话书签（session bookmarks）：**独立子模块**（用户拍板纪律——
  //     独立领域不挂别的模块下）。每轮星标 + 书签列表 + 跳转（第一阶段
  //     不做分支）。纯 UI + 宿主 API（不注册 AI 工具）；存储独立 sidecar
  //     session-bookmarks.json。bookmarkEnabled 独立开关（默认关）：开启
  //     时安装 HTTP API，关闭时整体卸载（数据文件保留）；客户端探测
  //     /api/bookmarks/state 成功才注入 turnTail 星标与「书签」Tab。
  //     开关在「设置」Tab 的「配置」里切换（applyRuntimePatch sync 链
  //     即时安装/卸载）。
  let bookmarkDispose = null
  const bookmarkCtrl = {
    sync() {
      const enabled = runtime.bookmarkEnabled === true
      if (enabled && bookmarkDispose === null) {
        const installed = installBookmarks(ctx, config)
        bookmarkDispose = installed.dispose
      } else if (!enabled && bookmarkDispose !== null) {
        bookmarkDispose()
        bookmarkDispose = null
      }
    },
  }
  bookmarkCtrl.sync()

  // 11. 无限画板（canvas）：**独立子模块**（用户拍板纪律）。canvasEnabled
  //     独立开关（默认关）：开启时安装（de_canvas 工具 + HTTP API +
  //     <memoryDir>/canvas/ 存储），关闭时整体卸载（数据文件保留）。
  //     resolveCwd 复用主插件 agents 服务（与会话编排同款），供工具与
  //     API 解析会话归属键。开关在「设置」Tab 的「配置」里切换。
  let canvasDispose = null
  const canvasCtrl = {
    sync() {
      const enabled = runtime.canvasEnabled === true
      if (enabled && canvasDispose === null) {
        const installed = installCanvas(
          ctx,
          config,
          (sessionId) => ctx.get('agents')?.get?.(sessionId)?.session?.header?.cwd,
          // 会话显示名解析（2026-08-14 用户要求：归属徽标显示会话名称
          // 而非一长段 sessionId）：别名优先 → sessionTitle 服务实时取
          // （左侧列表标题）→ null（前端兜底短 ID）。与 advisor/notify
          // 同款模式。
          // ⚠️ 2026-08-14 修复：sessionTitle.get(session) 直接读
          // session.events，传 undefined 会崩（可选链不保护参数）——
          // 画板 GET 遍历**所有节点**的 sessionId，必然遇到不在本进程的
          // 会话（离线/已归档），曾导致整个 GET 500、前端刷新后空板
          // （用户反馈"冲突后刷新画板是空的"的真根因）。必须先判
          // agent?.session 存在再取标题；查不到会话名返回 null 让前端
          // 兜底短 ID，绝不让单个节点拖垮整板加载。
          (sessionId) => {
            if (!sessionId) return null
            const agent = ctx.get('agents')?.get?.(sessionId)
            const alias = aliasStore?.get?.(sessionId) ?? null
            if (alias) return alias
            const session = agent?.session
            if (!session) return null
            return ctx.sessionTitle?.get?.(session)?.title ?? null
          },
        )
        canvasDispose = installed.dispose
      } else if (!enabled && canvasDispose !== null) {
        canvasDispose()
        canvasDispose = null
      }
    },
  }
  canvasCtrl.sync()

  // 7.9 项目记忆跨设备同步：**独立子模块**（施工图 §7 第 6 步；独立领域
  //     独立开关纪律——syncEnabled 默认关）。2026-08-13 用户拍板：记忆同步
  //     完全由用户在 Web GUI（记忆同步 Tab）主动操作——**无 AI 侧入口**
  //     （/memory_sync 命令组与快照状态行均已删除），仅保留 GUI 侧
  //     syncOps/syncStatus（Tab 与 API 用）。关闭时整体卸载（记忆目录/仓库
  //     全保留）。store 的 entryIdMode 随开关动态切换（仅项目轨受影响，
  //     未启用零变化）。
  const syncCtrl = {
    sync() {
      // 布局门禁（v3）：状态不是 v3 时不装配同步（迁移期间同步只会往错误位置搬数据）。
      if (layoutStatusNow().state !== 'v3') {
        store.entryIdMode = 'off'
        if (syncDispose === null) {
          console.warn('[memory-evolve] 布局未迁移到 v3，同步已停用（避免写入错误位置；迁移完成后重启插件即恢复）')
        }
        return
      }
      const enabled = runtime.syncEnabled === true
      store.entryIdMode = enabled ? 'on' : 'off'
      if (syncDispose === null) {
        const installed = installMemorySync(ctx, { config, getRuntime, applyRuntimePatch, store })
        syncDispose = installed.dispose
        syncStatusRef = installed.syncStatus
        syncOpsRef = installed.ops
      }
    },
  }
  syncCtrl.sync()

  // 8.9 Advisor 评审能力（lib/advisor/）：**独立子模块**（用户拍板：与广播/
  //     COI 同一纪律）。advisorEnabled 开关（默认关）：开启时安装（可见面
  //     观察器 + 评审运行时 + /advisor 命令 + HTTP API + 数据目录
  //     <memoryDir>/advisor），关闭时整体卸载（dispose 统一清理）；运行中
  //     键变化（provider/model/prompt/窗口/队列/超时）经 reconfigure 热
  //     更新（按签名重建运行时，仅窗口类键原地生效）。
  let advisorRef = null
  const advisorConfigOf = () => {
    // 合并静态 config 与运行时 advisor 键（installAdvisor 只消费 advisor* 键；
    // runtime 覆盖优先）
    const merged = { ...config }
    for (const key of RUNTIME_KEYS) {
      if (key.startsWith('advisor') && runtime[key] !== undefined) merged[key] = runtime[key]
    }
    return merged
  }
  const advisorCtrl = {
    sync() {
      // **B2（复审）：控制面常驻**——API/命令/面板状态始终可用（默认关闭
      // 时面板可开、/advisor on 可开）；开关只影响 observer/runtime 是否
      // 评审（installAdvisor 内部 effectiveEnabled + ensureRuntime 门禁）。
      // 不再按 advisorEnabled 卸载（旧实现默认关闭时 /status 404、无法开启）。
      if (advisorRef === null) {
        const installed = installAdvisor(ctx, advisorConfigOf(), {
          dataDir: config.advisorDataDir,
          sessionName: (sessionId) => {
            // MAJOR-3：别名优先（AliasStore）→ sessionTitle → null
            // ⚠️ 曾误写 aliasStoreRef（未定义变量）→ sessionName 闭包抛
            // ReferenceError → renderAndEmit 在 onDelta 前静默失败（评审
            // 从未开始）；正确变量为 apply 内的 aliasStore
            // ⚠️ 2026-08-14 防御加固：sessionTitle.get 传 undefined 会崩
            //（可选链不保护参数），先判 agent?.session 存在。
            const agent = ctx.get('agents')?.get?.(sessionId)
            const alias = aliasStore?.get?.(sessionId) ?? null
            if (alias) return alias
            const session = agent?.session
            if (!session) return null
            return ctx.sessionTitle?.get?.(session)?.title ?? null
          },
          // 测试环境 ctx.logger 可能是对象（非 cordis 函数式）——兼容两种形态
          logger: typeof ctx.logger === 'function' ? (ctx.logger('advisor') ?? console) : console,
          persistAdvisorPatch: (patch) => applyRuntimePatch(patch),
          validatePatch: validateRuntimePatch,
        })
        advisorRef = installed
      } else {
        // 运行中键变化：热更新（含开关翻转——reconfigure 停/启全部 runtime）
        advisorRef.ctrl?.reconfigure?.(advisorConfigOf())
      }
    },
  }
  advisorCtrl.sync()
}
