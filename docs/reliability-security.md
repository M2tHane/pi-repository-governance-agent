# Pi Repository Governance Agent — Reliability & Security

版本：v0.1｜日期：2026-09-10

> 本文定义事件接收、任务幂等、恢复、重试、发布一致性、权限、工作区隔离和数据安全边界。

## 1. 目标

系统需要保证：

- Webhook 快速可靠接收。
- 同一事件不会产生重复业务效果。
- 新提交不会被旧 Review 覆盖。
- 服务重启后已接收任务可以恢复。
- GitHub API 响应丢失时不盲目重复评论。
- Agent 不能越权读取其他仓库或宿主机资源。
- 仓库中的恶意内容不能改变系统权限和执行边界。
- 所有外部副作用可追溯。

## 2. 接收可靠性

### 2.1 Webhook 接收

流程：

1. 基于原始请求体验签。
2. 验证事件格式、installation 和 repository 归属。
3. 对支持事件保存 delivery 记录和 Job。
4. 事务成功后再确认接收。
5. 快速返回 2XX / 202。

M0 演示可以使用内存队列，但必须明确：服务重启会丢失未完成任务。

M1 使用 PostgreSQL 持久化事件和 Job。

数据库不可用时不能“假装接收成功”。

## 3. 幂等模型

系统分两层幂等。

### 3.1 接收层

以 GitHub `delivery_id` 去重。

收到相同 delivery_id：

- 已完成：直接确认，不重复建任务。
- 未完成：复用现有任务。
- 已失败：根据现有记录允许人工重投 / 恢复。

人工重投不能因为 delivery 已存在而永久失效。

### 3.2 业务层

按业务对象进一步防重复：

```text
repository
+ PR
+ task_type
+ target_sha / source_comment_id
```

例如：

- PR Review：repository + PR + head SHA。
- Reply Handler：repository + PR + review_comment_id。
- Decision Extractor：repository + PR + merged snapshot / merge identity。

## 4. Job 状态

至少支持：

- `queued`
- `running`
- `succeeded`
- `partial`
- `failed`
- `superseded`
- `cancelled`

重试复用同一个 Job，并记录：

- attempt。
- last_error。
- next_run_at。
- started_at / finished_at。

分析完成但尚未确认 GitHub 发布成功的 Job 不能标记为 succeeded。

## 5. 任务顺序与旧结果

同一个 PR 的 Review 发布串行化。

当新的 synchronize 事件到来：

- 排队中的旧 head Review → superseded。
- 正在执行的旧 Review → 尽力取消。
- 发布前再次检查 PR 当前 head。
- 当前结果与 head 不一致 → 不发布。
- 如最新 head 缺少任务 → 补建。

合并后的 Decision Extractor 或不同的人类回复不能因为“只保留最新 PR Review”而被错误丢弃。

## 6. GitHub 发布一致性

数据库和 GitHub API 之间无法获得天然 exactly-once。

因此目标是：**幂等记录 + 远端核对 + 可恢复状态机**。

发布前：

- 保存结果 fingerprint / 稳定标记。
- 校验 PR、head、repository 状态。

发布后：

- 保存 GitHub Review / Comment ID。

若 GitHub 已接受请求但客户端没有收到响应：

1. Job 进入待核对状态。
2. 通过已保存标记或远端记录查询是否已经发布。
3. 确认未发布后才能重试。
4. 不盲目重复发送。

## 7. 重试策略

可重试：

- HTTP 429。
- 临时网络错误。
- 模型临时错误。
- GitHub / 模型短暂 5xx。

策略：

- 有上限的指数退避。
- 尊重 Retry-After。
- 建议最多 3 次执行尝试。

不可持续重试：

- 权限失效。
- repository 已取消授权。
- 请求签名错误。
- 无效输入。
- 明确的资源不存在。
- 服务端校验失败。

这些进入 failed / manual intervention。

## 8. 服务恢复

M1 单实例启动时：

- 恢复 queued Job。
- 识别异常退出遗留的 running Job。
- 将中断任务恢复为可重新领取状态。

