# 项目理解指南：从 PR 审查到团队规则

本文面向知道项目目标、但尚不了解内部实现的读者。依据代码基线 `262d607`，核对日期为 2026-09-16；Pi SDK 说明以本项目安装的 `@earendil-works/pi-coding-agent` **0.85.1** 为准。

建议先读第 1～4 节建立整体印象，再读数据库和 Pi 细节；遇到英文状态时查第 10 节。启动配置见 [README](../README.md)。PR 回复、规则提取与多人讨论见第 3～4 节，错误兜底见第 9 节。

## 1. 先用一句话理解系统

**这是一个由确定性服务管理的 AI 代码审查系统：模型提出意见，人类确认长期规则，数据库保存整个过程。**

它有四种业务任务：

| 任务 | 做什么 | 结果在哪里 |
| --- | --- | --- |
| PR Review（PR 审查） | 阅读一次固定提交的变更，结合团队规则发现问题 | GitHub PR 评论及管理页 |
| Reply Handler（回复复核） | 阅读人类对 App 行内意见的回复，重新判断原意见 | 原 GitHub 线程及管理页 |
| Decision Extraction（决策提取） | PR 合并后，从代码和人类讨论提取可复用决定 | 管理页的待确认规则 |
| Health Audit（仓库健康检查） | 阅读默认分支快照与已有 CI 信息，形成有限范围的报告 | 管理页健康报告 |

系统不会自动修改源码、提交代码、合并 PR，也不会让模型直接批准团队规则。

### 谁负责什么？

| 参与者 | 可以把它理解成 | 实际职责 |
| --- | --- | --- |
| GitHub App | 项目在 GitHub 的服务身份 | 接收事件，用 installation token 发布评论 |
| Node.js 服务 | 调度员与门卫 | 验签、权限、去重、创建任务、准备代码、校验结果、发布 |
| Worker（任务执行循环） | 从待办箱取任务的工作人员 | 从 PostgreSQL 领取任务，调用对应处理器 |
| Pi SDK | 模型对话与工具调用的执行框架 | 管理 Session、请求模型、执行允许的工具、收集回复 |
| 模型 Provider | 提供推理能力的外部服务 | 根据上下文分析代码，请求工具，生成结构化答案 |
| PostgreSQL | 持久化台账 | 保存任务、发布记录、问题、规则版本与审计信息 |
| React 管理页 | 人类查看和管理的入口 | 看结果、配置仓库、确认规则、排查失败 |
| 维护者 | 长期规则的最终确认者 | 确认、修改、忽略、停用或替代规则 |

当前 HTTP 服务与 Worker 在同一个 Node.js 进程内运行。Worker 是一个后台循环，不是另外部署的一台机器；目前只有一个 Worker 串行领取 Job（任务）。复杂审查内部仍可同时运行两个专项 Agent。

## 2. 先分清这些名词

| 名词 | 中文与含义 | 例子 |
| --- | --- | --- |
| Webhook / delivery | GitHub 推送事件／一次事件投递 | “PR #42 的分支刚更新了” |
| Job | 持久化业务任务 | “审查 #42 在提交 abc123 的代码” |
| SHA | Git 提交标识 | 固定审查哪一版代码，避免分析过程中内容变化 |
| Workspace | 一次任务的临时代码目录 | 服务检出固定提交，结束后清理 |
| AgentSession | Pi 的一次独立会话 | 系统提示、输入、工具结果和模型回答组成的临时历史 |
| agent run | 一次 Agent 执行的审计记录 | 哪个角色、哪个模型、用了多少 tokens、是否失败 |
| finding | 一条审查意见 | “这里原地排序会改变共享集合” |
| publication | 一次对外发布的记录 | 哪个 Job 对应哪个 GitHub Review 或回复 |
| decision clue | 决策线索 | 人类解释某个场景需要例外，值得合并后再提取 |
| Team Memory | 可版本化的团队工程规则 | “查询方法不能修改共享集合” |
| token | 模型处理文本的计量单位 | 输入、输出及缓存读取都可能产生用量 |

**Session 历史、数据库记录、Team Memory 是三种不同的东西。**

- Session 历史帮助模型完成当前任务；本项目使用内存 Session，结束后释放。
- 数据库让服务重启后仍知道任务和发布进度；它不保存一份可直接恢复的完整 Pi 对话。
- Team Memory 是业务数据。服务检索规则并放入下一次模型输入，让模型“参考已经确认的决定”；没有因此训练或修改模型权重。

一个 PR 可以对应多个 Job，例如不同 head 的审查、每条回复的复核、合并后的提取。一个 Job 可以有多个 agent run；一条 finding 可以有多次人类回复。它们不是一一对应的。

