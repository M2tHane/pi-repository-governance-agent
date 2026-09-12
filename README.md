# Pi Repository Governance Agent

一个 TypeScript 服务，通过 GitHub App 接收 Webhook，在固定提交的只读 Workspace 中调用 Pi，发布 COMMENT Review，并将合并后的工程决定交给维护者确认后用于后续审查。

M0、M1 已完成。当前 M2 增加 inline finding、线程复核、按需多 Agent、共享预算和执行详情；验收状态与真实证据见 [M2 清单](docs/tasks/M2.md)。

## 启动

需要 Node.js 24+、Git、Docker / PostgreSQL。

```sh
npm ci
npm run db:up
```

复制 [.env.example](.env.example) 为 `.env` 并填写 GitHub App、数据库、模型和 OAuth 配置，然后：

```sh
npm run migrate
npm start
```

开发时使用 `npm run dev`。数据库配置与默认本地端口见 [compose.yaml](compose.yaml)。正常服务只有一个 PostgreSQL Worker。

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
| AGENT_TIMEOUT_MS | Review Job / 会话的时间上限，默认 300000 ms |
| QUEUE_CAPACITY | 保留用于 M0 内存队列；当前 PostgreSQL Worker 不使用此参数 |
| NODE_USE_ENV_PROXY / HTTPS_PROXY / NO_PROXY | 可选：让 Node 使用本机已有代理，保持 TLS 校验 |

管理界面可设置 repository enabled、路径范围、输出语言、Job 总 token 预算、single/auto 和 max delegates。预算不足会明确失败或 partial，不能按 child 数量扩大额度。固定复杂样本的评测配置和实际用量记录在 M2 清单中。

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
- 可定位 finding 绑定 inline comment；不可靠的行号降级到 summary。
- 人类回复本 App 的已绑定线程：重新读取当前 head，产生 FIXED、MISJUDGMENT、VALID_EXCEPTION、STILL_VALID 或 NEEDS_CLARIFICATION。
- merged PR：Decision Extractor 只提出 CANDIDATE；ACTIVE / supersede / deprecate 仍需维护者操作。
- 简单 PR 使用单 Agent；复杂 PR 由 Main 从允许角色中选择，最多两项同时运行，深度固定为一层。
- Main、Specialist 与 Reply 都不获得 shell、写文件、GitHub 写工具或 Memory mutation。
- 新 head、Draft、关闭、暂停和服务停止会取消活动审查；发布前再次检查当前状态和 SHA。

PostgreSQL 保存任务与幂等记录，异常重启后恢复 running Job。发布响应不确定时进入 uncertain，先核对远端再恢复。成功 Review 的线程绑定失败会单独标记，不重发整份 Review。当前不提供多 Worker 或 exactly-once 保证。

## 检查与固定模型对照

```sh
npm test
npm run test:db
npm run check:docs
npm audit --audit-level=high
```

`npm test` 包含构建、Node 内置测试、真实 Pi Session 配合 Provider 替身和本地 Git 样本。`test:db` 在临时 schema 运行并回收，不接触真实任务队列。

固定对照使用测试仓库提交 `ad75aa1e1f1a3604682af068c2c048da23bbbe7a` 的干净 checkout：

```sh
npm run build
node --env-file=.env scripts/evaluate-m2.mjs /absolute/path/to/fixed-checkout
```

结果写入被忽略的 `work/m2-evaluation.json`。该命令只调用模型，不运行样本代码、不发布 GitHub Review；Memory 场景是合成数据。Main 改动后可加 `--selective-only` 复用相同 SHA 和预算下已保存的 single baseline。

产品范围见 [PRD-MVP](docs/PRD-MVP.md)，实现分层见 [architecture](docs/architecture.md)，安全与恢复见 [reliability-security](docs/reliability-security.md)。
