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

scripts/agent-note-tree.ts、verify-agent-note-tree.ts、verify-agent-note-format.ts 的目录与格式规则沿用 write-notes-like-deepseek 技能提供的脚本，运行示例使用 node，共享入口保留本 Note 的反向注释；链接检查统一交给 Markdown 解析器。

package.json 使用 Node.js >=24 和 ESM。npm run check:docs 顺序执行 Notes 目录、Notes 格式和项目 Markdown 链接检查。链接检查使用开发依赖 marked、github-slugger、entities，分别负责解析 Markdown、生成重复标题锚点和解码标题中的 HTML 实体，不进入业务构建。

[链接检查器](../../../../scripts/check-markdown-links.mjs) 覆盖根目录 Markdown、docs/ 与 .agents/notes/；在 Git 仓库中从 tracked 与 untracked 且未忽略文件建立清单，避免读取本地会话导出。检查行内／引用式链接、图片路径、本地 Markdown 锚点、中文与重复标题、Setext 标题及显式 HTML id/name。代码围栏和行内代码不产生链接。外部 URL 不请求；非 Markdown 文件只检查存在性。无 Git 的文档副本按相同目录范围检查。归档冻结和语义仍需复核。

## Alternatives considered

### 单一长文档或统一 TODO

优点是入口少，初次记录方便。但需求、执行状态和架构理由的更新频率不同；本项目已有多阶段规划，将三者混写会使 M0 接手者难以确认真正的当前范围。因此保留各自唯一的文档归属，并通过相对链接连接。

### 独立 ADR 目录与完整文档站点

ADR 适合稳定追踪架构决定，站点适合多人浏览大量资料。当前决定数量很少；再维护 ADR、Notes 两套目录或构建站点会增加同步负担。因此使用技能规定的 Notes 树和根 README 入口，等浏览需求实际出现再添加展示工具。

### 全部生命周期和类别目录、模板与看板一起生成

完整结构有利于成熟团队统一使用。但本项目尚无 rejected/archived 记录，空目录和模板不能帮助完成当前任务。因此目录按需创建，复用现成校验工具；无需先引入看板或模板管理。

### 正则检查链接与自行实现 Markdown 标题规则

正则容易把代码示例视为链接，也难以正确处理引用链接、嵌套格式、重复标题与 HTML 实体。使用明确锁定的开发依赖解析这些语法，并移除旧 Note 检查器中的重复链接正则；代价是需要随工具维护依赖锁文件。

## Consequences

收益：接手者有明确阅读顺序，需求与任务进度分开，决定能追踪备选和代价。项目移动后，文档和校验脚本不依赖用户的技能安装路径。

代价：改动可能需要同步任务、Note 与代码反向链接；检查脚本是从技能复制的版本，需要在格式规则变化时主动同步。Node.js 24 是文档工具的当前最低运行要求。

已知上限：校验不判断理由是否真实，也不强制归档不可变。只有在实际出现归档、多人审阅或 CI 需求时，才加入对应检查或展示功能。

## Verification

验证入口为 npm run check:docs 与 test/docs-links.test.ts 的成功／失败样本。当前命令结果见 [UX 清单](../../../../docs/tasks/UX.md#2026-09-15四项优化实现与验证)，历史阶段证据保留在各阶段任务清单。
