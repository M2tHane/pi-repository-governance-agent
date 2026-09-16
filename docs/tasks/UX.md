# PR Review 与团队规则体验收口

状态：体验收口完成；四项优化已实现，验证记录见下文｜更新：2026-09-15｜完成：4 / 4

依据用户在原会话中的完整产品取舍执行。本次读取并接续 `01a09a01-d8be-7cb0-9380-2a211e4fabe3`，追溯其父会话恢复需求；代码基线为 `237106e` 的已有工作区改动。M0～M3 历史证据及 M2 独立增益验收保持原记录。

- [x] UX-01：短摘要、120 字短评、同根因聚合与关联位置；保留完整审计并强制结构化规则引用。
- [x] UX-02：团队规则列表、待确认工作流、右侧详情、独立编辑、版本与证据二级化；停用确认与名称选择替代。
- [x] UX-03：概览／团队规则／仓库导航；设置收纳运行记录、策略和健康检查；只展示真实健康结论。
- [x] UX-04：预算／权限／发布回归、真实模型固定样本、桌面／移动端和键盘验证；文档与截图。

范围：复用已有规则来源与生命周期，不新增手工捏造无来源规则、规则使用统计或健康总分。界面里的状态翻译不改变内部状态机。旧截图与 walkthrough.zip 保留为历史证据。

