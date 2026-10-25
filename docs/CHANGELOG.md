# 更新日志（Changelog）

本仓库所有版本变更记录，按日期倒序排列。

## 2026-10-15

### 新增

- **记忆存储改版：一条记忆 = 一个 md 文件（用户需求）**。此前一个分组 = 一个 `.md`、条目用 `\n§\n` 分隔、没有任何结构化字段；现在每条记忆独立成文件，**文件名为标题**，文件头用 YAML frontmatter 承载元数据：`id` / `title` / `summary` / `keywords` / `scenario` / `created` / `updated` / `group` / `class` / `seq`（另有 `git` / `project` / `branches` / `flags` / `archivedAt`）。文件名清洗规则：`\ / : * ? " < > |` 与控制字符换 `_`、超 60 字截断、尾部句读去掉、重名自动加 `-2`；改标题即改文件名，`id` 永不改变（跨设备合并与工具操作都锚在它上面）。
  - 新增模块 `lib/vault.js`（纯文件层：frontmatter 序列化/解析、标题→文件名、目录读写、全量同步），配套 `tests/vault.test.js`（23 例）。
  - 磁盘布局按「类」分目录：全局类 `<memoryDir>/global/<组id>/`、项目类 `<projectDir>/<组id>/`、会话类 `<memoryDir>/sessions/<会话id>/<组id>/`；**日志型**分组（会话日志 / 项目日志 / 今日日志）多一层日期目录 `2026-10-15/`。
  - 内存表示保持不变（仍是 `[id:…] [日期] 正文` 的标签化文本），因此 `add` / `replace` / `remove` / `query` 与全部上游调用方的契约零变化。
- **自动迁移 v1 → v2（用户拍板：后台自动迁 + 备份 + 可回滚）**。新增 `lib/migrate-v2.js`：插件加载 1.5 秒后后台执行，先把所有旧文件解析进内存（任何一个读不动就整体中止、磁盘一字不动），再把旧文件**整份复制**进 `<memoryDir>/backup-v1-<时间戳>/`（保持原相对路径），然后写新格式、删旧文件、落版本标记 `.vault-version`。可重入（目标已有同 `id` 的条目就跳过），可回滚（`POST /api/vault/rollback` 把备份搬回原位并清标记）。
- **三类模型：会话类 / 项目类 / 全局类（用户需求）**。分组新增 `klass` 字段（内置分组的类锁死，自建分组创建时必选）。内置分组改为：会话类 = 会话日志（`session`，日志型）/ 会话关键记忆（`sessionkey`）；项目类 = 项目日志（`project`，日志型）/ 项目关键记忆（`key`）；全局类 = 今日日志（`daily`，日志型）/ 全局关键记忆（`memory`）/ 用户档案（`user`）/ 记忆知识库（`kb`）。「日志」与「关键记忆」本质是同级的两个分组，只差出厂默认的「确认」「注入」两个开关。**所有内置记忆分组的 `inject` 出厂都是 `false`**（用户拍板：默认都不注入，要用再开）。
- **`memory_search` 工具（用户需求：模型可通过工具搜索元数据和摘要找到相关记忆）**。新增 `lib/memory-search.js`：跨三类加权检索（标题 10 / 关键词 8 / 摘要 5 / 使用场景 4 / 正文 1），`query` 用空格分词、**全部命中**才返回；结果给「标题 + 摘要 + 场景 + 命中片段 + 文件路径」。默认搜全部三类、**默认不搜归档**（`includeArchived: true` 才查）。同一套检索也开放给网页端：`GET /api/search`。
- **`memory` 工具新增元数据参数**：`title`（≤60 字，作文件名）、`keywords`（逗号分隔，如「编码, 高成熟度」）、`scenario`（使用场景）；`summary` 由「拼成 `[summary:…]` 文本标签」改为写进 frontmatter（文本视图仍在**显式摘要**时渲染该标签，渐进式披露行为不变）。
- **注入方式下沉到分组（用户需求）**：每个记忆 / 待办分组新增 `injectMode`（`inherit` 跟随全局 / `context` 运行时上下文快照 / `section` 系统提示词段）。**全局「注入」页选 `section` 时覆盖所有分组设置**（用户原话："选择开启全局全部使用系统提示词注入会覆盖此配置"）。实现上同一渲染函数注册两次（两个通道各一次），按 `opts.channel` 只输出属于该通道的段；公共段（会话 ID / 指南 / 收尾职责）跟随全局通道。
- **配置页拆成七个二级页（用户需求）**：「Memory Evolve 设置」重组为 **分组 / 工具 / 注入 / 界面 / 数据 / 功能 / 关于 + 指南**，其中「指南」**固定最后一位**；「开局提示词」从配置页移出（留在记忆页签，它属于记忆内容而非设置）。
  - 新增 `src/client/ConfigFields.tsx`（数据驱动的运行时开关面板，注入页与界面页复用）、`src/client/ToolsPanel.tsx`、`src/client/DataPanel.tsx`。
- **工具定义可修改（用户需求）**：新增 `lib/tool-registry.js` + `/memory-evolve/api/tools`。内置工具可**停用 / 改名 / 改描述**（工具级与参数级），改动存 `<memoryDir>/tools.json`；**自建工具**可新建，名字 + 描述 + 参数，执行绑定到内置动作（检索 / 读全文 / 写条目 / 列出 / 改写 / 删除 / 归档 / 还原 / 提升级别 / 待办 / 提交建议），不能凭空造行为。读盘失败一律回落内置定义（工具永不因配置坏掉而消失）。
- **停用分组的显示三态（用户需求）**：新增运行时配置 `showDisabled`，取值 `hidden`（**默认，不显示**）/ `dim`（灰显）/ `shown`（正常显示）——用户原话："默认不显示。不过灰显这个设置不错，选项改成显示/灰显/不显示"。
- 新增接口：`GET /api/classes`（三类分组树，带目录/条目数/归档数，供记忆页签与配置页直接渲染）、`GET /api/vault/status`、`POST /api/vault/migrate`（支持 `dryRun`）、`POST /api/vault/rollback`、`GET /api/search`、`GET|POST|DELETE /api/tools`。

### 变更

- **待办也套三类（用户需求）**：待办分组与记忆共用同一套「类 + 分组」模型。内置待办分组为 会话待办（`session`）/ 本项目待办（`project`）/ 全局待办（`global`）/ 每日待办（`daily`）；用户已弃用的 生活（`life`）与 工作（`work`）**出厂停用**（数据与配置覆盖都保留，随时可重新启用，不做破坏性删除）。待办仍是"一组一个文件"，只按类目录搬位置：全局 `<memoryDir>/todo/TODOS-<组id>.md`、项目 `<projectDir>/todo/`、会话 `<memoryDir>/sessions/<会话id>/todo/`，日志型再套一层日期目录。
- **「指南」页签顺序**：记忆 / 待办 / 技能 / 设置四个页签的「指南」全部从第一位挪到**最后一位**（用户需求）。
- `memory` 工具描述、`param.summary` 文案随新模型同步更新（摘要不再限 key 轨）。
- **记忆页签改三级结构（用户需求）**：一级 `待确认记忆建议 / 会话类 / 项目类 / 全局类 / 指南`（「指南」固定最后一位）；选中某个类后在其下出二级页签——该类每个分组一格 + 最后一格**归档**（`archive/<分组id>/`）；停用分组按运行时配置 `showDisabled` 三态显示（默认隐藏；页内三态按钮就地改该全局配置，与「设置 → 界面」同一项）。分组格显示该分组条目卡片（沿用美观/纯文本、搜索、分页、编辑/删除/归档），归档格按来源分组**只读**展示该类全部归档条目（新的归档目录模型下不提供「移回」，避免与正在改造的归档写入路径耦合）。
  - host `lib/memory-tab.js`：`buildMemoryFiles()` 改为返回 `{ files, classes }`——`files` 仍是扁平兼容行（内置八组 + 有归档条目时每个类一行 + `agents` 一行），`classes` 为三类树 `{klass, label, groups[], archive}`；分组项含 `klass / id / title / path`（**分组目录**，一条记忆一个 md）/ `count`（含日志型的一层日期子目录）/ `archivedPath` / `archivedCount` / `enabled` / `daily` / `builtin` / `stampKind`（`time`/`datetime`/`date`，渲染端据此剥时间戳）/ `content`（store 文本契约，展示前剥 `[id:…]` 与 `[summary:…]`）。第三参兼容旧签名（cwd 字符串）与 agent 对象（会话类分组需要 `session.id`）。
  - client `src/client/MemoryTabView.tsx`：三级页签 + 归档页；载荷兼容 `res.classes`、`res.files.classes`（api.js 未展开时的嵌套）与纯旧扁平行（现场合成单层树兜底）。
  - 词条：host `lib/i18n.js` 新增 `MEMORY_TAB_DICT`（`memoryTab.tab.archive` / `.archiveOf`）；client `src/client/index.ts` 新增 `memoryTab.klass.*` / `memoryTab.tab.archive` / `memoryTab.showDisabled.*` / `memoryTab.desc.session|sessionkey|archive` 等（zh/en 齐平）。

### 修复

