# Pi Repository Governance Agent

单个 TypeScript 服务接收 GitHub App Webhook，通过 Pi SDK 审查固定 PR 提交，并发布 `COMMENT` Review。M0 的真实 GitHub → Pi → COMMENT Review 技术闭环与最小权限已验证，证据见 [M0 清单](docs/tasks/M0.md)。

## 环境与命令

需要 Node.js 24+ 和 Git。安装依赖：

```sh
npm install
```

复制 [.env.example](.env.example) 为 `.env`，填写实际配置后运行：

```sh
npm run dev
```

生产式本地启动与检查：

```sh
npm run build
npm start
npm test
npm run check:docs
```

`npm test` 会先构建，再用 Node 内置测试运行本地替身和固定 Git 样本。

## 配置

| 变量 | 用途 |
| --- | --- |
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_PRIVATE_KEY_PATH` | App 私钥的绝对路径；私钥不放入仓库 |
| `GITHUB_WEBHOOK_SECRET` | Webhook HMAC secret |
| `GITHUB_ALLOWED_REPOSITORIES` | 允许的 `owner/repo`，多个用逗号分隔 |
| `MODEL_PROVIDER` / `MODEL_NAME` | Pi 使用的 provider 和模型 |
| `MODEL_API_KEY` | 对应模型凭据 |
| `PORT` | HTTP 监听端口 |
| `WEBHOOK_MAX_BYTES` | Webhook 请求体上限 |
| `QUEUE_CAPACITY` | 运行中与待执行任务总上限 |
| `AGENT_TIMEOUT_MS` | 单次 Pi 审查超时 |

配置缺失、整数无效或私钥文件不可读时，进程会在监听前失败。服务日志只记录 Job、PR、SHA、Review 与模型用量元数据，不输出 token、私钥或 Webhook secret。

## GitHub App

1. 在 GitHub 创建 App，权限设为 Metadata: Read、Contents: Read、Pull requests: Read & Write。
2. 订阅 `pull_request` 事件，将 Webhook URL 设为 `https://<公开地址>/github/webhook`，secret 与 `.env` 一致。
3. 只把 App 安装到用于演示的仓库，并把同一 `owner/repo` 写入 `GITHUB_ALLOWED_REPOSITORIES`。
4. 本地联调时自行启动已有 HTTPS 隧道，将转发目标设为 `http://localhost:$PORT`。隧道地址不写入代码。
5. 演示结束后停止隧道；需要撤销接入时，在仓库或组织的 GitHub Apps 设置中卸载该 App，并删除本地私钥和 `.env`。

GitHub 调用使用短期 installation token，不支持个人 PAT 回退。普通分支 PR 受支持；fork PR 在 M0 明确忽略。

## 运行边界

支持 `opened`、`reopened`、`synchronize`、`ready_for_review`。Draft、closed、无关 action、未授权仓库和 fork PR 不进入 Pi。Agent 只有限制在临时 Workspace 内的 `read_file`、`search_text`，不会加载待审仓库的 AGENTS.md、Skills、`.pi` 配置或扩展，也不能执行 shell 或写 GitHub。

M0 使用单进程串行内存队列。重启会丢失任务和去重状态，不支持多实例一致性、自动重试、跨重启恢复或 exactly-once。GitHub 发布网络结果不确定时任务记为 `uncertain`，需要先到 PR 核对，不会立即盲目重发。

常见错误：

- `签名无效`：检查 GitHub App 与 `.env` 的 Webhook secret 是否一致。
- `GitHub installation 认证失败`：检查 App ID、私钥、installation 是否仍有效。
- `GitHub API ... (403)`：检查 App 权限及仓库授权，修复后从 GitHub 重投 delivery。
- `未知模型`：检查 Pi provider/model 名称与 `MODEL_API_KEY`。
- `superseded`：PR 已关闭、转为 Draft 或 head 已更新；以最新 head 的事件重新审查。

产品范围见 [PRD-MVP](docs/PRD-MVP.md)，安全边界见 [reliability-security](docs/reliability-security.md)。