## 3. 一个 PR 从进入系统到发布意见

假设团队已有生效规则：“查询方法不能改变共享集合”。有人在 PR #42 中加入 `items.sort(...)`。

### 第一步：GitHub 告知变化

GitHub 向 `/github/webhook` 发送事件。服务先用原始请求体校验签名，再检查事件字段、仓库授权、是否重复投递等。事件分类由代码完成，不让模型决定接下来执行哪种业务任务。

符合条件的 PR 创建或更新事件进入审查。Draft（草稿）、关闭、暂停、未授权，以及当前不支持的 fork PR 不进入正常新审查。

### 第二步：保存任务并固定代码版本

数据库保存 delivery 和 Job。Worker 领取 Job 后读取 PR 信息及变更文件，准备固定 base SHA（比较起点）与 head SHA（本次目标）的 Workspace。

临时目录不是模型随意选择的。服务负责 Git 获取与检出，并核对 SHA；不执行待审仓库的安装、构建、测试或 hooks。路径和符号链接检查阻止模型读取 Workspace 外的文件。

### 第三步：召回适用的团队规则

当前检索分两层：

1. 从同仓库的生效规则中，按路径、语言、模块和适用条件筛选。
2. 从 PR 标题、正文、文件路径和 patch 提取词项，对规则标题、内容和理由做包含匹配计分，默认取前 10 条。

这不是向量检索，也没有先生成“行为摘要”再做独立语义匹配。范围匹配但词项得分为零的规则，也可能进入前 10 条；召回结果不保证覆盖所有相关规则。

### 第四步：Pi 驱动模型阅读和判断

模型获得 PR 信息、变更和召回规则，可以调用受控读取工具查看代码。它需要判断 `items` 是共享集合还是局部副本，才能判断排序是否违反规则。最终生成摘要和有证据的 findings（审查意见）。

简单任务由通用审查 Agent 完成。复杂任务可以由 Main（主协调 Agent）委派专项，详见第 7 节。

### 第五步：服务校验并发布

服务校验 JSON 结构、代码路径与位置、规则 ID 和版本、候选分组等，再重新检查仓库授权、启用状态、PR 是否仍然打开且非草稿、head 是否仍一致。

可映射到 diff 的意见成为行内评论；无法可靠定位的意见放入 Review 摘要。发布类型固定为 `COMMENT`（评论），不会自动 `APPROVE`（批准）或 `REQUEST_CHANGES`（要求修改）。

**模型回答不是直接发送到 GitHub 的字符串。中间有服务校验和发布条件检查。**

## 4. 回复、合并与团队规则形成

### 用户追加评论，Agent 都会收到吗？

实时复核仅处理：**人类在本 App 已绑定的行内 finding 线程中新建回复**。普通 PR Conversation 评论、别人的线程、Bot 或 App 自己的回复不会触发此流程；编辑和删除评论也不属于当前触发范围。

复核会读取当前 head、原问题和相关讨论，建立独立 Session。结果可以是已修复、误判、合理例外线索、仍然有效或需要澄清。已是 `FIXED`（已修复）或 `WITHDRAWN`（已撤回）的 finding，新收到的回复不会自动将其重新打开。

一个线程可以有多个用户评论。服务通过 source comment ID 去重，并根据 GitHub 创建时间和评论 ID 处理先后关系，防止迟到旧回复回退新状态。**这只是处理顺序，不是“最后说话的人正确”。** 当前没有投票、按作者级别裁决或多人共识协议；维护者在评论中发言也不会直接改变生效规则。

### 能自动从代码抽取 Memory 吗？

合并后会运行 Decision Extractor（决策提取器）。它读取变更、普通 PR 讨论、Review、行内评论和已有 decision clues，寻找明确、可复用的人类决定，并结合代码证据形成候选。

当前设计不把“代码刚好这样写”直接提升为团队规则，也不把 AI 自己的建议或尚未解决的争议当作已确认决定。服务还校验 PR／SHA、人类评论 ID 和代码证据路径；结构校验并不能证明语义正确，仍需维护者确认。合并 PR 不一定产生新规则。

例如：

1. 审查指出共享集合排序问题。
2. 人类解释：“查询返回值必须是副本，导出流程也遵守这个约束。”
3. PR 修改后合并。
4. 提取器提出 `CANDIDATE`（待确认）规则，附来源和理由。
5. 有仓库 maintain（维护）／admin（管理）权限的维护者在管理页确认，规则成为 `ACTIVE`（生效）。
6. 后续 PR 可能召回这条规则。

