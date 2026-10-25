# CHANGELOG

## 2026-10-23 23:48 — advisor 约束页 ended 不再空白

refreshScopes 遇 ended 清空 scopes 只记 ended 不写错误；约束页显示「该会话已结束」。验证：`npm run build`

## 2026-10-23 23:27 — 降噪：advisor 读端点无效会话全改 200 ended

- /status、/instructions、/scopes 同 /events 回 ended 空态；写端点仍 400。验证：`node --test tests/advisor-events-ended.test.js`

## 2026-10-23 23:26 — 降噪：features 端点 + advisor 事件改 ended

- /api/features 取装配引用值并 no-store；advisor /events 无效会话回 200 ended。验证：`node --test tests/api-features.test.js`

## 2026-10-23 23:13 — 入口探测改读 /api/features 一次

7 处入口探测改读能力表（并发去重、失败重试一次）；改开关需刷新页面；advisor status/instructions 亦按 ended 停。验证：`npm run build`

## 2026-10-19 12:37 — 一次性提示统一改右下角 toast + 开局提示词保存不再整页重拉

### 现状（现役行为）
- `src/client/Toast.tsx`：模块级单例 + 纯 DOM（同 `ask-confirm.ts` 套路），自建 `#dsh-memory-evolve-toasts` 容器挂 `<body>`，无需挂载点。`toast(kind, text, closeTitle?)` 任意模块可调；`useToast(t)` 给组件用（自动带「×」的本地化标题 `toast.close`）。
- toast 存活策略：`ok` **3 秒自动消失**；`error`/`warn` **不自动消失**（必须点 ×）。容器 `max-height:60vh; overflow:hidden; justify-content:flex-end`（从下往上堆，超高超量时裁掉的是最旧的顶部，最新一条始终可见），最多同时 **5 条**（超出丢最旧）。
- toast 不挡点击：条目整体 `pointer-events:none`，只有「×」按钮 `pointer-events:auto`（点条目关闭已取消）；× 视觉 16×16，`.me-toast-close::before { inset:-4px }` 把热区扩到 24×24。容器 `pointer-events:none`、z-index 2147482000（低于 ask-confirm 覆盖层）。组件外调用不传 `closeTitle` 时默认「关闭提示」/「Dismiss」（按 `navigator.language`）。
- 页级加载失败不再只弹 toast：`src/client/InlineError.tsx`（`me-notice me-notice-error` + 「重试」）挂在 `SnapshotPromptPanel`、`MemoryQueueView`、`MemoryTabView`、`BookmarksView`、`SyncView`、`VersionTabView` 顶部；成功即清除。
- `AdvisorPanel`/`advisor-store`：连接恢复提示同文案 **10 秒内去重**（`lastToast` 字段）。
- 一次性结果提示已全部改 toast（11 个组件）：`SnapshotPromptPanel`、`GroupsPanel`、`MemoryQueueView`、`MemoryTabView`、`TodoView`（含 `flash()`）、`SyncView`（删 `Notice` 类型）、`VersionTabView`（删 `error` 状态）、`CoIView`（5 个 pane，模块内 `pushToast` + 本地字典 `toast.close`）、`BroadcastView`、`BookmarksView`（info 类映射为 ok）、`PromptView`（`showNotice`）、`AdvisorPanel`/`advisor-store`（store 内直接 `toast()`）。
- 保留页内条（都是常驻状态，不是一次性结果）：`GroupsPanel` 布局未迁移告警（由 `layout` 状态驱动）、`VersionTabView` 等待重启横幅（`restartRequired` 服务端派生）、`BroadcastView` 两个 `bb-error`（加载失败，成功前一直显示）、`ModelsTabView` `mt-notice-error`（加载失败）、`PromptView` `pm-banner-error`（可手动关闭的错误状态）、`AdvisorPanel` `ErrorNotice`（加载失败 + 重试）、`AliasButton` `.me-alias-notice`（按钮旁即时反馈，非页面顶部提示）。
- 随迁移删除的死 CSS：`.mt-notice-ok`、`.bb-notice*`、`.coi-notice*`、`.bm-notice*`、`.advisor-notice*`（`.me-notice*` / `.mt-notice*` 的基础类与 `.me-notice-error`/`-warn` 保留给常驻条与 `InlineError`）。
- i18n：新增 `panel.loadFailed`、`panel.retry`、`toast.close`；删除孤儿 `snapshotPrompt.loadFailed`、`syncTab.loadFailed`。
- `SnapshotPromptPanel`：`save()` / `saveSettings()` 成功后**不再 `load()` 整页重拉**（改为本地 `setData` 合并 `custom` / `injectMode` + `builtinGuidance`），消除保存后整页闪烁；保存中按钮仍显示「保存中…」并禁用，成功后弹 toast（`snapshotPrompt.saved` / `resetDone` / `modeSaved`）。

### agent 约定
- 新增「一次性结果反馈」一律 `useToast(t)`（组件内）或 `toast()`（组件外/非 React 模块），不要再往页面里塞提示条；页内条只留给"需要一直可见"的常驻状态/告警/加载失败。
- **页级加载失败必须用 `InlineError`（常驻错误 + 重试）**，不能只弹 toast（面板会空着、无重试入口）。
- toast 生命周期：新增类型只能用 `ok`/`error`/`warn`；要自动消失的只有 `ok`，别给 error 加计时器。
- toast 的 DOM 生命周期不归 React 管：不要把它塞进面板 `return`，也不要依赖组件卸载去清理。
- 自带本地字典（不走 slot `Translate`）的视图（`CoIView`/`PromptView`）要从自己的字典取 `toast.close` 当关闭标题。

