# Agent Note: M2 线程复核与选择性多 Agent

Status: proposed

## Problem

M1 的 summary finding 缺少稳定线程对象，人类无法让 Agent 针对当前代码复核。把审查维度简单并行化还会产生重复意见、遗漏失败消耗，并让总预算随会话数放大。

## Proposal

沿用 [M1 的 PostgreSQL、单 Worker 和 Memory 边界](../../implemented/architecture/2026-09-10-m1-team-memory.md)、固定 SHA Workspace 和现有 Publisher。新增 finding / thread 绑定、source comment 幂等、Reply 状态与仅供后续提取使用的 decision clue。

Finding 身份包含固定目标、位置、类别与 Memory ID/version。同一位置的不同问题用局部序号区分，完全相同的条目只发布一次；序号只在同一位置冲突时使用，不把全局数组下标当身份。保留首次已存结果使普通重试稳定；同位置问题重排时的语义身份需要完整结果缓存后再加强。摘要明确显示行内意见数量，不把没有摘要 finding 写成整次没有 finding。

复杂度由代码计算，Main 只从白名单选择独立专项。深度为一层、同时最多两项。Main 按服务生成的候选 key 分组同根因问题，服务校验完整性并保留原始证据与冲突意见；子 Session 不继承父 messages。

总预算在 Provider 请求发送前按实际 body 的 UTF-8 字节数加协议余量保守预留，输出最多 16384 tokens，完成后按含 cache 的实际 usage 结算。失败且缺少 usage 时保留预留额，单独标为未回报消耗。SDK 自动压缩、自动重试和 Provider 重试关闭。

取消信号覆盖 Main、child、Reply；每个会话单独保存 usage，不能在共享 AbortSignal.reason 上覆盖另一个会话的消耗。过期 Reply 重排同一 source comment。Review 已发布但线程绑定失败只影响绑定状态。

数据库测试使用独立临时 schema，避免测试 Runner 领取真实队列。固定模型对照保留提交、预算、raw findings、partial 和失败记录，再进行人工确认。

## Alternatives considered

- 固定运行所有专项：简单 PR 额外付费且没有增益，保留确定性路由与 single 模式。
- 纯代码 Main：能并发却不能承担角色选择和语义去重。固定样本在不同位置重复报告同一根因，因此采用真实 Main 与经过引用校验的候选分组。
- 仅按 line/category 指纹去重：能保证基础幂等，不能消除跨专项的语义重复；作为 Main 失败时的有限 fallback，并显示 limitation。
- 每个 child 独立获得完整预算：父任务会超额，采用共享请求预留和会话上限。
- 只设置单次输出上限：不能约束多轮工具调用，且 4096 tokens 会截断复杂 JSON。
- 对 SDK 原始 context 估算输入：把未发送的保留内容也计入，改为实际 Provider payload。仍不引入 tokenizer 依赖，接受保守拒绝的代价。
- Reply 直接修改 ACTIVE Memory：一次解释不足以确立团队规则，仅保存 clue。
- 在开发库直接跑 Runner 测试：可能领取真实任务，改用一次性 schema。

## Acceptance criteria

- 本地验证 own / foreign thread、五类结论、重复事件、stale head、uncertain、角色与路径范围、预算、取消、候选分组和 PostgreSQL 恢复。
- 真实 GitHub 评论能追溯到固定 head、finding、source comment 和 Job。
- 固定样本记录 single / selective 用量、耗时、去重和无效意见，不把 baseline 失败视为零 finding。
- 真实多 Agent 发布、push 新 head 取消、partial 与维护者增益确认齐备后，再迁移本 Note 为 implemented。

## Risks

字节预留会高估实际 token，低预算可能提前停止；未知 Provider 输出限制字段会明确拒绝。Main 的分组仍需要质量评估，保留全部证据不能替代人工判断。模型可能返回无效结构，必须失败或明确 partial。单 Worker 与 GitHub 外部副作用之间仍没有 exactly-once。

本地组合样本的多 Agent 消耗约为 single 的 8.53 倍、耗时约 3.20 倍。新增调用链证据与泛化意见必须分开评估，不能用数量差证明收益。

状态与具体阻塞只记录在 [M2 清单](../../../../docs/tasks/M2.md)。