- **`add` 重复检测失效**：`readRaw()` 返回的是渲染文本（带 `[id:…] [日期]` 前缀），而待写入的 `stamped` 不带 —— `entries.includes(stamped)` 永不命中，同一内容会被反复写成 `abc.md` 与 `abc-2.md`。改为两种模式都**剥离身份证后比较**。
- **`setEntryBranches(entry, [])` / `setEntryDshOnly(entry, false)` 报成功却无效**：`objectOf()` 在文本里没有标记时会从旧条目把它们"复活"。改为**文本是唯一真相**，并让 `replace` 自己把旧标记搬到新条目（否则改正文会静默丢掉分支范围）。
- **过往待办全部读不到**：`TodoStore.pastItemsOf()` 仍在扫旧的 `<memoryDir>/daily/*.todo.md`，而写入早已是 `<memoryDir>/todo/daily/<日期>.md` —— `past` 查询、过往条目的 done/update/remove、`GET /api/todo?past=1` 全废。已改读新布局并兼容旧文件兜底。
- **`allTargets()` 会把停用的分组带进遍历**：原先在硬编码兜底表上拼启用分组，`life`/`work` 虽停用仍被遍历；改为**以分组配置为唯一真相**，并新增 `defaultTarget()` 跳过需要 cwd/sessionId 的类（否则没有 cwd 时连普通待办都加不了）。
- **无 frontmatter 的手写分片每次读盘换身份**：`id` 改为**由文件名派生**，同一文件恒定，写入时被正常收编而不再被改名。
- **`memory_search` 整体不可用**：工具输出 schema 用了 `additionalProperties: false` 却漏声明 `results` 数组，DSH 严格校验下每次调用都报 invalid output。已补全声明。
- **宿主缺注入通道会让整个插件装配失败**：`installSnapshotInject` 硬访问 `systemPrompt.section`，一旦走到那条分支，工具与 API 全丢。改为缺通道就跳过该段并告警。
- `GET /api/memory-files` 现在**展开** `buildMemoryFiles()` 的 `{files, classes}`（顶层给 `files` 数组 + `classes` 三类树），并把 `sessionId` 作为 agent 一起传给宿主端——**会话类分组由此真正可用**（此前整类 `path=undefined`）。
- **画板文件代理的敏感路径黑名单在 Windows 上完全失效（安全）**：`CANVAS_PATH_DENY` 的片段是 `/` 形式（`/.ssh/`、`/.config/`、`/.git/` …），而 Windows 路径是 `C:\Users\x\.ssh\id_rsa` —— `includes()` 一个都匹配不上，**私钥/凭据可以被直接在浏览器里预览/打开**。新增 `deniedFragmentOf()`：匹配前把 `\` 归一化为 `/`，`resolveNodeFile`（代理）与 `openNodePath`（打开/打开所在文件夹）两个调用点共用同一判定。
  - 同时给 `/AppData/` 加**定点例外**：放行其下的临时目录（`AppData\Local\Temp\` 是进程间交换的临时文件与测试/构建产物，不放行则 Temp 里所有普通文件都被误拦、真实文件预览整条链路失效）。例外**只针对这一条**：`Temp\.ssh\id_rsa` 仍按 `/.ssh/` 拒绝。

### 测试适配（v2 收尾，03:40）

- 旧格式断言批量改为 v2：`pathOf` 返回**目录**、一条记忆一个 md、归档目录 `archive/<组id>/`、文本视图带 `[id:…]` 前缀、日期戳按轨（`[YYYY-MM-DD]` / `[YYYY-MM-DD HH:MM]` / `[HH:MM]`）、日志型多一层日期目录、出厂分组全部 `inject:false`（断言"内容进快照"前先写 `groups.json` 打开该分组）、`buildMemoryFiles()` 返回 `{files, classes}` 且归档行 key = `archive-<类>`、add 的 summary 截断上限 200 字。
- 改动：`tests/memory-kb-track.test.js`、`tests/progressive-disclosure.test.js`、`tests/store-display-match.test.js`（夹具整份重写：改走 `objectOf()` + `syncVault()` / `archive.append()`）、`tests/entries-batch-fault.test.js`（mock 目标 `store.add` → `store.addEntry`）、`tests/snapshot-prompt.test.js`、`tests/i18n.test.js`。`tests/store-summary.test.js` / `tests/injection-source-kind.test.js` / `tests/review-*.test.js` 无需改动。
- 这批文件现状：59 例 → 58 通过、1 skip（`key add 的 summary 经待确认队列后仍保留显式摘要`）。
- **待修 lib 缺口 A（摘要丢失）**：`key` 及一切 `confirm=true` 分组的 `add`，`summary` 参数进不了待确认队列 —— `lib/index.js:1274` 只传 `finalContent`；`lib/review.js:385 enqueueSuggestion()` 签名无 summary；`lib/review.js:476` 采纳时走 `store.add(target, content)`。后果：AI 显式摘要被兜底摘要顶替。
- **待修 lib 缺口 B（归档页展示文本对不上）**：`lib/memory-tab.js:146-158` 渲染 `[<created 完整时间>] body`，`:315` 再套 `[<分组标题>]\n`；而 `ArchiveStore.entriesOf` 用 `textOfEntry`（`[id:…] [YYYY-MM-DD] [summary:…] body`）。于是 `lib/store.js:2009`（`ArchiveStore.removeExact`）与 `lib/review.js:580`（`promoteArchived`）拿到展示文本一律不命中（"归档条目不存在"）。用**归档条目原文**操作正常。
- 次要：`resolveRevealTarget`（`lib/index.js:1104-1116`）仍是旧单文件路径表（`MEMORY.md` / `USER.md` / `KB.md` / `MEMORY-archive.md` / `USER-archive.md` / `daily/<日期>.md`），v2 下这些路径均不存在，全靠"回退到所在目录"兜住。
- 观察：无 frontmatter 的手写分片，文本视图为 `[id:<文件名派生>] [今天] [id:<原头部>] …`（原头部被当正文保留）；展示/匹配链路仍可用，仅显示冗余。

### 遗留失败清零（环境无关化，05:10）

- 全量 947 例：**894 通过 / 51 失败** → 50 例修绿、1 例平台性跳过。修法一律是让用例**不依赖运行机器的环境**，不改产品行为：
  - `tests/update.test.js`（39 例）：`git init` 跟随系统 `init.defaultBranch`（本机为 `master`），而用例按 `main` 建仓并推送 → `src refspec main does not match any`，随后整条更新事务链路全红。`sh()` 助手统一注入 `-c init.defaultBranch=main`。
  - `tests/canvas.test.js`（4 例）：敏感路径用例在 Windows 上不成立 —— 根因在产品代码（见上条安全修复），产品修完即绿。
  - `tests/search-docs.test.js`（3 例）：`/Volumes`、`mdfind` 是 macOS 专属，而 provider 可用性按**本机真实环境**探测（`platform` 参数只决定候选顺序）。改为平台条件断言：非 macOS 只断言恒成立部分（`walk` 兜底在最后、显式列表不混入未列项），macOS 上保留完整顺序断言。
  - `tests/ws-coord.test.js`（2 例）：断言写死 posix 路径 `/w/a.js`，而模块按 `cwd` 解析成本机绝对路径。期望值改用 `resolve('/w', 'a.js')`。
  - `tests/coi.test.js`（2 例）：正则里写死 `/` 分隔符，Windows 输出为 `\`。改用 `[\\/]`。
  - `tests/sync-utf8-stream.test.js`（1 例）：假 git 是「无扩展名 + shebang」的 POSIX 脚本，Windows 既执行不了无扩展名文件也不认 shebang（PATH 还用 `:` 拼接）。该用例自称仅冒烟、不守护回归，且逐字节分块解码已由同文件上一个 mock 用例跨平台覆盖 —— 改为 Windows 上显式 `skip`。
- **英文 CHANGELOG 撤除**：`docs/CHANGELOG.en.md` 与 `CHANGELOG.en.md.bak-datastyle-20261010-231601` 删除；`docs/CHANGELOG.md` 顶部 `[English]` 链接、`README.en.md` 的 Changelog 链接均改指中文版（本仓库只维护中文一版更新日志）。

- **会话类待办根本写不进去（用户实测报错：`无法定位待办分组 "session"`）**：装配层 `new TodoStore(...)` 只传了 3 个参数，**漏掉第 4 个「会话 id 提供者」**；而所有调用点（工具 / 网页接口 / 自建工具 / 归档还原 / 快照注入）也都不传会话 id，store 又是单例、拿不到"当前是哪一次调用"。改为**显式传 `sessionId`**：`TodoStore` 的 `fileOf` / `readText` / `itemsOf` / `write` / `addTodo` / `findById` / `updateTodo` / `doneTodo` / `removeTodo` / `listTodos` 全部加尾参，构造时注入的 `sessionIdOf` 降级为回退；工具 `dtodo`、`/api/todo`、`/api/archive/promote`、自建工具分发、`promoteArchived`、快照注入全部补传。
  - 顺带修掉 `/api/todo` 的 add **默认轨道仍写死 `life` / `work`**（二者已出厂停用，落进去等于写进死轨）：现在与工具同款走 `defaultTarget()`，未指定 target 时落到排在最前的可写分组（网页端与 AI 工具行为一致）。
- **`memory` 工具整体返回 invalid output（用户实测报错：`"value.entry" is not a declared property`）**：`store.addEntry()` 是库内部 API，返回里带 `entry`（新条目对象，`lib/custom-tools.js` 要取 `entry.id`），而 `outcomeOnly()` 只剥了 `entries` / `removed` / `matches` → `entry` 原样透给模型，DSH 严格校验直接判 invalid output，对模型表现为「kb 写入失败，重试 3 次都一样」。已把 `entry` 一并剥除（**只剥本工具的返回值**，不动 `store.addEntry` / `store.peek` 的返回，库内部消费者不受影响）。
- 新增 `tests/memory-tool-schema.test.js`：按 `output.schema` 递归校验 memory 工具**每个 action 的真实返回**（含错误分支）并断言内部字段不外泄 —— 已反向验证：把 `entry` 剥除改回去，它在 `add:project` 上精确复现上面那条报错。
- 新增 `tests/todo.test.js` 用例「会话类待办：显式传 sessionId 可写，且不同会话彼此隔离」（路径落在 `sessions/<id>/todo/`、跨会话读不到、不传 id 报可行动的错）。

### 界面与工具优化（用户需求，06:10）

**新增**

- **待办批量写入**：`dtodo` 的 `add` 支持 `items: [{ target?, content, quadrant?, due?, cat? }]` —— 一次调用写多条（每条可自带分组），按分组归组后**每组一次锁**写盘；顶层 `target` / `quadrant` / `due` / `cat` 作逐条缺省；空内容条目跳过并计入 `skipped`；返回 `ids`（顺序与 items 一致）。设计目标是**减少模型步数**（记忆侧的 `entries` 批量此前已有，未动）。
- **工具定义可恢复默认**：`lib/tool-registry.js` 新增 `resetToolsConfig(memoryDir, { scope })`（`'all'` / `'builtin'` / 具体工具名），清掉内置工具的停用 / 改名 / 改描述覆盖；`'all'` 还会删掉自建工具并返回其清单。新增 `POST /memory-evolve/api/tools/reset`，「工具」设置页加「恢复默认」按钮（二次确认）。

**变更**

- **分组设置免保存即时生效**：注入与否 / 写入需确认 / 自动通过 / 启用 / 按日期分文件 / 所属类，改动即提交（此前要逐行点「保存」）；名称与「伴随注入的提示词」这类**文本**字段仍保留显式保存（它们需要编辑过程）。
- **注入方式改二选**：分组级只给「普通注入」（运行时上下文快照）/「系统提示词注入」，按钮按**实际生效**的通道高亮（分组内部值仍是 `inherit` 时按全局解析，所见即所得）；全局「注入」页选系统提示词时覆盖全部分组。
- **「提示词」改名「伴随注入的提示词」**（中英词条）。
- **停用分组的显示改二态**：只保留「显示 / 隐藏」，去掉「灰显」——用户实测它与「显示」视觉上分不出来；显示时停用项**一律灰字**。历史值 `dim` 读取时归一为 `shown`（旧配置不失效），写入侧只接受 `shown` / `hidden`。两个按钮靠页签行最右端（用户要求「放右上角」）。
- **分组卡片改三列**（窗口不够宽时自动降 2 / 1 列）；一级与二级页签之间间距收窄。
- **「打开文件」改「打开文件夹」**：宿主 reveal 通道在 macOS 由 `open <file>` 改为 `open -R`（在访达中定位该文件），与 Windows `explorer <file>` 对齐 —— 三平台都定位到**所在文件夹**。
- 工具描述修正：`todo.target` 的说明从旧四轨（work / life）改为三类模型措辞；新增 `todo.items` 词条（zh / en 齐平）。

**删除**

- **技能管理功能整体下线（用户要求）**：移除记忆页签的「技能」子页、`src/client/SkillsTabView.tsx`、`src/client/skills-browser/`（SkillsBrowser / contract / styles）、宿主 `lib/skills-manager.js` 及其测试、相关 i18n 词条与全部注册点。
  - **保留未动**：`lib/skills.js` 及其 `skill_manage` 工具（技能库 create / patch / read / list）—— 它不属于被下线的「技能管理页签 / 浏览器」；是否一并删除待用户确认。
- 记忆页签「打开文件」成功后不再弹「已用系统工具打开」提示（失败仍正常报错）—— 系统文件管理器自己会把窗口带到前台。

**测试**：949 → 940 例（技能管理及其测试随功能下线），**937 通过 / 0 失败 / 3 跳过**；新增 `tests/tool-registry-reset.test.js`、`tests/todo.test.js` 的批量写入与会话待办用例。

**修复（用户实测，06:30）**

- **归档按钮在多数记忆分组里消失（只剩「编辑 / 删除」）**：三处都还硬编码着**分组化之前的三轨** `memory / user / key` —— ① 前端按钮白名单 `ARCHIVABLE_IDS`、② 宿主 `POST /api/memory/archive` 的 target 校验、③ 归档页数据源 `GET /api/archive`（只遍历那三轨）。于是 kb（记忆知识库）等分组的条目根本没有归档按钮，即使有也会在归档页看不到。三处统一放开到**任意记忆分组**（含用户自建分组）。
  - 顺带补 `sessionId` 透传：`ArchiveStore` 的 `dirOf` / `entriesOf` / `append` / `remove` / `removeExact` 与 `review.js` 的 `promoteArchived` 此前把会话 id 硬编码成 `null`，会话类分组的归档目录**根本定位不到**；现在缺会话 id 时给出明确报错而不是静默失败。
  - 新增回归测试（`tests/api.test.js`）：kb 归档 → 归档页列出 → 移回主轨全链路，外加真正无效 target 仍被拒。
- **切换二级页签时按钮与字体横移**：页签激活态样式带了 `font-weight: 600`，激活后同一段文字变宽 → 整排页签连同右侧的「停用：显示 / 隐藏」一起位移（用户实测"点击记忆知识库再到归档，按钮和字体好像会移位"）。改为**字重固定**（`.mt-file-tab` 统一 500），激活只用背景 + 颜色区分。

### 待办归档并入目录模型（B2 第一批，宿主侧，16:55）

- **待办归档从旧单文件迁到分组目录**：归档轨新增 `todo-<组id>` 写法 —— 待办归档落 `archive/todo-<组id>/`（会话类带会话 id、项目类带工作目录），复用记忆侧同一套 `groupArchiveDirOf` 规则。记忆与待办的组 id 会重名（`session` / `project` / `daily` 两类都有），所以待办一律带前缀，并在 `ArchiveStore` 新增 `todoGroupResolver` 注入（各用各的分组解析器）。
- 旧的单文件 `TODO-archive.md` **保留只读兼容**（`todo-archive` 这条轨仍读得到），新写入一律进目录模型。
- `GET /api/archive` 现在会列出**每个待办分组**的归档（此前只有单文件那一条）；`POST /api/archive/promote` 与 `/archive/delete` 的 `cwd` / `sessionId` 解析改为按待办分组的「类」判定（此前只特判 `todo-project`）。
- **修掉一个会污染正文的数据 bug（转正路径）**：`promoteArchived` 的"剥渲染前缀"此前只认行首 `[日期]`，而 v2 归档条目由 `textOfEntry` 渲染成 `[id:…] [日期] [summary:…] 正文`。待办是纯文本轨、不解析这些标签，于是**转正后 `[id:…] [日期]` 被原样写进待办正文**（实测：正文变成 `[id:5ab80027] [2026-10-15] 整理知识库笔记`）。现在**分侧处理**：记忆侧只剥日期（把 `[id:…]`/`[summary:…]` 留给 `store.add` 解析回元数据 —— 保证转正后 **id 稳定、摘要不丢**），待办侧连 id/summary 一起剥干净。

### 待办三级结构 + 记忆库管理开关（B2 第二批 + B3 前端，17:10）

- **待办页签改成与记忆完全同构的三级结构**（用户拍板「待办的分级布局完全向记忆靠拢，二者一致」）：
  - 一级 = `[全部][会话类][项目类][全局类]`。其中「全部」是**跨分组功能格**（等价于记忆页签一级的「待确认建议」格）—— 点它时二级行不渲染、内容区直接给全部启用分组的待办，保住既有 `all` 语义。
  - 二级 = 当前类下的分组 + **全局类专属「过往」**（每日待办 daily 属全局类，所以过往只出现在全局类下）+ 末尾「归档」；按宿主 `showDisabled` 二态过滤（`hidden` 只显示启用项；`shown` 全显示且停用项灰字 + 「· 已停用」），行最右复用「停用：显示/隐藏」（与记忆页签同一项配置）。
  - 三级 = 列表 / 看板 / 过往列表 / 归档分段。归档按当前类下各分组分段展示（与记忆归档同构），每条可「移回」（`POST /api/archive/promote`，`target = todo-<组id>`）；旧单文件轨 `todo-archive` 归全局类最后一段、**只读**。
  - 词条：新增 8 条（中英齐平）、更新 11 条旧文案（把「四轨待办 / 点过往页签」的说法统一改成三级结构）。
- 「功能」页新增**记忆库管理工具**开关（**默认关**），对应宿主运行时键 `memoryLibraryEnabled`；`tests/client-config-save.test.js` 的 `PANEL_KEYS` 同步补上该键。

### 页签布局重构：一级与二级同处第一行（UI-3，18:10）

- **记忆页签与待办页签的一级 / 二级页签合并到同一行**（用户需求）。此前分两行，窄窗口下一级页签会换行，把靠后的页签（「开局提示词」）挤到第二行并与二级行粘连 —— 用户两次反馈「那个页签看不到了」。
- 新结构：`.mt-tabs-bar`（`position: sticky` 悬浮）内分两块 ——
  - `.mt-tabs-scroll`：页签区，`flex: 1` + `min-width: 0` + `flex-wrap: nowrap` + `overflow-x: auto`（隐藏滚动条）→ **永不换行**，溢出时页签那一侧横向滚动；
  - `.mt-tabs-actions`：操作区，`flex: none` → **锁定第一行最右**。页签再多、再溢出，「停用：显示 / 隐藏」始终钉在最右。
- 旧的负 margin 方案（`.mt-file-tabs + .mt-file-tabs { margin-top: -6px }`）**彻底移除** —— 它正是把换行后的页签压到下一行的元凶。
- 新增**结构探针** `probe-tabbar.mjs`：从**构建产物**里验证三件套容器、CSS 规则、nowrap / min-width 声明、按钮归属与 DOM 顺序、旧规则已移除，共 11 项（源码看着对、产物却不对的情况，只读源码查不出来）。

### 记忆时间戳精确到分钟（F-6，18:40）

- `lib/store.js` 的 `timeStampOf()`：非日志型分组此前只输出 `[YYYY-MM-DD]` —— 同一天写好几条时分不出先后。现在**所有记忆条目统一到分钟** `[YYYY-MM-DD HH:MM]`（`daily` 仍用 `[HH:MM]`，日期在它所在的日期目录里）。
- 前端 `MemoryTabView` 的 `parseEntries` 本就有兜底正则（`prefix.exec ?? GENERIC_STAMP_RE`），戳变长后仍能正确剥离、不会漏进正文（已核对代码）。
- 旧数据若 `created` 只有日期，渲染时补 `00:00`（迁移时就是这么写入的），所以界面会看到 `[2026-10-14 00:00]`；**新写入**的条目是真实时分。已真机验证（kb 分组首条读回即带时分）。
- 测试：4 个测试文件 31 处旧戳正则放宽为「日期 + 可选时分」（脚本 `probe-f6-stamps.mjs`，先干跑后写入），另 12 个用例的断言改由夹具已知的 `created` 精确推导。

#### ⚠️ 首版只改了渲染出口，写入侧与剥离侧没跟上 → 三个真 bug（同日 19:00 修复）

首版把「精确到分钟」只做在 `timeStampOf()` 上，于是：

1. **`add()` 判重彻底破裂（数据重复）**：`stampEntry()` 对 memory/user/key 写的仍是 `[YYYY-MM-DD]`，而展开读回走 `timeStampOf()` 得 `[YYYY-MM-DD HH:MM]` —— 判重是「`stripEntryId` 后整条等值」，于是**永不命中**：同一内容真的写两条、还都返回「已添加」。修法：写入侧改用 `nowStamp()`，幂等判断放宽到可选时分，让**写入态与读回态同形**。
2. **剥离侧失配（数据污染）**：`splitEntryHead()` 的时间戳正则只认 `[YYYY-MM-DD]`，新戳剥不掉被当成正文 —— `setEntryBranches` / `setEntryDshOnly` / `updateEntryContent` 重建条目时会**再盖一个戳**（实测出现两个时间戳），key 轨还会丢 `[branch:main]`。修法：该正则放宽为 `[YYYY-MM-DD( HH:MM)?]`，与 `ENTRY_HEAD_RE` / `objectOf` 同形；`stampEntry()` 的 project 分支幂等判断也从 `\d{2}:\d{2}` 放宽到 `\d{1,2}:\d{2}(?::\d{2})?`（手写的 `[2026-08-05 9:30]` 不再被重复盖戳）。
3. **归档戳不同形**：`lib/review.js` 的 `archiveSuggestions()` 写归档条目用 `[todayStamp()]`（只有日期），与主轨对不上，同一天归档多条也分不出先后。修法：改用 `nowStamp()`。

**语义变化（须知）**：`add()` 的判重粒度随戳粒度**从天降到分钟** —— 同一分钟内重复 add 会去重，跨分钟的同内容仍会写第二条；结构化 `addEntry()` 按正文去重，不受影响。

**回归测试**：新增 `tests/f6-stamp-consistency.test.js`（判重 / 更新不产生双时间戳 / 写入即真实时分），删掉任一条都意味着对应 bug 回归。

### 面向用户的「项目」改称「工作区」（T-3，18:50）

- **动机**（用户原话）：「项目关键记忆模糊了，模型很容易记忆待办全加项目里。」—— 叫「项目」时模型倾向把所有记忆/待办都塞进 `project` 分组；改成「工作区」语义更准（= 当前工作目录这一层）。
- **范围**：只改**面向用户**的词 —— 中文 194 处 / 英文 145 处（`lib/i18n.js` 71/58、`src/client/index.ts` 96/76、`lib/groups.js` 4/4、`lib/todo.js` 3、`lib/memory-search.js` 1，其余 19/7 分布在 CoIView / canvas-grok / AdvisorPanel）。
- **一律不动**（改了会破坏数据与接口）：`target=project`、`scope=project`、`todo-project`、`projects/`、`{projectId}` / `{projectHash}` / `{projectDir}`、`projectDirResolver`、`perTurnProjectWrites`、字典键名（`sync.projectOn` 等）、`--scope …|project|global`、`save('project')`。
- **代码注释未动**（48 行里仍写作「项目」）；两处**刻意保留**的 target 标注：「工作区日志（project）」/「Workspace log (project)」。
- **仍未同步（下一轮补）**：`lib/advisor/scopes.js` 注入评审员的 `### 项目约束`、`src/client/advisor/advisor-store.ts` 的 `LEVEL_LABEL.project = '本项目约束'` —— 与 AdvisorPanel 已改的「对本工作区所有会话生效」不一致。
- 内置分组名（`groups.js` 的 LABEL_DICT）改的是**出厂默认名**；用户已自定义过 label 的分组沿用其自定义值，不受影响。

### 开局提示词搬回设置页 + 记忆页签指南挪到最左（19:10）