## 2026-10-19 12:40 — 储备文案改版（复制到文案 + 无名保存 + 两栏）

### 现状（现役行为）
- 每份储备文案行只有一个 `me-btn-archive`「复制到文案」：把该份文本填进上方自定义文案编辑框，**不落盘、不发请求**；生效仍要点「保存」。
- 复制前确认：编辑框 `draft` 与已保存的 `data.custom` 不同（有未保存改动）时先弹「编辑框里有未保存的改动，用这份储备文案覆盖？」，取消则不动；无改动直接填。
- 空文本储备（`text.trim()===''`）的「复制到文案」禁用（title「这份储备是空的」），避免把编辑框清空。
- 新建入口在 `.sp-actions` 里、「恢复内置」左侧：「保存为储备文案」把编辑框现内容存成 `{ name: '', text: draft }`（空名直接存）；`draft.trim()===''` 时禁用；存后不清空编辑框。
- 没有起名输入框；行内名称框可编辑，空名 `placeholder` =「未命名」（删除确认文案同样回落该词）。
- 列表两栏（`.sp-presets-grid`，≤1100px 单列）；卡片头 `.sp-preset-head` 可换行（`flex-wrap`），名称框 `min-width` 48px；每张卡片文本框右下角 `.me-resize-handle` 复用 `useSyncedBoxHeights(120, 'dsh-memory-evolve:snapshot-presets-height')`，槽 `presets`：所有卡片联动、只可拖大、localStorage 记忆。
- 前端不再有任何启用/禁用语义：`togglePreset`、`activatePreset` 请求、`activePresetId` 均已从 `src/client/**` 移除。host 侧 `lib/api.js` 的 `activatePreset` 分支与 GET `activePresetId` 字段**保留**（兼容旧数据，UI 不暴露）。
- 相关 i18n（zh+en 成对）：`presetCopyToDraft`/`presetCopied`/`presetSaveAsPreset`/`presetUnnamed` 新增；`presetActivate`/`presetDisable`/`presetDisabled`/`presetActive`/`presetActivated`/`presetNameHint`/`presetAdd` 已删。

### agent 约定
- 储备文案交互不得再引入启用/禁用语义（不写 `activatePreset`、不读 `activePresetId` 做 UI 状态）。
- 新增储备文案持久化字段仍走 `lib/snapshot-presets.js`；空 `name` 是合法数据，前端展示一律回落 `presetUnnamed`。

## 2026-10-19 12:30 — 储备文案允许无名称（配合前端改版）

### 现状（现役行为）
- `lib/snapshot-presets.js`：`name` **可以为空串**（`upsertPreset` 不再返回 `NAME_REQUIRED`）；`normalizePresets` 不再丢弃空 name 条目（只丢弃非对象条目）；`text` 为空也允许；名字仍按 `PRESET_NAME_MAX`(60) 截断，文案仍 ≤ `PRESET_TEXT_MAX`(20000)。
- `savePresets` 的建目录改为 `systemDirOf(memoryDir)`（此前只 mkdir 记忆根，`.system/` 不存在时写盘会失败）。
- API `POST /api/snapshot-prompt { preset }`：不再有「储备文案需要名字」错误，仅保留 `TEXT_TOO_LONG` 与「不存在」。
- 文件位置不变：`<memoryDir>/.system/snapshot-presets.json`。

### agent 约定
- 空 name 条目是合法数据（前端"未命名"储备文案），任何读盘/归一化不得按 name 过滤。
- 测试：`tests/snapshot-presets-unnamed.test.js`（6 条）。

## 2026-10-19 12:12 — 同步布局门禁（v3）：strict / soft 双层 + 装配后回退守卫

### 现状（现役行为）
- 判据单源：`lib/sync/layout-gate.js`。`isLayoutV3(dir)` = `<dir>/.layout-version` 内容 === 3（迁移器最后一步写；worker 子进程不 import `lib/index.js`）。
- **strict**（`layoutBlockedReason` / `layoutGateError` / `layoutGateFailure`）：无标记即拒。**当前无调用方**（保留备用）。
- **soft**（`layoutBlockedReasonSoft` / `layoutGateErrorSoft` / `layoutGateFailureSoft`）：标记=3 放行；标记存在且 <3 拒；无标记但存在 `.system/migrate-v3.state`（迁移中）拒；**无标记且无迁移状态（v2 旧仓库/夹具）放行**。
- **装配后回退**（`layoutGateErrorIfRolledBack(assembledV3, dir)`）：装配时 v3、现在标记消失（`--rollback` 未重启 / 运行中手删 `.layout-version`）→ 拒，文案「记忆根已回退到旧布局，同步已停用：请重启插件并重新迁移」。`installMemorySync` 装配时算 `assembledV3 = isLayoutV3(config.memoryDir)`，`handleCommand` 从 `deps.assembledV3` 接收（ops 内部调用会传）。
- 调用点（全部只加"入口判断"）：
  - `lib/sync/index.js`：`:353` `assembledV3`；`:357` `layoutGate` 闭包（回退守卫 ?? soft）；9 个写 op 用它；`:661` `handleCommand` 入口（同样回退守卫 ?? soft；只拦 setup/sync/off/global 与 conflict resolve，status/migrate/conflict list 放行）。
  - `lib/sync/worker.js`：`:31` import；`runSync :58`、`resolveConflict :628`（soft）；`runStatus` 放行。
  - `lib/sync/repo.js`：`:55` import；`ensureMemoryRepo :638`、`deviceBConnect :871`、`ensureGlobalRepo :1130`（soft，守卫取 `p.memoryDir ?? p.dir`）。
  - `scripts/sync-worker.mjs`：退出码 2 = 布局门禁（与迁移 CLI 的 2 语义不同）。
