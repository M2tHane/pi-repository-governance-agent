# Multi-Agent Review

## Context

简单 PR 通常只需一次审查；复杂变更可能需要不同视角。固定并行所有专项会放大费用与重复意见，而让模型自由委派会扩大工具、路径和预算边界。

## Decision

[复杂度判断](../../src/review/orchestration.ts) 由代码根据当前变更和已召回规则计算。简单任务保持单 Agent；复杂任务由 Main 从代码允许的 Specialist 白名单中选择，`maxDelegates` 限定数量，同时最多两项，委派深度固定为一层。每个会话独立，子会话只获得固定 Workspace、允许路径、已召回 Memory 和只读工具。

整个 Job 共享 token 预算和截止时间。每次 Provider 请求前预留额度，完成后按实际 usage 结算；没有 usage 的失败仍保留未知消耗，不能当作免费重试。

Main 对候选 finding 做语义分组，服务验证成员不重复、不遗漏、没有伪造引用，并保留各专项原始证据与分歧。子任务失败或 Main 仅能回退到已验证子结果时，可以形成明确标注覆盖限制的 partial 结果，不能声称全量审查完成。

## Why

角色白名单与一层深度让选择性审查可预测，避免递归委派和权限扩张。共享预算避免成本随会话数成倍增长。纯位置指纹只能做有限的机械去重；同根因的跨文件意见需要 Main 分组，同时仍由服务检查完整性。

## Constraints

- Main 与 Specialist 不能获得 shell、源码写入、GitHub 发布或 Memory mutation 工具。
- 子会话不得继承父会话可变 messages，也不得再委派。
- partial、未知 usage、专项失败和证据冲突必须显式呈现；不能靠合并隐藏候选。
- Reply 只复核已绑定的人类线程和当前 head，不能直接修改 `ACTIVE` Memory。
