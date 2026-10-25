# 记忆目录布局 v3（实现规范）

> 本文件是**实现规范**，不是描述现状。改代码前先读完；有疑问问 Lead，不要自行改规范。
> 适用：`C:\Users\53518\dsh-plugins\dsh-memory-evolve-mod`。
> 目标：分组以 **id 为主目录**，记忆/待办彻底分开，改名 = 一次 rename，删除 = 删一个目录。

## 1. 顶层

```
<memoryDir>/
  .layout-version          ← 内容 "3"（迁移完成的标记）
  .system/                 ← 系统文件与元数据（不再放任何分组数据）
    groups.json
    tools.json
    plugin-state.json
    snapshot-presets.json
    SUGGESTIONS.jsonl
    .vault-version
    advisor/
    projects/<项目id>/PROVENANCE      ← 项目元数据（同步锚点）
    legacy/                            ← 迁移前的旧结构原样搬进来（不删）
  memory/                  ← 记忆分组
  todo/                    ← 待办分组
```

- `memoryDir` 默认 `<dshHome>/memories`，可由配置项覆盖；本规范里所有路径都相对它。
- **除上面三类（`.layout-version`、`.system/`、`memory/`、`todo/`）之外，记忆根下不允许出现其它顶层条目**；迁移时旧分组条目全部搬 `.system/legacy/`。
- **例外：模块数据原地保留**（本次重构不迁，模块代码仍读写记忆根顶层）。迁移器必须把它们分类为 `module-data` 并**跳过**（绝不可搬进 legacy，否则数据"消失"）：
  `models.json`、`aliases.json`、`notifications/`、`session-bookmarks.json`、`pending-skills/`、`canvas/`、`search-docs-index.json`、`broadcast*`、`session-orch/`、`coi/`、`logs/`、`tasks.json`。
  （后续可单独立项把这些也切进 `.system/`，届时迁移器白名单同步更新。）

## 2. 分组目录

### 2.1 记忆（kind = memory）

```
memory/<id>/
  global/<日期?>/<标题>.md
  project/<项目id>/<日期?>/<标题>.md
  session/<会话id>/<日期?>/<标题>.md
  archive/
    global/<日期?>/<标题>.md
    project/<项目id>/<日期?>/<标题>.md
    session/<会话id>/<日期?>/<标题>.md
```

### 2.2 待办（kind = todo）

```
todo/<id>/
  global/TODOS.md       或（日志型）global/<日期>.md
  project/<项目id>/TODOS.md   或 project/<项目id>/<日期>.md
  session/<会话id>/TODOS.md   或 session/<会话id>/<日期>.md
  archive/<同上结构>
```

### 2.3 通用规则

- **日志型**（`daily: true`）多一层日期：记忆是 `global/<日期>/<标题>.md`，待办是 `global/<日期>.md`。
- **daily 创建后不可改**：后端 `upsertGroup` 收到 `daily` 变更一律拒绝（不是忽略，是报错）；UI 不提供任何切换控件（日志型只显示徽标）。
- **归档目录在创建分组时创建**：由 API 层的建组动作执行 —— `mkdir <kind根>/<id>/{global,project,session,archive}` 并各放 `.keep`（防止同步/打包丢掉空目录）。路径层只负责产出路径，不做建目录。
- 记忆与待办**同 id 是两套完全独立的东西**：改一个、删一个都不影响另一个。
- 条目文件名 = 标题清洗后的安全段（沿用现有 `safeSegment` 规则，最长 80，非法字符换 `_`）。

## 3. 路径函数（唯一来源：`lib/groups.js`）

所有路径必须经这些函数产出，**禁止**在别处手拼。

| 函数 | 返回 |
|---|---|
| `systemDirOf(memoryDir)` | `<memoryDir>/.system` |
| `layoutVersionFileOf(memoryDir)` | `<memoryDir>/.layout-version` |
| `memoryRootOf(memoryDir)` | `<memoryDir>/memory` |
| `todoRootOf(memoryDir)` | `<memoryDir>/todo` |
| `groupDirOf(group, ctx)` | `<kind 根>/<id>/<类段>`（见下） |
| `groupArchiveDirOf(group, ctx)` | `<kind 根>/<id>/archive/<类段>` |
| `todoFileOf(group, ctx)` | `<kind 根>/<id>/<类段>/TODOS.md` 或 `<类段>/<日期>.md` |
| `projectMetaDirOf(memoryDir, projectId)` | `<memoryDir>/.system/projects/<项目id>` |
| `stateFileOf(memoryDir)` / `groupsFileOf` / `toolsFileOf` / `presetsFileOf` | 都在 `.system/` 下 |

`<类段>`：
- `global` → `global`
- `project` → `project/<项目id>`，项目 id = `ctx.projectId`，缺省时取 `basename(ctx.projectDir)`
- `session` → `session/<会话id>`（`ctx.sessionId`）

`ctx` 形状：`{ memoryDir, projectId?, sessionId?, date? }`。
缺 `projectId`（项目类）或 `sessionId`（会话类）→ 返回 `null`（沿用现行为）。