- **「开局提示词」从记忆页签搬回设置页**（用户定：它属于「配置」而不是「记忆内容」）。新位置在设置页二级页签的「注入」之后 —— 两者语义最近（都是"每轮注入给 AI 什么"）。面板内容与原来完全一致，只是入口位置变了；记忆页签不再保留该页签与渲染分支。
- **记忆页签的「指南」挪到最左**（用户定）。此前沿用的"指南固定最后一位"只对**设置页**成立（用户原话只约束了设置页）；记忆页签里「指南」是"这一页怎么看"的入口，放最前更顺手，于是排在「待确认记忆建议」之前。
- 结构探针 `probe-tabbar.mjs` 扩到 **14 项**：新增「指南渲染在最左」「设置页的二级页签里有开局提示词」「记忆页签区不再渲染开局提示词」三条；原先那条"开局提示词按钮位于页签容器附近"按新设计**反转**（它现在就该不在了）。

### 界面细节批（UI-7 / UI-9 / UI-10 / UI-11 部分 / UI-12，20:45）

- **UI-7** 删掉记忆页签上方那行常驻警告「⚠️ 以下文件为 § 分隔的结构化记忆，用系统工具打开后请谨慎编辑…」—— 每天都会看到，实际没人靠它避坑。
- **UI-9** 「停用：显示 / 隐藏」两个按钮**合成一个**（显示当前状态、点击切换），记忆与待办两个页签同款；字号与左侧页签一致（都是 13px）。
- **UI-10** 记忆 / 待办 / 设置三个页签的**顶部内边距删掉**（`.mt-panel` 的 `padding-top` 由 6px 改为 0），页签行直接贴到内容区顶端。
- **UI-11（部分）** 待办子页签的「指南」**移到最左**并加分隔符（与记忆页签一致）；会话类待办分组的显示名由「会话待办」改为「**本会话**」（英文 `Session todos` → `This session`）。
  - **未做**：待办的「两行合一行」。它的子页签挂在**外壳** `TodosTabView`，而「全部 / 类 / 分组」在 `TodoView` —— 两个组件各渲染一行，合并需要跨组件重构（已记为独立待办）。
- **UI-12** 设置页：「功能」与「关于」之间**加分隔符**；删掉功能页顶部那句「修改立即生效并持久化（覆盖 config.yaml 的对应项）。」；「指南」仍固定最右（不变）。

### 分组页三项（UI-8，20:50）

- 「注入 AI」改叫「**注入**」。
- 「写入需确认」+「自动通过」两个独立开关**合成一个二选下拉**（需确认 / 自动通过）—— 用户看不出二者关系。判定与宿主 `needsConfirmation()` **完全一致**（`autoApprove` 优先，否则看 `confirm`，`forceAll` 另算），改完即时生效（走既有的免保存通道）。
- 分组行头：`类 / 内置 / #id` 三个徽标**固定在该行最右并保持一行**，左侧名称框成为可被挤压的一方。此前名称框写死 `flex: 1 1 180px`、容器还允许换行，窄卡片里元数据会被挤到第二行。

### 取消内层滚动，顶栏对外层也能吸附（UI-6，21:00）

- **`.mt-panel` 不再做内层滚动**（去掉 `overflow-y: auto` 与 `height: 100%`）。`position: sticky` 只对**最近的滚动祖先**生效 —— 此前面板自己就是那个祖先，所以顶栏只认面板；内容一旦超出到外层滚动容器，顶栏就跟着滚走（用户实测：「记忆、待办的顶栏均有此问题，在外滚动条无法浮动」）。去掉内层滚动后内容自然撑开、由外层容器滚，顶栏因此对外层也能吸附。
- 顺带消除「内滚动条出现与否」造成的空隙差异 —— 即 UI-6 的第①条（设置页「分组 / 指南 / 功能」有内滚动条而「注入 / 工具 / 界面 / 数据」没有，横线下方那道空隙不一致）。

### 顶栏悬浮真修 + 类根路径 / 删常驻文案 / 计数口径 / 手写框（UI-6R、UI-13 ~ UI-18，22:15）

- **UI-6R 顶栏悬浮真修**。上级 UI-6 只处理了 `.mt-panel`，漏掉了真正的滚动祖先 —— **`.me-panel`**（`height:100%` + `overflow-y:auto`，嵌在 `.mt-panel` 内时还额外加 `max-height:62vh`）。它同时是「待办页根容器」和「设置页子面板的容器」，所以既造成右侧第②根滚动条，也造成「设置 → 工具」顶栏不浮动。改动：
  - `.me-panel` 去掉 `height` 与 `overflow-y`；删除 `.mt-panel .me-panel { height:auto; max-height:62vh }` 整块。
  - 列表容器不再内滚：`.me-list`（原 `max-height:380px`）、`.me-archive-list`（320px）、`.mt-entries`（320px）、`.me-todo-quad-body` 去掉 `max-height` 与 `overflow`；对应的 `::-webkit-scrollbar` 规则删除。
  - **唯一保留的内滚**：单条正文 `.mt-entry-text` 与纯文本视图 `.mt-content`，阈值统一 400px（约 20 行）。
  - `.mt-file-tabs` 补 `position:sticky; top:0; z-index:6` + 不透明背景。此前只有记忆 / 待办的 `.mt-tabs-bar` 是 sticky，设置 / 模型 / 待办子页 / 同步 / 书签 / 广播 / 提示词 / UI 设置这些页的页签行都不是 —— 这正是用户说的「设置-工具没有浮动」。
  - DSH 侧事实（供后续排查）：会话区**唯一**的滚动容器是 `[data-conversation-scroll]`；插件祖先链上的 `[data-slot=…]` 全是 `display:contents`（无盒子，写 height/overflow 无效）。
- **UI-14 / UI-18 删常驻文案**：记忆分组卡片的 `.mt-card-desc` 说明行（`memoryTab.desc.*`）不再渲染；页面顶部「当前会话工作目录:」行删除（`mt-cwd`）；待办页 `.me-todo-help`（`todo.help`）删除。key 轨的「当前分支」信息从说明行挪进卡片头部徽章（新增 `.mt-badge-branch`）。**保留**：设置页各控件下的一行解释、待办「工作区不可用」这类功能性提示；被删文案的内容仍完整保留在「指南」页。
- **UI-13 类根路径**：host `buildMemoryFiles()` 在类节点上新增 `rootPath`（会话类 = `<memoryDir>/sessions/<会话id>`；工作区类 = 工作区路径 cwd；全局类 = dsh-home）。客户端渲染为「分组目录 · 类根」，同时显示于分组卡片与归档块。
- **UI-16 条目数显示口径**：新增 5 个运行时配置 —— `countShowSession` / `countShowProject` / `countShowGlobal`（三类各自是否显示数字，默认都显示）、`countIncludeDisabled`（数字是否含已停用分组的条目，默认含）、`countIncludeArchived`（数字是否含归档条目，默认不含）。开关在「Memory Evolve 设置 → 界面」，客户端按 `/api/config` 归一后决定类页签 / 分组页签 / 卡片内计数徽章是否出现。
- **UI-17 手写框一视同仁**：`isManualAddGroup()` 放开为「除 key（有专用分支/DSH 选项框）与已停用分组外全部显示」——内置全局三轨、日志型分组、会话类、工作区类、自建分组都有同一个手写框，placeholder 与说明统一为 `memoryTab.addPlaceholder` / `memoryTab.addHelp`。会话类 / 工作区类写入走 `POST /api/memory/group`，同时带上 `sessionId` 与 `cwd`（宿主按该分组的类取用需要的那个）。

### 分组页一行到底 + 自动保存 + 注入三态（UI-19，23:05）

- **一行到底**：分组行的「自动保存 / 注入下拉 / 提示词 / 保存 / 删除」全部锁在同一行、永不换行（`.me-item-actions` 加 `flex-wrap:nowrap` 与 `> * { flex:none }`）；原来「注入通道」独立占一行、与操作行分家。
- **自动保存（新持久化字段 `autoSave`）**：分组配置新增布尔字段，`lib/groups.js` 的 `builtinEntry` / `normalizeGroupsConfig` / `upsertGroup` 三处齐平（`/api/groups` 直接透传 body，无需改动）。打开后该行的**名称与提示词在离开输入框时立即提交**，主「保存」按钮与提示词保存按钮一并变灰。
- **注入改为下拉三态**：原来的「注入」开关 + 两个注入通道按钮，合并成一个下拉 —— **不注入 / 普通（运行时上下文快照）/ 系统（系统提示词段）**。选项值仍按**生效态**显示（跟随全局且全局是 section 时这里显示「系统」）。提交时「不注入」发 `inject:false`，另两态发 `inject:true` + 对应 `injectMode`。
- **提示词**：按钮文案由「伴随注入的提示词」改为「**提示词**」；textarea 下方新增**独立的「保存提示词」按钮**（不必连带提交整行）。

### 待办页签合并成一行（UI-11③，23:05）

- 待办 Tab 的外壳页签（指南 / 待确认待办管理 / 待办）与类、分组页签**合并到同一行**（此前各占一行）。实现：外壳 `TodosTabView` 变成薄壳（只轮询待确认数、持有外壳页签状态），**页签行与内容分流全部搬进 `TodoView`**（新增 `shell` prop：`feature / onFeature / suggestions / onChanged`）；外壳页签不是「待办」时，类 / 分组页签整段收起（与记忆页签同构）。
- `TodoView` 根容器由 `.me-panel` 改为 **`.mt-panel`**（与记忆页一致，间距 10px）；`todosGuideSections` 随之从 `TodosTabView` 搬到 `TodoView`。

### 界面修正（22:37）

- 类根路径的呈现改为「**分组目录 ｜ 标签：类根**」（标签：会话目录 / 工作区 / dsh-home）—— 原来单一个「·」不醒目，看不出后一段是什么。
- **模型设置页表格（`.mt-models-scroll`）取消内滚**，跟外层页面一起滚（与「只留单条内容内滚」的口径统一）。

### 条目展开与高度记忆（F-8，23:40）

- **结构化条目（前置改造）**：`GET /api/memory-files` 的每个分组（含归档块）新增 `entries: [{ id, text, raw, title, summary, keywords, scenario, created, updated }]`，由 `lib/memory-tab.js` 的 `entryItemOf()` 产出。`text` 与分组 `content` 里那一条**逐字一致**（同一个 `displayText` 出口），`raw` 是完整原文；**分组 `content` 的对外契约不变**（仍走 `store.rowsOf` → `textOfEntry`，`groupLines` 换成 `groupRows` 只是同源换名）。
- **展开程度可设置（F-8②）**：新增三个运行时配置 —— `entryExpandMode`（`collapsed` **默认**＝只显示标题行，便于浏览 / `preview`＝展开前 N 行 / `full`＝整条撑开）、`entryPreviewLines`（默认 3）、`entryRememberHeight`（默认开）。入口在「Memory Evolve 设置 → 界面」。
- **逐条覆盖**：每条的时间戳右侧一个 ▶/▼ 箭头，点一下展开或收起；覆盖值会被记住（localStorage `memory-evolve:entryView`，键＝条目 id，旧数据退回原文指纹）。
- **拖拽高度（F-8③）**：条目下边缘多一根细线（`cursor: ns-resize`），拖动时**直接改 DOM 的 `maxHeight`**（不触发 React 重渲染），松手才写进 localStorage；设置里关掉「记住手动拖拽的高度」则不渲染这根线。
- 记忆页与待办页**共用同一套实现**：新增 `src/client/entry-view.ts`（`expandOptionsOf()` / `entryKeyOf()` / `useEntryViews()`），两页各自只留调用。待办正文 `.me-todo-text` 同时补上默认 400px 内滚（与 `.mt-entry-text` 同款，UI-6R 的口径）。

### 工具页重排 + 分组页一行 + 设置页瘦身（T-4 ~ T-7、G-5 ~ G-7、S-1 ~ S-3，2026-10-16 00:50）

- **工具页（T-4 / T-5 / T-6）**：
  - **两列网格**，一个工具一张卡片；卡片头＝工具名输入框（左）+ `#id`（紧跟其后）+ **右上角锁三个按钮**「查看内置 / 恢复默认 / 保存」。
  - 「查看内置」就地展开该工具的**出厂名称 / 描述 / 参数说明**；「恢复默认」= 只恢复这一个工具（`POST /api/tools/reset { scope: <工具id> }`）——原来只有一个全局恢复默认，现在挪到页面底部并改名「全部恢复默认」。
  - **修复「新建工具用不了」**：绑定动作此前写死 `search`，工具清单一旦变化就提交非法动作导致创建失败；改为加载清单后取第一项。工具名必须是 `[a-z0-9][a-z0-9._-]{0,39}`，界面补 hint。
  - **新建工具可指定 id**：`addCustomTool` 接受 `input.id`（格式非法 → `INVALID_ID`，与内置/自建撞名 → `ID_TAKEN`）；新建区多一个 id 输入框，留空自动生成。自建工具卡片可删除。
- **`skill_manage` 下线（T-7）**：不再注册该工具（`lib/index.js` 去掉 `ctx.tools.register(skillManageTool(...))` 与对应 import）；`BUILTIN_TOOL_IDS` 与工具页内置清单同步移除；注入快照的模块简介与审查指令里"技能用 skill_manage"的措辞一并删掉。
- **分组页（G-5 / G-6 / G-7）**：
  - **自动保存改为全局统一开关** `groupAutoSave`（运行时配置，默认关）。分组字段 `autoSave` 从 `lib/groups.js` 的 `builtinEntry` / `normalizeGroupsConfig` / `upsertGroup` 三处删除；开关挪到分组页顶部的全局开关区。
  - **一行到底**：自动通过（记忆）/ 按日期（待办）、启用、注入、提示词、保存、删除 全部挤进同一行 `.me-group-row` —— 永不换行，字号统一 12px、控件高度统一 26px。
  - **新建分组可指定 id**：新建行多一个 id 输入框（留空由宿主 `newGroupId()` 分配）。
- **设置页瘦身（S-1）**：删掉「数据」子页（DataPanel）——`SettingsTabView` 去掉 feature 与渲染分支；宿主 `/api/vault/*` 端点保留（迁移仍在后台自动跑）。
- **开局提示词两栏（S-2）**：改为**两栏并排**（左＝内置文案只读 / 右＝自定义文案可编辑），两栏等高 380px、各自内部滚动；删掉「查看内置文案」按钮与「可用占位符…」说明行。
- **下拉框宽度自适应（S-3）**：`.me-select` 原来写死 `width: 120px` → 改为 `width: auto; min-width: 120px; max-width: 100%`（浏览器按最长 option 算宽）；`.me-todo-select` / `.me-todo-filters select` 补 `flex: none; width: auto`，不再被 flex 压扁。
- **删说明性文案**：工具页 intro、注入页 intro、界面页 intro、分组页 help（记忆 / 待办两段）全部不再渲染。

### 条目元数据行（F-7，2026-10-16 00:55）

- **记忆条目**：时间戳右侧平铺显示该条的**标题 / 摘要 / 关键词 / 使用场景**（数据来自宿主 `entries`，见「条目展开与高度记忆」那节的 `entryItemOf`）；整行撑满，放不下就省略号。位置在展开箭头之后、操作按钮之前。
- 新增两个运行时配置 **`entryMetaMemory` / `entryMetaTodo`**（默认都开），入口在「Memory Evolve 设置 → 界面」。关掉后记忆页不渲染元数据行、待办页不渲染象限 / 截止徽章（时间戳与操作按钮照常）。
- 展开箭头：用户确认「图标本质就是两个箭头」——沿用 F-8 的 ▶ / ▼ 按钮，不另做样式。

### 工具页三改：块随保存生效 / 单列 / 删「新建工具」（2026-10-17 02:20）

- **删除「新建工具」整个模块**（用户实测无用处）：界面、状态、提交逻辑与相关校验一并移除；**自建工具卡片保留**（仍可删除）。
- **工具改为一行一个**（单列，取消上一版的两列网格）。
- **工具定义块**：
  - 包在**各自的工具卡片内**，**两列**排布，可**一键折叠**（默认展开）；
  - 每块可：勾启用、写文案（覆盖出厂文案）、「恢复默认」（清空覆盖）；
  - **全部暂存**：勾选/编辑**不再立即发请求**（修掉用户报的「点一下闪一下」），只有点工具名右侧的「保存」才一次性提交；
  - 工具页最顶一行提示该锁定规则。
- **后端**：
  - 新运行时配置 **`toolBlockTexts`**（`{ "<工具>.<块>": "自定义文案" }`，空串 = 恢复默认）；`lib/tool-blocks.js` 新增 `normalizeToolBlockTexts()` / `blockTextOf()`，`composeDescription()` 支持文案覆盖。
  - `POST /api/tools` 支持**组合提交**（工具覆盖 + 块启停 + 块文案一次到位；旧的单块形式仍兼容）；`GET /api/tools` 的 `blocks` 增加 `texts`，`definitions` 每项带 `label / defaultText / text`。
  - 新增 deps `listToolBlocks()`（`lib/index.js` 的 `toolBlockCatalog()`）：块目录含出厂文案与当前覆盖，配置页据此渲染编辑区。
