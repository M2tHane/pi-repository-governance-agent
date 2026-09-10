# Agent Note: M0 用单个 Node 服务嵌入 Pi 完成 GitHub PR 摘要审查

Status: implemented

## Problem

项目需要先证明真实 PR 事件能够驱动一次受控的代码分析，并将有依据的结果返回原 PR。若第一阶段同时实现知识库、交互、复杂编排和多种部署组件，就难以判断 GitHub 集成、Pi 执行与产品结果之间的最小链路是否成立。

## Decision

一个 TypeScript / Node 服务承载 GitHub App Webhook、确定性事件路由、串行内存队列、固定提交 Workspace、Pi PR Review Agent 和 Review Publisher。

服务使用 GitHub App installation token 读取授权仓库。每个 Job 创建独立的 Pi `AgentSession`，SDK 固定为 `@earendil-works/pi-coding-agent@0.85.1`；`DefaultResourceLoader` 关闭目标仓库资源发现，`SessionManager.inMemory()` 隔离会话，只注册服务自有的 `read_file` 和 `search_text`。Agent 返回结构化结果，服务校验并发表绑定 `commit_id` 的 `COMMENT` Review。

M0 使用一个业务 Agent。Main Agent、专项 SubAgent、Memory、持久任务、前端和健康检查仍归属后续阶段。

## Boundaries

- 一级路由、验签、权限、Job 归属及发布决定由代码处理。
- Agent 只读当前任务 Workspace，不持有 shell、源码写工具、GitHub 凭据或发布工具。
- Git checkout 固定 base/head SHA，禁用 hooks、credential helper 和交互提示；路径规范化和真实符号链接路径都不得越界。
- 发布前重新读取 PR 状态与 head；旧 head 结果不发布到新提交。
- 内存队列只用于单实例演示，进程重启会丢失任务与去重状态。

## Alternatives considered

### Spring Boot 接入层 + Node/Pi Worker

它能复用 Java 后端经验并独立部署业务控制和 Agent。M0 只有一条审查链路，两套运行时会增加进程通信与部署配置，因此保留单服务；出现独立扩容或组织边界时再拆分。

### 每个任务启动 Pi CLI 子进程

它提供进程级上下文分离，也能复用 CLI。SDK 能直接传入受限工具、控制资源加载和读取结构化结果，子进程本身也不是安全沙箱，因此 M0 使用嵌入式 SDK。

### 持久队列与 PostgreSQL

它能跨重启恢复并为后续 Memory 提供存储。M0 只验证受控真实闭环，内存队列已经覆盖串行、容量、去重和失败保留；进入团队试用的 M1 前再落实持久化。

## Consequences

收益：真实 GitHub 事件可以在一个进程内完成固定提交分析与可追溯 COMMENT Review，Agent 权限和外部副作用由服务端限制，部署只需要 Node、Git、模型凭据与 GitHub App 配置。

代价：任务和去重状态无法跨重启恢复，GitHub API 与本地状态没有原子提交，发布结果不确定时需要人工核对。静态只读审查不运行目标仓库构建或测试，模型结论仍需人类判断。

升级触发：进入 M1 团队试用时加入 PostgreSQL 持久任务；只有独立扩容或运行不可信代码成为真实需求时，再引入 Worker 拆分或执行沙箱。

## Verification

2026-09-10，GitHub App `4897032` 的 installation `160592861` 只授权 `M2tHane/pi-review-test-repository`，权限最终为 Metadata Read、Contents Read、Pull requests Write，事件仅为 `pull_request`。

[测试 PR #1](https://github.com/M2tHane/pi-review-test-repository/pull/1) 的 opened delivery 产生 Review `5167031392`，绑定 head `c422de6b52acb03e840dd2ece4feaf191e6585a7`；修复提交触发 synchronize delivery，并产生 Review `5167054909`，绑定新 head `5313be76640bad951d821e93cee7bdd5b230dc02`。重复 delivery 没有产生第三条 Review。1 ms 超时实验记录为 `timeout` 且没有发布。

`npm test` 的 10 项行为测试、`npm run check:docs` 和依赖审计通过；目标测试仓库的 4 项测试通过。完整命令、Job、delivery、SHA、时长和 Review URL 记录在 [M0 清单](../../../../docs/tasks/M0.md)。
