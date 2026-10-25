# Qoder IDE 记忆系统参考（面向 agent）

**数据源**：`C:\Users\53518\.qoder\memories\019fb5cc`（账户存储桶），743 文件 / 742 `.md` / 1 `.lnk`。
**采集口径**：元数据与体积统计 = 全量 742 个 `.md` 脚本扫描；语义结论 = 精读 62/743（global 全 4 个、projects\Global 全 4 个、Qoder-Chats 17 个非空分类各 1~2 个、11 个非空 cwd-slug 项目中抽 5 个、25 个"记忆机制"专题文档）。
**本文档只写现状与可执行结论**。证据格式：`<相对根路径>` + 原文片段。

---

## 0. 全局结构

```
019fb5cc/
├─ global/<分类>/<记忆标题>.md          ← 4 个文件（Quest 侧全局桶）
└─ projects/
   ├─ Global/<分类>/<标题>.md           ← 5 个文件（含 1 个 .lnk；IDE 侧全局桶）
   ├─ Qoder-Chats/<分类>/<标题>.md      ← 675 个文件（主桶）
   ├─ <cwd-slug>/<分类>/<标题>.md       ← 87 个 slug 目录，其中 11 个非空
   └─ <分类>/                            ← 29 个空目录（分类名直接挂在 projects 下）
```

目录语法固定为 **三级**：`root/<scope>/<category>/<title>.md`。

> 证据 `projects\Qoder-Chats\common_pitfalls_experience\Qoder记忆库目录结构与scope_path计算.md`：
> 「Qoder记忆库真实结构为`root/<scope>/<category>/*.md`（如`global/user_behavior`或`projects/Qoder-Chats/common_pitfalls_experience`）。使用`os.walk`扫描时，`scope_path`应取当前目录的父目录相对路径」

| 层 | 数量 | 说明 |
|---|---|---|
| scope=global | 4 | 仅 `user_behavior`(2) / `user_hobby`(1) / `user_info`(1) |
| scope=projects/Global | 4 md + 1 lnk | 全是 `user_behavior` |
| scope=projects/Qoder-Chats | 675 | 17 个分类非空 |
| scope=projects/<cwd-slug> | 20 | 分布在 11 个 slug |
| 其余 76 个 slug 目录 + 29 个分类目录 | 0 | 空壳，只有目录 |

`.lnk`：`projects\Global\user_behavior\user_behavior.lnk`，1825 字节，TargetPath = `C:\Users\53518\.qoder\memories\019fb5cc\projects\Global\user_behavior`（指向自身所在目录的文件夹快捷方式，内容无语义）。

---

## 1. 元数据 schema

**frontmatter 字段全集 = 4 个，742/742 全量存在，无缺失样本、未观察到兜底逻辑。**

| 字段 | 类型 | 取值域 | 必填 | 实测分布 |
|---|---|---|---|---|
| `title` | 字符串（双引号包裹） | 自由文本，6~71 字符，均值 24.1 | 是（742/742） | 唯一值 741，1 组重名 |
| `usage_scenario` | 字符串数组（块序列 `    - "…"`） | 1~7 条，均值≈2.5 | 是 | 2 条=425、3 条=289、1 条=19、4 条=5、6 条=3、7 条=1 |
| `keywords` | 字符串数组 | 2~10 条；中文/英文/中英混排 | 是 | 4 条=328、3 条=145、5 条=228、6 条=21、7 条=11、8 条=4、9 条=3、10 条=1、2 条=1 |
| `source` | 枚举字符串（双引号包裹） | `"user"` / `"auto"` / `"init"` | 是 | auto=704（94.9%）、user=22（3.0%）、init=16（2.2%） |

**无 `id` / `created` / `updated` / `group` / `tags` / `priority` 等字段**——身份与时间不落在 frontmatter（时间戳只能出现在正文里，见 §8）。

### 真实 frontmatter 原文（8 例）

`global\user_behavior\记忆库管理总规范.md`（source=user，3 场景）：
```yaml
---
title: "记忆库管理总规范"
usage_scenario:
    - "任何会话记忆存储"
    - "新增、检索、整理、命名、删除记忆时"
    - "记忆工具选择与分类分级时"
keywords:
    - "记忆"
    - "记忆管理"
    - "存储分级"
    - "UpdateMemory"
source: "user"
---
```

`global\user_behavior\开发踩坑护栏.md`（最大正文 3488 字，source=user）：
```yaml
---
title: "开发踩坑护栏"
usage_scenario:
    - "每次执行命令前: 涉及编码、命令规范、脚本编写/执行、状态取证的任何命令"
    - "执行开发任务时对照"
keywords:
    - "吞输出"
    - "防错"
    - "编码"
    - "踩坑"
    - "开发"
    - "环境"
    - "护栏"
source: "user"
---
```

