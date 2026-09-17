# Team Memory

## Context

PR 合并后的代码和讨论可能包含可复用的团队决定，但模型提取只能提出解释，不能代表团队授权。错误规则一旦进入后续 Review，会持续影响多个 PR；不同仓库的决定也不能相互泄漏。

## Decision

仅合并的 PR 触发 Decision Extraction。提取器依据合并快照、代码变化和人类讨论形成带来源的 `CANDIDATE`；具有该仓库维护权限的人通过管理界面确认后，规则才成为 `ACTIVE`。

[MemoryService](../../src/memory/memory.service.ts) 按 repository、状态和 Scope 检索当前有效版本；[Review 校验](../../src/review/review.processor.ts) 再核对模型引用的 ID、version、仓库和实际召回集合。候选修改生成新版本，待确认版本不自动撤销旧的有效版本。Reply 的解释只形成 clue，仍须经过提取与维护者确认。

## Why

模型的 confidence 衡量不了团队是否同意某项工程约束；自动激活会把误提取变成强规则。仓库权限与来源证据使规则的生效有明确责任人和可追溯依据。

当前先用仓库隔离、Scope 过滤和轻量文本排序。VectorDB 会增加索引维护与跨仓库召回风险，只有检索质量出现可测量缺口时才值得评估。

## Constraints

- 模型不得创建、激活、替代或停用 `ACTIVE` Memory。
- Review 只接收当前仓库、当前 Scope 内实际召回的 `ACTIVE` 版本；模型不能伪造 Memory 引用或来源。
- 保留人类评论与代码的来源校验、版本校验、仓库隔离和维护者权限检查。
- 例外规则必须限定 Scope 并关联本仓库仍有效的原规则。
