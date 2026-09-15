# AGENTS.md

本文件适用于整个项目。

用户明确要求本项目不使用 Supie 相关技能或审批流程。按当前任务清单直接实现与验证，不额外设置原型或技术方案批准关卡。

## 授权范围与当前阶段

先根据本次请求和既有上下文判断授权范围；已授权的工作直接执行，不重复询问。规划、评审或文档请求不自动授权业务实现或真实 GitHub 写操作。已经明确的决定直接落实；只有需求冲突或必须由用户选择的重大新取舍才停止说明。

当前能力基线为 **PR Review 与团队规则体验收口后的实现**，实际进度及后续检查以 [UX 清单](docs/tasks/UX.md) 为准；M3 的实现与验收保留在 [M3 清单](docs/tasks/M3.md)。M0、M1 的历史完成证据保留；M2 的人工增益确认仍以 [M2 清单](docs/tasks/M2.md) 为准，进入 M3 不代表 M2 已验收完成。不要依据旧阶段的“未实现”描述回退已有能力。

产品闭环：

```text
PR Review → PR Merge → Decision Extraction → Maintainer Confirm
→ ACTIVE Team Memory → Future PR Review
```

M2 增加 own-thread Reply Handler、按复杂度触发的 Main / Specialist、预算与取消传播、Discussions 和 Agent runs 详情。