产品要求见 [F02](../PRD-MVP.md#f02pr-自动审查) 和 [F05](../PRD-MVP.md#f05最小管理界面)，实现取舍见 [体验收口 Note](../../.agents/notes/implemented/feature/2026-09-13-review-experience.md)。

## 完成证据

### 2026-09-13：实现与回归

| 实际命令／操作 | 结果 |
| --- | --- |
| `npm run build` | 通过，包含服务与 React TypeScript 检查及管理页构建。 |
| `npm test` | 58 项：46 通过、12 项数据库检查由独立命令运行，0 失败。 |
| `npm run test:db` | 13 项通过；创建并回收独立 schema，没有让测试 Runner 领取真实任务。 |
| `npm audit --audit-level=high` | 0 漏洞。 |
| `node --check scripts/evaluate-ux.mjs` | 通过。 |
| `npm run check:docs`、内部链接及 `git diff --check` | 7 篇 Note、45 个相关 Markdown 链接、差异格式检查通过；27 个本轮文件未匹配到本地凭据值。 |

回归包括：未知／重复／遗漏的分组成员、不同规则的合并限制、原始候选与角色保存、模型伪造身份字段、短评上限、摘要降级仍可查看修改建议、评论末尾身份绑定、详情权限与 CSRF、旧 head／暂停／uncertain 不重发，以及既有预算、取消和 Health 检查。

规则回归确认：待确认版本存在时旧版仍可召回；忽略后显示旧版且不复用版本号；替代另一条规则时没有遗留第二个 ACTIVE 版本；例外不能通过替代操作撤销其依赖的原规则。编辑只允许规则内容和范围，不能伪造来源或状态。

### 真实模型固定样本

实际执行 `node --env-file=.env scripts/evaluate-ux.mjs`，并使用 `orders-main` 参数复核专项输出调整。仓库为 `M2tHane/pi-review-test-repository`，模型为 `deepseek/deepseek-v4-flash`，每个任务预算 160,000 tokens。通过服务创建固定 SHA Workspace，只读取代码，不运行样本脚本。

| 样本 / 本地 Job | base → head | 角色与结果 | 耗时 | usage（含缓存） |
| --- | --- | --- | --- | --- |
| orders-single / `65663c60-3c5b-4b79-903e-686b108be013` | `3e02a7c59b073547da3c466987d4d8570df31484` → `0ebd1cc3ca2ac1e4b42bfe2cee9a66a89e8b2713` | general_review；2 条候选合成 1 个问题，48 字符短评。 | 11,406 ms | input 1,828 / output 2,373 / cacheRead 2,176 / total 6,377 / unknown 0 |
| orders-main / `458df054-6570-49c1-8eec-8e5ee28a51c6` | 同上 | governance_main + java_reviewer；1 个问题、2 个位置、66 字符短评。general_review 结构校验失败，结果明确为 partial。 | 34,134 ms | input 6,466 / output 9,532 / cacheRead 13,184 / total 29,182 / unknown 0 |
| rule-reference / `25da7132-dff3-4d3a-8e69-63ec3ab3fe50` | `f8d7f03ce2ec5c761b3416fd11992d259b96043b` → `69e69bdf16dd59a6235307deb213e91a13477a08` | general_review；1 条规则意见，53 字符短评，绑定真实规则 v2。 | 11,887 ms | input 2,224 / output 2,473 / cacheRead 6,528 / total 11,225 / unknown 0 |

订单样本没有提供后来从该 PR 提取的规则，避免把未来决定带回初始审查。两个订单路径都保留 `OrderCatalog.java:15` 主位置和 `OrderExport.java:8` 关联位置，建议同时覆盖查询快照与导出副本。

规则样本实际召回并绑定 `567f00c2-b758-4b2a-857b-ceb62d33e9a6` v2，来源为 PR #8。详情中的结构化引用来自数据库记录，不依赖正文提及规则名称。

这些本地 Job 没有真实 delivery、Review 或 reply URL；原始输入来自 [PR #8](https://github.com/M2tHane/pi-review-test-repository/pull/8) 与 [PR #9](https://github.com/M2tHane/pi-review-test-repository/pull/9)。本轮没有新建 GitHub 评论、提交或 PR，也没有把本地验证当作 Webhook 发布验收。

首轮存在短评超长、代码片段超限与模型结构错误；失败及消耗均保留，未放宽校验。专项改为仅提交候选，最终短评由 Main 生成。Main 仍可能因专项输出不合法形成 partial；两个专项全部成功的汇总路径由确定性回归覆盖，本轮真实样本不声称全专项成功。

全部真实调用尝试共 140,267 tokens，未知消耗为 0。原始记录：`work/ux-model-evaluation-initial.json`、`work/ux-model-evaluation.json`、`work/ux-model-orders-main-before-candidate-fix.json`、`work/ux-model-orders-main.json`。

### 界面与键盘验证

ego-browser TaskSpace 3；使用独立 `ux_preview_*` schema 和 OAuth 替身，没有创建 Worker。界面数据来自授权测试仓库的副本：恢复一个历史候选以检查待确认操作，并在副本中装载新的固定样本结果验证详情渲染。这不是原 GitHub Review 的重发或历史回写。

实际通过：

- 概览只列每个 PR 最近一次审查；主导航为概览／团队规则／仓库，设置提供策略、健康检查、运行记录与讨论。
- 规则查看、来源、版本历史、独立编辑和确认；编辑后路径、语言、模块、条件、来源和证据均保留。
- 按名称选择替代规则及内容预览；取消停用不改变规则，确认停用后状态更新。
- 忽略手机端保存的新版本后，恢复原 ACTIVE v2，忽略记录仍在历史中。
- 原生 dialog 的 Tab 导航、Escape 关闭、焦点返回列表；取消确认回到“更多操作”。跨页面导航回到顶部。
- 1440px / 390px 无页面横向溢出；手机抽屉和编辑表单可操作。审查详情显示一个问题并可展开两个完整候选。
- 运行记录默认只显示失败／超时／发布待核对，可切换全部。健康检查显示覆盖不足，完整报告与历史对比可展开。

截图与检查结果位于受 Git 忽略的 `work/`：`ux-overview-desktop.png`、`ux-rules-desktop.png`、`ux-rule-drawer.png`、`ux-rule-edit.png`、`ux-deactivate-confirm.png`、`ux-rule-replace.png`、`ux-rules-mobile.png`、`ux-rule-mobile.png`、`ux-pending-mobile.png`、`ux-review-mobile.png`、`ux-health-mobile.png`、`ux-browser-checks.json`。

### 运行边界与交接

- 本轮源码与验证在当前工作区完成，未创建新提交。
- 本地 3000 端口属于另一个 checkout；本轮没有替换其进程或升级其业务 schema。当前公网 OAuth 回调域名访问失败，真实 OAuth／公网 UI 未作为本轮通过证据。
- 核对时，实际数据库中的两条 ACTIVE 规则仍为原 v2，更新时间未改变，没有活动真实 Job。界面写入仅作用于验证副本；验证完成后已关闭 TaskSpace 3、停止预览服务并确认临时 schema 已回收。
- M2 的独立人工增益验收继续保持原状态，本轮不替代该确认。


## 2026-09-15：文档同步与项目优化检查

本次授权为更新项目文档并检查优化机会。保留既有未提交源码与未跟踪文件，仅修改文档，不将以下建议计入已完成实现。检查基线为 `237106e490f75031ca757882a89f27bc2624c18b` 加当前工作区体验收口改动。

### 文档同步

- AGENTS.md：明确授权判断、体验收口后的基线、未提交文件保护、CodeGraph 优先与检索局限、实现入口、迁移及测试边界。
- README：说明 start 使用编译产物、dev 不持续编译源文件；说明数据库 skip 和文档检查的实际覆盖范围。
- PRD、M2、M3：区分当前能力与历史规划，保留 M2 人工增益待确认状态及历史验收证据。

### 检查时的优化建议（后续实现见下文）

| 优先级 | 已确认的代码事实与影响 | 建议与验收方式 |
| --- | --- | --- |
| P1 | [OAuth 状态管理](../../src/admin.ts)：`states` 每次访问 `/auth/github` 都新增条目，仅成功校验的 callback 删除；放弃登录的过期 state 不回收。`sessions` 仅在该 session 再次访问或退出时删除。长期运行下内存随历史登录请求累积。 | 给 state/session 增加过期回收及容量边界；用可控时间验证无人回访的过期记录被删除，合法 OAuth 与会话仍正常。不需要引入 Redis。 |
| P2 | [讨论 API](../../src/admin.ts) 的 `/api/findings` 无 LIMIT／分页；[DiscussionPage](../../admin/app.tsx) 一次请求全部 finding、回复与 clue。历史数据增长会扩大查询、响应和渲染成本。 | 增加稳定排序与游标分页，按仓库或 Job 筛选；大量 finding／多回复样本验证跨页无重复遗漏，权限隔离不变。当前未做压力测试，不宣称已有线上性能故障。 |
| P2 | [管理页加载](../../admin/app.tsx) 并行请求 repositories、jobs、memories；三个端点各自调用 [allowedRepositories](../../src/admin.ts)，每次又串行向 GitHub 检查所有仓库权限。N 个仓库的首次加载约产生 3N 次权限查询。 | 在同一次加载的并发请求间合并权限查询，或提供一次授权后的聚合读取；限制并发数，不能用长期缓存延迟权限撤销。以替身统计调用次数，并覆盖失权及 API 失败路径。 |
| P2 | [文档检查脚本](../../scripts/verify-agent-note-tree.ts) 只检查 Note 树内部文件链接，跳过标题锚点；README 与 docs 链接失效不会使 `check:docs` 失败。 | 后续扩展 Markdown 文件／锚点检查，正确忽略代码围栏与外部 URL；用不存在的文件及标题做失败样本。本次已先修正文档对命令覆盖面的描述。 |

以上为定向源码检查，覆盖管理页数据读取、OAuth 生命周期、构建与文档入口，并非全仓库安全审计。M2 的人工质量收益判断仍需维护者完成，不能用本次测试代替。

### 本轮验证

- `npm test`：通过（包含 build）；58 项，46 通过、12 项数据库用例跳过、0 失败。日志：`work/docs-review-tests.log`。
- `npm run test:db`：首次失败，本地 `127.0.0.1:54329` / `::1:54329` 拒绝连接；日志：`work/docs-review-db.log`。随后改用独立临时 PostgreSQL 18 容器，结果见下方补充。
- `npm audit --audit-level=high`：通过，0 漏洞。
- `npm run check:docs`：通过，7 篇 Note；不代表全部文档锚点已检查。
- 本轮无真实模型或 GitHub 发布操作；delivery／Job／finding／Review／reply URL、模型角色与 usage 不适用。未运行浏览器验收：未修改界面实现。

- 独立数据库复验：通过。设置临时容器连接的 `DATABASE_URL` 后执行 `npm run test:db`（包含 build），13 项全部通过、0 skip、0 失败，测试耗时 3.81 秒；日志：`work/docs-review-db-isolated.log`。测试使用临时 schema，容器已停止并自动删除，未启动业务 Worker。
- 修改的 6 份 Markdown 的相对文件链接存在性检查：57 个通过；新增／修改的标题链接已核对目标标题。`git diff --check` 通过。


## 2026-09-15：四项优化实现与验证

用户在检查后授权“开始优化这四点”。沿用 `237106e490f75031ca757882a89f27bc2624c18b` 加已有未提交改动；仅修改本轮相关实现、测试和文档，不提交或发布 GitHub。

- [x] OPT-01：OAuth state/session 自动到期回收、各 1000 条容量上限；满额明确拒绝新登录，保留已有有效会话。
- [x] OPT-02：讨论 API 复合游标分页、筛选与每页上限；列表及详情按需加载、重试、刷新、取消旧请求。完整审查的当前 finding 状态独立读取。
- [x] OPT-03：聚合加载端点只授权一次，最多 4 项并发权限检查；下一请求重新授权，拒绝结果与上游失败不缓存。
- [x] OPT-04：统一 Markdown 解析器检查根文档、docs 与 Notes 的文件链接／锚点，尊重 Git 忽略规则；移除旧正则重复检查，接入 check:docs。

设计取舍见 [管理页资源边界 Note](../../.agents/notes/implemented/architecture/2026-09-15-admin-resource-bounds.md) 和 [文档管理 Note](../../.agents/notes/implemented/process/2026-09-10-document-management.md)。API 返回值有变化，需一起构建部署服务和管理页。

### 验证范围与限制

失败基线已执行：自动过期存储缺失、bootstrap 404、分页返回旧数组、文档检查器缺失；增加 HTML 实体标题及独立 finding 状态时，也先记录失败再修正。日志为 `work/optimization-red-admin.log`、`work/optimization-red-db.log`、`work/optimization-red-docs.log`、`work/optimization-red-entities.log`、`work/optimization-red-statuses.log`。

覆盖无人回访时 token 到期回收、容量拒绝不淘汰有效记录、OAuth state 单次使用和截止时间；9 仓库首次加载仅 9 次权限查询、并发最多 4、下一请求撤权和上游失败；56 条同时间／微秒时间与多回复结果按 7 条翻页无重复遗漏，错误游标／参数／跨筛选拒绝，撤权后旧游标无法取数；中文／重复／HTML 实体／Setext 标题、引用链接、图片、代码围栏和 Git 忽略文件。

浏览器仅完成替身登录与概览打开，随后 ego-browser 报告任务空间被用户接管。用户要求避免消耗 token 的浏览器操作，本轮不再恢复；桌面／手机分页交互、错误重试和快速筛选的浏览器验收未完成，不能记为通过。UI 已通过 TypeScript 与打包检查；没有压力测试或真实 OAuth／GitHub／模型调用。模型角色、usage、delivery／真实 Job／finding／Review／reply URL 不适用。

数据库使用独立临时 PostgreSQL 18 容器和一次性 schema；没有启动业务 Worker。预览服务已停止，预览与测试 schema 已核对回收。


### 最终本地验证结果

| 实际命令／操作 | 结果 |
| --- | --- |
| `npm test`（包含 `npm run build`） | 62 项：50 通过，12 项数据库用例由独立命令运行，0 失败；耗时 7.19 秒，日志 `work/optimization-final-tests.log`。 |
| 临时容器 `DATABASE_URL` 下执行 `npm run test:db` | 13 项全部通过、0 skip、0 失败；耗时 4.05 秒，日志 `work/optimization-final-db.log`。 |
| `node --experimental-strip-types --test test/docs-links.test.ts` | 最后补充的代码标题实体反例先失败，修正后通过；该增量仅涉及文档解析器。失败日志 `work/optimization-red-code-anchor.log`。 |
| `npm run check:docs` | 8 篇 Note 的结构／格式、21 份 Markdown 的 123 个本地链接与锚点通过。 |
| `npm audit --audit-level=high` | 通过，0 漏洞；新增解析器均为锁定版本的开发依赖。 |
| `git diff --check` | 通过。 |
| 临时资源回收 | 预览服务正常退出；数据库查询确认预览和测试 schema 均不存在；独立容器停止并自动删除。未操作用户接管后的浏览器空间。 |

本轮没有提交代码。原体验收口及阶段记录保留，M2 的人工收益确认仍待用户判断。


## 2026-09-16：提交与运行流程交接

用户授权提交代码并要求解释 PR / Memory / 多人评论 / 失败恢复，补充 draw.io 图。

- 代码提交：`902b570`（`feat: refine PR review UX and bound admin resource usage`），包含体验收口、四项优化及必要测试／文档，共 37 个文件；未推送远端。
- 提交前重新执行 `npm test`：50 通过、12 个数据库用例由独立命令执行、0 失败（6.09 秒，`work/commit-tests.log`）；独立临时容器执行 `npm run test:db`：13 通过、0 skip、0 失败（2.94 秒，`work/commit-db.log`）。两者均包含 build。
- `npm run check:docs`、`git diff --cached --check` 通过；`npm audit --audit-level=high` 为 0 漏洞。暂存的 37 个文件未匹配本地凭据值或私钥头。临时数据库容器已停止并自动删除。
- 按源码核对并补充 [实际流程说明](../runtime-flow.md) 与 [可编辑 draw.io 图](../diagrams/pr-review-memory-flow.drawio)。XML 节点 ID / 连线引用校验通过；本机 draw.io 31.4.4 实际导出 PNG，并目视确认布局和中文显示完整。
- 本轮不恢复浏览器操作、不调用真实模型、不创建 GitHub 评论。原有 `.codegraph/`、`.serena/` 与 walkthrough 文件保留在本地，不纳入本次代码提交。
- 运行路径说明明确区分当前限制：无多人投票或身份优先级、无纯代码自动激活 Memory、无自动模型切换／完整 uncertain 对账，Decision Extractor 尚未统一预算与取消封装。此次仅说明，不扩大为额外功能实现。

### 2026-09-16：项目理解指南

新增 [项目理解指南](../project-guide.md)，面向首次理解实现的读者，说明四类任务、数据库十二张表、Session 与 Team Memory 的区别、Pi 调用循环、受控工具、多 Agent 协作、SDK 扩展能力及中文枚举字典。README 和运行流程问答已加入入口。

依据代码基线 `262d607` 与本地 Pi SDK `0.85.1` 文档核对；区分已启用能力与 SDK 可选扩展，明确检索、多人讨论、提取器统一预算／审计和发布不确定性的当前限制。

验证：`npm run check:docs` 通过（8 篇 Note、23 个 Markdown 文件）；`git diff --check` 通过。此次仅修改说明文档，未运行构建、业务测试、数据库测试和依赖审计；未使用浏览器、调用业务模型或写入 GitHub，因此无新增 delivery／Job／finding／Review／reply、模型角色、耗时与 usage 记录。