修改生效规则会生成待确认的新版本；确认前旧版仍可用于检索，忽略新版本也不会撤销旧版。规则变更留下 actor（操作者）及前后内容的审计记录。

合理例外只能先形成线索或候选，不能通过回复绕过确认。多个维护者之间也没有自动投票或更高级别维护者优先的制度；数据库事务保护数据一致性，团队意见分歧仍需要人类解决。

[打开可编辑 draw.io 流程图](diagrams/pr-review-memory-flow.drawio) · [查看完整流程图 PNG](diagrams/pr-review-memory-flow.png)

![PR Review 与 Team Memory 闭环](diagrams/pr-review-memory-flow.png)

## 5. 数据库到底有什么作用？

如果只调用模型然后发评论，服务重启后就很难知道：事件是否处理过、评论是否发过、哪条规则已经确认、某次回复改变了哪个问题。PostgreSQL 保存这些需要长期记住的事实。

它同时承担五种职责：**任务队列、去重记录、发布台账、规则存储、运行审计**。当前没有 Redis 队列或向量数据库。

### 每张表保存什么？

| 表名 | 中文含义 | 主要内容与作用 |
| --- | --- | --- |
| `schema_migrations` | 数据库结构升级记录 | 哪些迁移文件已经执行，避免重复升级 |
| `repositories` | 仓库配置 | installation、启停、路径范围、输出语言、预算、审查方式、健康检查计划 |
| `webhook_deliveries` | 事件投递记录 | delivery ID、事件、action、仓库与接收时间；防止重复事件重复执行 |
| `jobs` | 业务任务 | 任务类型、PR、SHA、状态、尝试次数、重试时间、错误及审查结果 |
| `review_publications` | PR Review 发布记录 | Job 对应的 GitHub Review ID、URL、指纹与发布状态 |
| `review_findings` | 审查意见 | 分类、严重度、证据、代码位置、规则引用、处理状态及 GitHub 线程绑定 |
| `reply_publications` | 回复发布记录 | 人类原评论 ID、复核 Job、finding、分析 SHA、结论及 GitHub 回复 |
| `decision_clues` | 决策线索 | 回复中识别出的潜在例外、规则变化或实现理由 |
| `memories` | 团队规则及版本 | 规则内容、理由、范围、来源、证据、状态、替代关系和确认人 |
| `memory_audits` | 规则操作审计 | 谁在何时确认、编辑、忽略、停用或替代了规则，内容如何变化 |
| `agent_runs` | Agent 执行审计 | 所属 Job、父 run、角色、模型、状态、用量、覆盖限制和耗时 |
| `health_reports` | 健康检查报告 | 对应 Job 的结构化报告；可在管理页读取 |

注意：提取器目前没有接入通用的 `agent_runs` 记录链路，不能据此认为每个提取 Job 都有对应 run。OAuth 登录 state 与会话则使用有容量和期限限制的内存存储，服务重启后需要重新登录。

### 表之间如何联系？

下面是便于理解的逻辑关系，并不表示每条关系都存在数据库外键：

```text
repository（仓库）
 ├─ delivery（GitHub 事件）→ job（任务）
 │                          ├─ agent_runs（一次或多次模型执行）
 │                          ├─ review_publication（发布的 Review）
 │                          ├─ findings（具体问题）
 │                          │   ├─ reply_publications（回复复核结果）
 │                          │   └─ decision_clues（决策线索）
 │                          └─ health_report（健康任务的报告）
 └─ memories（规则的各个版本）→ memory_audits（人类操作记录）
```

Review、Reply、Extraction、Health 是不同类型的 Job，不会要求每个 Job 都填满图中所有分支。手动或定时 Health 也不依赖 GitHub delivery。

### 几个数据库术语

| 术语 | 通俗解释 | 本项目例子 |
| --- | --- | --- |
| 主键 PK | 一条记录的唯一编号 | `jobs.id`；规则用 `(id, version)` 区分版本 |
| 外键 FK | 一条记录指向另一条记录的约束 | run 关联所属 Job；部分规则引用只是逻辑关联 |
| 唯一约束 | 不允许重复登记同一件事 | delivery ID、发布指纹、source comment 等去重依据 |
| 事务 | 一组变更一起成功或一起回滚 | 数据库结构升级、规则状态切换等 |
| 索引 | 帮助快速查找的目录 | 按任务状态领取任务、按仓库查询记录 |
| JSONB | PostgreSQL 中可存结构化 JSON 的字段 | 规则 scope、报告、模型结果与用量明细 |
| migration | 逐步升级数据库结构的脚本 | `migrations/001_baseline.sql` 及后续编号文件 |