- 文案 zh/en 由 `getLocale()` 选，内置在 `layout-gate.js`（未改 `lib/i18n.js`）。

### agent 约定
- 新增同步写入口必须接 `layoutGate`（ops/命令）或 `layoutGateFailureSoft(dir)`（worker/repo，返回 `{ok:false, code:2}`）；只读入口不要接。
- 门禁只读 `.layout-version` 与 `.system/migrate-v3.state`，不探测旧结构（旧结构探测在 `lib/index.js` 的 `layoutStatusOf`，那是装配层）。
- 测试：`tests/sync-gate-v3.test.js`（22 条）；`node --test tests/sync-gate-v3.test.js tests/sync-*.test.js` = 177 tests / 174 pass / 1 fail（`sync-e2e` 的断电残留锁用例并行抖动，单跑常绿）。

## 2026-10-19 05:38 — vault 版本标记归位 `.system/`（不再写回记忆根顶层）

### 现状（现役行为）
- `.vault-version` **写入**位置：`<memoryDir>/.system/.vault-version`（`vaultMarkerPathOf`）。**读取**先 `.system/`，没有再退回根下旧位置（`legacyVaultMarkerPathOf`，只读兼容 = 视为已迁移，不重复迁移）。
- `migrateToVault()` 走"已迁移"分支时会调 `normalizeVaultMarkerLocation(memoryDir)`：旧位置有、`.system/` 没有 → 搬进 `.system/`；两边都有 → 删旧位置那份。已迁移目录下次启动自愈。
- `rollbackVault()` 删标记时新旧两处都删。
- 真实目录已归一：`~/.dsh/memories` 根下现在只有 `.layout-version`/`.system`/`memory`/`todo`。

### agent 约定
- 记忆根顶层只允许 `.layout-version`、`.system/`、`memory/`、`todo/`（module-data 例外见规范 §1）。
- 任何"版本/标记文件"新代码一律 `join(systemDirOf(memoryDir), '<name>')`；旧位置只能读、禁止写。

## 2026-10-19 05:20 — 磁盘布局 v3 重构（目录结构 / 迁移器 / 分组页 UI）

### 目录结构（现役，权威规范 `docs/layout-v3.md`）
- 顶层：`.layout-version`（内容 `3`）、`.system/`、`memory/`、`todo/`。
- 分组 = `<memoryDir>/<kind根>/<id>/`：`global/`、`project/<项目id>/`、`session/<会话id>/`、`archive/<类段>/`。
- 日志型（`daily:true`）多一层日期：记忆 `global/<日期>/<标题>.md`；待办 `global/<日期>.md`（非日志待办是 `global/TODOS.md`）。
- 改名 = `renameSync` 一次；删除 = 删 `memory|todo/<id>` 整目录（含 archive）；记忆与待办**同 id 互不相干**。
- 项目元数据（`PROVENANCE`）在 `.system/projects/<项目id>/`；系统文件（groups/tools/plugin-state/snapshot-presets/SUGGESTIONS/advisor）在 `.system/`。
- 模块数据（`models.json`/`aliases.json`/`notifications/`/`session-bookmarks.json`/`pending-skills/`/`canvas/`/`search-docs-index.json`/`broadcast*`/`session-orch/`/`coi/`/`logs/`/`tasks.json`）**保持记忆根原位**（本次不迁）。

### 迁移（`scripts/migrate-v3.mjs`）
- 缺省 dry-run；`--apply` 先整目录备份到 `<记忆根>..bak-<yyyyMMdd-HHmmss>`；`--rollback <备份目录>` 把当前根改名 `..pre-rollback-<ts>` 留后路再拷回；`--allow-sync`（检测到 `syncEnabled=true` 时必须显式给，否则退出码 2）。
- 幂等 + 断点（`.system/migrate-v3.state` 的 `done[]`）、冲突不覆盖且源原地、module-data 跳过、未知顶层条目收 `.system/legacy/`、末尾写 `.layout-version`。
- 真实记忆目录 dry-run：**68 步**（建根 3 / 目录 43 / 文件 14 / legacy 3 / `.keep` 7），moduleData 0、无冲突。
- 步骤数 75 → 68 是修掉"同一源被搬迁与 legacy 双重认领"后的修正（少 7 条假条目），**不是漏搬**。

### 分组页 UI
- 日志型分组只显示「日志」徽标，**无任何切换控件**（创建时在新建行选一次，之后不可改，后端 `DAILY_FIXED`）。
- 自建分组 `#id` 可编辑：保存时先 `POST /api/groups/rename`，再用新 id 提交其余字段；失败原样显示后端 `error`。
- 删除：先 `GET /api/groups/delete-preview` 拿统计 → 确认框显示「N 条（分布 M 处）＋归档 K 条」→ `DELETE`；成功提示用**实际删除结果** `deleted`。
- 顶部显示记忆根 + `布局 v{3}`；`layout.writesBlocked` 时整页写入口禁用 + 只读提示。

### 已知缺口（后续立项）
- `lib/sync/filesets.js`、`lib/sync/repo.js` 的文件集白名单与 `.gitignore` 仍是旧布局；**v3 下项目级同步仓语义待重设计**。
- 项目身份变化（加 remote 换项目 id）后，`memory/<id>/project/<旧pid>` 不会跟随改名 → 那批项目记忆读不到（未删）。
- `coi/`、`session-orch/`、`broadcast*` 仍是记忆根顶层（module-data 例外，规范 §1 明文允许），迁移器跳过它们。
- `lib/sync/*` 内部**没有** `writesBlocked`：靠"运行期 `syncCtrl` 在 `state !== 'v3'` 时不装配同步" + "迁移 CLI 在 `syncEnabled=true` 时必须 `--allow-sync`"两层兜底；迁移与同步并行仍需人工避免。