- **实测暴露并修掉的两处**：① `TOOL_BLOCKS is not defined`（`lib/index.js` 漏 import → 配置页 400）；② 配置页显示的描述与**真实注册给模型的描述不同源**（只显示总述）→ 统一到 `memoryDescription()` / `todoDescription()` 单一出口。
- **实测结果**（临时 profile 的 web 实例，真 HTTP）：组合保存后 `enabled` 与 `texts` 都生效；工具描述里关掉的块 `【元数据】` 消失、自定义文案 `【读】自定义文案测试` 出现。

### 工具定义分块启用（2026-10-16 22:00，紧急任务）

- **问题**：`memory` / `dtodo` 的描述把六条轨、六种动作、批量写、情绪反馈全塞在一段里，模型每轮都读到大量本会话用不到的说明（用户原话：「当前各工具定义严重冗杂」）。
- **解决**：工具定义拆成**块**，可逐块启用（当前为手动方案；将来做自动启用只需在块表旁加一个计算函数）。
  - 新增 **`lib/tool-blocks.js`**：块表 `TOOL_BLOCKS`（23 块）、`normalizeToolBlocks()`、`isBlockEnabled()`、`composeDescription()`（总述 + 启用块）、`trackEnabled()`（target → 块过滤，memory / dtodo 各一张映射表）、`anyBlockEnabled()`。
  - **描述重写**：`memory.desc` / `todo.desc` 由两段巨型文本改为「总述 + 分块」，`memory` 10 段 / `todo` 9 段（`lib/i18n.js`，中英齐平）。
  - **参数同步裁剪**：关掉块 → 描述段消失、`target.enum` 去掉该轨、专属参数（`entries` / `feedback` / `title`·`summary`·`keywords`·`scenario` / `archived` / `filter`… / `items` / `due` / `past`·`expired` / `important`·`urgent`·`quadrant`）从 schema 里删掉。
  - 启用状态存运行时配置 **`toolBlocks`**（形如 `{ "memory.tracks.project": false }`，缺省全开）；工具 schema 是 getter，DSH 每轮读取 → **改完立即生效、无需重启**。
  - 接口：`GET /api/tools` 新增 `blocks`（块表 + 启用状态）；`POST /api/tools { block, enabled }` 切换单个块（未知块报错）。
  - 配置页：工具卡片内新增「工具定义块」区，逐块勾选（关掉即从模型可见的 schema 里消失）。
- **实测验证**：
  - `tests/tool-blocks.test.js`（6 例：块表归一 / 按块拼描述 / target 过滤 + **3 例装配级实测** —— 真的 `apply()` 一遍插件，读注册出去的 `memory` / `dtodo` 定义，断言关掉的块不出现在描述与参数里）。
  - `tests/tool-blocks-api.test.js`（1 例 **API 级实测** —— 走 `installApi` 注册的真实 HTTP handler：GET 返回块表与启用状态、POST 切块写进运行时配置、再读仍生效、未知块被拒）。

### 工具页三处失效修复（2026-10-16 22:50，用户报）

- **工具定义块点了没反应**：前端请求漏了 `/memory-evolve` 前缀（写成 `/api/tools`）→ 404，且被 `.catch` 静默吞掉。改为统一 `toolRequest()` 帮手：自动带前缀、自动 JSON、**非 2xx 一律抛错并把错误文案显示出来**；`/api/tools`、`/api/tools/reset`、`?id=` 删除、块切换四条路径全部走它。
- **新建工具按钮永远灰着**：`disabled` 挂在 `newAction === ''` 上 —— 动作未选中（清单没加载完、或选择失效）按钮就点不动。改为只看名称；绑定动作缺省取清单第一项（新增 `createTool()`），清单为空才报错。
- **恢复默认失败时无提示**：`resetAll` 的 catch 只给固定文案，真实原因（含 HTTP 状态码）被丢掉；现在一并显示。
- 说明：host 侧三个接口**一直是好的**（临时 profile 实测通过），问题全在前端调用层。

### 工具定义细化到分组（2026-10-16 23:20，用户要求）

- **块分两类**：**静态块**（动作用法 / 元数据参数 / 批量写 / 情绪反馈）+ **分组块**（`<工具>.group.<分组id>`，运行时按分组表生成）。
- **没有「必须存在」的分组**：内置分组与用户自建分组**完全平等**，插件自带分组只是不能删、不能改 id；每个分组都是一个可单独开关的模块。
- **描述按分组拼**：记忆工具的「写入目标」从「轨级 3 段」改成**每个分组一段** —— 内置分组取词条 `memory.groupDesc.<id>`（新增 memory / user / kb 三段，daily·project·key 由原 `tracks.*` 改名而来），**自建分组用它自己的「提示词」**，都没写就退回 `target=<id>`；待办工具同理（`todo.groupDesc.<id>`）。
- **关掉一个分组块**：描述里那一段消失、`target` 候选值里该分组消失（`trackEnabled()` 就是查 `group.<id>` 块）。
- **API**：`GET /api/tools` 的 `blocks.definitions` **分组块排在前**（`写入目标：…` / `待办目标：…`）；`POST { block, enabled }` 的合法性校验放行分组块（此前只认静态块，分组块会被判「未知的块」）。
- 词条：`memory.desc.tracks.core` 删除（拆成三段），其余 `*.desc.tracks.*` 改名为 `*.groupDesc.*`。

### 工具页再修三处（2026-10-16 23:20）

- **新建工具「保存失败」看不到原因**：`catch` 现在显示后端返回的真实错误；工具名做即时校验（中文 / 大写 / 空格当场提示「只能用小写字母/数字/._-，中文请写进说明」）；**名称留空自动生成**（`custom_tool_N`），按钮不再因「动作未选中」而永久禁用。
- **分组块开关报「未知的块」**：`POST /api/tools` 的校验只认静态块 → 分组块一律 400。已修。
- 测试：`tests/tool-blocks.test.js`、`tests/tool-blocks-api.test.js` 更新到分组块模型（7 例全过，含 API 级实测）。

### 已知限制

- **归档页暂无「移回」**：归档已改目录模型（`archive/<组id>/`），而 `/api/archive/promote` 仍走旧的整组归档文件；归档页先做成只读。
- 自建工具支持「新建 + 列出 + 删除」，动作分发待接线；内置工具的**参数级**描述覆盖已在数据层就绪（`tools.json` 的 `params`），界面暂只暴露工具级描述。
- `lib/sync/*`（Git 同步）**主体已适配 v2**：`filesets.js` 新增目录前缀白名单（`key/` `project/` `archive/` `todo/`，全局轨 `global/` `archive/` `todo/`），`repo.js` 的两份 `.gitignore` 同步放行新目录，`isTodoPath` 认 `todo/TODOS-<组id>.md` 与 `todo/<组id>/<日期>.md`（旧文件名列表全部保留，未迁移的仓库照旧可同步）。**剩余**：`tests/sync-todo` 的两个端到端流程用例（双设备并集 / 双向冲突解决）仍红——同步器在暂存与合并阶段还依赖旧单文件名，需继续深入 `lib/sync/worker.js`。同步默认关闭，不影响日常使用。

## 2026-10-14

### 新增

- **开局提示词可看可改（用户需求）**：记忆插件每轮注入的那段「固定指导文案」（工具与读法说明 + 收尾职责清单）现在在「Memory Evolve 设置 → 开局提示词」子 Tab 里**原样显示**（内置渲染结果可折叠查看），并能整段改写：保存后替换内置文案，留空恢复内置。支持占位符 `{branch}` / `{memoryTool}` / `{todoTool}` / `{targets}` / `{reviewInterval}` / `{sessionId}`（未命中的 `{xxx}` 原样保留）；记忆条目、待办内容、会话 ID 等动态内容不受影响，照常注入。自定义文本生效时，内置收尾职责段整段让位（不会在用户文本之后又追加一份内置指令）。
  - host：新增 `buildGuidance()`（把固定段从 `renderSnapshot` 抽出、可脱离会话上下文单独渲染）+ `renderPromptTemplate()` / `snapshotPromptVars()`；配置键 `snapshotPrompt`（默认空串 = 内置，≤20000 字符，运行时热改并持久化）；接口 `GET/POST /memory-evolve/api/snapshot-prompt`。
  - client：新增 `src/client/SnapshotPromptPanel.tsx` + 设置 Tab 第 5 个子 Tab。
- **注入方式可选：运行时上下文快照 / 系统提示词段（用户需求）**：新增运行时开关 `injectMode`——
  - `context`（默认）：`systemPrompt.context()`，每轮变化的尾部运行时上下文，前缀缓存最省（升级前唯一行为）；
  - `section`：`systemPrompt.section()`，直接作为 **system 提示词段**参与 system 消息拼装（与 `dsh-system-prompts` 同一条通道）。
  该选项**对全部注入内容同时生效**：各记忆分组、内置指导文案、待办注入。切换即换注册通道（`snapshotCtrl.sync()` 挂在 `applyRuntimePatch` 上，改完立即生效、无需重启）。
- **内置文案开关（用户需求）**：新增 `builtinGuidance`（默认开）。关掉后不再注入插件自带的固定指导段（工具与读法说明 + 收尾职责清单）；用户自定义的「开局提示词」与各分组内容、待办注入照常生效（自定义优先于内置开关）。
- 两个开关与「开局提示词」共用同一面板与接口：`GET /api/snapshot-prompt` 一并返回 `injectMode` / `builtinGuidance`，`POST` 支持 `{ text?, injectMode?, builtinGuidance? }`（字段各自独立保存）。

### 修复

- **「开局提示词」页的开关排版错乱（用户反馈）**：`.me-field` 是「左侧标签+说明 / 右侧控件」的一行式布局，此前把 checkbox 与说明文字当成并列子项塞进去，被挤成竖排、还和「查看内置文案」按钮重叠；现统一为该页既有写法（`label.me-field` 包 `span.me-field-label` + 右侧 `input.me-switch`），注入方式下拉也归位到右侧。

### 测试

- 新增 `tests/snapshot-prompt.test.js`（5 例）：`buildGuidance` 产出与写入/审查开关联动、GET/POST/恢复内置/限长校验、`renderSnapshot` 用自定义文本整段替换不再追加内置职责、`builtinGuidance=false` 只关内置文案（分组内容与自定义文案不受影响）、`injectMode` 读写与非法值拒绝。
- `tests/plugin.test.js` 的快照逐字断言保持全绿——证明抽出 `buildGuidance` 与增设注入通道未改变默认（context）行为。

## 2026-10-13

### 新增

- **记忆与待办全面「分组化」——轨道变成可自定义的分组（用户需求）**：过去记忆六轨（memory/user/key/kb/project/daily）与待办四轨（life/work/project/daily）都写死在 `store.locate()` / `TodoStore.fileOf()` 与工具的 `enum` 里，用户既不能新建、也不能逐轨控制「是否注入 / 写入要不要确认 / 注入时那段提示词长什么样」。现在新增 `lib/groups.js` 作为**唯一分组模型**，配置落在 `<memoryDir>/groups.json`：
  - **可新建、可命名**：分组建在设置面板里（「Memory Evolve 设置 → 分组」），可自定名称；作用域可选**全局**（所有会话共享，落 `<memoryDir>/groups/<id>.md`）或**项目级**（跟随会话工作目录，落项目记忆目录，与 KEY.md 同处）；
  - **每个分组独立控制是否注入**：`inject` 开关；
  - **每个分组的提示词可编辑**：`prompt` 非空即替换该分组的注入抬头（留空用内置文案）；
  - **所有记忆分组都有待确认门槛**：`confirm`（写入进待确认队列）+ `autoApprove`（该组自动通过）+ 全局 `allAutoApprove`（一键全部跳过队列）。出厂默认**刻意保持升级前的行为**：`key` 与**自建分组**需要确认（用户拍板"新建分组默认需要确认"），`memory`/`user`/`kb`/`project`/`daily` 仍直接写入（AI 的常规记录路径，每条都让用户点会淹没用户）——需要"全都问我"时在「分组」页逐个或全局打开即可；
  - **待办同样分组化**：life/work 不再特殊（保留为普通内置分组，数据不迁移），分组可选作用域与**是否按日期分文件**（`daily`），每个分组独立 `inject`；
  - 内置分组不可删除、作用域不可改（文件位置与工具语义是代码约定），但名称/注入/确认/自动通过/提示词/启用全可改；删除自建分组只删配置，**磁盘上的条目文件保留**（宁可留孤儿文件也不静默销毁内容）。
- **设置面板新增「分组」子 Tab**：分组列表（记忆/待办分区）+ 新建 + 行内改名称/作用域/开关/提示词 + 删除，另有全局开关区（红点、跳转、全部自动通过、待办注入、收尾检查）。
- **待办注入与收尾检查开关（用户需求）**：`todoInject`（默认关）把「需要关注的未完成待办」注入快照——注入哪些分组由各分组的 `inject` 决定，单组注入用分组名当抬头；`todoCheck`（默认开）关闭后快照不再要求模型收尾检查到期待办。
- **待确认记忆的界面行为可配（用户需求）**：`pendingBadge`（默认开，关掉后红点一律不显示，队列与处理入口照旧）、`jumpToPending`（默认关，开启后有待确认记忆时点进记忆 Tab 直接落在「待确认记忆建议」子页）。
- **分组 CRUD API**：`GET /memory-evolve/api/groups`、`POST /memory-evolve/api/groups`（无 id = 新建）、`DELETE /memory-evolve/api/groups?kind=&id=`。

### 变更

- **`memory` 工具与 `dtodo` 工具的 `target` 改为动态枚举**：都来自「启用中的分组」（getter 每次读最新 groups.json），新建分组后无需重启即时可用；`memory_suggest` 的 target 同样是动态的「记忆分组 + `todo-<待办分组>`」。
- **待办默认智能视图改为分组属性驱动**：判据从写死的 `life/work/project/daily` 改为「项目级分组（scope=project）的当前项目未完成项 + 任意分组的重要项（q1/q2）+ 任意按日期分组（daily=true）今天的未完成项 + 通用逾期/今日到期」。
- **`/api/todo` 默认覆盖全部启用分组**；**`/api/memory/delete`、`/api/memory/update`、建议采纳的 target 白名单**同样动态化，自建分组因此自动获得与内置轨完全一致的增删改能力（`store.locate()` 统一解析，自建分组的读写走同一套锁/漂移守卫）。
- **记忆 Tab**：自建分组自动多出一个页签（标题=分组名，作用域决定路径），条目结构判定从白名单改为排除法（AGENTS.md 纯文本、归档只读，其余皆条目且可编辑）；自建分组支持手动添加（新增 `POST /api/memory/group`）、编辑、删除；未知分组的说明文案走通用兜底 `memoryTab.desc.custom`。
- **待办视图**：页签、快速添加的目标下拉、条目轨徽标全部由分组配置驱动（拿不到分组时回落内置四轨，页签不空白）。

### 测试

- 新增端到端自检（临时脚本，14 项全绿）：出厂默认分组表（记忆 6 + 待办 4）→ 新建自建记忆分组 → 手动写入 → 记忆 Tab 页签出现（标题=分组名）→ 默认不注入 → 打开 inject 后内容进快照且抬头为分组名 → 新建待办分组并写入/查询/注入 → 删内置分组被拒（400）→ 删自建分组成功 → `groups.json` 落盘正确。
- `renderSnapshot` 增加第 7 个参数（todo store）用于待办注入；对不完整 config（缺 `memoryDir`）容错，保持既有单元测试的调用方式可用。

## 2026-10-11

### 新增

- **记忆知识库（第六轨，`target=kb`）**：新增 `<memoryDir>/KB.md`——与 MEMORY.md / USER.md 同目录、同 § 条目格式、同程序日期戳，但**永不注入上下文**：`renderSnapshot()` 只读 memory/user/key，kb 只供模型按需检索（`list` 配 `filter`/`since`/`until`/`limit`，并且和 project/daily 一样带「默认最近 50 条 + 库规模/时间跨度」的保护视图，避免整库被一次 list 拉进上下文）。因为不注入，写入不进确认队列（没有污染上下文的代价）；`replace`/`remove` 与其它轨同款。记忆 Tab 新增「记忆知识库 KB.md」页签：卡片视图、搜索、手动添加、编辑、删除；「归档」与 `[dsh-only]` 对它不适用（不注入即无需瘦身）。同步侧并入 `memory-global` 文件集（`KB.md` 随全局记忆仓库同步）。`memory` 工具的 `memory.desc` / `param.target`（中英）、记忆 Tab 指南（五轨 → 六轨）与同类注释一并更新。
- 记忆 Tab 的 `kb` 行沿用既有 `MemoryFileRow` 契约（`title` 由宿主侧 `TITLE_DICT` 本地化：「记忆知识库 KB.md」/「Memory knowledge base KB.md」），前端零特判。

### 修复