`global\user_hobby\用户网络工具选型偏好.md`（source=auto）：
```yaml
---
title: "用户网络工具选型偏好"
usage_scenario:
    - "推荐DDNS服务或远程访问方案时"
    - "用户希望简化网络配置流程时"
keywords:
    - "DDNS偏好"
    - "IPv6支持"
    - "免费子域名"
    - "无自有域名"
source: "auto"
---
```

`global\user_info\手机操作系统限制.md`（source=auto，正文 54 字）：
```yaml
---
title: "手机操作系统限制"
usage_scenario:
    - "推荐远程工具或客户端时排除所有安卓 APK 方案"
    - "选择鸿蒙原生应用作为替代"
keywords:
    - "鸿蒙7"
    - "纯血鸿蒙"
    - "无安卓兼容"
source: "auto"
---
```

`projects\Global\user_behavior\思考输出风格_必须使用：简洁精炼、拒绝废话、果断决定、指令冲突果断决.md`（**缩进用 tab，与空格混排**；keywords 含英文条目）：
```yaml
---
title: "思考输出风格_必须使用：简洁精炼、拒绝废话、果断决定、指令冲突果断决断"
usage_scenario:
    - "执行任何任务开局时的思考与输出"
    - "编写记忆、文档、回复等一切自然语言输出"
    - "需要决策时直接给出结论"
keywords:
    - "decisive conflict resolution"
    - "instruction priority"
    - "指令冲突决断"
    - "decision without hesitation"
	-  "高成熟度"
source: "user"
---
```

`projects\Qoder-Chats\common_pitfalls_experience\360_安全卫士拦截_SCM_服务操作但注册表直写可绕过.md`（场景含英文句）：
```yaml
---
title: "360 安全卫士拦截 SCM 服务操作但注册表直写可绕过"
usage_scenario:
    - "Set-Service 报拒绝访问时"
    - "服务被优化软件禁用且无法启动时"
    - "360 环境服务配置排查时"
    - "Configuring Windows services in environments with security software"
keywords:
    - "360 拦截服务操作"
    - "SCM 拒绝访问"
    - "注册表直写绕过"
    - "服务被禁用"
source: "auto"
---
```

`projects\Qoder-Chats\project_ide_configuration\记忆系统按需检索机制.md`（关键词即工具名）：
```yaml
---
title: "记忆系统按需检索机制"
usage_scenario:
    - "理解记忆库的数据加载策略"
    - "排查为何某些详细规则未在当前上下文中显示"
keywords:
    - "记忆树"
    - "按需检索"
    - "memory_overview"
source: "auto"
---
```

`projects\c-桌面映射-文件-电脑教程-小工具合集\common_pitfalls_experience\bat脚本del命令重定向缺失与路径引号缺失（经验证）.md`（`keywords` 6 条）：
```yaml
---
title: "bat脚本del命令重定向缺失与路径引号缺失（经验证）"
usage_scenario:
    - "bat脚本中del命令执行报语法错误"
    - "清理含空格路径的临时文件失败"
    - "批处理脚本静默执行时nul重定向写法错误"
    - "Windows修复脚本安全分析"
keywords:
    - "bat"
    - "del"
    - "重定向"
    - "nul"
    - "路径引号"
    - "cleantempfiles.bat"
source: "auto"
---
```

### 解析器宽容度（可执行结论）

- tab 与空格混排的块序列可被解析（上例 `\t-  "高成熟度"` 未导致解析失败）→ 该 YAML 解析器接受 tab 缩进。
- `title` 内可含 `：`、`、`、`/`、`\\`、`(` `)`、空格（见上例与 `C:\\mount2 系 2019 年系统镜像挂载残留目录的全面调查结论`）。
- `keywords` 允许纯英文与中英混排。

---

## 2. 分类体系

**分类是固定枚举：29 个。global 与 projects 下每个 scope 使用同一套名字，同名同义。**

29 个分类（按 Qoder-Chats 下文件数降序；`—` = 该分类在某 scope 下为空）：

| 分类 | Qoder-Chats | global | projects/\<slug\> |
|---|---|---|---|
| common_pitfalls_experience | 180 | 0 | 有（4 个 slug 用） |
| project_environment_configuration | 146 | 0 | 有（6 个 slug 用） |
| development_practice_specification | 109 | 0 | 有（1 个 slug 用） |
| project_introduction | 75 | 0 | 有（7 个 slug 用） |
| task_summary_experience | 39 | 0 | 有（4 个 slug 用） |
| project_scm_configuration | 28 | 0 | 有（2 个 slug 用） |
| project_ide_configuration | 26 | 0 | 有（2 个 slug 用） |
| development_code_specification | 16 | 0 | 有（1 个 slug 用） |
| project_build_configuration | 14 | 0 | 有（2 个 slug 用） |
| project_tech_stack | 10 | 0 | 有（4 个 slug 用） |
| development_comment_specification | 8 | 0 | — |
| project_dependency_configuration | 7 | 0 | — |
| tool_experience | 7 | 0 | 有（1 个 slug 用） |
| important_decision_experience | 5 | 0 | — |
| project_architecture | 3 | 0 | 有（1 个 slug 用） |
| development_test_specification | 1 | 0 | — |
| learned_skill_experience | 1 | 0 | — |
| user_behavior | 0（目录存在） | **2** | **4**（projects/Global） |
| user_hobby | 0（目录存在） | **1** | — |
| user_info | 0（目录存在） | **1** | — |
| expert_experience | 0（空目录） | 0（空目录） | — |
| history_task_reference_files | 0（空目录） | 0（空目录） | — |
| mcp_experience | 0（空目录） | 0（空目录） | — |
| project_rule | 0（空目录） | 0（空目录） | — |
| skill_experience | 0（空目录） | 0（空目录） | — |
| task_breakdown_experience | 0（空目录） | 0（空目录） | — |
| task_experience | 0（空目录） | 0（空目录） | — |
| task_flow_experience | 0（空目录） | 0（空目录） | — |
| user_communication | 0（空目录） | 0（空目录） | — |

