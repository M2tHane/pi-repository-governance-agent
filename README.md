# Pi Repository Governance Agent

帮助团队 Review PR，并记住已经确认的工程决定。开发者在 PR 里查看简短问题与建议，维护者在管理页确认团队规则。底层使用 TypeScript、GitHub App、固定提交的只读 Workspace 与 Pi。

第一次了解项目，先读 [项目理解指南](docs/project-guide.md)：用具体 PR 解释整体流程、数据库各表、Pi 调用与扩展，并提供主要枚举值的中文对照。

服务支持 inline finding、线程复核、按需多 Agent、共享预算，以及 M3 的仓库健康检查与历史报告。本轮体验收口与验证见 [UX 清单](docs/tasks/UX.md)，健康检查实现记录见 [M3 清单](docs/tasks/M3.md)；M2 的独立人工验收状态见 [M2 清单](docs/tasks/M2.md)。

## 启动

需要 Node.js 24+、Git、Docker / PostgreSQL。

```sh
npm ci
npm run db:up
```

复制 [.env.example](.env.example) 为 `.env` 并填写 GitHub App、数据库、模型和 OAuth 配置。首次初始化数据库时执行：

```sh
npm run migrate
npm start
```

表结构已就绪后，正常启动只需 `npm start`，服务不会自动执行迁移。以后新增数据库结构变更时，再手动运行 `npm run migrate`，成功后启动服务。

`npm run migrate` 会先构建，`npm start` 只运行已有 `dist/`。开发时可使用 `npm run dev`：启动前构建一次，再监听编译产物；修改 `src/` 或 `admin/` 后需另行执行 `npm run build` 并刷新页面。数据库配置与默认本地端口见 [compose.yaml](compose.yaml)。正常服务只有一个 PostgreSQL Worker。

## 配置

| 变量 | 用途 |
| --- | --- |
| GITHUB_APP_ID / GITHUB_PRIVATE_KEY_PATH | App 身份与可读的本地私钥路径 |
| GITHUB_WEBHOOK_SECRET | 原始请求体 HMAC 验签 |
| GITHUB_ALLOWED_REPOSITORIES | 授权的 owner/repo，逗号分隔 |
| DATABASE_URL | PostgreSQL 连接 |
| MODEL_PROVIDER / MODEL_NAME / MODEL_API_KEY | Pi 模型；本项目真实验证使用 deepseek/deepseek-v4-flash |
| GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET | 管理界面的 GitHub OAuth |
| GITHUB_OAUTH_CALLBACK_URL | 与 App 设置一致的 /auth/github/callback 地址 |
| SESSION_SECRET | 至少 32 字符的本地会话签名 secret |
| PORT / WEBHOOK_MAX_BYTES | HTTP 端口与 Webhook 请求大小上限 |
| AGENT_TIMEOUT_MS | Review / 会话时间上限，默认 300000 ms；Health 取该值与 120000 ms 中的较小值 |
| QUEUE_CAPACITY | 保留用于 M0 内存队列；当前 PostgreSQL Worker 不使用此参数 |
| NODE_USE_ENV_PROXY / HTTPS_PROXY / NO_PROXY | 可选：让 Node 使用本机已有代理，保持 TLS 校验 |

OAuth state 有效期 10 分钟，登录会话有效期 8 小时，到期自动回收；两类记录各最多 1000 条，满额时新登录返回 503，请稍后重试。

管理页主导航为概览、团队规则和仓库；仓库页设置启停，设置 → 审查策略管理路径范围、输出语言、任务预算、审查方式和专项上限。预算不足会明确失败或 partial，不能按 child 数量扩大额度。固定复杂样本的评测配置和实际用量记录在 M2 清单中。

设置 → 审查讨论支持仓库筛选，每次最多加载 50 条，可继续加载、重试或刷新。管理页首次加载通过聚合 API 复用本次仓库授权，每次新请求仍重新检查权限。

设置 → 仓库健康检查使用同一仓库的路径范围、语言和预算。点击“运行健康检查”后，服务固定默认分支 SHA 和最近 30 天窗口；同仓库已有活动健康任务时返回原任务。定时默认关闭，可在健康检查页设置每日／每周，并查看下次 UTC 执行时间。

macOS 若对私钥路径返回 EPERM，应授权对应目录访问或将已有私钥放到可读的本地私密位置。浏览器能访问 GitHub 而 Node OAuth 请求失败时，检查系统代理与 Node 环境是否一致。

## GitHub App

1. 权限：Metadata Read、Contents Read、Pull requests Read & Write。
2. 订阅 Pull requests 和 Pull request review comments。
3. Webhook URL：`https://<公开地址>/github/webhook`，secret 与本地配置一致。
4. App 安装范围和 GITHUB_ALLOWED_REPOSITORIES 保持一致。
5. OAuth callback 与公开服务地址保持一致。