JSONB 不是另一种数据库，也不意味着数据无需校验。模型输出进入数据库前仍需经过服务校验。

正常启动服务不执行迁移。首次初始化数据库，或以后确有数据库结构变更时，手动运行 `npm run migrate`：按文件顺序检查升级记录，以数据库锁避免迁移冲突，每个尚未执行的迁移在事务内执行并记录。表结构已就绪时直接启动服务即可。保留现有 SQL 和手动命令供新环境初始化；后续结构调整应增加迁移，不改写已经执行过的历史脚本。

数据库事务也无法把一次网络发布和本地写入变成同一个原子操作。因此发布响应丢失时仍可能出现 `uncertain`（结果待核对），详见第 9 节。

## 6. Pi Agent 是怎样调用的？

### Pi、模型和本服务不是同一个东西

模型负责生成下一段回答或工具请求；Pi 负责维持对话和执行工具调用循环；本服务决定模型能看什么、用什么工具，以及答案能否产生外部效果。

本项目直接在 TypeScript 中嵌入 SDK，不是启动一个终端里的 Pi CLI 来代替业务服务。底层几层可以这样理解：

| 包 | 作用 |
| --- | --- |
| `pi-coding-agent` | Session、资源加载、工具与扩展集成，本项目直接使用的 SDK |
| `pi-agent-core` | Agent 对话与工具执行的基础循环 |
| `pi-ai` | 模型 Provider 与模型调用抽象 |
| `pi-tui` | 终端界面能力；不是本项目 React 管理页 |

### 通用 Session 调用链

主要入口为 [review.processor.ts](../src/review/review.processor.ts)。Review、Reply、Health 使用通用会话封装；Decision Extractor 有单独的创建路径，不能假定两者所有保护完全一致。

通用路径按以下顺序工作：

1. 创建 `ModelRuntime`（模型运行配置），从服务配置设置 Provider、模型和运行时 API key。
2. 创建受控的 `DefaultResourceLoader`（资源加载器），加载服务自有系统提示。
3. 使用 `createAgentSession` 创建 Session：固定 Workspace、模型、工具白名单；Session 与设置保存在内存。
4. 包装模型请求入口，在每次 Provider 请求前预留预算，限制输出额度，订阅使用量事件。
5. 调用 `session.prompt(...)` 传入本任务的结构化输入。
6. Pi 在模型与工具之间循环，直到模型给出最终回答或失败／超时／取消。
7. 服务提取最后的模型文本，按本业务输出结构解析和校验。
8. 在 `finally` 中清理监听、计时器，并释放 Session。

下面是阅读辅助伪代码，省略了预算、取消和校验细节，不能作为完整生产调用直接复制：

```ts
const runtime = await ModelRuntime.create({ refreshOnCreate: false });
await runtime.setRuntimeApiKey(provider, apiKey);
const model = runtime.getModel(provider, modelName);
const loader = controlledLoader(workspaceRoot, serviceSystemPrompt);
await loader.reload();

const { session } = await createAgentSession({
  cwd: workspaceRoot,
  modelRuntime: runtime,
  model,
  noTools: "all",                    // 关闭默认工具
  customTools: allowedTools,          // 服务实现的受控工具
  tools: allowedTools.map(t => t.name), // 显式启用白名单
  resourceLoader: loader,
  settingsManager: SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  }),
  sessionManager: SessionManager.inMemory(),
});
try {
  await session.prompt(JSON.stringify(taskInput));
  // 提取模型答案 → 服务校验 → 服务决定是否发布
} finally {
  session.dispose();
}
```

这里的 key 由服务设置，不作为任务文本交给模型。正常配置只有一组 Provider 和模型；不同角色主要通过提示与权限区分，不是自动选择不同厂商的模型。

### 工具调用究竟发生了什么？

例如模型认为需要查看集合的定义，会生成一个 `read_file` 请求。Pi 将请求交给本服务注册的 TypeScript 工具函数；函数检查路径并读取允许文件，把结果返回对话。模型接着基于代码继续分析。

```text
服务提供 PR 变更和规则
  → 模型请求 read_file({ path: "src/catalog.ts" })
  → Pi 调用服务注册的读取函数
  → 函数检查路径并返回文件内容或错误
  → 模型判断是否还要调用 search_text
  → 模型返回结构化审查结果
  → 服务校验并发布
```

当前工具：

| 工具 | 中文用途 | 谁可以使用 |
| --- | --- | --- |
| `read_file` | 读取受控 Workspace 文件 | 通用审查、专项、回复；Health 使用更严格的有界版本 |
| `search_text` | 在受控文件中做文本搜索 | 同上；不是互联网搜索，也不是 SQL 查询 |
| `delegate_agent` | 请求一个允许的专项角色分析子问题 | 仅 Main |