可执行结论：
- 12 个分类全库为空（仍在每个 scope 下预建了空目录）→ **枚举先建目录、按需填充**。
- 命名规则统一：**全小写 + 下划线分词**，词尾命名 `*_experience`（经验）/ `*_specification`（规范）/ `project_*`（项目事实）/ `user_*`（用户属性）。
- 同一分类名在 global 与 projects 下含义相同（如 `user_behavior` 两处都放"须长期遵守的硬约束"）。但**两个桶物理独立、禁止混用**：

> 证据 `global\user_behavior\记忆库管理总规范.md`:24
> 「`projects\Global\user_behavior` 是 IDE 记忆目录，**与 `user` 记忆桶完全独立**，禁止混用。」
> 证据 `projects\Global\user_behavior\记忆库管理总规范_任何会话的第一次记忆存储必须查看本规范.md`:21
> 「全局重要记忆统一存放于 global\user_behavior 文件夹，代号 'user'; 不得与大写 projects\Global\user_behavior 混淆。」

### cwd-slug 命名规则（据 11 个非空 slug + 若干空 slug 归纳）

| 原路径 | slug |
|---|---|
| `C:\Users\53518\Documents\Qoder\2026-08-13\chat-4` | `c-Users-53518-Documents-Qoder-2026-08-13-chat-4` |
| `C:\Users\53518\Desktop\libnetcomm.so` | `c-Users-53518-Desktop-libnetcommso` |
| `C:\桌面映射\文件\电脑教程\小工具合集` | `c-桌面映射-文件-电脑教程-小工具合集` |
| `C:\Users\53518\AppData\Roaming\Clash Nyanpasu\config` | `c-Users-53518-AppData-Roaming-Clash Nyanpasu-config` |

