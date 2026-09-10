# Agent Note: 按需求、任务和决定分工管理项目文档

Status: implemented

## Problem

项目的产品目标、架构理由和下一阶段任务原先分散在讨论与一份 PRD 中。接手者需要区分已落地能力、待实现方案和执行进度，也需要在修改时找到决定的原因，避免反复重建规划或把建议当成事实。

## Decision

项目以 [AGENTS.md](../../../../AGENTS.md) 约束协作，以 [PRD-MVP](../../../../docs/PRD-MVP.md) 保存需求，以 [M0 清单](../../../../docs/tasks/M0.md) 保存任务状态和证据，以 .agents/notes 保存重要决定及真实备选。

Notes 使用 lifecycle/class/date-topic 路径。当前只创建有实际内容的目录；状态变化通过移动文件与同步正文表达。已验证的 [M0 架构](../architecture/2026-09-10-m0-pi-github-review.md) 位于 implemented。

项目内 docs/PRD-MVP.md 是后续维护的需求文件；已废弃的单体 docs/PRD.md 不再作为同步维护目标。

同一决定的事实变化原地更新，不增加流水账或 INDEX.md。变更带来的原因、实际行为、验证与代码保持在同一批可审阅改动中。

## Verification tooling

scripts/agent-note-tree.ts、verify-agent-note-tree.ts、verify-agent-note-format.ts 复用 write-notes-like-deepseek 技能提供的脚本。仅将运行示例改为 node，并在共享入口加上本 Note 的反向注释。

package.json 使用 Node.js >=24 和 ESM，直接运行带可擦除类型的脚本；目前没有第三方依赖。npm run check:docs 执行两个校验。该工具选择已在本机 Node v24.18.0 环境核对运行条件。

现有校验覆盖 Notes 结构、头块、章节和活动 Notes 内部相对文件链接；不覆盖全部 Markdown 链接、归档冻结或语义判断，这些仍通过改动复核完成。

## Alternatives considered

### 单一长文档或统一 TODO

优点是入口少，初次记录方便。但需求、执行状态和架构理由的更新频率不同；本项目已有多阶段规划，将三者混写会使 M0 接手者难以确认真正的当前范围。因此保留各自唯一的文档归属，并通过相对链接连接。

### 独立 ADR 目录与完整文档站点

ADR 适合稳定追踪架构决定，站点适合多人浏览大量资料。当前决定数量很少；再维护 ADR、Notes 两套目录或构建站点会增加同步负担。因此使用技能规定的 Notes 树和根 README 入口，等浏览需求实际出现再添加展示工具。

### 全部生命周期和类别目录、模板与看板一起生成

完整结构有利于成熟团队统一使用。但本项目尚无 rejected/archived 记录，空目录和模板不能帮助完成当前任务。因此目录按需创建，复用现成校验工具；无需先引入看板或模板管理。

## Consequences

收益：接手者有明确阅读顺序，需求与任务进度分开，决定能追踪备选和代价。项目移动后，文档和校验脚本不依赖用户的技能安装路径。

代价：改动可能需要同步任务、Note 与代码反向链接；检查脚本是从技能复制的版本，需要在格式规则变化时主动同步。Node.js 24 是文档工具的当前最低运行要求。

已知上限：校验不判断理由是否真实，也不强制归档不可变。只有在实际出现归档、多人审阅或 CI 需求时，才加入对应检查或展示功能。

## Verification

验证命令为根目录的 npm run check:docs。2026-09-10 初始化验证通过：2 篇 Note 的结构与格式检查通过，18 个项目内 Markdown 文件链接有效；临时反例确认校验器会拒绝状态与路径不一致、Notes 相对死链。

AGENTS.md 与共享校验入口均指向本记录；M0 任务全部保留未完成，架构 Note 保持 proposed。此记录只说明已建立的文档流程，不声称业务服务已实现。
