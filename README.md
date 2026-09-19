# GitHub PR Review Agent

基于 **Pi + GitHub App** 的团队级 PR Review 与工程治理 Agent。

它不只是在 PR 中生成一次性的 AI Review，而是把 **PR 审查、讨论复核、团队规则沉淀、后续规则复用** 串成一个持续闭环：

```text
Pull Request
    ↓
AI Review
    ├─ Single Agent
    └─ Main Agent + Specialist
    ↓
Inline Findings / Summary
    ↓
Developer Reply
    ↓
Reply Re-evaluation
    ↓
PR Merged
    ↓
Decision Extraction
    ↓
CANDIDATE Team Memory
    ↓
Maintainer Confirm
    ↓
ACTIVE Team Memory
    ↓
Future PR Review
```

项目同时提供仓库级 **Health Audit**，用于在不修改源码、不执行仓库脚本的前提下，对代码库进行只读健康检查。

## 核心能力

### 1. Multi-Agent PR Review

根据 PR 复杂度选择不同审查路径：

- 简单 PR：Single Agent 直接完成 Review。
- 复杂 PR：Main Agent 按需委派 Specialist，并聚合结果。
- 支持专项审查角色，例如 General、Java、Security、Architecture、Memory Conflict。
- 固定 PR Head SHA 创建只读 Workspace，避免分析过程中代码漂移。
- Structured Output 约束模型结果，并在发布前进行结构、路径和状态校验。
- 使用共享 Token Budget 控制 Main 与 Specialist 的总消耗。
- 支持并发委派、Partial Fallback、Finding 去重与同根因聚合。
- 可定位问题发布为 GitHub Inline Review；无法可靠定位的问题降级到 Summary。

### 2. Team Memory

将 PR 中明确确认的工程决策沉淀为后续 Review 可复用的团队规则：

```text
PR Merge
  → Decision Extraction
  → CANDIDATE
  → Maintainer Confirm
  → ACTIVE
  → Future Review Recall
```

Memory 具备以下约束：

- Repository Isolation：规则只在所属仓库内生效。
- Scope Filter：根据路径、语言、模块和适用条件过滤规则。
- Version / Source Validation：校验规则版本及来源。
- Human-in-the-loop：AI 只能提出候选规则，ACTIVE 规则必须由维护者确认。
- 支持 supersede / deprecate 等规则生命周期管理。

### 3. Reply Handler

开发者回复 Agent 的 Inline Finding 后，系统会重新读取当前 PR Head 与讨论上下文，对原问题进行二次判断。

当前状态包括：

- `FIXED`：问题已经修复。
- `MISJUDGMENT`：原 Review 判断错误。
- `VALID_EXCEPTION`：存在合理例外。
- `STILL_VALID`：问题仍然成立。
- `NEEDS_CLARIFICATION`：需要进一步说明。

### 4. 可靠性与安全治理

系统使用 PostgreSQL 持久化任务、幂等状态和 Review 结果，并对 GitHub 与模型调用做显式失败处理：

- Webhook Delivery 幂等。
- PostgreSQL 持久化 Job。
- 异常重启后恢复未完成任务。
- 指数退避与有限次数重试。
- Publication Fingerprint 防止重复发布。
- GitHub 发布结果不确定时进入 `uncertain`，先核对远端状态，而不是直接重发。
- 新 Head、Draft、关闭 PR、仓库暂停等情况会取消过期 Review。
- Main、Specialist 和 Reply Agent 均不获得 shell、写文件、GitHub 写操作或 Memory Mutation 权限。

### 5. Repository Health Audit

Health Agent 对仓库进行独立的只读检查：

- 固定默认分支 SHA 与检查窗口。
- 不运行仓库脚本。
- 不修改源码。
- 不发布 GitHub Review。
- 不修改 Team Memory。
- 支持手动执行以及每日 / 每周定时执行。
- 历史报告保存在管理界面中。

## 系统架构

```text
GitHub
  │
  │ Webhook / Pull Request / Review Comment
  ▼
GitHub App
  │
  ▼
HTTP API
  │
  ├───────────────┐
  ▼               ▼
PostgreSQL     Admin UI
  │
  ▼
Persistent Worker
  │
  ├─ PR_REVIEW
  ├─ REPLY_HANDLE
  ├─ DECISION_EXTRACT
  └─ HEALTH_AUDIT
  │
  ▼
Pi Agent Runtime
  │
  ├─ Main Agent
  ├─ Specialist
  ├─ Reply Agent
  ├─ Decision Extractor
  └─ Health Agent
  │
  ▼
GitHub Review / Team Memory / Health Report
```

主要技术栈：

- TypeScript / Node.js 24+
- Pi Coding Agent
- GitHub App / Webhook / OAuth
- PostgreSQL
- React
- Docker Compose

## Quick Start

### 1. 安装依赖

```bash
npm ci
```

### 2. 启动 PostgreSQL