- **记忆 Tab：点分隔线右侧的文件页签、再点左侧功能页签，文件页签不取消高亮（用户反馈）**：文件页签的选中态只看 `activeKey === row.key`，而切到「指南 / 待确认记忆建议」时 `activeKey` 保持不变 → 两个页签同时呈选中态，看起来「右边那个取消不掉」。改为 `feature === null && row.key === activeKey`（选中态只在文件视图下成立）。
- **技能管理：长路径下右侧「编辑/保存」按钮看不见也点不到、路径本身也看不全（用户反馈，阻塞级）**：`basename()` 只按 `/` 切分，而 `/read` 返回的是 `realpath()` 结果——Windows 上是纯反斜杠路径（`C:\…\office-docx\SKILL.md`），于是 basename **原样返回整条绝对路径**（108 字符 ≈ 780px），塞进 `flex: none` 的 `.sb-editor-filename`（不收缩）；而 `.sb-main` 内容盒只有 616px 且 `overflow: hidden` → 行尾的 spacer 与按钮被挤出可视区裁掉，同时 `.sb-editor-path` 被压成 0 宽（连 `title` 悬浮提示一起失效）。修复分两层：① 路径工具全面支持两套分隔符——新增 `SEP_RE`/`normPath()`/`dirOf()`，`basename()` 取 `/` 与 `\` 的较后者，`relOf()` 改为规范化后比较，`joinPath()` 保留原路径风格，`focusDir` 与面包屑跳转改用 `dirOf()`；② 顶栏改两行布局：第一行文件名（`flex: 0 1 auto` + `min-width: 0` + `max-width: 60%` + 省略号）与操作按钮（`.sb-editor-topbar .sb-btn { flex: none }`，杜绝压缩），第二行完整路径（`overflow-x: auto` 横向可滚动 + 「复制路径」按钮，1.5s 反馈）。
- **`gitBranch()` 的合并实现会漏掉「刚 `git init`、还没有提交」的仓库**：把两次 git（`branch --show-current` + `branch --format`）合并成一次 `branch --format=%(refname:short)\t%(HEAD)` 后，未生成分支 ref 的新仓库列不出任何行、当前分支解析为 undefined（记忆条目会丢分支标签）。补一条仅在解析不到时触发的 `--show-current` 回退（有 3s TTL 缓存，边缘路径多付一次 git 启动可接受），并导出 `clearGitBranchCache(cwd?)` 作为缓存逃生口（`git init` 后立即可见 + 测试跨阶段复用同一目录）。

### 变更

- **进入记忆 Tab 不再「刷新一段时间」：接口 0.8~1.2s → 缓存命中 ~20ms，且首帧就有内容（用户反馈）**。两处根因、两处修复：
  - **宿主侧重复 git 子进程**：`/api/memory-files` 一次请求里 `buildMemoryFiles` 会解析项目目录 3 次（`resolveProjectDir` + `project`/`key` 两行各一次 `store.pathOf`，每次都跑完整的 `resolveProjectId` = 1~3 次 git），最后再加 `gitBranch` + `gitBranchList` 两次——合计约 8 个同步子进程（实测接口 1076/1063/776ms，响应体仅 19KB，文件 IO 完全不是瓶颈）。修复：`buildMemoryFiles` 只解析一次项目目录并由它推导 `KEY.md` / `KEY-archive.md`；`identity.js` 的 `resolveProjectId` 加 30s TTL 记忆化（按 cwd）；`gitBranch`/`gitBranchList` 合并为一次 git 调用 + 3s TTL 缓存。实测同一接口第 2/3 次调用降到 **17ms / 23ms**。
  - **前端每次进入都重挂、重挂就重拉**：DSH 的 `conversation.view` 只渲染激活项（`renderSlot(..., { only: viewId })`），切走即卸载，badge 计数变化还会让宿主 `dispose + 重新注册` 再换一次 entry key；组件每次挂载都 `setFiles(null)` → 闪「加载中」。修复：模块级 `filesCache`（按 sessionId）+ `load({ useCache, silent })`——重挂/切回时先用缓存瞬时渲染再后台静默对齐；`useState` 惰性初值直接取缓存，首帧即有内容；条目增删改后的刷新用 `{ useCache: false, silent: true }`（旧列表不会把刚删的条目闪回来，也不清空 DOM）。
- **技能管理搜索：从「只搜名称/描述/适用场景」扩到「全字段 + 全库文件」**（用户反馈「搜索管理不全面」）：① 列表过滤的 haystack 加入 `source`/`provider`/`path`/`resourceBase`（按目录名、按来源都能搜到）；② 新增宿主 `GET /skills-manager/api/search?q=`：按技能目录递归扫描**文件名与文本内容**（跳过 `.git`/`node_modules`/隐藏项与二进制，单文件 ≤256KiB、单技能 ≤300 文件、总命中 ≤200 条并回报 `truncated`），返回 `{skill, path, name, kind, line?, text?}`；③ 左栏新增「文件命中」区（300ms 防抖 + 竞态保护），点一条即切到所属技能并打开该文件；④ 目录树按同一个查询词过滤文件名（目录保留，避免树断成不可导航的碎片）。
- **技能管理排版统一**（用户反馈「字体不好看」）：原来字号散落 42 处硬编码（10px 徽标、12 处 11px 小字），mono 一律写 `var(--dsw-font-family-mono, …)`——而该变量在整个 DSH 归档里 **0 命中**，永远走兜底列表。现在在 `.sb-root` 集中定义 `--sb-font-base/sm/xs` 与 `--sb-font-mono`（改用 DSH 真实存在的 `--ds-font-family-code`，兜底补 `Consolas`），次要信息 11px → 12px（与 DSH 自身 UI 的 12~14px 主体对齐）、徽标 10px → 11px（中文小字可读性），`.sb-root` 字体补中文兜底。

### 测试

- 新增 `tests/memory-kb-track.test.js`（3 例）：kb 落在 `<memoryDir>/KB.md` 且无需 cwd；add/list/replace/remove 往返（含程序日期戳）；**kb 内容绝不进上下文快照**（与 memory/user 注入轨做对照，并断言快照里不出现 `KB.md`，防止将来加段落时误注入）。
- `tests/memory-tab.test.js`：轨数断言 9 → 10，英文标题集合补 `Memory knowledge base KB.md`，中文补「记忆知识库 KB.md」。
- `tests/plugin.test.js`：`gitBranch` 用例在 `git init` 后补 `clearGitBranchCache(dir)`（分支查询新增的 3s TTL 缓存会让「非 git → git 仓库」两阶段测试命中旧缓存）。
- 实测（本机 desktop 实例）：`/memory-evolve/api/memory-files` 冷启动 1216ms → 缓存命中 17/23ms；kb 写入/读回/精确删除全链路通过；`memory` 工具 `target=kb` list 正常返回保护视图；`/skills-manager/api/search?q=SKILL` 返回 16 条命中（扫描 5 个技能目录，673ms）。

## 2026-10-10

### 修复

- **桌面版「点了记忆相关操作后整页 UI 变成没有 CSS 的裸控件」——本插件注入的 `<style>` 缺 `data-plugin` 归属，被 DSH 的客户端样式账本连带删除（根因，阻塞级）**：DSH 的客户端模块系统（`@deepseek-ai/dsh-client-modules`）用 `<style>` 上的 `data-plugin` 维护归属账本——物化一个插件 bundle 之后 `claimStyles(ownerId)` 会**把所有没有该属性的 `<style>` 认领给刚物化的那个插件**，而该插件被 HMR 重载 / 图重组回收时 `removeOwnedStyles(ownerId)` 会**删除 `data-plugin === ownerId` 的全部 `<style>`**。官方客户端插件（`ui-layout` / `ui-conversation` / `ui-theme` …）在 bundle 顶层注入时就写 `tag.dataset.plugin = 包名`，账本因此始终正确；本插件的 11 处注入（`apply()` 里的 10 个 `ctx.effect` + 画板 `injectCanvasStyles()`）只写了自定义标记 `data-*-css`，**没有 `data-plugin`**，于是账本两个方向都错：① 自己的样式成了「无主标签」，会被**随后物化的任意插件**认领走，那个插件一旦重载/回收，这里的样式就被连带删除，而且不会恢复（注入守卫只在标签不存在时才注入，`apply()` 未必再跑）；② 反过来，本插件物化时 `claimStyles` 会把页面上**所有**无主标签（profile 里同类不守约插件的样式）认领到自己名下，本插件一重载就把别人的样式一起删掉。用户看到的就是「点记忆相关操作后整页 UI 变成裸控件」——`<link>` 引入的 shell 基础样式没被删，所以布局骨架还在、控件全变原生外观，最容易被误判成「桌面版渲染坏了」。触发链：任何让插件 bundle 变化的动作（HMR rebuilt；本机 `@dsh-external/dsh-super-injector` 的「热重载」会直接调 `clientModules.rebuilt(name)` 与 `compose()`/`notifyGraphChanged()`）→ 客户端 `entries.reload(id, rev)` → `replace()` → `removeOwnedStyles(id)`。修复：新增 `src/client/style-tag.ts` 作为唯一注入入口 `injectOwnedStyle(markerAttr, css)`——注入即 `setAttribute('data-plugin', 'dsh-memory-evolve')`（= 包名 = Loader 条目 id），命中「标签已存在」分支时若归属被误认领则**抢回**；`src/client/index.ts` 的 10 处 effect 收敛成一行调用，画板模块保持自包含、内联打标；重建 `lib/client.js`（11 处 `createElement("style")` 收敛为 2 处统一入口）。证据：① 对照实验（`node` + 极简 DOM 复刻账本语义，分别跑修复前/后的产物）——修复前 10/10 个注入标签无归属、10/10 会被别的插件认领走；修复后 0/10 无归属、0/10 被认领、10 个归到自己名下、自己重载只删自己那 10 个；② 全量扫描桌面 profile 的 7 个样式注入插件，现全部带归属（本机另外三个同类不守约插件 `dsh-prompt`（5 处）、`@dsh-external/dsh-tool-manager`（1 处）、`@dsh-external/dsh-super-injector`（1 处）已一并补齐源码与产物）。注意这不是本插件独有的问题：**任何在运行时注入 `<style>` 却不写 `data-plugin` 的插件都会污染整页账本**；根治方向是 DSH 侧把 `claimStyles` 从「认领所有无主标签」改成「只认领本次 factory 执行期间新增的标签」。

### 测试

- 新增 `tests/client-style-owner.test.js`（5 例静态护栏）：归属键必须等于 `package.json` 的 `name`；`src/client/index.ts` 不得再出现裸 `createElement('style')` 且 `injectOwnedStyle` 调用 ≥10 处；画板模块必须显式打标且常量等于包名；`lib/client.js` 里**每一个** `createElement("style")` 的上下文都必须带 `data-plugin` 归属；归属键字面量不得被写成带 scope 的形式。已验证：把产物退回修复前版本时该用例必失败，恢复后全绿。

## 2026-09-28

### 修复

- **会话格式 v4 下插件注入消息会让接收方那一轮整轮失败（issue #68，阻塞级）**：DSH 0.1.7-rc.2 起会话持久化走 format v4，每条消息的 `source.kind` 必须由生产者自报（canonical 形态 `plugin:<包名>`，校验在 `@deepseek-ai/dsh-session-format-v3-to-v4` 的 message-sources 模块，持久化侧同规则）；v3 时代的「裸 `kind: 'plugin'` + 并列 plugin 字段」被**显式拒绝**：`format v4 message requires a producer-owned source kind`。插件有 4 处注入点仍在用旧写法——会话广播 / COI 通知（`lib/coi/index.js` 的 `deliver()`）、COI 任务状态通知（`lib/coi/scheduler.js` 的 `#deliver()`）、写冲突警告（`lib/coi/ws-coord.js` 的 `userMessage()`）与工作区活动公告板（同文件）。报错发生在**接收方会话认领该事件时**，所以症状是"注入所在的那一轮整轮失败"，而不是注入调用本身报错；又因为公告板需要活跃会话 ≥2、写冲突与 COI 通知靠事件触发，表现为"重启就好、过一阵复发"——重启只是清空了公告板基线 / 节流状态，并非修复。修复：新增 `lib/coi/source.js` 导出唯一常量 `PLUGIN_SOURCE_KIND = 'plugin:dsh-memory-evolve'`（与宿主 `producerKind()` 对未知生产者的映射一致），4 处全部改用它并删掉 `plugin` 字段。读取侧无需改动：`advisor` 用自己的 `kind: 'advisor'`，`review.js` 的 `lastTurnWasMessage()` 判 `undefined || 'user'`，新 kind 的语义不变。
- **带 `[summary:…]` 的条目在记忆 Tab 无法删除 / 编辑 / 归档，归档页也无法移回主记忆 / 删除（issue #59）**：根因是**展示层剥了程序元数据、匹配层没跟上**——`buildMemoryFiles()` 下发前会剥掉 `[summary:…]`（渐进式披露，2026-08-17 引入）与 `[id:…]`（2026-08-11 引入），前端 `MemoryTabView` 把这份展示文本当 raw 回传；而 `findExactIndex()` 只对 `[id:…]` 免疫，`peekExact()` 用 `includes()` 严格相等，归档侧 `ArchiveStore.removeExact()` 更是 `entries.indexOf()` 严格相等（**连 `[id:…]` 都不免疫**——启用 Git 同步后写入身份证的归档条目一律删不掉），`promoteArchived()` 的 `includes` 子串又被 `[summary:…]` 从中间截断。同一类问题第二次发生（第一次是 `[id:…]`），结论写进代码注释：**展示层每剥一种新元数据，匹配层必须同步扩展**。修复：`lib/store.js` 新增并导出 `normalizeForMatch(entry) = stripEntrySummary(stripEntryId(entry))`；`findExactIndex()` 改用它，并新增 `{ first }` 选项（主轨多条命中仍报歧义、保守拒绝；归档允许重复条目，取首条）；`peekExact()` 改走 `findExactIndex` 并**返回磁盘原文**（归档「先写后删」因此保留 `[id:…]` / `[summary:…]`，转正回主轨不丢元数据）；`ArchiveStore.remove()` 与 `removeExact()` 两侧统一归一化；`promoteArchived()` 的 `hits` 与随后的 `archive.remove()` **必须同一套基准**——只修 `hits` 不修 `remove` 会出现「转正成功但归档那条删不掉」→ 同一内容同时留在主轨与归档，且全程没有报错提示。
- **`runGit()` 的 30s 网络超时实际不生效——超时只杀直接子进程，Promise 可能永不 settle（issue #69，阻塞级）**：`git ls-remote` / `git fetch` 会再派生 `git-remote-https`，它**继承并持有** stdout/stderr 管道写端；Node 的 `'close'` 事件要等所有 stdio 句柄关闭才触发，而 `resolve()` 只挂在 `'close'` 上——超时回调虽然把 `git` 杀了，`'close'` 却永不触发，于是 Promise 挂死。实测（本地 TCP 黑洞，比不可路由地址更确定）：修复前 120 秒内 Promise 从未 settle；修复后 **30022 ms 返回 `{ok:false, code:null}`** 并在 stderr 末尾标注超时。影响不止"卡一次"：同步在 systemd user timer 下周期运行，一次挂死就让调用方永远拿不到失败原因，`node --test` 跑 `tests/sync-*.test.js` 也会整片挂住。修复三层一起做：① `settle()` 单次落定——超时 / error / close 谁先到谁生效、后到的丢弃，否则会出现"超时返回失败、随后 close 又翻案成成功"；② 超时**主动 resolve** 一个失败结果，不再等 close；③ 落定后 `killGitTree()` 尽力清理——`detached` 进程组 + `kill(-pid)` 连带孙进程（Windows 无进程组信号，退回 `child.kill()`），并 destroy 两路管道让 `'close'` 得以触发。顺序上必须**先落定、再清理**：反过来的话 destroy 管道触发的 `'close'` 会抢在超时结果之前 resolve 成一个假的成功。`NETWORK_TIMEOUT_MS` / `LOCAL_TIMEOUT_MS` 一并导出，供回归测试按真实阈值推进假定时器，避免测试另抄一份阈值后与实现漂移。
- **内置技能同步：`skillDir` 哨兵显式落地 + 成功/失败都不再静默（issue #67）**：issue 报告的"第二层"（`config.skillDir` 默认 `null` 未解析就传给 `syncBuiltinSkills()` 并抛 TypeError）**经复测不成立**——`resolveConfig()` 自首个提交起就有 `config.skillDir = resolve(config.skillDir ?? join(homedir(), '.agents', 'skills'))`，而 `apply()` 是先 `resolveConfig()` 再 `installCoi()`，调用点拿到的从来是字符串（实测 `resolveConfig({}).skillDir` → `C:\Users\…\.agents\skills`；本机 `~/.agents/skills` 里五个内置技能俱全，`memory-consolidate` 的落盘时间正是插件启动那一刻）。真正成立的是 #58 的第一层：调用点在 `installCoi()` 内、而 `installCoi` 由 `coiEnabled`（默认 false）门控——**默认配置下内置技能不会同步**，这一层由同批的 `e73a28e` 一并解决（见下条）。本次修的是 #67 里仍然值得修的三点：① 调用点显式兜底 `config.skillDir ?? DEFAULT_SKILL_DIR`（新增导出常量，与 `resolveConfig()` 的解析结果由测试钉成一致），`syncBuiltinSkills()` 则对非字符串入参抛**看得懂**的错（点名参数 + 指出该用 `resolveConfig()` 还是 `DEFAULT_SKILL_DIR`），不再把 Node 的 `The "path" argument must be of type string` 抛给上层；② 每次同步都落一行可见日志（目标目录 + 总数 + 更新数），`action: 'missing'`（插件包内缺该技能 = 打包事故）单独 warn，catch 打完整堆栈——此前成功路径只在有变更时 log、失败路径只有一行 warn，"技能从来没装上"只能靠反查技能目录的 mtime 才能发现；③ **顺带修掉同一路径上一个 Windows 专属缺陷**：`skillVersion()` 的 `^---\n` 只认 LF，而 Windows 上 `core.autocrlf=true` 检出的 SKILL.md 是 CRLF——源与目标都解析出 0，版本门控退化成"永远相等"，**x-version 升级在 Windows 上静默失效**（首次安装因目标不存在仍会复制，所以只有"升级不生效"这一半可见；本机 `~/.agents/skills` 里那五个技能正是这么来的）。改为 `^---\r?\n…` 后 CRLF 与 LF 解析一致。同源的 `normalizeSkillText()` 在 CRLF 下也把已有 frontmatter 误判成"没有"并叠加第二份头，一并改为按 `trim()` 比较边界行（不重写用户文本的换行）。
- **内置技能同步被 COI 开关连带关闭：默认配置下内置技能永远装不上（issue #58）**：`syncBuiltinSkills()` 的调用点原本在 `installCoi()` 内，而 `installCoi` 由 `coiEnabled` 门控（默认 `false`——本插件本职是记忆/待办/技能，调度是按需增强），于是 `memory-consolidate` 与 kimi/codex/grok/hermes 四个 CLI 使用指南在**默认配置下永远不会进技能库**；调用点又包着 try/catch 只打一行 warn，连"从来没跑过"都留不下痕迹（与 §7.5 broadcast 当初"独立子模块挂在 COI 下拆不开"是同款事故）。修复：同步提到插件主装配（`lib/index.js` 的 `apply()` 步骤 6.5），实现抽成 `lib/coi/skills-sync.js` 的 `syncBuiltinSkillsIfEnabled(config, pluginSkillsDir?)`——**判定只看 `coiSyncSkills`，代码里不再出现 `coiEnabled`**；`PLUGIN_SKILLS_DIR` 一并移过去并导出（供测试断言源头确实在包内），`installCoi()` 内的调用与模块级常量删除，该模块只剩适配器指南的写入需要 `normalizeSkillText`。`coiSyncSkills` 的语义随之明确为"启动时是否把内置技能同步到技能库"，与调度开关无关。
- **收尾的 key 建议没写明用哪个工具（issue #58 第二项）**：`snap.keyDuty` / `snap.subagentKeyTail` 只说"另向 target=key 提交 1 条建议"，而 `memory_suggest` 的 target 白名单是 `['memory','user','todo-life','todo-work','todo-project','todo-daily']`（`lib/review.js`），**不含 key**——照字面选工具即报"不支持 target=key"，会话收尾会反复踩。走待确认队列的正规通道是 memory 工具的 `add`（与 `memory_suggest` 共用 `enqueueSuggestion` 队列）。两处文案改为"另用 memory 工具 action=add 向 target=key 提交 1 条建议（走待确认队列，用户确认后写入并注入）"，中英同步。

