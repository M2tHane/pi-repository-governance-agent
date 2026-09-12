# Agent Note: M1 用 PostgreSQL Team Memory 延续跨 PR 工程决定

Status: implemented

## Problem

M0 的内存队列只能完成单次 PR Review。进程重启会丢失任务，合并后的讨论不会形成可治理的长期规则，后续 Review 也无法区分团队确认的决定与模型临时判断。

## Decision

单个 Node 服务继续承载确定性路由和 Pi Agent，并以 PostgreSQL 保存 Webhook delivery、Job、发布状态、Repository 配置、Memory 版本与审计记录。数据库驱动的单 Worker 恢复异常中断任务，对可恢复错误最多执行三次；发布前检查固定 head、PR 状态、仓库授权与启用状态。

`pull_request.closed` 只在 `merged=true` 时创建 `DECISION_EXTRACT` Job。Decision Extractor 读取合并快照、最终 changed files 和人类讨论，只能输出带人类评论与代码双证据的 `CANDIDATE`。重复来源通过仓库内指纹保持幂等。

Maintainer 通过 GitHub App OAuth 登录。服务端保存短期用户 token，浏览器只持有 HttpOnly、SameSite Session Cookie；所有 mutation 同时校验 Session、Origin/CSRF、Memory 的实际仓库归属，以及用户对该仓库的 `maintain` 或 `admin` 权限。只有人类确认的 `ACTIVE` Memory 会先按仓库和 Scope 过滤，再作为只读输入交给 PR Review Agent。服务端再次校验模型返回的 Memory ID、version 和 source。

React 管理页由同一服务提供静态资源，只覆盖 Repositories、Jobs 和 Team Memory。仓库暂停会阻止新 Job；include/exclude paths 限制审查文件，output language 和 token budget 随 Job 传给 Agent。

## Alternatives considered

### ORM、Redis 与独立 Worker

M1 只有一个服务和一个 Worker。`pg`、SQL migration 和 `FOR UPDATE SKIP LOCKED` 已覆盖持久领取、恢复及幂等，不增加 ORM、Redis、BullMQ 或进程间协议。只有多实例吞吐成为真实瓶颈时才扩展调度。

### 自动激活高 confidence 决策

模型 confidence 不能代表团队授权。自动激活会把误提取内容变成后续 Review 的强规则，因此所有提取结果停在 `CANDIDATE`，必须由有仓库权限的人确认。

### 保存 OAuth token 到业务表

M1 只在交互 Session 内需要用户 token 来实时检查仓库权限。服务端内存 Session 已满足要求，并减少持久凭据面；代价是服务重启后管理员需要重新登录。

### VectorDB 与跨仓库检索

首个闭环先使用仓库隔离、Scope 过滤和轻量文本排序。它足以验证决定能否跨 PR 复用，也避免文本相似导致跨仓库规则泄漏。召回质量出现可测量缺口后再评估向量检索。

## Consequences

后续 [M2 线程复核与选择性多 Agent](../../proposed/architecture/2026-09-11-m2-reply-and-multi-agent.md) 在本决定的 PostgreSQL / Workspace / Memory 边界上扩展 finding、reply 和 agent run，不替换维护者确认流程。

收益：受支持的 Webhook 在事务提交后才返回 202，任务能跨正常重启恢复；合并讨论形成可追溯但默认不生效的候选规则；维护者操作有真实 GitHub 权限边界；后续 Review 只能引用当前仓库实际召回的 ACTIVE 版本。

代价：单 Worker 限制吞吐，内存 OAuth Session 会在重启时失效，文本检索对语义改写不敏感。真实跨 PR 证明仍依赖已授权测试仓库中的 PR A/PR B 操作，本地测试不能替代这项外部证据。

## Verification

2026-09-11，PostgreSQL 18.6 上 `npm run test:db` 覆盖 migration 幂等、delivery 去重、重启恢复、三次重试、merged 路由、Memory 版本与 Scope、OAuth state、Session、CSRF、Maintainer 操作、跨仓库拒绝和暂停仓库。`npm test` 覆盖 M0 回归、Decision 输出约束和模型 Memory 引用校验。

[PR #2](https://github.com/M2tHane/pi-review-test-repository/pull/2) 的合并讨论生成 Memory `df080917-5a9d-4059-9b3c-e0be1fdd0dd8`；真实 GitHub OAuth user `M2tHane` 将其激活并更新到 v2。[PR #3 Review](https://github.com/M2tHane/pi-review-test-repository/pull/3#pullrequestreview-5169083573) 只引用 ACTIVE v2 和 PR #2 来源，[PR #4 Review](https://github.com/M2tHane/pi-review-test-repository/pull/4#pullrequestreview-5169028729) 在 Scope 外召回 0 条规则。merge commit、squash 和 rebase 的真实快照、Worker 异常恢复及 delivery 重投证据记录在 [M1 清单](../../../../docs/tasks/M1.md)。