多 Worker 后再增加：

- Job lease。
- lease expiration。
- 领取原子性。
- Worker crash recovery。

不提前为尚未出现的扩容问题引入复杂队列平台。

## 9. 漏投递补偿

GitHub 不会自动重投所有失败 Webhook。

M1 必须至少具备：

- 查看失败投递的方法。
- 人工重投操作步骤。
- 服务恢复后检查 GitHub App delivery 记录的能力。

自动补偿脚本在持续运行需求明确后再增加。

## 10. Agent 权限边界

分析 Agent 默认只获得只读能力。

允许：

- read / grep / find / ls。
- 受限 git diff / log / blame。
- 当前 Job 范围内 GitHub 读取。
- 当前 team / repository 范围内 Memory 读取。

禁止：

- 任意 shell。
- edit / write。
- git push。
- create PR。
- merge PR。
- memory activate / supersede / deprecate。
- 直接 GitHub create review / reply comment。
- 读取其他 Job、其他仓库或宿主机凭据。

## 11. 仓库内容的信任边界

以下内容全部视为**待分析数据**：

- PR description。
- PR comments。
- source code。
- README。
- AGENTS.md。
- 仓库内 `.pi` 配置。
- 任何提示模型执行命令的文本。

这些内容不能修改：

- 服务端 system prompt。
- Tool 权限。
- Memory 生效条件。
- GitHub 发布对象。
- repository / team 归属。
- delegate_agent 角色白名单。

## 12. Pi ResourceLoader

Pi 的默认资源发现能力可能读取工作目录中的上下文、Skills 或扩展配置。

本系统必须使用受控 ResourceLoader：

- 只加载服务维护的 Agent 定义。
- 只加载服务维护的 Skills。
- 只加载服务维护的 Extensions。
- 不从待审 PR 工作区自动加载可执行扩展。

仓库自己的 `.pi`、AGENTS.md 等只能作为数据读取，不能改变执行能力。

## 13. 工作区隔离

每个 Job 使用独立只读仓库工作区，并绑定固定 SHA。

必须约束：

- 工具根路径。
- `..` 路径穿越。
- 符号链接解析。
- 可读目录白名单。
- Git 命令白名单。
- Git hooks。
- 外部 filter / helper。

模型不能通过 symlink、Git 配置或命令参数读取宿主机凭据或其他 Job 目录。

初期不执行被审仓库：

- build。
- test script。
- package install。
- arbitrary binary。

优先使用静态代码分析和已有 CI 结果。

未来如需动态验证，应引入专门执行沙箱：

- 无宿主机凭据。
- 受限网络。
- CPU / memory / time 限制。
- 临时文件系统。

## 14. GitHub 权限最小化

核心 MVP：

| GitHub 权限 | 级别 |
| --- | --- |
| Metadata | Read |
| Contents | Read |
| Pull requests | Read & Write |
| Contents Write | 不申请 |
| Actions / Checks | 默认不申请 |
| Security alerts | 默认不申请 |

Pull requests Write 只用于 COMMENT Review / 评论。

服务端不允许模型选择：

- APPROVE。
- REQUEST_CHANGES。
- Merge。

## 15. Token 与凭据

使用 GitHub App installation access token。

要求：

- Token 由 GitHub 适配层管理。
- 不进入模型 prompt。
- 不写入 Agent 可读工作区。
- 不记录到普通日志。
- 错误日志对 Token / Secret 做脱敏。

其他模型 API key 和内部凭据采用同样原则。

## 16. 数据边界

所有核心对象都必须带归属：

- Job → team + repository。
- Memory → team + repository / authorized scope。
- Review Result → repository + PR + SHA。
- Audit Record → source Job + user / system actor。

服务端在以下边界分别校验权限：

- 管理 API。
- Memory 检索。
- GitHub 发布。
- 手动任务重试。
- Memory 激活 / 替代 / 废弃。

模型给出的 repository_id、Memory ID 或 URL 永远不能代替服务端授权判断。

## 17. 模型数据流