```bash
npm run db:up
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

至少需要配置：

```text
GITHUB_APP_ID
GITHUB_PRIVATE_KEY_PATH
GITHUB_WEBHOOK_SECRET
GITHUB_ALLOWED_REPOSITORIES
DATABASE_URL
MODEL_PROVIDER
MODEL_NAME
MODEL_API_KEY
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_OAUTH_CALLBACK_URL
SESSION_SECRET
```

完整配置说明见 [.env.example](.env.example)。

### 4. 初始化数据库

首次运行：

```bash
npm run migrate
```

`migrations/001_baseline.sql` 用于全新数据库初始化。已有旧版迁移记录的数据库不要直接套用 baseline，需要单独制定迁移转换方案。

### 5. 启动服务

生产式启动：

```bash
npm run build
npm start
```

开发模式：

```bash
npm run dev
```

> `npm start` 不会自动执行数据库迁移。数据库结构发生变化时，应先显式运行 `npm run migrate`。

## GitHub App 配置

建议权限：

- Metadata: Read
- Contents: Read
- Pull requests: Read & Write

订阅事件：

- Pull requests
- Pull request review comments

Webhook：

```text
https://<your-domain>/github/webhook
```

GitHub App 安装范围应与 `GITHUB_ALLOWED_REPOSITORIES` 保持一致。

管理界面使用 GitHub OAuth，并通过 OAuth 权限与 CSRF 校验保护维护者操作。

## Review 工作流

触发 PR Review 的事件：

```text
opened
reopened
synchronize
ready_for_review
```

不会进入正常新 Review 的情况包括：

- Draft PR
- Closed PR
- 暂停仓库
- 不受支持的 Fork
- 未授权仓库

完整流程：

```text
Webhook
  ↓
Signature / Repository / Delivery Validation
  ↓
Persistent Job
  ↓
Pin Base SHA + Head SHA
  ↓
Load Diff / Workspace / Team Memory
  ↓
Complexity Routing
  ├─ Single Agent
  └─ Main + Specialist
  ↓
Validate Structured Output
  ↓
Deduplicate Findings
  ↓
Re-check PR State + Head SHA
  ↓
Publish GitHub Review
```

## Team Memory 工作流

只有合并后的 PR 才会进入 Decision Extraction：

```text
Merged PR
  ↓
Read Diff + Review + Human Discussion
  ↓
Extract Reusable Engineering Decision
  ↓
Validate Repository / SHA / Source / Code Evidence
  ↓
CANDIDATE
  ↓
Maintainer Review
  ├─ Confirm → ACTIVE
  ├─ Edit → New Candidate Version
  ├─ Supersede
  └─ Deprecate
```

系统不会把“代码碰巧这样写”直接提升为团队规则，也不会自动把 AI 自己的意见写入 ACTIVE Memory。

## 测试与验证

运行基础测试：

```bash
npm test
```

数据库测试：

```bash
npm run test:db
```

文档链接检查：

```bash
npm run check:docs
```

依赖审计：

```bash
npm audit --audit-level=high
```

### 固定 Review Evaluation

固定样本使用测试仓库指定 SHA：

```text
ad75aa1e1f1a3604682af068c2c048da23bbbe7a
```

运行：

```bash
npm run build
node --env-file=.env eval/evaluate-m2.mjs /absolute/path/to/fixed-checkout
```

结果写入：

```text
work/m2-evaluation.json
```

UX / Root Cause / Rule Reference Evaluation：

```bash
node --env-file=.env eval/evaluate-ux.mjs
```

## 项目结构

```text
.
├── frontend/          # 管理界面
├── src/               # 后端与 Agent Runtime
├── migrations/        # PostgreSQL Migration
├── eval/              # Agent Evaluation
├── test/              # 自动化测试
├── scripts/           # 构建与辅助脚本
├── docs/              # 产品、架构与设计文档
├── .agents/           # Agent 决策与工程上下文
├── compose.yaml
├── package.json
└── README.md
```

## 文档

如果第一次阅读项目，建议按以下顺序：

1. [项目理解指南](docs/project-guide.md) — 从实际 PR 出发理解完整运行流程、数据库、Pi Agent 与核心状态。
2. [PRD](docs/PRD-MVP.md) — 产品目标与范围。
3. [Architecture](docs/architecture.md) — 系统模块与实现分层。
4. [Reliability & Security](docs/reliability-security.md) — 可靠性、安全边界和失败恢复。
5. [PR Review / Team Memory 流程图](docs/diagrams/pr-review-memory-flow.png) — 图形化查看主要闭环。

可编辑流程图：[`docs/diagrams/pr-review-memory-flow.drawio`](docs/diagrams/pr-review-memory-flow.drawio)

## 当前边界

当前实现刻意保持以下约束：

- 单 PostgreSQL Worker，不提供多 Worker 调度保证。
- 不承诺 exactly-once；通过幂等、状态机和远端核对降低重复副作用。
- Team Memory 不是全仓库自动学习系统，ACTIVE 规则必须经过人工确认。
- Health Audit 是有限范围的只读检查，不代表完整代码安全证明。
- Review 质量受模型、Token Budget、Workspace 覆盖范围和规则召回结果影响。

## 项目目标

这个项目关注的不是“让 LLM 多写几条 Review 评论”，而是构建一个可持续运行的团队级代码治理闭环：

```text
Review → Discussion → Decision → Memory → Future Review
```

让一次 PR 中已经确认的工程经验，不再随着 PR 合并而消失。