### agent 约定
- 路径只从 `lib/groups.js` 的函数取；`join(memoryDir, 'xxx')` 视为缺陷。
- 新增写入口必须接 `writesBlocked()`；只读不用。
- 分组 id：`^[a-z0-9][a-z0-9_-]{0,31}$`，保留字 `archive/memory/todo/system`，同 kind 大小写不敏感唯一。

## 2026-10-19 05:08 — 磁盘布局 v3 上层适配（路径全走 groups.js + 布局门禁 + 分组改名/删除统计接口）

### 现状（现役行为）
- 所有记忆/待办/归档路径只由 `lib/groups.js` 产出：`groupDirOf` / `groupArchiveDirOf` / `todoFileOf` / `systemDirOf` / `stateFileOf` / `suggestionsFileOf` / `advisorDirOf` / `legacyDirOf` / `projectMetaDirOf`。别处**禁止**手拼 `global/ sessions/ projects/ todo/ archive/` 或 `.system`。
- `projectDirResolver` 的值是 `.system/projects/<项目id>` **元数据目录**，只允许取末段作 `projectId`（`projectIdOf({projectDir})`）；数据目录一律由路径函数算。ctx 只传 `{ memoryDir, projectId, sessionId, date }`。
- 系统文件：`plugin-state.json` / `SUGGESTIONS.jsonl` / `advisor/` / `tools.json` / `snapshot-presets.json` / `groups.json` 均在 `.system/`；`models.json` / `aliases.json` / `notifications/` / `session-bookmarks.json` / `pending-skills/` / `canvas/` / `broadcast*` / `session-orch/` / `coi/` 等模块数据**保持记忆根原位**（迁移器跳过）。
- 布局门禁：`lib/index.js` 的 `layoutStatusOf(memoryDir)` → `{state:'v3'|'needs-migration'|'unknown', version, migrating, needsMigration, writesBlocked, legacyEntries}`。`needs-migration` = 版本≠3 且探测到旧结构（`global/ sessions/ projects/ archive/ daily/ groups/`、`MEMORY.md/USER.md/KB.md/*-archive.md/TODOS-life.md/TODOS-work.md`、`todo/*.md`、`todo/<id>/*.md`）或有 `.system/migrate-v3.state`。**不自动迁移**。
- `apply()` 启动时：`state==='unknown'`（真空目录 / 只有 module-data）→ 直接写 `.layout-version` = `3`（`mkdir -p` + `writeFileSync`，失败只 warn）。这是除迁移 CLI 外**唯一**写标记的地方；不写的话全新用户永远停在 unknown、同步被门禁挡死。
- 写入门禁生效点：memory 工具（list/expand 之外）、dtodo 工具（list 之外）、`memory_library`（info/titles/path/read/dedupe 之外）、自建工具 dispatch（search/read/list、todo+list 之外）、HTTP 写接口（`/api/{groups,memory,archive,suggestions,todo,vault}` 与 `/memory-evolve/memory-sync/*` 非 GET → 409 `LAYOUT_NOT_V3`）、`memory_review` 命令（approve/archive/approve-all）。读操作全部放行。
- `syncCtrl` 在 `layoutStatus.state !== 'v3'` 时**不装配**同步（`store.entryIdMode='off'`，日志提示）。迁移完成后重启即恢复。
- 分组接口：`GET /api/groups`（含 `layoutVersion` 与每组 `layout:{dir,archiveDir,daily,klass,kind}`）、`POST /api/groups/rename {kind,id,newId}`、`GET /api/groups/delete-preview?kind=&id=`、`DELETE /api/groups?kind=&id=`（返回 `deleted:{entries,archived,locations}` 并删整目录）。
- 建组顺序（防脏状态）：隔离同名非空目录（改名 `<id>..orphan-<yyyyMMdd-HHmmss>`，响应带 `orphanDir`/`message`）→ 建 `{global,project,session,archive}` 骨架（各放 `.keep`）→ 最后 `saveGroups`；配置写失败则撤掉骨架并复原孤儿目录。
- 改名：`renameGroupId(memoryDir, kind, oldId, newId, loadGroups(memoryDir))`（第 5 参必须传，否则漏"配置有、目录没建"的同 kind 撞名）；配置写失败时**反向 rename 目录回旧 id**（错误文案给出回滚结果）。
- 删除：目录先改名进 `<id>..deleting-<时间戳>` 垃圾桶 → 写配置 → 失败则改回 → 成功才真删垃圾桶。
- `todo/past` 只扫 `<memoryDir>/todo/daily/global/<日期>.md`，不再兜底旧布局。

### agent 约定
- 新增任何路径，先在 `lib/groups.js` 加函数，再调用；直接 `join(memoryDir, 'xxx')` 视为缺陷。
- 新增写入口（工具/命令/API）必须接 `writesBlocked()`；只读入口不要接。
- 分组 id 规则：`^[a-z0-9][a-z0-9_-]{0,31}$`，保留字 `archive/memory/todo/system`，同 kind 内大小写不敏感唯一；`daily` 创建后不可改（`DAILY_FIXED`）。
- 内置分组更新接口**不重校验 id**（内置 id 本身是保留字）；只有新建与改名校验。

## 2026-10-19 04:25 — 分组页：开关按钮化 + 两栏 + 下拉框真正统一（撤销无效的"分组↔工具块联动"）

