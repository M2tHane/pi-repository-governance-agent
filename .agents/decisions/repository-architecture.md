# Repository Architecture

## Context

服务同时处理 GitHub Webhook、持久 Job、PR Review、Reply、Team Memory、Health Audit 和管理 API。这些流程共享仓库授权、固定快照与 PostgreSQL 事务；按技术层拆成多个服务会让一次审查跨越更多部署和一致性边界。

## Decision

保持单个 Node 进程和一个 PostgreSQL Worker，以业务模块组织 `src/`。`bootstrap` 只装配依赖，`github` 接收并路由事件，`jobs` 负责领取与分派，`review`、`reply`、`memory`、`health` 各自处理业务，`admin` 提供管理接口，`persistence` 持有 SQL 和事务。

[Dispatcher](../../src/jobs/dispatcher.ts) 显式处理已知 Job Type；未知类型必须失败。[Database](../../src/persistence/database.ts) 暂时作为既有调用方的薄 facade，SQL 已归入业务 Repository。该 facade 是渐进迁移的兼容边界，不是继续集中新业务逻辑的理由。

PostgreSQL 同时承担持久状态、幂等键、事务和 Job 领取；外部 GitHub 发布由服务在提交前后明确处理不确定结果。运行时不自动执行迁移。

## Why

当前只有一条串行 Worker 链路，数据库行锁与 `FOR UPDATE SKIP LOCKED` 已覆盖领取和恢复。微服务、Redis 或 BullMQ 会增加队列与数据库之间的一致性问题及部署成本，尚无独立扩容证据。

手写 SQL 使事务范围、锁和幂等约束可见；ORM 或完整 DDD 层次会在当前规模引入重复映射。薄 facade 保留旧接口，让模块迁移不必同时重写调用方和状态机。

## Constraints

- 修改模块边界时保留 Webhook 验签、Job 状态、重试、取消与发布事务语义。
- 新 SQL 放在所属业务 Repository；不要把业务判断重新堆进 Database facade。
- 新 Job Type 必须显式接入 Dispatcher、持久化和验证，不能默认按 Review 处理。
- 只有实际吞吐、隔离或部署需求出现时，再评估多 Worker、独立服务或额外队列。
