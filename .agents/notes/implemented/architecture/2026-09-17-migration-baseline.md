# Agent Note: 新部署使用当前 Schema Baseline

Status: implemented

## Problem

八份迁移记录了 M1、M2、健康检查和体验阶段的逐步演进。全新部署必须依次执行历史建表、删改约束和旧数据修复，难以直接看出当前 Schema。旧数据库已经记录这些文件名，直接替换迁移文件并在原库执行会使新的 baseline 再次尝试建表。

## Decision

[001_baseline.sql](../../../../migrations/001_baseline.sql) 直接创建当前 Schema：11 张业务表、最终列定义、约束和索引；[迁移执行器](../../../../src/persistence/migrations.ts) 与 `schema_migrations` 机制继续保留，后续结构变更从 `002_*.sql` 开始。只用于旧数据的 `UPDATE jobs SET last_error = NULL` 不进入空库 baseline。

Baseline 用于全新数据库或可重建的开发数据库。保留数据且已记录旧文件名的数据库不能直接执行此 baseline；需要单独设计迁移记录转换和数据核查后再切换。验证在随机命名的隔离 PostgreSQL schema 中完成，不对现有业务表执行 baseline。

## Alternatives considered

- 直接拼接旧 SQL：会保留多余的 `ALTER`、索引重建和旧数据修复，不能呈现最终定义。
- 删除迁移执行器并改用一份 `schema.sql`：会失去后续增量迁移的记录与幂等机制。
- 在现有旧库直接运行新文件：`schema_migrations` 只认识旧文件名，会重新建表并冲突。

## Consequences

新环境只需执行一份 baseline，后续继续使用 `npm run migrate`。迁移历史文件名从八条变成一条，因此已有数据的环境需要独立转换方案，不能依赖本次目录清理原地升级。

隔离 schema 中，旧八份迁移和新 baseline 的 12 张表（含 `schema_migrations`）在列类型、空值、默认值、约束、索引上逐项一致。`npm run migrate` 在全新 schema 成功执行，`npm run test:db` 的 13 项数据库测试通过。