### 现状（现役行为）
- 分组页所有开关（全局开关区、行内 daily/enabled、新建行的 daily）都是**按钮 + 颜色反馈**（`.mt-view-btn` / `-active` + `aria-pressed`），页面里无 `checkbox`。
- `.me-list-groups` 两列（`repeat(2, minmax(0,1fr))`，≤1100px 一列）；`.me-group-row` 允许换行（两栏后列变窄，不换行会横向溢出）。
- 下拉框统一：`.me-select` / `.me-todo-select` / `.me-todo-date` 均 28px 高、`border-l3`、圆角 6px、字号 12px、`min-width: 96px`；`.me-group-row` 里的下拉框与按钮也统一到 28px。`.me-todo-filters select` 例外（体积更小，单独一条规则）。
- **没有**"分组 ↔ 工具分组块联动"开关：停用分组本来就会让该分组从工具描述的分组段与 `target` enum 中消失（走 `listEnabledGroups`），再加开关只会得到开关前后输出逐字相同的死代码。

### agent 约定
- 开关类 UI 一律按钮 + `aria-pressed` + `mt-view-btn-active`，禁止用 checkbox 承担开关语义。
- 给下拉框加样式时注意 `styles.css` 里 `.me-group-row .me-todo-select { height }`（特异性 0,2,0）会压过 0,1,0 的合并规则。

## 2026-10-19 04:10 — 分组页：开关改按钮、栏目两栏、下拉框统一、分组↔工具块联动开关

### 现状（现役行为）
- 分组页所有开关（全局开关区、行内 daily/enabled、新建行的 daily）都是**按钮 + 颜色反馈**（`.mt-view-btn` / `.mt-view-btn-active`），页面里已无 `checkbox`。
- `.me-list-groups` 是**两列**网格（`repeat(2, minmax(0,1fr))`，≤1100px 变一列）。
- 下拉框统一：`.me-select` / `.me-todo-select` / `.me-todo-date` 同为 28px 高、`border-l3`、圆角 6px、字号 12px、`min-width: 96px`。
- 新运行时开关 `groupBlocksSync`（**已在 04:25 撤销**：停用分组本来就从工具描述与 `target` enum 消失，开关前后输出逐字相同，属死代码）。

### agent 约定
- 改动描述覆盖的语义请对照 `normalizeHeadOverride`，不要按段落数/长度猜旧数据。
- 开关类 UI 一律按钮 + `aria-pressed` + `mt-view-btn-active`，禁止用 checkbox 承担开关语义。

## 2026-10-19 03:55 — 修核实员指出的三处（工具页 500 / dtodo 语义 / merged 覆盖）

### 现状（现役行为）
- `listBuiltinTools` 的 dtodo 项：`merged: todoComposed(config, getRuntime)` —— 那句必须传**函数**（内部 `getRuntime().toolBlocks`）。写成 `getRuntime()` 会让 `GET /api/tools` 直接 500、工具页打不开。
- dtodo 的注册描述（`lib/todo.js` 的 getter）改为**头段覆盖**语义：`composeDescription(..., normalizeHeadOverride(toolOverride(...).description, tt('todo.desc')))`，与 `todoComposed` 同一出口。
- `memory_search` / `memory_suggest` 的 `merged` 现在**含覆盖**（`toolDescriptionOf(...)`），「合并定义」能看到用户改动；它们的描述仍是单段（无分块合成）。
- 新增 `normalizeHeadOverride(raw, fullDefault)`（lib/tool-blocks.js）：`undefined` = 没覆盖、`''` = 显式置空、其它 = 头段文本。旧版"整段覆盖"用**精确比对**识别（覆盖值 === 不含头段覆盖的完整合成 → 视为没覆盖）；**任何其它情况都原样保留**，绝不按段落数/长度截断用户内容。最坏情况是"旧数据没被识别 → 内容重复一遍"，不会静默丢内容；应付手段是用「恢复默认」重置该工具后再改。
- 储备文案：禁用后主编辑框同步清空；启用前该行若有未保存改动会**先保存再启用**（不会出现"启用的是旧文本"）。

## 2026-10-19 03:40 — 工具描述框只编辑「通用定义」，另给「合并定义」查看

### 现状（现役行为）
- `tools.json` 的 description 覆盖**只替换头段（通用定义）**，不再整段替换：`composeDescription(blocks, tool, t, prefix, groupSections, texts, headOverride)`（lib/tool-blocks.js）；`memoryComposed` / `todoComposed` 从 `toolOverride(...).description` 取覆盖传进去。空串覆盖 = 头段消失、块照常。
- 配置页工具卡片里的描述框 = **通用定义**这一层：`listBuiltinTools` 的 `description` 传默认头段，`listToolCatalog` 再套覆盖。
- 每个工具另返回 `merged`（当前完整注册内容：通用定义 + 分组段 + 各启用块），前端「合并定义 / 收起定义」按钮展开在卡片下方（`.me-tool-merged`，只读）。

### agent 约定
- 描述覆盖的语义是"替换头段"，不是"替换整段"；要整段控制就关块。
- `memory_search` / `memory_suggest` **没有**分块合成（`merged` 与通用定义相同）；只有 memory / dtodo 是完整合成。

## 2026-10-19 03:40 — 储备文案：文本框 + 启用/禁用同一个按钮

### 现状（现役行为）
- 每份储备是一个块：名字 input + 文本框（`.me-item-edit.sp-preset-text`，固定 120px）+「启用/禁用」（**同一个按钮切换**）+「保存」+「删除」。
- 启用 = 把该份**已保存**文案写进 `snapshotPrompt`；禁用 = 清空 `snapshotPrompt`（回到内置文案）。
- 每份有本地草稿 `presetDrafts`：编辑名字/文本后点该行「保存」才落盘；`load()` 会重置草稿，`refreshPresets()` 不会。