模型没有 shell、任意 HTTP、SQL、写文件或 GitHub 发布工具。Git 获取、数据库存取与 GitHub 写操作由服务代码执行。

## 7. 多 Agent 是怎么协作的？

当审查方式为 `auto`（自动）且复杂度达到条件时，使用 Main 协调。复杂度信号包括文件数、变更行数、Java 变更、涉及安全边界、多模块和可能的规则冲突；当前阈值包括至少 4 个文件或估算至少 120 行变更等，完整判断见 [orchestration.ts](../src/review/orchestration.ts)。

Main 根据任务事实和允许角色调用 `delegate_agent`。服务检查角色、范围、规则引用、深度与剩余预算，再创建独立 child Session（子会话）。

- 角色包含通用、Java、安全、架构、规则冲突；不是每次全部运行。
- 每个子会话拥有独立 messages（对话历史），共享固定 SHA、Workspace 和已召回规则。
- Main 的角色是委派与汇总；专项通过读取工具收集证据。
- 委派深度固定为一层，子 Agent 不能继续委派。
- 仓库专项数量上限默认 2，可配置 0～4；**同时运行上限仍为 2**。
- 整个 Job 共享预算，不是每个子 Agent 各领一份完整预算。
- Main 汇总并合并重复候选，服务检查它有没有凭空增加、遗漏或重复引用候选。

这是本项目通过自定义工具和多个 Session 实现的协作，不是 Pi 自动提供一个不受限制的多 Agent 集群。

## 8. Pi 有哪些扩展？本项目用了哪些？

“Pi 支持一种扩展”不等于“本项目已经启用它”。下面依据安装版本的 SDK 文档区分两者。

| 能力 | 它是什么 | 本项目情况 |
| --- | --- | --- |
| Custom tools（自定义工具） | 为模型提供有结构化参数的程序能力 | 已使用：读取、搜索、委派，由服务注册 |
| Extensions（扩展模块） | TypeScript 模块可注册工具、命令、事件钩子和终端交互 | 自动加载关闭；本项目主要直接用 SDK 注入工具与监听事件 |
| Skills（技能） | `SKILL.md` 及相关资源描述一套工作方法 | 自动加载关闭，不执行待审仓库的技能指令 |
| Prompt templates（提示模板） | 可复用的提示文本／快捷命令 | 自动加载关闭；角色提示由服务代码控制 |
| Context files（上下文文件） | 自动把项目约定加入对话，如 `AGENTS.md` | 自动加载关闭；待审仓库文件即便被读取，也只是数据 |
| Themes（主题） | Pi 终端显示样式 | 自动加载关闭；与 React 管理页样式无关 |
| Pi Packages（资源包） | 分发扩展、技能、模板和主题的包 | 不从待审仓库加载第三方资源包；安装 SDK 依赖不等于启用资源包 |
| Session 持久化与分支 | 保存、继续或分叉会话历史 | 本项目使用内存 Session，不通过 Pi 会话文件恢复业务任务 |
| Compaction（上下文压缩） | 对长会话历史进行压缩 | 通用调用路径关闭自动压缩 |
| Provider／模型配置 | 通过运行配置选择模型服务 | 由服务环境配置决定，模型不能自行更换；没有自动切换厂商兜底 |

SDK 扩展模块可以使用 `registerTool` 注册工具、`registerCommand` 注册命令、监听 `tool_call` 等事件。终端 UI 扩展不是管理页插件，不能直接变成 React 页面。

受控加载器明确设置 `noExtensions`、`noSkills`、`noPromptTemplates`、`noThemes`、`noContextFiles`。原因是待审代码可能来自不可信提交，不能让其中的 `.pi`、README 或 `AGENTS.md` 改变审查服务的权限和指令。

### 如果以后要扩展本项目，改哪里？

| 想增加的能力 | 合适的扩展位置 |
| --- | --- |
| 新的只读分析工具 | 服务注册的工具定义、参数校验、路径／返回大小限制及测试 |
| 新的专项角色 | 角色白名单、适用条件、角色提示、委派限制及输出校验 |
| 更好的 Memory 检索 | `MemoryService.retrieve` 的候选筛选与排序，配套召回评测 |
| 新的模型服务 | 服务配置和 ModelRuntime 接入，验证模型支持的工具调用与 usage |
| 新的规则管理动作 | 管理 API、权限、数据库事务、审计与界面，不交给模型自由操作 |
| 新的页面 | React 管理页与服务 API；不通过 Pi 终端主题完成 |