源码按任务需要发送给配置的模型服务。

团队必须能够明确：

- 使用哪个模型供应商。
- 哪些源码 / diff 会被发送。
- 日志保存什么。
- 数据保留多久。

日志应屏蔽：

- 密钥。
- Token。
- 不必要敏感内容。

审计应保留：

- Job。
- repository / PR / commit。
- 工具执行摘要。
- 引用来源。
- 模型用量。
- 最终结果。
- 外部副作用。

不需要保留或展示模型内部思维过程。

## 18. 生命周期与数据删除

Job 工作区在任务完成后回收。

Session / 审计可按服务配置保留，例如试用默认 30 天。

Team Memory 独立保存，并遵循自身生命周期。

仓库撤销接入或团队要求删除数据时，需要明确：

- Job 是否删除。
- Review 结果是否删除。
- Audit 是否保留。
- Memory 是否删除或归档。
- 工作区和缓存是否立即回收。

## 19. 预算与资源限制

M2 的 repository budgetTokens 是整个 PR Job 的总量。Main 与 child 在同一 ledger 预留每次 Provider 实际 body 的输入字节估计及输出，完成后按含 cache 的 usage 结算；单次输出最多 16384 tokens。估计包含协议余量，会保守拒绝，不能把额度视为精确 tokenizer 结果。

Provider 已收到请求但未回报 usage 时，保留该次预留额度，并与实际 token 分列。失败和取消的会话也保存用量；共享取消原因不承载可被其他 Session 覆盖的 usage。SDK 自动压缩、自动重试及 Provider 重试关闭。

委派深度固定 1、同时最多 2 项；role、focus path、Memory、时间和 token 都由服务检查。Draft、closed、新 head、仓库暂停和受控停止通过 AbortSignal 取消 Main 与 child。Reply 遇到 superseded 则重新绑定当前 head，不丢失人类回复。

数据库测试在一次性 schema 运行；测试 Worker 不接触真实 Job 队列。当前验证和限制见 [M2 清单](./tasks/M2.md)。

M3 Health 的预算还跨 Job 重试与进程恢复持久保存。每次模型请求前，onUsage 必须先成功保存已消耗量与本次最大预留；写入失败就不发送 Provider 请求。收到 usage 后结算；进程在响应前消失时，旧预留作为 unreportedTokens 保留。下一次尝试扣除同一 Job 的实际与未知消耗，不因手动重试重置额度。

Health 的文件清单、单文件／总字节、工具返回行数、CI 页数与来源数量均有上限；报告记录实际读取范围。GitHub、Git、文件与模型阶段共用取消信号，最大任务时限为 AGENT_TIMEOUT_MS 与 120 秒的较小值。失败或缺失数据不等于检查通过；趋势只比较可比维度。当前边界与证据见 [M3 清单](./tasks/M3.md)。

每个 Job 应配置：

- 最大模型调用次数。
- 最大 Token / 成本预算。
- 最大运行时间。
- 最大并发子任务数。
- delegate_agent 总预算。

父任务取消必须传播至尚未完成的子任务。

预算耗尽时：

- Job 标记 partial 或 failed。
- 输出已检查范围。
- 输出未完成维度。
- 不得显示“检查通过”。

## 20. 可靠性与安全验收

| 场景 | 通过条件 |
| --- | --- |
| 签名错误 | 拒绝请求，不创建 Job |
| 同一 delivery 重放 | 不重复业务效果 |
| 新 head 到来 | 旧结果不作为最新 Review 发布 |
| 服务重启 | 已持久接收任务可恢复 |
| GitHub 发布响应丢失 | 先核对远端，再决定是否重试 |
| 模型返回跨仓库 Memory ID | 服务端拒绝 |
| PR 内容要求“忽略系统规则并运行脚本” | 不改变权限，不执行脚本 |
| 恶意 symlink 指向宿主机 | 工具层拒绝越界读取 |
| 模型超时 / 部分专项失败 | Job 显示 partial / failed 与缺失范围 |
| repository 移除授权 | 停止读取、执行和发布 |