## 2026-10-19 03:20 — 修占位符生效名的写法（原写法必然 ReferenceError）

### 现状（现役行为）
- `renderSnapshot()` 是**模块级**函数，拿不到 `apply()` 里的闭包（`getRuntime` 等）。要让 `{memoryTool}` / `{todoTool}` 用生效名，只能在调用处（`index.js` 的 systemPrompt text 回调）用 `resolveToolDefs` 解析后，经 `opts.memoryTool` / `opts.todoTool` 传进去；`renderSnapshot` 内只读 `opts`，缺失时回落 `config.toolName` / `config.todoToolName`。

### agent 约定
- **禁止**在 `renderSnapshot`（以及其它模块级导出函数）里引用 `apply()` 的闭包变量：那会在"用户设了自定义开局提示词"时每轮抛 `ReferenceError`，宿主 `SystemPrompt.assemble()` 无 try/catch → 整个会话进不了模型。
- 改这类函数前先自问：它是不是模块级？需要的运行时值必须由调用方经参数传入。

## 2026-10-19 03:10 — 修第二核实员指出的四条（重启回落 / 工具面消失 / 名字格式 / 占位符旧名）

### 现状（现役行为）
- `toolDefsLive` 已进 `RUNTIME_KEYS`：写盘后重启能读回（原先写盘但不读，开关静默回落 false）。
- `syncToolDefs()` 注册失败会**回滚**：注销本批后，用出厂名重建 memory 与 memory_search —— 用户填了非法/撞名的新名字时，工具面不会空掉（原先两个记忆工具一起消失）。
- 改名两道校验（`POST /api/tools`）：① 格式必须符合 `TOOL_ID_RE`（`a-z 0-9 . _ -`，≤40）；② 撞名比对其它工具**在联动开启时实际会用的名字**（`toolNameOf`，即 tools.json 覆盖优先于运行时名），命中即拒绝。`TOOL_ID_RE` 已从 tool-registry 导出。
- 注入占位符 `{memoryTool}` / `{todoTool}` 用**生效名**：`snapshotPromptVars(config, agent, ctx)` 支持 `ctx.memoryTool` / `ctx.todoTool`，调用处按 `resolveToolDefs` 解析。

## 2026-10-19 02:55 — 修核实员指出的三条（工具面可写坏 / 草稿被冲 / 删除无确认）

### 现状（现役行为）
- `syncToolDefs()`：**先挡撞名**（memory 与 memory_search 同名直接抛，且此时旧注册还在），**再挂一个可追加的 disposer 才开始注册**；注册中途抛错 → 注销本批、disposer 置空、错误上抛。不会停在"半套工具面、要重启插件"。
- `POST /api/tools` 改名时先查撞名（与其它内置工具**当前**名字比较，含覆盖），撞名直接拒绝。
- 开局面板的储备文案区：任何操作只刷新列表（`refreshPresets`），**不再整页 reload**，未保存的编辑框内容不会被冲掉；只有「启用」会让编辑框跟随该份文案；「删除」走 `askConfirm` 二次确认。
- `upsertPreset` 对超长文案改为**拒绝**（`TEXT_TOO_LONG`），与运行时 `snapshotPrompt` 的 20000 校验策略一致。

## 2026-10-19 02:40 — 开局提示词储备文案（多份文案，可切换启用）

### 现状（现役行为）
- 存储：`<memoryDir>/snapshot-presets.json`，`{ "version": 1, "items": [ { "id": "p3f2a1", "name": "…", "text": "…" } ] }`；模块 `lib/snapshot-presets.js`（load/save/upsert/remove/find，坏数据降级不抛）。
- 接口：`GET /api/snapshot-prompt` 额外返回 `presets` 与 `activePresetId`；`POST` 支持三种动作 —— `{ preset: { id?, name, text } }`（新建或按 id 更新）、`{ removePreset: id }`、`{ activatePreset: id }`（启用 = 把该份 text 写进运行时 `snapshotPrompt`）。
- UI：开局面板底部「储备文案」：名字输入 + 「存为储备」（存**当前编辑框内容**）；每行显示名字与「启用 / 删除」，启用中那份的按钮高亮且禁用。

### agent 约定
- **不要**给储备文案加 active 字段：生效与否由「`snapshotPrompt` 与 item.text 内容是否相同」判定（用户在编辑框直接改文本时启用态自然失效）。
- 名字必填（空名拒绝，`NAME_REQUIRED`）；名字 ≤60、文案 ≤20000（与运行时 `snapshotPrompt` 校验一致）。

## 2026-10-19 02:40 — 工具定义联动开关（改名/停用真正生效）

### 现状（现役行为）
- 新运行时配置 `toolDefsLive`，**默认 false**。开启后 `tools.json` 里的**改名 / 停用**才作用于注册（模型侧工具面）；关闭时忽略，保持出厂名并始终注册 —— 因为改工具面会让老会话的 KV 缓存失效。
- 解析统一走 `resolveToolDefs(memoryDir, live, id, fallbackName)`（lib/tool-registry.js），返回 `{ name, enabled }`。
- 四个工具全部接入：memory / memory_search（index.js 的 `syncToolDefs`）、dtodo（todo.js `createTodoController` 的 `defs()` 与 `resync()`）、memory_suggest（reviewCtrl 的 `ctx.effect` 内判断）。
- 触发重注册的时机：`toolDefsLive` 翻转（applyRuntimePatch）、保存工具定义、恢复默认（api.js 调 `deps.syncToolDefs`）。
- UI：工具页顶部「工具定义联动 已开启 / 已关闭」按钮（按钮 + 颜色反馈，不是勾选）。