以上是扩展位置说明，不表示这些新功能已经实现。本地 SDK 参考在 `node_modules/@earendil-works/pi-coding-agent/docs/` 的 `sdk.md`、`extensions.md`、`skills.md`、`packages.md`；安装依赖后可阅读。

## 9. 错误和工具失败时有哪些兜底？

| 情况 | 当前处理 | 仍需理解的限制 |
| --- | --- | --- |
| 重复 Webhook／重复回复 | delivery、任务条件、source comment 与发布记录去重 | 不承诺跨系统 exactly-once（严格仅执行一次） |
| 读取工具参数错误或文件不可访问 | 返回工具错误，模型可据此调整 | 不保证模型总能修正；可能最终失败 |
| 模型 JSON、位置或规则引用不合法 | 服务拒绝不合格结果 | 不会为了成功而直接发布未经校验文本 |
| 单个专项失败 | 可以汇总其余合格结果，标记 partial（部分完成） | 必须显示覆盖限制 |
| Main 失败 | 条件允许时仅汇总已校验子结果并记录 fallback（降级） | 没有合格结果或已取消时，不能伪装完整成功 |
| 预算不足／超时／取消 | 通用会话限制请求、终止 Session，记录状态与用量 | 提取器尚未统一接入预算、取消与 run 审计链路 |
| Provider 失败但没有返回 usage | 保留预留额度，单列未知消耗 | 未知消耗不能当作零 |
| 被识别为暂时性网络／限流错误 | 持久化重试时间，最多尝试 3 次（含首次），按退避或有效 Retry-After 安排 | 不是所有错误都能自动重试；不会无限循环 |
| GitHub 发布请求结果不确定 | 保留 uncertain（待核对），先查远端 | 当前不是完整自动对账系统，不能盲目重发 |
| Review 已发布但线程绑定失败 | 保留 published（已发布），标记绑定不完整 | 不重发整份 Review；对应回复链路可能受限 |
| PR 出现新 head／转草稿／关闭／仓库暂停 | 取消过期分析，发布前再次检查；Reply 可重新排到新 head | 会话保护不等于所有前置网络请求都有统一时限 |
| 服务异常重启 | 恢复数据库中的任务，结束遗留 running run 的状态 | 重新执行任务，不是恢复原 Pi 对话的下一句 |

SDK 自动重试与业务 Job 重试是两层机制：通用 Session 关闭自动重试，由服务决定业务层是否重新执行。网络发布存在“远端成功、本地没收到响应”的可能，这正是发布台账和 `uncertain` 状态存在的原因。

### Health 报告也有边界

健康检查固定默认分支 SHA 和最近 30 天数据窗口，可手动运行或按日／周计划运行。它分析代码、已有 CI 元数据、依赖声明和文档，不运行待审仓库脚本，也不是完整漏洞扫描。

当前最多纳入 200 个文本文件，每文件 64 KiB，总计 2 MiB；工具单次最多返回 200 行／16000 字符；CI 来源最多 50 项。截断、无权限和缺少数据都应出现在覆盖限制中。报告没有意见，不代表仓库没有问题。

## 10. 主要枚举与中文含义

以下列出业务理解和排障常见的固定值。英文是代码／数据库值，中文是本文解释；同样的英文在不同对象上含义可能不同。外部 GitHub 的原始 CI 状态不作为本项目穷举字典。

### 10.1 Job 类型与状态

| `job_type` | 中文 |
| --- | --- |
| `PR_REVIEW` | PR 审查 |
| `REPLY_HANDLE` | 回复复核 |
| `DECISION_EXTRACT` | 决策提取 |
| `HEALTH_AUDIT` | 仓库健康检查 |

| Job `status` | 中文与含义 |
| --- | --- |
| `queued` | 排队，等待领取或到达重试时间 |
| `running` | 正在执行 |
| `succeeded` | 任务成功完成，不代表“代码没有问题” |
| `partial` | 部分完成，有明确覆盖缺口 |
| `failed` | 失败 |
| `timeout` | 超时 |
| `superseded` | 被更新的目标取代，旧结果过期 |
| `cancelled` | 已取消 |
| `uncertain` | 发布结果不确定，需要核对 |

### 10.2 finding 分类、严重程度和证据强度

