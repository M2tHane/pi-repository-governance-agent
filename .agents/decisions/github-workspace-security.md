# GitHub Workspace Security

## Context

审查服务必须从 GitHub 读取用户仓库的指定提交。Git fetch 的凭据与交互行为会影响后台 Worker；仓库内容、路径和符号链接则来自不可信输入，不能取得宿主机权限或改变 Agent 指令。

## Decision

[Workspace 入口](../../src/workspace/workspace.ts) 使用 GitHub App installation token，通过仅传给 Git 子进程的 Basic authorization header 认证。remote URL 和命令参数不含 token；`GIT_TERMINAL_PROMPT=0` 使认证失败立即返回，credential helper 与 hooks 被禁用。每个 Job 创建临时仓库，checkout 后核对目标 head SHA，结束时删除。

Agent 只能通过服务提供的受限只读工具访问该 Workspace。读取文件时同时检查规范化路径、父目录和最终真实路径，拒绝符号链接越界。仓库里的 README、AGENTS.md、提示词、源码和评论都只是待审数据，不能注册工具、改变身份或授权，也不运行目标仓库脚本。

## Why

GitHub Smart HTTP 对曾尝试的 Bearer header 回退到交互式用户名提示，可能无限阻塞串行 Worker。把 token 放入 clone URL 虽可认证，却会进入 remote 配置、进程参数或错误文本。子进程环境中的 header 与非交互设置同时降低这两类风险。

固定 SHA 和真实路径检查保证分析对象与发布前复核的提交一致，并阻止仓库符号链接读取宿主机文件。禁用资源发现和代码执行避免待审仓库把自身指令提升为服务权限。

## Constraints

- token 不得进入 clone URL、Git remote、日志、模型输入或目标仓库文件。
- Git 认证失败必须终止任务，不能等待终端输入或回退到用户 credential helper。
- 任何新增文件工具都必须遵守固定 Workspace、真实路径与只读边界。
- 发布前仍须重新确认仓库授权、PR 状态和当前 head；固定本地 checkout 不代替远端复核。