## 4. id 规则（校验函数放 `lib/groups.js`，导出给 API/UI 复用）

- 正则：`^[a-z0-9][a-z0-9_-]{0,31}$`（小写字母/数字开头，允许 `_` `-`，总长 ≤32）
- 拒绝保留字：`archive`、`memory`、`todo`、`system`
- **大小写不敏感唯一**（Windows 上 `Memory` 与 `memory` 撞）；比较时统一 `toLowerCase()`
- 同一 kind 内唯一；跨 kind 不冲突
- 内置分组的 id **不可改**；自建分组可改

## 5. 改名

- 自建分组：`renameMemoryGroupId` / `renameTodoGroupId`（或统一 `renameGroupId(memoryDir, kind, oldId, newId)`）
- 实现：校验新 id → 校验同 kind 内不冲突 → `renameSync(<kind 根>/<oldId>, <kind 根>/<newId>)` → 更新 `groups.json`
- 有数据也允许（同盘 rename 是原子的）；目标已存在则**拒绝**（不覆盖）
- 归档在 id 目录内，自动跟随，无需单独搬
- 会话类/项目类的数据都在 id 目录下，因此改名不涉及遍历

## 6. 删除自建分组

- 只删 `<kind 根>/<id>`（含 archive）
- 删除前统计并返回给 UI：
  - `entries`：`global` + 各 `project/<id>` + 各 `session/<id>` 下的 `.md` 文件数
  - `archived`：archive 下同口径文件数
- `locations`：涉及的 `project/<id>` / `session/<id>` **目录数，只计含 ≥1 个 `.md` 的目录**（空目录不计）
- UI 确认框必须显示统计，并要求显式确认；内置分组禁删
- 记忆/待办互不影响（删记忆分组不动 todo 同 id 目录）

## 7. 迁移 v3

入口：`lib/migrate-v3.js`（纯逻辑）+ `scripts/migrate-v3.mjs`（CLI）。

必须满足：
1. **先备份**：整目录冷拷贝到 `<memoryDir>..bak-<yyyyMMdd-HHmmss>`（用户已同意本次备份）
2. `--dry-run`：只输出计划（要搬多少目录/文件、哪些冲突、哪些跳过），不落盘
3. 幂等：重复运行不重复搬（`.system/migrate-v3.state` 记录已完成步骤）
4. 断点：中途失败可续跑
5. 步骤顺序：
   `.system/` 建立 → 搬系统文件 → `memory/`、`todo/` 建根 → 按分组搬数据 → 项目元数据 → 旧顶层条目搬 `.system/legacy/` → 写 `.layout-version`
6. 回滚：用备份整体替换（脚本给 `--rollback <备份目录>`）
7. 迁移后 `groups.json` 里的 id/klass 不变，只改路径

旧 → 新映射：
- `<memoryDir>/global/<id>/…` → `memory/<id>/global/…`
- `<memoryDir>/sessions/<sid>/<id>/…` → `memory/<id>/session/<sid>/…`
- `<memoryDir>/projects/<项目id>/<id>/…` → `memory/<id>/project/<项目id>/…`
- `<memoryDir>/todo/TODOS-<id>.md` → `todo/<id>/global/TODOS.md`
- `<memoryDir>/todo/<id>/<日期>.md` → `todo/<id>/global/<日期>.md`
- `<memoryDir>/sessions/<sid>/todo/TODOS-<id>.md` → `todo/<id>/session/<sid>/TODOS.md`
- `<memoryDir>/sessions/<sid>/todo/<id>/<日期>.md` → `todo/<id>/session/<sid>/<日期>.md`
- 归档：`<…>/archive/<id>/…` → `memory/<id>/archive/<类段>/…`；`archive/todo-<id>/…` → `todo/<id>/archive/<类段>/…`
- `<memoryDir>/projects/<项目id>/PROVENANCE` → `.system/projects/<项目id>/PROVENANCE`

## 8. 启动与兼容

- 启动时读 `.layout-version`：
  - 存在且为 3 → 正常
  - 缺失且存在旧结构（`global/`|`sessions/`|`projects/`|`todo/` 旧语义）→ **不自动迁移**，记录状态，由 UI/CLI 提示"需要迁移 v3"
  - 迁移进行中 → 阻止写入（避免半迁移写坏）
- `groups.json` 结构版本保持 2（不变）

## 9. UI（分组页）

- 日志型分组：显示"日志"徽标，**无任何切换控件**
- 自建分组：`#id` 可编辑（保存时走改名 API），重名/非法 id 给明确报错
- 删除按钮：先请求统计 → 确认框显示"将删除 N 条记忆（M 个位置）＋归档 K 条" → 确认后删
- 分组页顶部显示记忆根路径与布局版本

## 10. 测试要求

- 路径函数：3 klass × 2 kind × daily 两态，共 12 组断言
- 改名：成功/重名/非法 id/内置拒绝
- 删除统计：多会话 + 多项目场景
- 迁移：dry-run 报告、幂等（跑两次结果一致）、断点续跑、回滚
- daily 不可改：后端拒绝 + UI 无控件