| 字段 | 英文值 | 中文 |
| --- | --- | --- |
| category（分类） | `correctness` | 正确性 |
| category | `security` | 安全 |
| category | `architecture` | 架构 |
| category | `maintainability` | 可维护性 |
| category | `team_rule` | 团队规则 |
| category | `memory_conflict` | 规则冲突 |
| severity（严重程度） | `low` / `medium` / `high` / `critical` | 低／中／高／严重 |
| evidence_level（证据强度） | `weak` / `moderate` / `strong` | 弱／中／强 |
| side（diff 侧） | `LEFT` / `RIGHT` | 变更前 base／变更后 head |

严重程度表示潜在影响，证据强度表示支持判断的证据有多充分，两者不是同一件事。

### 10.3 finding 状态与 Reply 结论

| finding 状态 | 中文 |
| --- | --- |
| `OPEN` | 待处理 |
| `NEEDS_CLARIFICATION` | 待澄清 |
| `STILL_VALID` | 意见仍有效，仍需处理 |
| `FIXED` | 已修复 |
| `WITHDRAWN` | 意见已撤回 |
| `EXCEPTION_PENDING` | 例外待确认 |

| Reply 结论 | 中文 | 对应 finding 状态 |
| --- | --- | --- |
| `FIXED` | 已修复 | `FIXED` |
| `MISJUDGMENT` | 原意见是误判 | `WITHDRAWN` |
| `VALID_EXCEPTION` | 发现合理例外线索 | `EXCEPTION_PENDING`，不直接批准规则例外 |
| `STILL_VALID` | 原意见仍有效 | `STILL_VALID` |
| `NEEDS_CLARIFICATION` | 需要更多说明 | `NEEDS_CLARIFICATION` |

### 10.4 发布与绑定

| 对象 | 英文值 | 中文 |
| --- | --- | --- |
| publication（发布） | `pending` | 待发布 |
| publication | `published` | 已发布 |
| publication | `uncertain` | 结果待核对 |
| publication | `failed` | 发布失败 |
| binding（线程绑定） | `pending` | 待绑定 |
| binding | `bound` | 已绑定 GitHub 行内线程 |
| binding | `summary` | 由摘要承载，无对应行内线程 |
| binding | `incomplete` | 绑定不完整 |

### 10.5 规则与决策线索

| Memory 类型 | 中文 |
| --- | --- |
| `architecture_decision` | 架构决定 |
| `engineering_rule` | 工程规则 |
| `security_rule` | 安全规则 |
| `coding_convention` | 编码约定 |
| `exception` | 有适用范围的例外 |
| `deprecated_pattern` | 团队决定弃用的模式 |

| Memory 状态 | 中文 |
| --- | --- |
| `CANDIDATE` | 待确认候选 |
| `ACTIVE` | 已确认并生效，可被检索 |
| `SUPERSEDED` | 已被其他版本或规则替代 |
| `DEPRECATED` | 已停用 |
| `REJECTED` | 已忽略／拒绝 |

`deprecated_pattern` 是规则内容的类型，例如“不要继续使用某种写法”；`DEPRECATED` 是规则自身的停用状态。前者完全可以处于 `ACTIVE`。

| decision clue 类型 | 中文 |
| --- | --- |
| `possible_exception` | 潜在例外 |
| `possible_rule_change` | 潜在规则变化 |
| `implementation_rationale` | 实现理由 |

| 规则审计 action | 中文 |
| --- | --- |
| `edit` | 编辑 |
| `approve` | 确认 |
| `reject` | 忽略／拒绝 |
| `deprecate` | 停用 |
| `supersede-old` | 将旧规则标为已被替代 |
| `supersede-new` | 激活用于替代的新规则 |

证据类型 `human_comment` 表示人类评论，`code` 表示代码。规则 scope 中 `paths` 为路径、`languages` 为语言、`modules` 为模块、`conditions` 为适用条件；这些是字段名，不是生命周期状态。

### 10.6 Agent 角色、模式与运行状态

| 角色值 | 中文 |
| --- | --- |
| `general_review` | 通用审查 |
| `java_reviewer` | Java 专项审查 |
| `security_reviewer` | 安全专项审查 |
| `architecture_reviewer` | 架构专项审查 |
| `memory_conflict_reviewer` | 规则冲突专项审查 |
| `governance_main` | 主协调 Agent |
| `reply_handler` | 回复复核 Agent |
| `health_auditor` | 健康检查 Agent |

前五项是可委派角色。Decision Extractor（决策提取器）也是模型处理流程，但当前不应把它当作已有同等 run 审计的角色。

| 字段 | 英文值 | 中文 |
| --- | --- | --- |
| review_mode（仓库策略） | `single` / `auto` | 单 Agent／按复杂度自动选择 |
| orchestration mode（实际执行方式） | `single` / `orchestrated` | 单 Agent／主协调加专项 |
| fallback（降级方式） | `validated_children` | 仅汇总已经校验的子结果 |
| agent run status | `running` / `succeeded` / `partial` | 执行中／成功／部分完成 |
| agent run status | `failed` / `timeout` / `cancelled` | 失败／超时／取消 |