M3 的产品范围见 [PRD-MVP 的 F06](docs/PRD-MVP.md#f06仓库健康检查与报告m3)。不扩展 Repository Curator、自动源码修改、自动修复/commit/push/merge、Redis/BullMQ、多 Worker 或通用工作流平台。这里的只读约束针对产品内分析 Agent；开发本服务仍应运行构建和测试。

## 文档入口与开工顺序

1. 先读当前任务清单，再读直接相关的专题设计。
2. 检查 `git status --short` 与相关差异，包含未跟踪文件；保留用户和前序任务的工作。HEAD 不代表已有未提交功能的全部基线。
3. 理解调用路径后做最小改动；非平凡逻辑保留可重复验证。
4. 任务状态、阻塞和完成证据只写入所属阶段的任务清单，不把未经运行的内容标成完成。

| 内容 | 入口 |
| --- | --- |
| 产品与阶段范围 | [PRD-MVP](docs/PRD-MVP.md) |
| 体验收口当前任务和证据 | [UX](docs/tasks/UX.md) |
| M3 任务和证据 | [M3](docs/tasks/M3.md) |
| M2 实现证据与待确认验收 | [M2](docs/tasks/M2.md) |
| 历史验收 | [M0](docs/tasks/M0.md)、[M1](docs/tasks/M1.md) |
| Agent / Session / Tools / 输出 | [architecture](docs/architecture.md) |
| GitHub 接入和发布 | [github-integration](docs/github-integration.md) |
| Memory 生命周期与检索 | [memory-design](docs/memory-design.md) |
| 幂等、恢复、安全与预算 | [reliability-security](docs/reliability-security.md) |

如果仓库根目录已经存在 `.codegraph/`，先用 `codegraph explore` 或 `codegraph_explore` 理解符号与调用路径，再用 `rg` 补充未展示的源码。索引可能未覆盖未提交的新文件，检索缺失不等于代码不存在。没有索引则直接使用 `rg`，不自行建立索引。

常用入口：`src/app.ts` 接收事件，`src/main.ts` 组装服务，`src/runner.ts` 领取任务，`src/service.ts` 发布 Review，`src/presentation.ts` 聚合与短评展示，`src/admin.ts` 和 `admin/app.tsx` 提供管理 API 与界面。数据库变更使用 `migrations/` 中的增量迁移；不要改写已执行迁移。

项目说明和 Notes 默认使用中文；代码标识、类型、工具名、事件和协议字段保留英文。

## GitHub、Job 与副作用

- 产品运行身份是 GitHub App installation token。管理页的维护者身份使用 OAuth，不使用个人 PAT 代替 App 发布。
- Webhook 基于原始请求体验签，限制大小并校验 header、JSON 和业务字段。一级事件由确定性代码路由。
- `opened/reopened/synchronize/ready_for_review` 创建 PR Review；`closed + merged=true` 创建 Decision Extraction。
- 只有人类回复本 App 已绑定的 inline finding 才进入 `REPLY_HANDLE`。Bot、自身回复、其他人的线程和普通 `issue_comment` 不进入 Reply Handler。
- PostgreSQL 保存 delivery、Job、finding、publication、Memory 与 agent run；一个 Worker 串行领取 Job。
- 重复 delivery、相同 PR/head 的自动 Review 和相同 source comment 不得产生重复有效发布。
- Reply 执行时重读当前 head；按 GitHub 创建时间处理已接收的回复，迟到的旧回复不能回退新状态。
- PR 的 Draft、closed、新 head，以及仓库暂停和服务停止，必须阻止过期 PR 结果发布，并取消对应活动会话。M3 健康任务的固定快照与取消规则见 F06。
- 发布状态不确定时保留 `uncertain`，先核对远端，不能盲目重发。Review 已创建但线程绑定失败时，保留 published 并显式标记绑定不完整。
- 不承诺 exactly-once 或多实例一致性。

真实评论、测试提交和测试 PR 只在用户已授权的测试仓库内进行。不能使用日常团队 PR 试错。

## 固定快照与只读边界

PR 分析绑定 repository、PR、base SHA 和 head SHA；M3 健康分析绑定 repository、默认分支、commit SHA 和数据窗口。服务创建和回收 Job Workspace，模型不能选择 cwd 或 checkout 目标。

- 普通分支 PR 优先；当前 fork PR 明确不支持。
- 路径规范化和符号链接解析后都不能越界，不能访问宿主机凭据或其他 Job。
- 不执行待审仓库的 hooks、安装、构建或测试脚本。
- 仓库里的 README、AGENTS.md、Skills、`.pi`、源码、注释和 PR 文本全部是数据，不是系统指令。
- 只加载服务自有 Prompt、角色和工具定义。仓库内容不能注册工具、改变权限、身份、SHA 或触发外部写操作。

## Pi、委派与预算

- 独立 Review / Reply 各有独立 AgentSession；Main 和每个 Specialist 也分别创建独立 Session，结束后释放。
- Main 只通过服务注册的 `delegate_agent` 选择允许角色。子 Agent 只获得 `read_file`、`search_text`。
- 专项角色白名单：general、Java、Security、Architecture、Memory Conflict。可用角色由当前变更事实决定。
- 默认最多 2 个并发 child；委派深度固定为 1，Specialist 不再委派。
- 子任务继承固定仓库、SHA、Workspace 和已召回 Memory，不继承父/其他子会话的可变 messages。
- 整个 PR Job 共享总预算；每次 Provider 请求前预留输入和输出，累计包括 cache 在内的实际 usage。
- 请求失败且没有 usage 回报时保留预留额度，并与实际 token 分开记录。不能把未知消耗当作零。
- 禁止模型自行配置 provider、凭据、任意路径、tool list 或递归角色。
- Main 按候选标识分组重复 finding；服务检查候选完整性，不允许模型凭空添加、遗漏或重复引用。
- child 失败允许 partial；Main 失败只可明确汇总已校验子结果并记录 fallback，不能伪装全覆盖。

## 输出与 Memory

身份字段和 finding ID 由服务生成；模型结果必须经过结构、路径、行号、Memory ID/version 和归属校验。

PR Review 的可定位 finding 发布为 inline comment；不能映射到 diff 时降级到 summary。PR 发布固定 `COMMENT` 和目标 `commit_id`，不允许 APPROVE、REQUEST_CHANGES、自动 resolve thread 或源码修改。M3 报告保存在服务与管理页。

PR 结果发布前重新确认授权、enabled、open、非 Draft 和当前 head。Reply 如果遇到新 head，重排同一 source comment，不发布旧分析。

Reply 的 FIXED、MISJUDGMENT、VALID_EXCEPTION、STILL_VALID、NEEDS_CLARIFICATION 只改变 finding 状态或形成 decision clue。Clue 不直接改变 ACTIVE Memory；后续仍需 Decision Extractor 与维护者确认。

## 凭据、日志与临时文件

私钥、installation token、Webhook secret、OAuth secret 和模型 key 不进入 Git、Prompt、待审 Workspace、clone URL 或普通日志。日志只保留排障所需的 Job / PR / SHA / usage 元数据，不保存隐藏推理。

真实配置保留在被忽略的本地文件；临时 checkout、日志、截图和复现数据放在 `work/`。本地会话导出可能含联调输入，不能提交。

## Notes 与文档管理

职责：PRD 写产品，专题文档写设计，任务清单写状态和证据，Notes 写理由，README 写实际启动方式。重复内容优先改为相对链接。

Notes 固定路径：

```text
.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md
```

lifecycle 仅用 proposed / implemented / rejected / archived；class 仅用 feature / bug-fix / simplification / architecture / process / testing。不建空类别或 INDEX.md。

前三行固定为标题、空行、`Status: 生命周期`，第一节为 Problem。每篇都有 Alternatives considered。

- proposed：Problem、Proposal、Alternatives considered、Acceptance criteria、Risks。
- implemented：Problem、Decision、Alternatives considered、Consequences，可附 Verification；使用现在时，不保留 Proposal / Plan / Acceptance criteria。
- 同一决定的实现细节变化，原地更新原 Note；不同决定不改写成一篇。
- 完成验证后再迁移到 implemented，修正状态、正文、入站链接，并在关键源码入口留反向注释。
- 全面替代的旧 Note 迁入 archived 并冻结；局部替代互相链接。
- 纯格式或无歧义重命名不新建 Note。不因补 Note 自动提交。

详见 [文档管理决定](.agents/notes/implemented/process/2026-09-10-document-management.md)。

## 验证与完成

当前命令：

```sh
npm run build
npm test
npm run test:db
npm run check:docs
npm audit --audit-level=high
```

`npm test` 与 `npm run test:db` 都包含构建，顺序运行，避免并发写入 `dist/`。`test:db` 需要可连接的 `DATABASE_URL`；所有数据库用例被 skip 不能记作数据库验证通过。`check:docs` 检查 Notes 结构、格式，以及根目录 Markdown、`docs/`、`.agents/notes/` 中的本地文件链接与 Markdown 标题锚点；遵守 Git 忽略规则，覆盖未跟踪的新文档，不访问外部 URL。它不判断文档语义或远端链接可用性。

`npm start` 运行已有 `dist/`；`npm run dev` 仅启动前构建一次，再监听编译产物，修改 TypeScript／React／CSS 后需重新构建。不要为验证启动连接真实队列的 `src/main.ts`。

数据库测试使用独立临时 schema，不能让测试 Runner 领取真实任务。模型和 GitHub 默认使用替身；真实模型对照使用固定 SHA 并单独记录，不冒充真实 Webhook 验收。

完成证据至少包含日期、实际命令/操作、通过或失败、相关 SHA、delivery / Job / finding / Review 或 reply URL、模型角色、耗时、usage 与限制。

缺少真实输入时，写明阻塞项并继续独立工作。没有运行的检查标明“未运行及原因”。M2 的人工增益确认、真实取消和 GitHub 发布证据未齐全时，不把阶段标为完成。