真实联调只在授权测试仓库进行。GitHub 发布使用短期 installation token；维护者管理操作使用 OAuth 与 CSRF 校验。

## 当前行为

- opened / reopened / synchronize / ready_for_review：Review 固定 head；Draft、closed、暂停仓库和 fork 不进入新 Review。
- 同根因候选合并为一个短评，保留关联位置和完整证据。可定位问题绑定 inline comment，不可靠的行号降级到 summary。
- 人类回复本 App 的已绑定线程：重新读取当前 head，产生 FIXED、MISJUDGMENT、VALID_EXCEPTION、STILL_VALID 或 NEEDS_CLARIFICATION。
- merged PR：Decision Extractor 只提出 CANDIDATE；ACTIVE / supersede / deprecate 仍需维护者操作。
- 简单 PR 使用单 Agent；复杂 PR 由 Main 从允许角色中选择，最多两项同时运行，深度固定为一层。
- Main、Specialist 与 Reply 都不获得 shell、写文件、GitHub 写工具或 Memory mutation。
- 新 head、Draft、关闭、暂停和服务停止会取消活动审查；发布前再次检查当前状态和 SHA。
- Health 使用独立只读 Agent，报告保存在管理页；不发布 GitHub 评论、不运行仓库脚本、不修改源码或 Memory。
- Health 定时与手动触发共享去重，异常重启最多补一个到期检查；领取时 PR / Reply / Decision 优先，不抢占已经运行的 Health。
- App 被删除、暂停或移除已登记仓库时，验签后的事件会停用对应仓库并取消相关审查。重新接入后由维护者明确恢复启用。

PostgreSQL 保存任务与幂等记录，异常重启后恢复 running Job。发布响应不确定时进入 uncertain，先核对远端再恢复。成功 Review 的线程绑定失败会单独标记，不重发整份 Review。当前不提供多 Worker 或 exactly-once 保证。

Health 的单次清单上限是 200 个文本文件、每文件 64 KiB、合计 2 MiB；每次文件工具最多返回 200 行／16000 字符。CI 只读取已有权限可见的元数据，最多保存 50 项来源。没有权限、没有记录、截断或未读完整时明确展示覆盖限制，零意见不代表健康保证。重试保持原 SHA／窗口，并扣除本任务此前实际和未知消耗；有报告的任务不会重复调用模型。

## 检查与固定模型对照

```sh
npm test
npm run test:db
npm run check:docs
npm audit --audit-level=high
```

`npm test` 包含构建、Node 内置测试、真实 Pi Session 配合 Provider 替身和本地 Git 样本。`test:db` 从环境或 `.env` 读取 `DATABASE_URL`，在临时 schema 运行并回收，不接触真实任务队列；缺少连接配置会跳过数据库用例，不能据退出码认定验证通过。两个测试命令都会构建，请顺序执行。

`check:docs` 验证 Notes 结构和格式，并检查根目录 Markdown、`docs/`、`.agents/notes/` 的本地文件链接与标题锚点。它遵守 Git 忽略规则，也检查未跟踪的新文档；代码示例、外部 URL 不作本地链接检查。外部链接可用性与文档语义仍需人工复核。文档与优化检查记录见 [UX 清单](docs/tasks/UX.md#2026-09-15文档同步与项目优化检查)。

固定对照使用测试仓库提交 `ad75aa1e1f1a3604682af068c2c048da23bbbe7a` 的干净 checkout：

```sh
npm run build
node --env-file=.env scripts/evaluate-m2.mjs /absolute/path/to/fixed-checkout
```

结果写入被忽略的 `work/m2-evaluation.json`。该命令只调用模型，不运行样本代码、不发布 GitHub Review；Memory 场景是合成数据。Main 改动后可加 `--selective-only` 复用相同 SHA 和预算下已保存的 single baseline。

订单根因聚合与真实规则引用使用完整演示保留的 `work/e2e-order-api`、`work/e2e-order-followup` checkout（固定 SHA 写在脚本中）：

```sh
node --env-file=.env scripts/evaluate-ux.mjs
```

结果保存到 `work/ux-model-evaluation.json`。可附 `orders-single`、`orders-main` 或 `rule-reference` 单独运行，结果按样本另存。它只读取数据库中的规则并调用模型；Main 样本显式调用编排，partial 状态原样记录。

产品范围见 [PRD-MVP](docs/PRD-MVP.md)，实现分层见 [architecture](docs/architecture.md)，安全与恢复见 [reliability-security](docs/reliability-security.md)。

完整运行机制和中文枚举见 [项目理解指南](docs/project-guide.md)，流程图提供 [draw.io 源文件](docs/diagrams/pr-review-memory-flow.drawio) 与 [PNG 预览](docs/diagrams/pr-review-memory-flow.png)。