规则：盘符小写去冒号 → `\` 替换为 `-` → 删除其余非"字母/数字/空格/中文"字符（`.` 被删，空格与中文保留）。

> 特例证据 `projects\c-Users-53518-AppData-Roaming-Clash Nyanpasu-config\...`（目录名含空格，不转义）。

---

## 3. 记忆树 / 索引

**磁盘上无任何索引文件。** 743 个文件中文件名含 `index`/`索引`/`总览`/`树`/`规范` 的共 76 个，逐个核对后**全部是内容规范文档，没有一个是目录清单**（例：`README文档结构规范.md`、`DSH_技能目录结构规范.md`、`记忆树结构与工具链配置.md`）。

**索引存在于引擎侧（数据库/内存），不落盘：**

> 证据 `projects\Qoder-Chats\project_ide_configuration\记忆系统按需检索机制.md`:13
> 「记忆系统采用树状索引结构（memory_overview）进行概览展示，仅包含标题、子节点数量和关键词，不包含完整正文内容。具体记忆的正文通过SearchMemory工具按需检索加载。」

> 证据 `projects\Qoder-Chats\project_ide_configuration\记忆树结构与工具链配置.md`:15
> 「记忆树架构包含development_spec、project_info、experience_lessons、task_summary四大类，其中project_info下包含project_introduction、project_tech_stack等子类」

结论：**磁盘层级 = 3 级**（scope → category → 标题.md，无父子记忆关系）；**引擎侧另有 2 级逻辑分组**（四大类 → 子类 → 条目），其大类名（`development_spec` / `project_info` / `experience_lessons` / `task_summary`）与磁盘上的 29 个分类名**不同名**，是 UI 侧聚合。

遍历方式（无索引可依赖）：
> 证据 `global\user_behavior\记忆库管理总规范.md`:46
> 「**[检索硬规则]** 整理或检索记忆时，**必须遍历整个 `memories/` 目录树**（含所有子目录）。」
> 同文件 :47「**[禁止]** 仅检索单个分类文件夹或依赖"总览标题"做判断。」

---

## 4. 摘要机制

| 问题 | 现状 |
|---|---|
| 独立摘要字段 | **无**。frontmatter 只有 4 字段，无 `summary`/`abstract`/`description`。 |
| 独立摘要文件 | **无**。743 文件中无 index/overview 类文件。 |
| 摘要载体 | ① 引擎侧 `memory_overview` 树（标题 + 子节点数 + 关键词，不含正文）；② `usage_scenario`（何时该用）；③ `keywords`（检索用）。 |
| 标题长度 | 6~71 字符，均值 24.1。 |
| 标题句式 | 无统一模板，实际三类：**事实/结论式**（`手机操作系统限制`、`mihomo 内核版本`、`Clash Nyanpasu 内核工作目录与安全路径限制`）；**坑/机制式**（`PowerShell中Get-Content不支持Byte编码`、`Git提交失败因未配置user.name和email`）；**规范式**以`规范`收尾（`脚本编码与格式强制规范`）。重要条目加"必须使用/必须查看"标识。 |
| 标题 = 文件名 | 是（净化后）。742 个文件中 409 个的 title 与文件名字面不同，**逐条核对差异只有三类字符替换**：空格→`_`、`/`→`_`、`:`→`_`（`. ` 与中文标点保留）。 |

> 命名规则证据 `projects\Global\user_behavior\记忆库管理总规范_任何会话的第一次记忆存储必须查看本规范.md`:36
> 「## 命名\n标题与文件名严格一致，禁止脱节; 改名时文件名、title 绑定同步; 标题去除"用户裁定""复盘"等废话; 重要记忆标题加"必须使用/必须查看"标识。」

字符替换实例：
| title（原文） | 文件名 |
|---|---|
| `Clash Nyanpasu 规则集/代理集添加机制与测速 URL 硬编码位置` | `Clash_Nyanpasu_规则集代理集添加机制与测速_URL_硬编码位置.md`（`/`→删、空格→`_`） |
| `PowerShell Add-Type 缺少 using System; 导致 IntPtr 类型未定义` | `PowerShell_Add-Type_缺少_using_System;_导致_IntPtr_类型未定义.md`（`;` 保留） |
| `C:\\mount2 系 2019 年系统镜像挂载残留目录的全面调查结论` | `Cmount2_系_2019_年系统镜像挂载残留目录的全面调查结论.md`（`\`→删） |

**`usage_scenario` 与 `keywords` 的实际作用（双重）：**

1. **给检索用**：`keywords` 是 `search` 模式的关键词面；`usage_scenario` 参与"覆盖度"判定。
2. **给人/模型判断何时取用**：场景文字是自然语句（`"Set-Service 报拒绝访问时"`），不是标签。
3. **给注入筛选用**（关键）：`usage_scenario` 覆盖度广是注入准入条件之一。

> 证据 `global\user_behavior\记忆库管理总规范.md`:37-42
> 「### M-3. 【注入机制】只注入高频关键记忆\n- **[规则]** 会话启动时，**仅注入**同时满足以下条件的记忆：\n  1. `source = user`\n  2. `usage_scenario` 覆盖度广（非狭窄场景）\n  3. 数量限制：**最多 5 条全文**\n- **[不注入]** `source = auto` 或场景狭窄的记忆 → 不注入上下文，按需检索（由用户或工具触发）。」

---

## 5. 注入策略

| 维度 | 规则 | 证据 |
|---|---|---|
| 准入条件 | `source = user` **且** `usage_scenario` 覆盖度广 | `global\user_behavior\记忆库管理总规范.md`:35-41 |
| 注入形态 | **全文**（不是标题/摘要） | 同上 :38「最多 5 条全文」 |
| 条数上限 | **最多 5 条** | 同上 :38 |
| 被排除者 | `source = auto` 或场景狭窄 → 不进上下文，按需检索 | 同上 :42 |
| 概览注入 | 另有 `memory_overview` 树（仅标题 + 子节点数 + 关键词）做概览展示 | `...\记忆系统按需检索机制.md`:13 |
| 优先级/打分 | 文档只给出"覆盖度广"这一定性口径，**未发现量化打分规则** | — |
| 生效范围 | 会话启动时（beginning-of-session） | `global\user_behavior\记忆库管理总规范.md`:35 |

`source` 三值实测占比（全量 742）：

| 值 | 数量 | 占比 | 分布 |
|---|---|---|---|
| `"auto"` | 704 | 94.9% | 全库铺开，AI 自动积累 |
| `"user"` | 22 | 3.0% | `global\user_behavior` 2 条、`projects\Global\user_behavior` 4 条、Qoder-Chats 16 条（散落在 8 个分类） |
| `"init"` | 16 | 2.2% | **只出现在 5 个项目初始化时间点**（`c-Users-53518-Documents-Qoder-2026-08-1x-chat-*`），每项目固定 3~4 条 `project_introduction` / `project_tech_stack` / `project_environment_configuration` / `project_build_configuration` |

22 条 `source: user` 清单（即"注入候选池"，上限 5 条）：
```
global\user_behavior\开发踩坑护栏.md
global\user_behavior\记忆库管理总规范.md
projects\Global\user_behavior\全局准则.md
projects\Global\user_behavior\全局输出要求_必须使用_修改.md
projects\Global\user_behavior\思考输出风格_必须使用：简洁精炼、拒绝废话、果断决定、指令冲突果断决.md
projects\Global\user_behavior\记忆库管理总规范_任何会话的第一次记忆存储必须查看本规范.md
projects\Qoder-Chats\common_pitfalls_experience\pythonw_直接运行相对导入脚本静默闪退：需_-m_包方式_+_异常日志钩子.md
projects\Qoder-Chats\common_pitfalls_experience\仅在排查服务状态异常时不怀疑_360_主动防御.md
projects\Qoder-Chats\development_code_specification\AHK_v2_语法易错点：ClipboardAll_恢复用法与标识符遮蔽.md
projects\Qoder-Chats\development_code_specification\VBS_与_BAT_脚本必须_ANSI_无_BOM_编码（与_PowerShell_相反）.md
projects\Qoder-Chats\development_code_specification\小狼毫互转微软拼音_GUI_技术栈规范：tkinterdnd2_全控件注册拖放.md
projects\Qoder-Chats\development_practice_specification\状态验证取证规范：直接枚举取证与取证时序.md
projects\Qoder-Chats\development_practice_specification\问答交互使用_AskUserQuestion_仅grilling技能启用.md
projects\Qoder-Chats\project_environment_configuration\GUI_工具启动偏好：VBS_无黑框（wscript+pythonw_-m），禁用_bat_启动.md
projects\Qoder-Chats\project_environment_configuration\python-manager_依赖安装与刷新机制.md
projects\Qoder-Chats\project_environment_configuration\技能管理目录路径：.qoderskills_与_AISkills重要技能.md
projects\Qoder-Chats\project_environment_configuration\本机.cmd关联Notepad++劫持与runas中转脚本部署.md
projects\Qoder-Chats\project_environment_configuration\本机UAC默认跳过：提权自动允许无弹窗.md
projects\Qoder-Chats\project_ide_configuration\GUI界面交互与布局规范.md
projects\Qoder-Chats\project_scm_configuration\GitHub_推送流程与配置_推送前必须查看.md
projects\Qoder-Chats\task_summary_experience\Windows登录任务栏延迟系统性诊断与UsoSvc修复.md
projects\c-Users-53518-AppData-Roaming-Clash Nyanpasu-config\project_introduction\全局_JS_脚本动态识别代理组方案.md
```

`user` 的实际差异（可执行）：**`source` 不是"谁写的"注释，而是注入开关**——`auto` 条目永不自动进上下文，只能被检索取用。`init` 是项目初始化时批量播种的项目事实（每个项目 3~4 条，含 `project_introduction`）。

---

## 6. 检索与防重

工具名（磁盘上无工具定义文件，以下为规范原文口径）：

| 名称 | 用途 | 证据 |
|---|---|---|
| `fetch` | 按 **title** 精确检索 | `global\user_behavior\记忆库管理总规范.md`:56 |
| `search` | 按 **文件名片段/关键词** 遍历整个目录树检索 | 同上 :57 |
| `SearchMemory` | 按需加载正文、获取条目 id | `...\Qoder_记忆系统磁盘不可写约束.md`:16、`...\记忆系统按需检索机制.md`:13 |
| `UpdateMemory` | 增 / 改 / 删（唯一写通道） | 同上 :52 |
| `memory_overview` | 树状概览（标题 + 子节点数 + 关键词） | `...\记忆系统按需检索机制.md`:13 |

**命中判定口径 = 双层**：`fetch` 走 title 精确匹配；未命中**必须**切 `search` 走内容/文件名片段匹配，**以内容关键词匹配为准**。

> 证据 `global\user_behavior\记忆库管理总规范.md`:55-62
> 「### M-6. 【检索防重机制】命中失败后切 search
> - **[触发条件]** 使用 `fetch` 按 title 检索未命中。
> - **[强制]** **必须立即切换** `search` 模式，带**文件名片段（关键词）** 复查整个目录树。
> - **[核对流程]** 1. 检查是否有内容匹配但 title 不同的已有记忆。2. 若存在 → 执行 `UpdateMemory` 更新该记忆。3. 若确实不存在 → 才允许新建记忆。
> - **[禁止]** 仅凭 title 不匹配就盲目新建，导致重复条目。」

> 证据 `global\user_behavior\记忆库管理总规范.md`:49-51
> 「- **[硬规则]** 整理或检索记忆时，**必须遍历整个 `memories/` 目录树**（含所有子目录）。
> - **[禁止]** 仅检索单个分类文件夹或依赖"总览标题"做判断。
> - **[校验]** 以**内容关键词匹配**为准，避免漏检。」

**有无落盘检索日志：无。** 743 个文件中无日志/索引文件；`C:\Users\53518\.qoder\memories\` 下只有 `019fb5cc\global|projects` 两级目录。审计痕迹只出现在**正文里**（`（来源：Bash）` 等，102/742 条带此标注，见 §8）。

**防重效果实测**：742 个文件中跨目录同名文件仅 1 组 —— `user_behavior_记忆存储位置约束.md` 同时存在于
`projects\Qoder-Chats\project_environment_configuration\` 与 `projects\Qoder-Chats\project_ide_configuration\`（标题同、正文不同：前者只说"禁止移动"，后者带完整绝对路径）。

---

## 7. 生命周期

### 权威源与写通道

| 事实 | 证据 |
|---|---|
| 权威源 = SQLite `local.db` 的 `agent_memory` 表（`%APPDATA%\Qoder\SharedClientCache\cache\db\local.db`，实测存在，668 MB） | `...\Qoder_记忆权威存储与同步机制.md`:15 「Qoder的记忆系统由 SQLite 数据库 `local.db` 作为权威存储…核心表为 `agent_memory`（字段包括 id, title, content, category 等）」 |
| 磁盘 `memories/` = **展示层**，启动时 `RunFullSync` 由 DB 单向重建 | `...\Qoder记忆持久化与运行机制.md` 「Qoder启动时执行全量同步（RunFullSync），以本地数据库(local.db)为权威源单向覆盖重建磁盘文件」 |
| 外部直接改磁盘 → 被还原；直写 DB → 不触发同步 | `...\IDE_记忆直写数据库不触发同步.md` 「直接通过 SQL（INSERT/UPDATE）修改 `agent_memory` 表**不会触发**磁盘同步。官方同步机制仅由 Go 服务通过内部通道（如 operation_log）触发」 |
| 同步服务 = Go 进程 `cosy/memory/filesync`，监听 **56510** 端口 | `...\Qoder_记忆权威存储与同步机制.md` 「Qoder 运行时会启动 `cosy/memory/filesync` 模块（Go 进程监听 56510 端口），通过 MemoryFileWatcher 监视磁盘目录」 |
| 唯一外部可行路径 = 完全退出 Qoder → 改磁盘 → 重启（RunFullSync 双向吸收） | 同上 |

### CRUD 规则

| 操作 | 规则 | 证据 |
|---|---|---|
| 新建 | `UpdateMemory` create，**实测约 20 秒内同步到磁盘**；文件名 = 完整 title | `...\Qoder_记忆系统磁盘同步与_UpdateMemory_机制.md`:19-23 |
| 新建（限制） | 另一份实测称 `UpdateMemory` **仅支持更新、不支持新建**（空 memoryId 或特殊 category 被 Go 后端拒绝：报 40400 或静默忽略；面板也无 create RPC） | `...\Qoder_IDE_UpdateMemory_工具不支持新建记忆.md`:15 |
| 更新 | 内容同步到磁盘；**title 更新后磁盘文件名不变**（仍为旧名） | 同上 :21 |
| 删除 | `UpdateMemory` delete，**实测约 20 秒内磁盘文件消失** | 同上 :23 |
| 改名/修复文件名 | 必须 `delete` 旧条目 + `create` 新条目（新文件名 = 完整新 title） | 同上 :23「若需修正截断或错误的文件名，必须使用 `UpdateMemory delete` 旧条目 + `UpdateMemory create` 新条目」 |
| 合并 | 「适度合并专题化」；`task_summary` 复盘若与底本逐字重复 → 直接删正文，否则保留原正文并追加"更正段" | `global\user_behavior\记忆库管理总规范.md`:69-70 |
| 过期/冲突 | **直接更正为已验证现状，不保留历史版本** | 同上 :71 |
| 用户指令优先 | 用户明确要求"自行整理/直接整理"或授权批量落地 → 跳过审计与批准，直接执行 | 同上 :72 |
| 分类内不重复建 | 「尽量整合进已有的规范条目，不重复新建」 | `...\记忆库管理总规范_任何会话的第一次记忆存储必须查看本规范.md`:21 |

### 文件命名冲突

- 规范声称会出 `_1` 副本：`global\user_behavior\记忆库管理总规范.md`:53-56「直接操作文件会导致索引重建时旧文件残留，生成 `_1` 重复副本，污染记忆库。」
- **实测当前库 `_1` 副本 = 0 个。** 全量 742 文件名中匹配 `_\d+\.md$` 的只有 1 个：`projects\Qoder-Chats\common_pitfalls_experience\pywin32_win32gui_64位下无_DragQueryFile_且_GetWindowLong_读_wndproc_返回_0.md` —— 其 `_0` 是标题自带内容，不是冲突副本。
- 文件名含 `副本`/`copy`/`重复`/`old`/`旧`/`bak` 的 = 0 个。
- 为此建了专用工具：`...\记忆整理工具项目配置.md`:16「核心功能：元数据管理、文件系统编辑（删除/改名/搜索/新建/移动）、内置回收站、**_1残留清理**」。

---

## 8. 文件体积与正文形态

| 指标 | 值（全量 742） |
|---|---|
| 正文长度 min / 中位 / 均值 / max | 12 / 184 / 358.6 / **3488** 字符 |
| 单段无换行（整条一句/一段） | **486** 条（65.5%） |
| 含 `## 二级标题` 分节 | 77 条；含任意 `#`~`###` 标题 = 79 条（其中 `###` 仅 5 条） |
| 含 ``` 代码块 | **5** 条 |
| 含日期时间戳（`20xx-xx-xx`） | 31 条 |
| 正文含 `（来源：…）` 标注 | 102 条 |

**正文形态 = 纯文本短段为主，不做结构化。** 这是规范明令：

> 证据 `global\user_behavior\记忆库管理总规范.md`:26-29
> 「### M-2. 【记忆内容要求】精炼规则，禁止废话
> - **[禁止]** 记忆内容附带：用户裁定结论、配套技能、来源说明、时间戳、具体事故案例。
> - **[强制]** 存入 `user` 的记忆必须精炼为**规则式表述**（如 "禁止 X"、"强制 Y"）。
> - **[强调]** **不要结构化表达**（如 JSON/表格），只写纯文本规则。」

典型正文（`global\user_info\手机操作系统限制.md`，13 行全文 / 54 字正文）：
```
用户使用鸿蒙 7 (HarmonyOS NEXT) 纯血系统，不支持安装任何 Android APK 应用。
```

长正文只出现在 `task_summary_experience`（复盘）与少数 `learned_skill_experience`，会带 `## Goal` / `## Steps` 分节，如 `projects\Qoder-Chats\learned_skill_experience\Flutter_Windows应用VSNPrint崩溃诊断与二进制补丁修复规范.md` 的 `## Goal` / `## Steps`（994 字）。