### agent 约定
- 注册名与是否注册**只能**经 `resolveToolDefs` 解析，不要直接读 tools.json 拼名字。
- 任何影响工具面的改动都必须触发 `syncToolDefs()` + `reviewCtrl.resync()` + `todoCtrl.resync()`，否则就是"配置页改了、模型看不到"。
- 停用只影响注册，不动数据；`ctx.effect` 返回空 disposer 时表示"已停用、不要注册"。

## 2026-10-19 02:20 — 工具定义可置空（描述 / 参数说明允许显式空）

### 现状（现役行为）
- 工具描述与参数说明支持三态：**不覆盖**（字段缺省或 `null`）、**显式置空**（`""`）、有内容。工具名仍不允许为空（空串 = 恢复默认）。
- **出厂默认描述与生效描述是两个出口**（关键，别合并）：
  - `memoryComposed` / `todoComposed`（lib/index.js）= 只做分块合成、**不含覆盖**，供 `listBuiltinTools` 当 `defaultDescription` 用；
  - `memoryDescription`（lib/index.js）= memory 的**注册出口**（合成结果再套覆盖）；
  - `todoDescription` **已删除**：dtodo 的注册描述在 `lib/todo.js` 的 getter 里自己套覆盖，index.js 里不需要第二个出口（留着会让后来人按文档改错地方）。
  - 合并过一次就有 bug：`defaultDescription` 被污染 → 前端判据「等于默认就删覆盖」在第二次保存时误删用户覆盖。
- 四个可编辑描述的工具，注册侧**全部**接覆盖：memory（index.js:1562 getter）、dtodo（todo.js:779）、memory_search（memory-search.js:198）、memory_suggest（review.js:317）。
- 前端工具描述框去掉 placeholder：清空后框里就是空，不再显示灰字默认值。

### 已知缺口（不是 bug，是不可达或已接受）
- 参数说明（`params` 的覆盖）只进配置页显示，**注册侧未接** `paramDescriptionOf`；配置页目前没有参数说明的编辑 UI，所以用户改不到、影响不到模型。
- 自建工具的描述仍是 `textOrUndefined(...) ?? name`（空串会变成工具名）；自建工具没有描述编辑入口。
- **内置固定文案里的工具名不会跟随改名**：`i18n` 的 `snap.section` 段写死了「memory 工具、dtodo」。开联动改名后若仍在用**内置**文案，指导语里的名字还是旧的 → 模型可能按旧名调用。规避：改用自定义/储备文案（可用 `{memoryTool}` / `{todoTool}` 占位符，它们跟随生效名）。

### agent 约定
- 区分两个工具函数：`textOrUndefined`（**名字**等不能空的字段，空串 = 不覆盖）、`textOrEmpty`（**描述 / 参数说明**，空串 = 显式置空）。别混用。
- 想恢复默认：`patch` 里传 `null`（前端「恢复默认」按钮走 `/reset`）。
- 覆盖优先于分块合成：一旦用户写了描述覆盖，工具定义块的开关不再影响模型侧描述文本。
- 新增任何"可编辑工具描述"的工具，注册处必须套 `toolDescriptionOf(loadToolsConfig(memoryDir), <toolId>, 默认文案)`，否则配置页能改、模型侧不变。

## 2026-10-17 08:05 — 窄屏下块框改独立高度

### 现状（现役行为）
- 工具页块输入框的槽：宽屏两列 = `block:<tool>.row<floor(index/2)>`（同一行两个一起变）；**窄屏一列（≤900px）= `block:<tool>.<blockId>`（每块独立）**。断点与 styles.css 里 `.me-tool-blocks-grid` 的一致，由 `useNarrowLayout()` 判断。
- 代价：宽屏/窄屏之间同一块的高度记忆不互通（两套槽名）。

## 2026-10-17 07:50 — 工具页文本框高度：默认行数 + 分行同步 + 本地记忆

### 现状（现役行为）
- 高度统一由 `src/client/use-synced-box-height.ts` 的 `useSyncedBoxHeights(defaultInitial, storageKey)` 管：`heightOf(slot, initial?)` 取值、`startResize(slot, event, initial?)` 绑自绘手柄；**下限 = 该槽 initial（只能拖大）**；松手写 localStorage。
- 工具页（键 `dsh-memory-evolve:tools-heights`）：
  - 块输入框槽 = `block:<tool>.row<floor(index/2)>` —— 同一行的两个同步，其他行不动。（**窄屏例外：2026-10-17 08:05 起改为每块独立，见该条**）
  - 块框默认 54px = **2 行文字**（11px × 1.6 × 2 + 内边距 16 + 边框 2）。
  - 工具描述框槽 = `desc:<toolId>`，默认 153px = **7 行文字**（12px × 1.6 × 7 + 18），容器 `.me-desc-wrap`（position:relative + flex）。
- 开局提示词（键 `dsh-memory-evolve:snapshot-prompt-height`）：单槽 `all`，默认 180px，两栏同步。
- 六个注释类统一 `margin: 0; padding: 0`（工具页并删掉两处 inline marginTop）。

### agent 约定
- 同一个 storageKey 只能建**一个** hook 实例：写盘是整对象覆盖，两个实例共键会互相抹掉对方的槽。
- 槽之间下限不同，必须逐槽显式传：描述框传 `DESC_BOX_H`，漏传会退回 `defaultInitial`（默认行数失效）。
- 记忆高度上限 4000px，超限／非法值一律当坏数据丢弃。
- 注释不写自己的 margin/padding，间距交给父容器 gap。
- `.me-tool-block-text` **不要**加 min-height：会把默认的 2 行高度顶大。

## 2026-10-17 07:10 — 尺寸手柄：只准拖大 + 拖动中冻结滚动（修「拖小时整页往上跳」）