- **适配 DSH 0.2.0-rc.1：settings 服务读接口与提交事件改名（静默降级，无报错）**：升级前机械比对新版 `packages/extensions/tool-cordis/src/api-catalog.ts`（老 0.1.5-rc.2 → 新 0.2.0-rc.1）发现两处破坏性变更——① `ctx.settings.get(ns)` **被移除**（新版改为 `describe(options?)` 返回 `SettingsDescriptor[]`，每项 `{ ns, value, schema, revision, … }`，按 `ns` 自行查找；`register`/`installSection` 同时移除）；② 提交事件 `settings/updated(ns, next, prev, source)` **改名为** `settings/document-updated(ns, revision)`。插件有四处依赖：宿主侧语言解析（`lib/i18n.js`）、`de_models` 的供应商目录（`lib/models.js`）、会话编排按模型名解析 provider（`lib/session-orch.js`）、以及 `apply()` 里跟随语言切换的监听器（`lib/index.js`）。旧代码在新宿主上不会报错——`settings.get` 不存在时被 `typeof` 守卫挡掉、未知事件名只是永不触发——表现为「语言设置要重启才生效」「供应商目录读不到配置（表格空白）」「spawn 显式传 model 时解析不出 provider」，属最难查的静默降级。新增 `lib/settings-compat.js` 统一封装：老宿主走 `get()`，新宿主用 `describe()` 建一次表再查 `ns`（`makeSettingsReader` 保证「每个 provider 一次 describe」的平方级开销不会出现），读不到一律返回 `undefined` 按未配置处理、绝不抛错；监听器同时订阅新旧两个事件名（`SETTINGS_CHANGE_EVENTS`），两代宿主都能就地跟随。`ctx.get` 本身抛错也吞掉降级（读服务不该带崩 `apply()`）。
- **同类排查结论（本次一并核对，无需改动）**：服务目录 91 项、事件 81 项、`ctx` 继承 API 9 组逐条比对——插件使用的 `tools`/`agents`/`sessions`/`sessionPersistence`/`sessionTitle`/`skills`/`llm`/`webServer`/`workspaceRegistry`/`commands`/`systemPrompt`/`fs`/`approval`/`attachments` 方法集**零删减**；被移除的 `agent/session-start`、`settings/updated` 事件与 `codeRuntime`/`e2b`/`ctx.hmr` 插件均未使用；会话格式 `SESSION_FORMAT_VERSION` 3 → 4 由宿主按「世代文件」（`session.v4.jsonl.zstd` 旁挂，v3 原文件保留）自动迁移，插件按事件 id 记录的书签锚点不受影响；客户端模块加载契约（`window.__ModuleLoader__.load({id, factory})`）、静态模块表（react / react-dom / `@deepseek-ai/dsh-client-ui-primitives`）、`ctx.slots.inject/register`、客户端 `locale.bind/register` 全部未变。`agent/created` 仅返回值类型放宽为 `undefined | Promise<undefined>`，插件监听器同步返回，兼容。
- **供应商目录读取兜底**：`de_models` 与会话编排原来直接调用 `ctx.settings.get(...)`（`lib/models.js` / `lib/session-orch.js`），新宿主上会直接抛 `TypeError`；现改走兼容层，并保留原有的「读不到就按未配置处理」语义（不改变表格与 provider 解析的行为，只换读取通道）。
- **客户端崩溃级适配一：ui-primitives 图标导出被改名（旧名不是别名、是删除）**：DSH 0.2.0-rc.1 把图标导出从**尺寸后缀**改成**字重后缀**——旧 `IconWarningOutline16` / `IconChevronDownOutline14` / `IconFolderClose16` / `IconLoadingOutline16`，新 `IconWarningOutlineRegular` / `IconChevronDownOutlineRegular` / `IconFolderCloseRegular` / `IconLoadingOutlineRegular`（另有 `…Medium` = 1.3px 描边、`…Artwork` = 单图元）。旧名在新宿主上 `git grep` 零命中，即**彻底删除**；`import { IconWarningOutline16 }` 拿到 `undefined`，React 渲染 `undefined` 组件立刻抛 "Element type is invalid"，**技能管理 Tab 与画板 Tab 整块 UI 崩掉**（只在升级后才暴露，本地测试与宿主端日志都看不到）。新增 `src/client/ui-icons.ts` 跨版本解析层：`resolveIcon(新名, 旧名)` 按「`…Regular` → 旧 `…16`/`…14` → `…Medium` → 渲染 null 的空实现」四档解析，两代宿主共用同一份 bundle；`SkillsBrowser.tsx`（12 个图标）与 `CanvasView.tsx`（2 个图标）改为从这里 import，`src/client` 下不再有任何文件直连 `@deepseek-ai/dsh-client-ui-primitives`。新旧 `…Regular` 与旧 `…16` 同为 16×16 viewBox、默认 `size=16`，视觉一致。
- **客户端崩溃级适配二：切换会话入口 `sessions.open` 被移除**：旧宿主 `ctx.sessions.open(id)`（`ClientSessions.open`，0.1.5-rc.2 的 `packages/api/session-controller/src/client/sessions/service.ts:270`）在 0.2.0 里被删掉（同文件只剩内部 `waitForOpen`/`attachOpening`），官方改走 `ctx.uiWorkspace.openSession(id)`（官方 `ui-chat/src/client/apply.ts` 同款迁移）。旧写法编译期无感、加载期不报错，**只在用户点「跳转到会话」时抛 `TypeError: ctx.sessions.open is not a function`**（站内通知铃铛跳转、画板 footer「跳转」按钮）。新增 `src/client/client-compat.ts` 的 `openSessionCompat(ctx, id)`：老宿主优先走 `sessions.open`（行为一字不变）、新宿主回退 `uiWorkspace.openSession`、两者都不可用返回 `false`；两处调用点（`src/client/index.ts`）改走它，`ctx.get` 抛错也吞掉。

### 变更

- **内置技能 `memory-consolidate` 升 `x-version: 2`（外部 PR #58 第三项，按原文摘取）**：补四类实战边界——① **同一轨的写操作串行执行**（同一个 `.md` 是读-改-写，交错执行会互相覆盖、也会撞上 drift guard；一个簇处理完再动下一个）；② **`replace` 是整条替换**：`content` 必须给完整新全文，只传增量或新句子会**静默吞掉**其余段落（2026-09-16 实证：更正一条多段记忆时只写新句子，其余段落整条丢失，靠 memories 仓库的 git 备份才找回；改写前先用 `list`、key 轨可用 `expand` 把原文读全）；③ **key 建议用 memory 工具 `add`（`target=key`）提交，不要用 `memory_suggest`**（后者 target 白名单不含 key，传入即报「不支持 target=key」）；④ 新增「四、故障处理（异常兜底）」——drift guard 报「无法解析往返」拒写时的逃生路径（先备份 → 用插件自带 `lib/store.js` 做 `serializeEntries(parseEntries(text))` 规范化并校验往返条数不变 → 回到工具流程），以及「判断条目是否粘连只认 `parseEntries(text).length`」（用正则数 `\n§\n` 会因正文里逐字引用的内容性 `§` 假阳性）。技能正文取自 PR #58 的 `d78043d`，与该提交逐字节一致。**注意：这一项只有在本版之后才真正装得上**——此前 CRLF 检出下 `skillVersion()` 解析出 0、版本门控退化成"永远相等"，Windows 上 x-version 升级是静默失效的（见上）。

### 测试

- 新增 `tests/injection-source-kind.test.js`（4 例）：① 复刻宿主 v4 准入规则并做**前提自检**——该规则必须拒绝退役写法、且通过 canonical 写法，否则后面的断言都是假绿；② `PLUGIN_SOURCE_KIND` 的形状与准入；③ 扫描 `lib/` 不得残留退役写法；④ 扫描四处注入点必须引用同一常量（防未来新增注入点时又手写一份 kind）。行为侧证据落在既有用例上：`tests/coi.test.js`（会话广播 / 房间动态 / COI 完成通知）与 `tests/ws-coord.test.js`（写冲突 `additionalContexts` / 公告板）直接断言真实构造出来的消息对象满足 `source.kind === PLUGIN_SOURCE_KIND` 且 `source.plugin === undefined`；`tests/plugin.test.js` 与两个 advisor 用例里按旧写法构造的桩数据同步更新。
- 新增 `tests/store-display-match.test.js`（12 例）。关键设计：展示文本取自**真实的 `buildMemoryFiles()`**，测试里没有复刻一遍剥离逻辑——展示层将来再剥一种新元数据时，这些用例会跟着一起红，而不是"测试全绿、线上仍坏"。覆盖：`normalizeForMatch` 只剥头部（正文里的 `[summary:…]` 字面量不动，且两条只差该字面量的条目仍分得清）；主轨删除 / 编辑（时间戳与摘要原样保留）/ 分支范围 / `[dsh-only]` 四个精确操作；`peekExact` 返回磁盘原文；归档页删除（带 summary 与**只有 `[id:…]`** 两种，后者单独钉一条）；归档重复条目取首条；`promoteArchived` 转正后**断言归档文件已清空**（防"只修 hits 不修 remove"的半吊子修复）；以及"归一化后多条命中 → 保守拒绝、一条都不动"。已验证：把 `normalizeForMatch` 退回旧的"只 stripEntryId"行为后，12 例中 5 例必失败。
- 新增 `tests/sync-git-timeout.test.js`（7 例，其中 1 例 POSIX 专属）：注入**永不 emit `'close'`** 的假子进程（等价于"孙进程占着管道"），用 `mock.timers` 按真实阈值推进，断言「未到点不得 settle」「到点必须 settle 且带超时说明与命令行」「迟到的 `'close'` 不得把结果翻案成成功」「两路管道被 destroy」「正常路径与 spawn 报错不受影响」。为避免回归退化成**挂死**——旧实现下 Promise 永不 settle，直接 `await` 会让测试进程一直挂着而不是报错——等待改用 `setImmediate` + `Date.now()` 轮询的真实时间预算，超预算直接抛出明确断言。另加一条 POSIX 专属用例：真实 detached 子进程 + 真实孙进程（正是 `git → git-remote-https` 的形态），验证 `kill(-pid)` 把整棵树清掉；Windows 没有进程组信号（也没有 SIGKILL 语义），跳过——Windows 上的保证是"调用方不再被拖住"，孙进程可能活到它自己超时。已验证：把超时回调退回旧的"只 kill 不落定"，7 例中 4 例必失败，且是**明确的断言失败而非挂起**。
- 新增 `tests/skills-sync-default-dir.test.js`（6 例）：① `DEFAULT_SKILL_DIR` 与 `resolveConfig({}).skillDir`、`resolveConfig({ skillDir: null }).skillDir` 必须一致（哨兵解析只有一处权威，防两处定义漂移），显式配置不被覆盖；② `syncBuiltinSkills(ps, null | undefined | '')` 抛的错必须点名 `userSkillsDir`、指出正确做法，且**不含** Node 的 `The "path" argument must be of type string`；③ 打包守卫——`BUILTIN_SKILLS` 每一项都必须真的在插件包 `skills/` 里且有含 name/description 的 frontmatter（把运行期静默的 `action: 'missing'` 变成红测试）；④ 用插件包真实内容同步：五项全部落盘、零 `missing`、二次全 `unchanged`；⑤ **CRLF 下 x-version 升级必须生效**（把新版正则退回 LF-only 后该例必失败——已验证）；⑥ `normalizeSkillText` 在 CRLF 下不叠加第二份 frontmatter，缺字段与未闭合仍要报错。
- 新增 `tests/skills-sync-decoupled.test.js`（8 例）：源头在包内（`PLUGIN_SKILLS_DIR` 指向仓库 `skills/` 且五项齐全）；**`coiEnabled:false` 不影响同步**（issue #58 的要害）；`coiSyncSkills:false` 是唯一关断开关（`coiEnabled:true` 也照样不同步，且连技能库目录都不创建）；`skillDir` 哨兵落到 `DEFAULT_SKILL_DIR`（用**空的内置源头**避免写入真实技能库，目标目录改由日志行断言）；同步抛错收口成一条带原因的 warn 并返回 null；每次启动都汇报结果（含最常见的"共 5 个，更新 0 个"）；源头缺失时逐个记 `missing` 并 warn；目标路径被同名文件占位时同样收口不抛。
- `tests/plugin.test.js` 新增两条**装配级**用例（跑真实 `apply()`）：`coiEnabled:false` 时五个内置技能必须落盘、`coiSyncSkills:false` 时连技能库目录都不创建。已验证「摘掉主装配调用」后第一条必失败。同文件的快照用例补上第二项的断言：key 建议必须点名 `memory 工具 action=add`，且不得出现 `memory_suggest target=key`（防止文案退化回"没写工具名"）。
- 新增 `tests/settings-compat.test.js`（13 例）：老宿主 `get()` 路径、新宿主 `describe()` 路径、服务缺失 / `get` 抛错 / `describe` 抛错 / 返回非数组 / 空 `ns` 一律 `undefined`、`makeSettingsReader` 的批量语义（新宿主只 `describe()` 一次；老宿主每次实时 `get()`）、事件名常量、`resolveLocale` 在新老两种形态下都解析出 `en`。
- `tests/plugin.test.js` 新增 1 例集成用例：`apply()` 在 get 形态与 describe 形态两种 settings 服务下、监听 `settings/updated` 与 `settings/document-updated` 两个事件名都能就地切换语言（`document-updated('models')` 不得误改语言）。
- 新增 `tests/client-icons-compat.test.js`（5 例静态护栏）：除 `ui-icons.ts` 外禁止任何 client 源文件 import ui-primitives；TSX 里禁止残留 `…16`/`…14` 旧名；shim 里旧名只能作为 `resolveIcon` 的兜底参数出现；每个 `resolveIcon(新名, 旧名)` 的新名以 `Regular` 结尾、旧名以 `16`/`14` 结尾；构建产物 `lib/client.js` 同时带新旧两套名字（证明解析分支没被静态折叠）。
- 新增 `tests/client-compat.test.js`（6 例）：`openSessionCompat` 在「有 `sessions.open`」「只有 `uiWorkspace.openSession`」「两者都无」「空 id / 抛错的 `ctx.get`」四种情形下的选择与降级；`src/client` 里禁止再出现 `ctx.sessions.open(...)` 直调（注释除外）；产物里同时含 `uiWorkspace` 与 `openSession`。该用例直接 import `src/client/client-compat.ts`（Node 22.18+ 原生剥离类型，无需构建）。
- 全量 842 例通过（840 存量 + 2 新增文件）。