**规范与现状冲突（3 处，均为现状事实）：**
1. M-2 禁止"（来源：xxx）"，但 102/742 条正文带 `（来源：Bash）`、`（来源：Bash, UpdateMemory）`、`（来源：User Observation, System Verification）`。
2. M-2 禁止时间戳，但 31 条正文含日期（如 `...\Cmount2_系_2019_年系统镜像挂载残留目录的全面调查结论.md`「（2026-08-11 全面取证调查）」）。
3. 写通道冲突：`...\GUI工具写操作规范.md`:14「GUI工具的写操作（如修复、改名、删除）必须生成UpdateMemory指令清单，由AI代理执行SearchMemory获取id后调用UpdateMemory完成变更，**禁止直接操作文件系统**」 vs `...\记忆整理工具架构偏好_直接写磁盘.md`「抛弃AI指令清单模式，**回归直接写磁盘文件**的实现方式」——两条并存，未收敛。

---

## 9. 可借鉴清单（对照 dsh-memory-evolve-mod 现状）

**对照基线**（插件 v2 现状，均给出源码位置）：
- 一条记忆 = 一个 md，文件名 = 标题清洗（`\ / : * ? " < > |` 与控制字符→`_`、折叠空白、去首尾点空格、截断 60 字、重名加 `-2` `-3`）→ `lib/vault.js:40-43,67`
- frontmatter = `id / title / summary / keywords / scenario / created / updated / group / class / seq / git / project / branches / dshOnly / archivedAt` → `lib/vault.js:19-37`
- 三类：`session | project | global` → `lib/vault.js:29`
- 分组可自定义 → `lib/groups.js`
- 按组注入（每组自决 `inject`）→ `lib/index.js:818-820`
- 检索带权重打分：`title 10 / keywords 8 / summary 5 / scenario 4 / body 1` → `lib/memory-search.js:22`
- key 轨渐进式披露（条数 ≤3 或字符 ≤1500 全量注入，否则摘要注入 + `expand` 取全文）→ `lib/index.js:127-130`
- 正文软上限 200000 字符 → `lib/vault.js:70`

