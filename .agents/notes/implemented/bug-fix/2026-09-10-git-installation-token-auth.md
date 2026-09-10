# Agent Note: Git 固定提交下载使用非交互 installation token 认证

Status: implemented

## Problem

真实 PR 首次执行时，Workspace 的 `git fetch` 在 GitHub 拒绝原 Bearer header 后退回用户名提示。后台串行 Worker 因此无限等待，既没有失败状态，也阻塞后续任务。把 token 放进 clone URL 还会让凭据出现在 remote 配置和错误输出中。

## Decision

`withWorkspace` 将 installation token 编码为 `x-access-token:<token>` 的 Basic authorization header，通过 `GIT_CONFIG_VALUE_0` 只传给子进程环境。它同时设置 `GIT_TERMINAL_PROMPT=0`，认证失败立即成为可记录的 Job 错误；临时仓库 remote 仍是不含凭据的 GitHub HTTPS URL。

该入口继续使用干净的 `git init`、禁用 hooks 和 credential helper，并在成功或失败后删除当前 Job 创建的临时目录。

## Alternatives considered

### Bearer authorization header

优点是与 GitHub REST 请求一致，代码直观。真实 Smart HTTP fetch 没有接受当前写法并触发交互回退，因此不能作为已验证方案。

### token 写入 clone URL

GitHub 常见示例支持 `https://x-access-token:<token>@github.com/...`，兼容性清楚。但 token 会进入进程参数、Git remote 配置或错误文本，增加泄漏面，所以不用于本服务。

### 直接使用 GitHub Contents API 构造 Workspace

它不需要 Git Smart HTTP，并能逐文件控制访问；完整快照需要递归分页、二进制处理和大量请求。M0 已需要固定提交 Git 上下文，保留 Git fetch 更小。

## Consequences

收益：后台任务不会等待终端输入；remote 和命令参数不含 token；真实 installation token 能下载绑定 head SHA。

代价：运行环境仍必须提供 Git，且 header 认证依赖 GitHub Smart HTTP。未来若支持非 GitHub remote 或动态执行沙箱，需要分别定义凭据传递方式，不能复用该 GitHub 专用 header。

## Verification

2026-09-10 使用 installation `160592861` 从 `M2tHane/pi-review-test-repository` 获取 base `98cd7fa345ca0663fdd15120ad6b2774112f2aa7` 与 head `c422de6b52acb03e840dd2ece4feaf191e6585a7`。`git rev-parse HEAD` 等于目标 head，且受限读取成功取得 `src/note-store.js`；回调结束后 Workspace 被删除。`npm test` 的本地双提交样本同时通过。