---

## 2026-09-15

### 修复

- **记忆正文被同步链路持续损坏成 U+FFFD 替换字符（根因，阻塞级）**：MEMORY.md 与 daily 日志里长出 `�`（线上实证 45 处、跨四天静默累积；本机 4 个 daily 文件 11 处），格式预检（`isCanonical`/parse→serialize 往返）**照样放行**，所以一直没人发现。根因在**同步读路径**：`runGit()`（`lib/sync/repo.js`）收集子进程输出用的是裸 `String(chunk)` —— Buffer 的 `String(chunk)` 等价于 `chunk.toString('utf8')`，即**每个管道分块各自独立解码**；git 大对象按 32 KiB 块写管道，任何跨块边界的多字节字符（汉字 3 字节、emoji 4 字节）都被切成两段无效序列、各解码成一个 U+FFFD。传播链：`readTreeFiles()`（读远端 theirs / merge-base base）→ 损坏文本进场 → `mergeEntries` → 写回 → 提交 → 下次同步再把损坏读回来继续切，**逐轮累积**。法证：损坏文件所在提交的两个父提交都是 0 处损坏，合并结果却有 2 处，下一轮 2 → 3；4 个损坏文件的干净版本里，损坏字符起始字节偏移为 32766 / 32767 / 32766 / 81913 ——前三个**恰好跨越字节 32768**。修复：改为 `setEncoding('utf8')` 流式解码（Node 内部 StringDecoder 在分块边界保留半截序列、由下一块补齐）。同款问题一并修掉三处：`lib/sync/index.js`（worker 子进程 stdout/stderr，stdout 末行是 JSON，损坏会导致解析失败）、`lib/search-docs.js`（文档检索 `out += chunk`，损坏字符进检索结果）、`lib/coi/scheduler.js`（COI 任务日志，启动/恢复两条路径，损坏字符直接落进用户看的日志）。`runGit()` 顺带新增 `opts.spawnFn` 注入点（测试用，使"分块边界"可确定性复现）。
- **文档检索输出上限改按 UTF-8 字节计**：`lib/search-docs.js` 的 `maxBytes` 保护此前用 `out.length + chunk.length`（字符串 UTF-16 单元与 Buffer 字节混用）。改用 `setEncoding` 后 chunk 是字符串，沿用 `.length` 会把中文按 1/3 字节少算，故改为独立累计 `Buffer.byteLength(chunk, 'utf8')`。

### 测试

- 新增 `tests/sync-utf8-stream.test.js`（14 例）：注入假 spawn + 手动 `push` 的 Readable，把 2 / 3 / 4 字节字符在**每一个内部切点**分成两次投递（stdout、stderr 各 6 例），加逐字节最坏分块与真实子进程冒烟。每例都带"同一分块序列交给旧的逐块解码必然损坏"的**前提自检**，切点失效会直接失败而不是假绿。已验证：回退解码修复后 14/14 必失败。（第一版回归用真实子进程 + 60 ms 定时分写，经外援复核证伪为**可假绿**——父进程稍慢，两段就被合并成一个 data 事件，已改写为注入式。）

---

## 2026-09-14

### 修复

- **记忆正文里的 `{{...}}` 会把会话「毒死」（issue #53，阻塞级）**：宿主的系统提示词段渲染器把段正文里的 `{{name}}` 当模板变量解析，**未注册变量直接 throw**（宿主只注册 `provider`/`model`/`cwd`）。而 `memory:snapshot` 段把会话标题/别名、`memory`/`user` 轨、项目 KEY 轨的**原文**直接拼进去，此前只对提示词注入轨做了净化——于是记忆里出现一个字面量 `{{xxx}}`（真实案例：记录 `x-opencode-session: {{session}}` 这条事实）就等价于给所有注入该轨的会话埋雷：**该会话每一步、每一轮都起不来，且无法用 memory 工具自救**（工具调用需要回合，而回合已经起不来），只能手改记忆文件。现改为**整段快照在离开插件前统一净化**：`sanitizeSnapshotBody` 新增 `expand` 选项——注入轨保持 `expand=true`（用户写的就是待展开模板），记忆轨与整段快照用 `expand=false` **只降级不展开**（记忆里的 `{{date}}` 是用户记录的字面事实，展开会篡改内容；降级为 `{date}` 既保语义又让宿主不再解析）。`buildMemoryContext`（只喂外部 COI 执行器、不经过宿主渲染器）不做净化。渲染侧净化意味着**升级插件后已中毒会话自动恢复**，无需改动用户数据文件。
- **advisor 启用后每回合报 `TypeError: events is not iterable`（issue #49）**：与 issue #42 / PR #38 同源——DSH 0.1.2-alpha.4+ 的 `Session` 不再暴露 `.events` 数组，当时修了 `lib/review.js` 却漏了 advisor 装配层的 `session/event` 接线，监听器把 `undefined` 转给 observer，`findLastMessageTurnEnd` 对其做 `for...of` 即抛错。现沿用同款三档兜底 `session.ownEvents?.() ?? session.events ?? []`（新宿主走 `ownEvents()`，老宿主回退 `.events`，都拿不到时给空数组）。

### 新增

- **内置技能 memory-consolidate：记忆合并梳理（外部 PR #50）**：把随时间累积出的重复条目、新旧并存版本、相近分散表述，按七条标准（覆盖更新 / 相近合并 / 字面去重 / 冲突裁决 / 项目经验下沉 / 过期状态清理 / 跨轨归位）整合归档。硬边界：只走 memory 工具（`replace`/`archive`/`add`，禁直改 `.md`、禁 `remove`，保证可逆）、daily 日志与待办不参与合并、key 轨新增仍走用户确认队列。附带零依赖只读预扫脚本 `scripts/scan_memory.mjs`（`§` 条目解析 + CJK 二元组 TF-IDF 相似度 + 覆盖线索 + 冲突极性聚簇），只做候选发现、不做裁决与写操作。

### 变更

- **收尾规则改为两步式：先记记忆、再输出完整回复（外部 PR #52）**：原规则要求把完整回复与 memory 工具调用放进同一条消息，但 DSH 中**带工具调用的消息结束不了 turn**，必然逼出一条多余的收尾消息；而 `transcriptView` 默认 `compact`（折叠已完成 turn 的过程、突出最终输出）高亮的是**最后一条**消息，于是高亮到的是那条无意义收尾而不是完整回复。现改为：① 本条消息只发写入工具调用（不写正文）→ ② 下一条消息输出完整回复（无工具调用，结束 turn）。完整回复因此成为最后一条、被 compact 正确高亮。注意 `snap.turnEndHead` 文案里不出现 dtodo 字样——该行不受 `todoEnabled` 控制，待办的收尾指导由受控的 `snap.todoHint` 单独承担。
- **内置技能同步升级为「整目录复制」（外部 PR #50）**：此前同步只复制 `SKILL.md`，现改为整目录（`scripts/` 等辅助文件随技能一起分发），版本门控与用户编辑保护语义不变（目标 `x-version` 不低于内置时不覆盖）。**行为变更**：版本升级时目标目录会被先清空再复制，用户自加在内置技能目录里的文件会被删除。

---

## 2026-09-09

### 修复

- **「Memory Evolve 设置」里勾选「记忆写入看门狗」保存后刷新即失效**：`MemoryQueueView.saveConfig()` 手工拼了一个固定 patch 对象发给宿主，键列表是**手写**的——`perTurnWriteGuard`（看门狗开关）与 `writeGuardThreshold`（阈值）有控件、`draft` 绑定也在（勾选立即变化），却没进 patch，于是 POST body 里根本没有这两个键，宿主 `updateRuntime()` 收不到、`plugin-state.json` 不落盘，刷新后 GET 回显仍是默认 `false`；因为界面读的是本地 draft，保存瞬间还显示「配置已保存」，问题只在刷新后才暴露。修复：把两个键补进保存 payload（TS 源码 + 构建产物 `lib/client.js` 同步重建），并新增回归测试 `tests/client-config-save.test.js` 钉住「面板 draft 绑定键 ⊆ saveConfig 发送键」这条契约（同时断言源码与产物键集合一致，防「改了源码没重建」），已验证还原修复后该测试必失败。

---

## 2026-09-08

### 修复

- **记忆 Tab 子导航被 DSH 宽度手柄遮挡、部分元素无法点击（issue #40）**：DSH 0.1.2-rc 起会话列两侧渲染「拉宽」用的宽度手柄（absolute 全高、z-index 8、拦截点击的 col-resize 竖条，元素带 `data-width-handle`，宽度 `min(40px, (100% - --dsh-chat-content-width)/2 - 48px)`）。插件的管理 Tab 是**占满整列宽**的面板（不随 `--dsh-chat-content-width` 收窄），把对话框拉宽后手柄条正好压住顶部子导航行（指南 / 全局规则 AGENTS.md …），元素被遮挡、点击被手柄拦截。修复思路与 DSH 官方对全宽 overlay 视图的先例一致（官方在 `ConversationRoot.module.css` 用 `.root:has([data-conversation-composer-overlay]) .widthHandle{display:none}` 关掉手柄），插件侧新增 `[data-phase]:has(...) [data-width-handle] { display: none }`，**一次覆盖全部 11 个 Tab 的根容器**（`.mt-panel` 记忆/技能/待办/设置/模型/同步、`.me-panel` UI 设置/版本/指南、`.coi-root` COI、`.bb-pane` 广播、`.pm-root` 提示词、`.bm-panel` 书签）——任一插件 Tab 挂载期间隐藏手柄，切回会话等视图自动恢复；拉宽偏好（`--dsh-chat-user-width`）本身不受影响，回会话 Tab 仍可拖拽。选择器用 `[data-phase]` 属性而非 CSS-module 哈希类名（`.root` 被哈希化选不中），该属性在 DSH 里非唯一但其它持有者不含上述根容器，不会误伤。
- **子代理快照不再注入 dtodo 收尾提示（issue #43）**：`snap.todoHint`（「收尾时调用 dtodo list 检查到期……有到期未完成项就在回复末尾提醒用户」）是**面向真人会话**的职责——子代理不向用户直接交付（结果回父会话），也不该替父会话提醒待办，注入只会诱导它多调一次 dtodo 白烧 token。同一函数内 review 计数、写入看门狗、收尾标题、写入文案早已按 `isSubagent` 降级，唯独此处漏了豁免。补齐后子代理快照不含任何 dtodo 收尾指导（头部工具清单的事实陈述保留：dtodo 工具对子代理确实注册可用）。新增回归测试，已验证「还原修复后测试必失败」。
- **review 每回合报「turn-stopping 处理失败：Cannot read properties of undefined (reading 'length')」（issue #42）**：DSH 0.1.2-alpha.4+ 的 Session 不再暴露 `.events` 数组，旧代码读取得到 `undefined` 后取 `.length` 抛 TypeError，经 `turn-stopping` 的 serial dispatch 冒泡，被插件的 try/catch 隔离成一条不影响回合的告警。改用 `agent.session.ownEvents?.() ?? agent.session.events ?? []` 三档兜底（老宿主回退 `.events`）。该修复此前只存在于开发轨，**本版本首次随发布交付**——只更新到上一个发布 tag（v26082401）的用户仍会看到这条报错。
- **headless profile 无法加载：依赖仅 web 运行时提供的 workspaceRegistry 服务（issue #35）**：该服务从硬性 `inject` 列表移除，改为 `ctx.get` 按需读取 + 局部注入，headless profile 不再因缺服务加载失败。
- **会话书签星标在 DSH 0.1.1-rc.2+ 全站失效（issue #39）**：官方重构了 `data-chat-anchor-key`（`node:{seq}` → `{kind.length}:{kind}{id}`，key 不再携带 seq），星标注入/列表/跳转/分支全链路失效。改为按锚点原文通用切分 kind/id（不硬编码 kind 名）+ 会话事件日志反查 `{seq, turn}`，旧记录按 seq 回退兼容；顺带修复 fork seed 的 seq 空洞越界（seq≠数组下标导致中间轮分支退化为全量复制）。
- **全盘 dir 搜索卡死（外部 PR #32）**：WALK_IGNORE 补 Windows 系统目录、maxFiles 截断后清空 pending 队列（防数千微任务级联）、defaultRoots 盘符去重。
- **Windows 下技能采纳跨盘失败**：`memoryDir`（D:）与 `skillDir`（C:）跨盘时 `renameSync` 抛 EXDEV，降级为 `cpSync + rmSync`，其余错误照抛。
- **移动端「Memory Evolve 设置」页长文本/控件溢出（issue #31）**：配置说明等无空格长串加 `overflow-wrap: anywhere`、控件加 `max-width: 100%` + `box-sizing: border-box`（不依赖移动通道，普通移动浏览器同样修复），并补上移动通道漏掉的 `.me-todo-select` 全宽规则。

### 新增

- **MEMORY.md / USER.md 页签支持手动新建记忆条目（issue #30）**：此前各文件页签中只有项目关键记忆 KEY.md 有手动添加框，用户最想随手记的长期记忆（MEMORY.md）与用户档案（USER.md）是纯只读——想让 AI 记住某条偏好/环境只能靠反复口头交代或等自动沉淀。新增 `POST /memory-evolve/api/memory/memory` 与 `/memory-evolve/api/memory/user` 端点（与 KEY 同款 `store.add` 盖戳追加，日期前缀由程序生成），前端 MEMORY.md / USER.md 页签顶部渲染同款添加框，草稿按文件分桶（切页签不丢内容），保存后清空草稿、刷新列表并提示。

> 本版本还包含 **2026-09-04** 记录的「记忆写入看门狗」与「广播投递即唤醒（wake 参数）」两项新增（见下）。

---

## 2026-09-04

### 新增

- **记忆写入看门狗（长会话防遗忘，吸收 PR #37 特性一）**：长会话中模型对「每轮收尾写 daily/project」的固定提示词逐渐失效（指令稀释），连续多轮不写记忆且程序侧毫无反馈，遗漏被静默吞掉。新增程序侧合规追踪：按会话统计「连续完成多少个用户回合未写任何 daily/project 记忆」（`writeGapCounter`，`agent/turn-stopping` 计数、subagent 不计、进程内存态），缺口达到阈值（`writeGuardThreshold`，默认 2，可在「Memory Evolve 设置 → 配置」调整）时快照注入置顶 ⚠️ 提醒，粘性直到下一次成功写入即消（key 轨确认队列不算——看门狗只盯每轮进展日志）。提醒文案刻意静态（不嵌实时计数）+ 按实际启用的写入轨参数化（单轨关闭不命令写已关轨）。**独立开关 `perTurnWriteGuard`，默认关**（用户拍板 2026-09-04：根源是模型指令遵循能力，强遵循模型不需要；打开才启用）。
- **广播投递即唤醒（de_broadcast send wake 参数，吸收 PR #37 特性二）**：研究「为什么广播有时能唤醒会话、有时不能」——根因在 DSH 核心的投递原语：广播投递一律用 `inject`（不唤醒），接收方 **running 时同回合可见（像被唤醒）**、**idle 时消息停在收件箱直到下次自然驱动（没动静）**、**offline 直接跳过**——三种状态三种观感。新增 `wake: true`（send 可选参数，默认 false 行为不变）：idle 接收方改走 `followup` 唤醒（投递到下一回合并启动驱动，等价替用户发消息，与 de_session wake / COI wakeOnComplete 同款机制；消息体带「发送方唤醒了你」标记）；running 接收方仍 inject（不打断）；offline 跳过（收件箱 + 回来补投兜底）。回执**始终**附「已唤醒 N 个空闲接收方」计数（含 0）。投递按接收方独立容错 + Set 去重（房间/项目/显式接收者重叠不重复投递、单点失败不中断）。经 Codex 独立评审与本地 DSH 0.1.2 源码实锚验证（Agent.followup/status/wakeDriver 语义成立）后合入。

---

## 2026-08-17

### 修复