### 现状（现役行为）
- 两个面板的框尺寸联动都走 `src/client/use-synced-box-height.ts` 的 `useSyncedBoxHeight(初始高度)`：拖任一手柄，同类框一起变；**下限就是初始高度，只能拖大不能拖小**（工具页 180 / 开局页 380）。
- 拖动期间：`<html>` 挂 `me-resizing` 类（CSS 关滚动锚定、禁选中、光标竖向缩放）；每次 pointermove 后用 `requestAnimationFrame` 把滚动容器拉回拖动开始时的 scrollTop；松手再补一次恢复。
- 滑动容器由 `findScrollParent()` 从手柄往上找最近的「可滚动且当前真能滚」的祖先，兜底 window。DSH 外壳命中的是 `[data-conversation-scroll]`。
- 清理路径：`pointerup` / `pointercancel` / `window.blur` 三个监听都会摘类并注销。

### agent 约定
- 改尺寸的交互不要用浏览器原生 resize 手柄 + ResizeObserver 联动：原生拖拽与受控 `style.height` 抢同一个写入方（框会抖），且容器变矮会触发 scrollTop 钳制（整页跳）。一律 `resize: none` + 自绘手柄 `.me-resize-handle`。
- 高度下限钉成初始值（禁止拖小）：唯一能触发「滚动钳制跳页」的路径就是拖小。
- 回写 scrollTop 必须放在 `requestAnimationFrame` 里：`setState` 异步，同一帧读到的还是旧 `scrollHeight`。
- 手柄必须带 `touch-action: none`：触摸/触控笔下 pointerdown 后会立刻 pointercancel，拖动直接失效。
- 有意不做：拖动中允许滚轮滚动（本 hook 语义是拖动期间冻结滚动位置）。

## 2026-10-17 03:36 — 块单独保存 + 尺寸联动 + 注释字号统一 + 开局提示词两栏对齐

### 变更
- 工具页块输入框：**框里就是生效原文**（没写过覆盖即默认文案），不再是灰色占位符；`placeholder` 已去掉。
- 每块「保存」位于「恢复默认」左侧，只提交本块 `{ blocks:{key}, blockTexts:{key} }`（不带工具 id）。
- 「恢复默认」= 把框内容换回默认原文（**不落盘**），仍需点「保存」。
- 无覆盖判据：提交值 `trim()` 后等于 `defaultText` → 交空串，后端据此删除覆盖（`blockTextPayload()`）。
- 尺寸联动（拖右下角**自绘手柄**同步，不是写死高度、也不是原生斜拉条）：工具页所有块框共用一个高度、开局提示词两栏共用一个高度，二者都用新 hook `src/client/use-synced-box-height.ts` 的 `useSyncedBoxHeight()`。
- 开局提示词「恢复内置」= 把编辑框内容换成内置原文（不落盘）；保存时等于内置原文 → 交空串。
- `.sp-box` 加 `margin: 0`：`<pre>` 的默认外边距会把左栏整体下移，两栏看着不齐。
- 注释字号统一：`.me-hint` / `.me-help` / `.me-muted` / `.me-field-hint` / `.me-field-sub` / `.mt-muted` 一律 11px（此前 `.me-hint` 未定义，字号随继承漂移）。

### agent 约定
- 界面注释/说明文字只能从上述六个类里挑，不要自造类名、不要写裸 `<p>`。
- 块文案"有没有覆盖"看**是否与 `defaultText` 相同**，不是看空串。
- `POST /memory-evolve/api/tools` 无 `id` 时只改运行时块配置；`blocks`/`blockTexts` 都缺则 400。
- **可 resize 的框：不要用浏览器原生手柄 + ResizeObserver 联动**（会与受控 `style.height` 抢写入方 → 抖动；容器实时变高 → 滚动锚定顶页）。一律 `resize: none` + `.me-resize-handle` + `useSyncedBoxHeight()`。
- 由于 `.me-item-edit` 自带 `resize: vertical`，关掉原生手柄必须用两段式选择器（`.me-item-edit.sp-box` / `.me-item-edit.me-tool-block-text`），否则被特异性压回去。

## 2026-10-16 17:30 — 测试临时目录自动清理

### 问题
测试用 `mkdtempSync(join(tmpdir(), 'xxx-'))` 建临时目录，靠零散的 `rmSync` 手动删。断言失败提前抛出、或漏写删除时目录永久残留在 `%TEMP%`。累积 6335 个顶层条目后，Windows 登录时 `winlogon 通知订户 <Profiles>` 耗时升至 100+ 秒（欢迎界面卡死）。

### 新增
- `tests/_tmp.js`：临时目录登记 + 三层清理 + 启动清扫。
- `scripts/clean-tmp.mjs`：测试结束后的最终清扫。

### 修改
- 60 个 `tests/*.test.js`：`mkdtempSync(join(tmpdir(), 'xxx-'))` → `tmproot('xxx-')`，并 import `tmproot`。
- `package.json`：`test` 脚本追加 `node scripts/clean-tmp.mjs`。

### agent 约定
- 测试建临时目录一律用 `tmproot(前缀)`，**禁止**直接 `mkdtempSync(join(tmpdir(), ...))`。
- 需要提前释放用 `tmpremove(dir)`。
- **不要**在测试里写 `rmSync(dir)` 手工清理：`_tmp.js` 已覆盖（含断言失败路径）。多写反而在 Windows 上触发"删完又被异步写盘重建"。
- 清理脚本 `clean-tmp.mjs` 已挂进 `npm test`；单独跑测试（`node --test tests/xxx.test.js`）后用 `npm run test` 或手动执行该脚本兜底。
