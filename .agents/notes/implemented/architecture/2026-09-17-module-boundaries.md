# Agent Note: 单进程治理服务按业务边界组织源码

Status: implemented

## Problem

Webhook、Review、Job、Health 和 PostgreSQL 的实现长期平铺在 `src/`。`database.ts` 同时持有迁移、任务状态、发布、Finding、Memory 候选和健康报告 SQL；`main.ts` 同时装配依赖、分派 Job、启动调度与处理退出。追踪一次 PR 审查需要在多个含糊文件名之间跳转，重构时容易误改事务、取消和发布状态。

## Decision

[应用装配](../../../../src/bootstrap/application.ts) 保持单进程、单 PostgreSQL Pool，并把四种 Job Type 显式交给 [Dispatcher](../../../../src/jobs/dispatcher.ts)。`main.ts` 只启动应用和注册退出信号。[Webhook](../../../../src/github/webhook/handler.ts) 按原始 Body 验签后交由事件处理器判断是否入队。[Review Processor](../../../../src/review/review.processor.ts) 保留可顺读的主链路，[Publisher](../../../../src/review/review.publisher.ts) 集中管理快照复核、发布指纹、`uncertain` 和行内评论绑定。

[Database](../../../../src/persistence/database.ts) 保留原有方法签名，作为现有调用方与业务 Repository 的薄转发层；SQL 已按 Job、仓库、Review 发布、Finding、Reply、Agent Run、Health 和 Memory 候选归位。行映射与事务辅助独立于 Repository，避免运行时循环导入。事务范围、锁、重试和状态更新语句不因目录迁移改变。

[Health](../../../../src/health/health.processor.ts) 分开调度、Job 处理及只读审计服务；[Memory](../../../../src/memory/memory.service.ts) 与 Decision 提取同域。Admin 后端按路由和授权职责拆分，前端行为保持原样。测试镜像业务目录，数据库集成测试通过独立 Schema 共用准备与清理。

## Alternatives considered

- 微服务、ORM、完整 DDD 分层：会增加部署和抽象成本，现有业务链路无需更换。
- 一次性重写 SQL 和所有调用方：会同时改变持久化与业务边界，难以定位行为回归；保留薄转发层使阶段验证可执行。
- 把每条 SQL 拆成单独类：文件碎片多，无法改善事务理解；按业务聚合事务与 SQL。
- 将未知 Job Type 默认送入 Review：会误处理新类型；Dispatcher 明确失败。

## Consequences

新开发者可从目录直接定位 Webhook、Job、Review、Memory、Health、Admin 和 Persistence。代价是 `Database` 仍暴露历史聚合方法；它只转发至持有 SQL 的 Repository，后续调用方可以逐步直接依赖所属 Repository。未改变 PostgreSQL Schema、Prompt、Agent 编排和 GitHub 发布契约。

验证以每阶段构建、相关定向测试、真实 PostgreSQL 集成测试与最终全量测试为准。`npm test` 在未加载 `DATABASE_URL` 时跳过数据库集成场景，`npm run test:db` 单独执行这些场景。