- **Code Mode 启用提示词管理器后整轮失败（issue #13）**：`de_prompts` 工具参数说明不再携带宿主可解析的双花括号语法——工具 Schema 被序列化进 `tools:sdk` 系统提示词段后，说明文字中的 date/time 模板示例会被误当作未注册的 prompt variable，触发 `unknown prompt variable "{{date}}"` 并阻断后续所有回合。说明改为单花括号写法（功能不变：用户提示词正文中的 `{{date}}`/`{{time}}` 展开不受影响）。同批清理 `de_session` 工具描述中的同类残留（`{{model}}` 示例改为纯文字）。新增回归测试确保模型可见的工具 Schema 不再泄漏该语法。

---

## 2026-08-14

### 修复

- **版本更新后「当前版本」显示旧版本号**：更新成功的设备重启后，版本页出现「当前版本」仍为旧版、状态却显示「已是最新」的冲突。根因是更新事务的 fetch 使用 `--no-tags`（新 tag 只进私有引用、不落本地 refs/tags），而本地版本标识依赖 `git describe` 只能找到最近可达的旧祖先 tag。现已改为按 commit SHA 判定：HEAD 精确匹配任一发布 commit 时直接取该 commit 的发布 tag（开发轨已包含发布版本时显示最新 tag），不再信任 describe 结果；更新事务检查点同步落盘新版本号与「已是最新」状态。
- **更新成功后远端复核失败会误留更新红点**：checkout 成功后的远端重检失败不再把状态回退为 outdated（本地版本关系已由 SHA 核验确定，重检失败只记录错误信息）。
- **缓存期内手动切换版本/恢复开发轨状态陈旧**：24h 检测缓存命中时增加本地 HEAD 校验，本地提交变化立即失效重检，不再出现最长 24 小时的状态错报或假「等待重启」提示。
- **旧缓存版本号自动自愈**：已带错误版本号缓存的设备，升级后打开版本页立即显示正确版本，无需等待自动重检。

---

## 2026-08-13

### 新增

- **无限画板**：把散落各处的文件/文本/图片/音视频集中到一块无限画布上陈列的素材工作台。本地路径引用（文件留原地）、单板+视角筛选（会话/项目/全局 + 归属徽标）、无限平移缩放（LOD/虚拟化/GPU 合成性能底座）、三种上板入口（路径/便签/真实本地搜索）、画板内直接预览/复制/引用、卡片自由拖拽与右下角缩放、AI 双向（`de_canvas` 工具：按 id 查/读、往画板中央区放便签，不注入上下文）、整板 rev 乐观锁防多会话覆盖。独立子模块 `canvasEnabled` 开关，存储 `<memoryDir>/canvas/boards.json`。
- **web 站内通知**：`de_notify` / `de_channel_send` 新增 `web` 渠道——通知直达网页右上角铃铛，支持未读徽标、弹窗列表、全文查看、附件缩略图、一键跳转对应会话。
- **COI 任务列表分页**：GUI 任务子 Tab 分页浏览，任务记录多时不再一次性全部渲染。

### 变更

- **临时信息（scratch）模块移除**：画板内便签（markdown/纯文本节点，内容存画板内）已覆盖其能力，删除「临时信息」Tab、`scratchEnabled` 开关与 `/api/scratch` 路由；已有 scratch.md 内容保留在记忆目录，未自动迁移。

### 改进

- **通知机制重构——快照不再被其他模块反复拉动重注入**：COI 任务（已发起/完成）、工作区公告板（并行开始/结束/成员变化）、会话广播（新消息/房间动态）全部从上下文快照移出，改为**独立消息投递**（不打断正在进行的回合）；快照只保留身份、记忆与纪律等稳定内容。各模块变化不再连带整段快照重复注入，上下文更干净。
- **COI 完成通知只给状态与日志路径**：任务完成/启动消息不再附带日志截取摘要（长日志时截取落在正文中段、看不出结论），直接给出完整日志文件路径，AI 用 read 读取全量输出；`de_coi_status` 只查状态/取路径。
- **工作区公告板防抖**：只在真实状态变化时通知（并行开始/结束、成员变化、备注变化），会话正常运行期间不再反复刷新。
- **记忆同步改为纯 GUI 操作**：移除 `/memory_sync` 命令与快照同步状态行——同步完全由你在「记忆同步」Tab 手动触发，AI 不再参与同步执行。
- **版本检测启动即触发**：插件启动后后台自动检测一次新版本，设置 Tab 红点不再依赖手动打开版本页。
- **通知铃铛全面打磨**：SVG 图标、位置避让、移动端适配；弹窗优化（标题颜色 / 会话名称显示 / 长文大弹窗）；列表分行布局 + 已读按钮 + 标题跳转；邮件式去重、空行折叠、拖拽吸附、配色统一。
- **兼容 DSH 0812 内测版**：适配核心服务名改名（workspace→workspaceRegistry、httpServer→webServer），对外行为不变。

### 修复

- **记忆归档安全**：归档改为「先写入归档文件、成功后再删除主轨」——归档写入失败时主记忆原样保留，不再丢数据。
- **待确认建议序号对齐**：建议队列按热度排序后采纳/拒绝仍按原始序号处理，不再误操作其他条目（误采纳/误拒绝）。
- **记忆同步可靠性**：冲突解决可安全重试（git 失败不再残留半完成状态、不重复写入条目）；远端身份校验更严格（远端分支存在但身份文件缺失/损坏时拒绝合并）。
- **会话切换不再串台**：记忆 Tab 的文件列表与页签选择按会话隔离，切换会话后不再显示上一个会话的内容。
- **待办逾期判定**：改用本地日期（东八区晚上「今天」的截止不再被误标为逾期）。
- **共享记忆库地址回显**：不再误显示主代码仓库地址（避免把共享库配置改成代码仓）。
- **模型设置入口**：关闭「支持思考」后仍可重新打开编辑器（不再无路可回）。
- **手机端工具栏**：加号/模型按钮不再因增强未就绪而永久消失。
- **COI 任务恢复**：重启后不再残留「会话忙」假锁；长任务输出扫描缓冲设上限，不再无限吃内存。
- **会话评审**：总闸关闭后停止后台每秒轮询（重开自动恢复）；重置评审员时旧评审结果不再写入已清空的新会话。
- **工具描述与实际行为对齐**：工作区锁的保留时长描述修正（30 秒 TTL）、提示词与广播参数说明修正（重复键不再覆盖语义）。
- **通知详情截断**：点开通知总是拉取全文，修复 200~8KB 中长通知显示不全。
- **会话评审开关体系**：`advisorEnabled` 改为模块总闸（设置 Tab 关闭即整体停用）；修复会话级开关刷新页面后丢失；各会话默认关闭（opt-in），总闸开启后需在悬浮面板手动启用。

---

## 2026-08-12

### 新增

- **会话评审（Advisor）模块**：每个会话挂独立评审员，实时观察用户输入与回复，按 info / nit / concern / blocker 四级给出反馈；支持五层约束（系统提示词 / 全局 / 项目 / 会话 / 评审会话）；管理面板含约束 / 实时 / 记录 / 设置四个 Tab，可指令问答、查看评审员上下文规模、一键恢复默认提示词。
- **版本检测与更新**：自动检测远端新版本（git tag），设置 Tab 新增版本页（当前版本 / 最新版本 / 更新按钮 + 红点提醒）。
- **任务完成自动唤醒**：`de_coi_dispatch` 新增 `wakeOnComplete` 参数——任务完成后自动唤醒派单会话投递完成摘要，无需用户手动触发。

### 改进

- **完成唤醒无次数限制**：用户显式要求的唤醒每次都生效，与 `de_session wake` 同语义。
- **COI 输出可追溯**：`de_coi_status` / `de_coi_wait` 输出开头直接给出完整日志文件路径，无需自行搜索。

### 修复

- **提示词注入快照不再被宿主渲染器拦截**：注入正文含 `{{date}}`/`{{time}}` 等变量时，快照段渲染侧统一展开；正文里残留的任意 `{{...}}`（未知变量、malformed 引用）也一并去模板化——宿主 system-prompt 渲染器把段文本 `{{...}}` 当模板变量解析、未注册即报 unknown prompt variable 导致整轮注入失败的问题（issue #6）彻底兜底，旧版本遗留/手动编辑的注入数据同样安全。
- **会话评审四项细节**：实时流清空、悬浮窗默认隐藏、tool-call 按序显示、中文指南文案补齐。

---

## 2026-08-11

### 新增

- **记忆同步（跨设备项目记忆共享）**：项目记忆一键同步到远端，多台电脑共享同一份记忆；三层启用开关（模块 / 项目 / 轨），逐项目 opt-in 默认关闭；条目身份证机制保证双设备合并对齐；GUI「记忆同步」Tab（状态卡片 / 初始化 / 同步 / 冲突逐条解决）。
- **共享记忆仓库**：一个私有仓库装所有项目的记忆，每个项目自动使用专属分支，互不干扰；老仓库自动识别、零迁移。
- **统一单一模式**：记忆远端模型合并——默认复用主代码仓库、也可指定共享记忆仓库，每项目一条专属分支；项目待办（TODOS.md）并入项目记忆轨同步。
- **全局记忆轨**：全局记忆 / 用户档案 / 每日日志 / 待办四轨可跨设备同步（仅共享记忆仓库可用），每轨一条独立分支。
- **图片链路五大能力**：输入框图片直发 IM 渠道（`sessionImage` / `attachmentId` 来源）；COI 派单带图（codex / kimi / grok / hermes）；`de_session` 支持 Agent 预设；`de_models` 展示模型图片输入能力；会话广播图片附件（收件箱缩略图 + 延迟保留转发窗口）。

### 改进

- **记忆同步 Tab 全面重排**：三子 Tab 化（项目 / 全局 / 记忆远端）、统一推拉按钮、设备级启用开关、状态文案「未提交」改「未推送」+ ahead 统计。
- **兼容 DSH 260810 快照**：`dsh.client` 配置迁移、Agent 预设挂载，新会话工具面完整。

### 修复

- **Windows 换行事故**：Windows Git autocrlf 将记忆文件转为 CRLF 导致解析失败——新增 `.gitattributes` 强制 LF + 存量文件无损自愈，双设备同步恢复。
- **全局轨数据安全加固**：修复凭证泄漏、跨轨冲突数据风险、非法路径上传、假 dirty 重复提交等问题；全局推送被冲突拦截后可直接在界面逐条解决。
- **spawn / wake 工具面缺失**：修复 DSH 260810 下新会话与恢复会话缺少 bash / read / write / edit 的问题。

---

## 2026-08-10

### 新增

- **memory 工具多轨批量写**：一次调用同时写每日日志 + 项目日志，收尾合并为一次工具往返。
- **情绪反馈记录**：日志条目可携带用户情绪反馈（正面 / 负面 + 原话摘录），积累后可按任务分类分析满意度。

### 改进

- **大文件保护**：project / daily 无参数查询默认返回最近 50 条并附元数据，记忆 Tab 分页展示，消除长文件截断。

### 修复

- **旧插件迁移引导**：dsh-skills-manager 残留会导致 Web 整页不可用——补充醒目迁移文档与禁用列表自动迁移。

---

## 2026-08-09

### 新增

- **工作区冲突协调**：多会话并行时声明文件 / 服务占用（`de_ws_declare` / `de_ws_status` / `de_ws_release`），写前冲突检测、占用方定向通知、活动感知快照段。
- **会话书签**：每一轮可星标命名，独立列表一键跳回；从任意已完成轮创建官方分支。
- **本地文件搜索内容检索**：`memory_evolve_search_local_files` 支持文件内容关键词检索（可选参数，默认行为不变）；新增四档模式（文件名+内容 / 仅文件名 / 仅内容 / 关闭）。
- **DSH UI 设置模块**：左侧会话列表默认只显示进行中的会话；对话区加宽（约 95%）；消息气泡加宽（约 80%）。
- **立即注入**：提示词可「当前回合立即生效」注入（快照变更 + 插话），只注入一次，不受次数 / 间隔影响。
- **会话编排模块（de_session）**：spawn 程序化创建标准会话、wake 唤醒、status / list 查询；`me` 查自身信息；`rename` 改会话名称 / 别名；新会话自动挂工作区分组。
- **会话广播收件箱**：未读 / 全部 / 已读筛选 + 搜索 + 分页；房间成员在线状态持久化（重启不丢失）。

### 修复

- **内容检索漏搜**：修复全盘上万文档时目标文件扫不到的问题。
- **工作区协调实测迭代**：活动段重复注入刷屏、会话删除后锁残留、显示完整会话 ID 等。

---

## 2026-08-08

### 新增

- **de_prompts 创建 / 修改**：模型可自行创建 / 修改提示词，与 GUI 同一套校验。
- **de_prompts 多维过滤**：按名称 / 分类 / 标签 / 简介过滤，未命中时明确提示是哪个条件没匹配。
- **提示词简介与启用状态**：每条提示词可填简介、可禁用；de_prompts 工具（列表 / 详情 / 注入）上线，AI 可选择合适提示词注入当前会话或作为子任务提示词。
- **memory 工具归档**：AI 可直接归档记忆条目（memory / user / key 三轨）并查询归档内容，可逆。
- **提示词管理器交互升级**：一键预设注入（注入一次 / 持续注入 / 自定义）；临时注入（不建提示词直接注入）；次数 / 间隔自由输入。
- **会话广播房间 / 项目群**：多会话聊天室（成员跨工作目录）+ 项目公告群（按目录可见）；30 天无活动自动清理；房间 / 项目消息保留 30 天供回看。
- **会话广播管理面板**：消息收件箱、房间管理、成员在线状态；踢人 / 解散自动发送系统通知；解散软删除可追溯。
- **会话别名**：给会话起友好名称（≤10 字），快照 / 面板 / 消息显示别名优先。
- **会话搜索（de_session_search）**：搜索本机 Codex 历史会话（按项目 / 关键词，只读扫描、零常驻状态）。
- **会话页 Tab 体系重构**：记忆 / 技能 / 待办 / Memory Evolve 设置四个独立 Tab，每个 Tab 带中英双语指南。
- **会话广播独立模块**：从 COI 调度拆出独立开关与存储目录，互不影响。

### 修复

- **注入文案去歧义**：注入结果按实际行为显示（只注入一次 / 共 N 次 / 持续注入），不再误读。
- **幽灵分类可管理**：分类树中残留的旧分类可正常改名 / 删除（提示词自动迁移）。

---

## 2026-08-07

### 新增

- **提示词管理器**：提示词库 CRUD + 分类树 + 标签 + 搜索 + 使用统计；注入执行器（次数 × 间隔，支持无限 / 一次性 / 有限次）；内置 13 个来自 GitHub 真实提示词库的完整范式。
- **COI 调度模块**：统一调度 kimi / codex / grok / hermes 等外部 CLI——非阻塞后台任务、进度可视化、会话分层管理与恢复、跨 COI 接力、任务模板、用量统计、崩溃恢复；支持自定义 CLI 适配器。
- **临时信息便签**：会话页独立 Tab，持久化 Markdown 便签（跨重启保留）。
- **本地文件搜索**：`memory_evolve_search_local_files` 按文件名搜索本机文档（默认只搜文档类型，全类型需显式开启）。
- **每日待办可查过往**：`dtodo list` 支持 past / expired 查询历史；待办子 Tab 新增「过往」页签（含过期遗留）。
- **记忆条目编辑**：五轨记忆美观视图直接编辑保存（程序标记与分隔符受保护）。
- **建议队列分类**：记忆 / 待办 / 技能建议三个独立待确认 Tab；采纳时可改目标轨（记忆三轨之间）。

### 改进

- **适配 DSH 08-06 profiles 架构**：客户端注册改用 `ctx.slots.inject`，快照提示分区更清晰。

---

## 2026-08-06

### 新增

- **技能管理并入**：独立插件 dsh-skill-browser 整体合并——技能浏览 / 搜索 / 筛选 / 一键禁用启用 / 自定义目录；旧插件禁用列表自动迁移。
- **四轨待办**：生活 / 工作 / 项目 / 每日；四象限 + 截止 + 状态 tag；`dtodo` 工具（add / list / done / update / remove）与默认智能视图。
- **key 轨确认制**：模型写入项目关键记忆先进待确认队列，用户采纳后才写入并注入。
- **项目关键记忆归档**：key 条目可归档至 KEY-archive.md，可逆（可移回主记忆）。
- **git 分支感知**：记忆按分支注入与查询，日志自动带来源分支标记。

---

## 2026-08-05

### 新增

- **初版发布**：分层记忆与自我进化插件——全局事实 / 用户档案 / 项目记忆 / 每日日志四轨记忆。
- **记忆审查机制**：后台审查 + 建议队列（采纳 / 归档 / 拒绝，支持批量）。
- **Web 界面**：设置面板「记忆管理」、会话页记忆 Tab（文件内联视图）。
- **技能自我进化**：`skill_manage` 工具（严格创建门槛 + 待确认队列）。