### 10.7 Health 与 GitHub 事件

| 字段 | 英文值 | 中文 |
| --- | --- | --- |
| schedule（计划） | `off` / `daily` / `weekly` | 关闭／每日／每周 |
| trigger（触发来源） | `manual` / `schedule` | 手动／定时 |
| dimension（检查维度） | `code` / `ci` / `dependencies` / `documentation` | 代码／持续集成／依赖／文档 |
| CI source kind（来源类型） | `check` / `workflow` | 检查项／工作流 |
| reference kind（报告引用） | `code` / `ci` / `memory` | 代码／CI 信息／团队规则 |
| PR action | `opened` / `reopened` | 创建／重新打开 |
| PR action | `synchronize` / `ready_for_review` | 分支更新／由草稿转为就绪 |
| PR action | `closed` | 关闭；同时 `merged=true` 才是合并后的提取入口 |
| Review event（发布类型） | `COMMENT` | 仅评论 |

### 10.8 用量字段速查

这些不是枚举，但在运行详情中容易误解：

| 字段 | 中文 |
| --- | --- |
| `input` | 输入 tokens |
| `output` | 输出 tokens |
| `cacheRead` | 读取缓存的 tokens |
| `cacheWrite` | 写入缓存的 tokens |
| `totalTokens` | 已报告的总 tokens，包含缓存相关用量 |
| `unreportedTokens` | 没有得到实际 usage 回报、仍保留的预留额度；不是精确测量值 |

## 11. 如何看管理页与排查问题？

- **概览**：先判断近期任务有无异常，再进入对应 PR 或任务详情。
- **团队规则**：区分待确认与已生效；查看来源、理由、范围和版本后再确认。
- **仓库／审查策略**：检查是否启用、路径是否被过滤、输出语言、预算和专项上限。
- **审查讨论**：看具体 finding 的状态和线程绑定；支持分页，不代表首屏已经加载全部意见。
- **运行记录**：看角色、用量、失败原因和覆盖限制。Job 成功不等于每个专项成功，也不等于没有发现问题。
- **健康检查**：看报告固定的 SHA、窗口与覆盖限制，不把它当作实时全仓库健康保证。

遇到“为什么没回复”，依次检查：是否在 App 的行内线程、finding 是否仍可处理、仓库是否启用、是否有 Reply Job、Job 的错误／发布状态。遇到“为什么没使用某条规则”，先检查是否 `ACTIVE`、仓库和 scope 是否匹配，再考虑检索数量及排序限制。

App installation token 用来代表服务访问 GitHub；OAuth 用来识别管理页的人及检查其仓库权限；模型 API key 用来访问模型 Provider。这三种凭据不可混用。数据库连接配置也不会成为模型工具或提示内容。

## 12. 接下来从哪些文件读起？

| 想了解什么 | 入口 |
| --- | --- |
| 服务怎样启动、连接各处理器 | [src/main.ts](../src/main.ts) |
| 数据如何持久化与恢复 | [src/persistence/database.ts](../src/persistence/database.ts)、[数据库迁移目录](../migrations/) |
| Pi Session、工具和审查 | [src/review/review.processor.ts](../src/review/review.processor.ts) |
| 复杂度和专项协作 | [src/review/orchestration.ts](../src/review/orchestration.ts) |
| 团队规则的检索与生命周期 | [src/memory/memory.service.ts](../src/memory/memory.service.ts)、[Memory 设计](memory-design.md) |
| Agent、工具和结构化输出整体设计 | [架构说明](architecture.md) |
| GitHub 接入、发布与回复 | [GitHub 集成](github-integration.md) |
| 幂等、恢复、权限与预算 | [可靠性与安全](reliability-security.md) |
| 产品范围与阶段目标 | [PRD](PRD-MVP.md) |
| 已完成什么、实际测试了什么 | [UX 清单](tasks/UX.md)、[M2 清单](tasks/M2.md)、[M3 清单](tasks/M3.md) |

`src/queue.ts` 是 M0 的历史内存队列，不代表当前持久化 Worker 的实现。阅读时应从 `main.ts` 的实际装配路径进入，避免被旧代码名字误导。

最后记住这条闭环：**代码变更 → 受控 AI 审查 → 人类讨论 → 合并后提出规则 → 维护者确认 → 后续审查参考规则。** 自动化负责发现和整理，人类负责决定哪些经验应成为长期约束。