| # | Qoder 机制 | 插件现状 | 价值 | 落地要点 |
|---|---|---|---|---|
| 1 | `usage_scenario` 是**字符串数组**（1~7 条，实测均值 2.5），一条记忆声明多个触发场景 | **单字符串** `scenario`（`lib/vault.js:25`） | 多场景→检索打分更准；也是"覆盖度"判定的输入 | vault 序列化接受数组（旧值字符串自动包成 `[s]`，读时兼容两形态）；`memory-search.js:52` 的 scenario 分改为"命中场景数 × 4"累加；工具 schema `scenario` 允许 `string 或 string[]` |
| 2 | `source: user / auto / init` **作为注入准入开关**（auto 永不自动注入；实测 user 仅 3.0%） | **无来源字段**（frontmatter 无 source，`lib/vault.js:19-37`） | 把"用户拍板的硬规则"与"AI 自动记的经验"分开：注入只放前者 → token 最省、噪声最低；也是 AI 自动写入 vs 用户确认写入的天然标记 | frontmatter 增 `source`（默认 `auto`）；`memory` 工具 add 由 AI 发起 = `auto`，经 key 轨待确认队列采纳 = `user`；注入层加"仅 source=user 段"开关（默认关，保持现有按组注入语义） |
| 3 | **准入 = 来源 + 场景覆盖度，上限 5 条全文**；超限不进上下文 | 阈值机制**只覆盖 key 轨**（`keyFullInjectThreshold=3` / `keyFullInjectCharLimit=1500`，`lib/index.js:127-130`）；kb/project/daily 与自建分组**全量注入、无上限** | 防"记忆库长大 → 每轮快照膨胀"；插件已写好这套阈值逻辑，只差推广 | 把 `keyFullInjectThreshold` / `keyFullInjectCharLimit` 提升为**分组级配置**（沿用各组现有 `inject` 开关同一处），超阈值自动降级为摘要注入（复用既有渐进式披露渲染路径） |
| 4 | 引擎侧 `memory_overview` 树：**只给标题 + 子节点数 + 关键词**，正文按需 `SearchMemory` 取 | 有 summary + `expand` 渐进式披露，但**没有"一次性给全树骨架"的出口**；`memory list` 返回全量条目 | 大库时用最少 token 让模型先知道"有什么"，再决定展开哪条 | 新增 `memory action=overview`（按 class→group 两级，每条目只回 `title + keywords + summary 前 40 字 + id`）；或加一个注入段：条目总数超阈值时用骨架替代明细 |
| 5 | **命中失败必须换检索口径**：title 精确未命中 → 切关键词遍历全树 → 内容匹配则改、确实没有才新建（M-6 明文流程） | add **直接追加**，无强制查重；查重靠事后 `memory-consolidate` 技能 | 从源头堵重复条目；插件已有加权检索函数，改造成本极低 | `memory` 工具 `add` 前自动跑一次 `memory-search`（复用 `lib/memory-search.js`），若最高分条目超阈值则**不落盘**、返回"疑似重复：<id/title>，请用 replace 或确认新建"；人工确认走现有待确认队列 |
| 6 | **磁盘孤儿检测**：外部改名/删除会在索引重建时留下 `_1` 残留副本（M-5）；配套工具专门做"`_1` 残留清理" | 有 drift guard（`skills\memory-consolidate\SKILL.md` 硬边界 3「禁止直接编辑记忆 .md 文件…外部改写会导致整个文件拒绝写入」），但**孤儿文件只容忍、不报告**（`lib/api.js:317`「宁可留孤儿文件也不静默销毁内容」） | 磁盘上"存在但不在任何分组索引中"的 .md 会永远吃不到注入也不被发现；扫一次即可暴露 | 记忆 Tab 加"孤儿扫描"：枚举记忆根目录下所有 `.md`，与分组索引求差集；列表提供"纳入分组 / 归档 / 保留"。复用现有同步模块的目录列举能力（`lib/sync/`） |
| 7 | 分类是**固定枚举 29 项**，每个 scope 下预建同名目录，按需填充（Qoder-Chats 视图下 12 项全空、17 项非空） | 分组可自定义（更灵活），但**无跨项目统一的分类枚举** | 跨项目/跨设备时同名分类可对齐、可统计、可迁移 | 内置一份 29 项分类模板，新建分组时"选模板一键铺开"；**不强制**，仅作为自定义之外的快路径 |
| 8 | 分类**区分文体**：`user_behavior` 只放精炼规则式的全局硬约束（规则组 M），经验类一律进 `*_experience` | 有 `class`（可见范围）但**不区分"规则"与"经验"两种文体** | 规则条目要短、要能全文注入；经验条目可以长。混在同类里会让注入预算被长文吃掉 | 分组配置加 `kind: rule \| experience`：`rule` 组写入时校验"无时间戳、无 `（来源：…）`、长度 ≤ 500 字"，`experience` 组放宽到现有 200000 字符上限（`lib/vault.js:70`） |
| 9 | 短正文纪律：中位 184 字、65.5% 单段无换行、仅 5/742 带代码块 | 软上限 200000 字符（`lib/vault.js:70`），无下限/无文体引导 | 正文越短，全量注入的条数上限就能越高 | 与 #8 合并实现：`kind=rule` 组按 §8 的统计口径设 500 字软上限，超限时返回提示并可强制写 |

**不建议借鉴的两条**（Qoder 做法劣于插件现状）：
- **文件名锁死**：Qoder 改 title 不改磁盘文件名，修名必须 delete+create（`...\Qoder_记忆系统磁盘同步与_UpdateMemory_机制.md`:21-23）；插件"改标题即改文件名 + `aliases` 记旧名"（`lib/vault.js:43`）更优。
- **DB 权威 + 磁盘展示层**：Qoder 需 Go 服务 + 56510 端口 + 20 秒同步延迟，且 Qt 面板与磁盘长期不一致（`...\Qoder_IDE记忆管理机制现状.md`:17「尽管projects目录下存在大量记忆文件，但IDE记忆中仅有一条」）；插件以明文 md 为唯一权威，无同步问题。
