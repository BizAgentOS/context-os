# DataEngine Feature List

Last Updated: 2026-10-19

**2026-10-19 v0.3.0 规划登记：**用户确认 Fabric IQ 对照与产品全面体检后的方向，将全部改进定义为开发版本 v0.3.0，登记 FEATURE_036—068（33 项，分 M0 清理与对齐、M1 核心闭环、M2 问答、M3 数据接入、M4 试点准入五个里程碑）。目标设计见 [v0.3.0 目标产品蓝图](features/v0.3.0-blueprint.md)，Feature、票与依赖见 [v0.3.0 设计与任务](features/v0.3.0.md)。本次只登记范围与拆票，全部为 Planned，未开工、未改代码、未改变既有 Feature 状态或版本号。

**2026-10-17 修复补记（未发布）：**在 v0.2.3 基线上处理 [ISSUE-001—012](ISSUES.md)：运行结束交付、同一运行候选版本、场景/弹窗反馈与引用、旧解读结构迁移、发现/命名待核对，以及行业包仅作名称说明参考；恢复 14 项程序结构后的资料修订测试。验证范围与未完成的浏览器/全量结果见[本轮验收](experiment/ISSUES_2026_10_17.md)。没有新建 Feature、调整既有完成/首次发布状态、更新版本号或发布 Tag；ISSUE-013 仍需用户处理凭据与额度。

**2026-10-16 v0.2.3 本地发布：**基础本体改由规则（Helix 数据程序）构建，内部 Agent 只修正；本体页按程序发现结果展示；修复替换 CSV 后重建失败。按用户确认作为 0.2.x 发布，不新增或改变 Feature 状态；已知问题与 14 项暂跳过测试见[待修问题](ISSUES.md)。

**2026-10-15 v0.2.2 修复发布：**在本地 Git 发布 v0.2.1 复核的 7 项修复，覆盖快照保留、来源覆盖、旧发布接入、同名字段、日期保真及候选能力提示；231 项测试与快照整链通过，见[修复验收](experiment/ENGINE_WORKBENCH.md#021-复核修复2026-10-15未发布)。本次没有新增 Feature，031—035 的首次 Released 保持 v0.2.1。

**2026-10-15 增补：**用户确认数据持续更新、本体持续修订、按版本发布数据底座，v0.2.0 增补 FEATURE_031—035：移植 Helix 快照与执行服务、完整本体发现、执行验证与 Agent 工具、发布锁定数据，以及三页界面与整链验收。决定见 [ADR-004](ADR/ADR-004-managed-snapshots-and-pinned-releases.md)；025—030 的完成记录不变。

**2026-10-14 开发交付：**v0.2.0 的 FEATURE_025—030 已完成整体前后端、199 项测试和浏览器验收。吸收 Helix 程序构建方法，统一数据、本体、发布与接入；未连接用户业务数据、未正式发布，真实场景验证另行进行。证据见[工作台验收](experiment/ENGINE_WORKBENCH.md)。

**2026-09-10 文档整理：**新增[产品与架构](DATA_ENGINE_DESIGN.md)、[语义契约](SEMANTIC_CONTRACTS.md)、[Agent 与前端协作](AGENT_UI_DESIGN.md)，并更新 `AGENTS.md` 阅读入口。只沉淀设计与纠正历史描述，未新增实现票、改变功能状态或运行产品验收。

**2026-09-15 当前计划：**产品核心明确为本体驱动多源数据融合，目标调整为企业与数据、本体工作区、消费与治理三页。FEATURE_012—016 的十八张任务已完成；计划见[三页设计](THREE_PAGE_PLAN.md)，实际证据见[整链验收](experiment/FUSION_CHAIN.md)。保持本地实验，尚未发布。

**2026-09-11 Agent 产品文档整理：**参考 KodaX-Space 的职责分层，建立[文档中心](README.md)、当前 Agent 契约、KodaX 接入记录、内置 Skill 和 ADR；旧 Agent 设计归档。三页需求和十八张票、依赖与状态不变。

**2026-10-19 开工：**根据用户本轮开发授权开始 M0（036—039）；其余按依赖推进，未发布。

**2026-10-19 M0 验收：**036—039 完成并分别本地提交；完整 277 项测试、快照整链、真实 KodaX 修订 / 查询、桌面与窄屏验证通过。版本保持 v0.2.3，未发布；M1—M4 的其余 29 项仍 Planned。证据及模型读取限制见[M0 验收](experiment/V030_M0_2026_10_19.md)。

**2026-10-19 M1 首批验收：**040 分层语义模型、047 会话 / 执行池和 049 事件推送完成隔离迁移、公共边界、真实模型及浏览器验收，完成证据见[基础批次记录](experiment/V030_M1_FOUNDATIONS_2026_10_19.md)。当前版本仍为 v0.2.3，未发布；后续从 041 统一变更继续。

**2026-10-19 041 开工：**用户确认实施方案：首次构建后新增来源带来的新实体按 R2 进入待处理；有待采用变更时不阻塞发布，只提示不包含在本次发布中。041 改为 InProgress，未发布。

**2026-10-20 041 T041-02 完成：**工作版组合与版本递增、发布固定工作版、已采用局部纠正进入发布与差异；有待采用变更只提示不阻塞。全量 325 项测试与类型检查通过；041 仍 InProgress（T041-03、04 未开始），版本 v0.2.3 未发布。证据见[设计块](features/v0.3.0.md#feature-041)。

**2026-10-20 041 T041-03a 完成：**自动采用按 R2 分流：首次构建仍自动采用，之后的程序构建出现新对象 / 新关系 / 新合并 / 退役结构时不再自动采用，候选留作待处理并在任务里标明原因；同结构重绑、快照与依据刷新、名称说明变化仍自动采用。全量 329 项测试与类型检查通过；T041-04 未开始，版本 v0.2.3 未发布。

**2026-10-20 041 T041-03b 完成：**`ProgramBuilds.adopt` 支持按选择采用：只保留所选的新增对象 / 关系 / 合并，重新走定义与来源校验后采用；未选中的结构不进工作版，并在下次构建重新提出；非法选择或含退役结构的候选明确拒绝。041 的 T041-01—03 全部完成，T041-04 部分完成（04a 已完成，04b/04c 未开始）；全量 331 项测试与类型检查通过，版本 v0.2.3 未发布。

**2026-10-20 041 T041-04a 完成：**关系纠正的采用在同一事务内登记为 `local_correction` 类型的 adopted 变更（subject 指向纠正版本，effect 带目标、目标集与原因），幂等且不登记未采用的候选；旧接口地址与响应保持不变。全量 333 项测试与类型检查通过；04b（映射修订与旧候选投影）与 04c（界面版本号收敛）未开始，版本 v0.2.3 未发布。

## Version Info

- **Current Release:** v0.2.3（2026-10-16，本地 Tag `v0.2.3`）。v0.2.2 于 2026-10-15 发布（本地 Tag `v0.2.2`）。v0.2.0 于 2026-10-14 发布（提交 `930b10e`，Tag `v0.2.0`）。
- **Planned Version:** v0.3.0（2026-10-19 登记，FEATURE_036—068；M0 与 M1 首批已验收，其余 26 项 Planned）。v0.1.0 保留历史功能与验收记录。
- **版本状态:** 计划于 v0.2.0 的 11 项全部完成：025—030 随 v0.2.0 发布，031—035 随 v0.2.1 发布；v0.2.2 为这些能力的修复发布。v0.1.0 未单独发布，002、004、005、006、019 仍未完成，继续保留。
- **状态规则:** `Planned → InProgress → Completed`；`Released` 仅填写实际发布版本。
- **设计:** [v0.3.0 设计与任务](features/v0.3.0.md)及[目标产品蓝图](features/v0.3.0-blueprint.md)；[v0.2.0 设计与开发步骤](features/v0.2.0.md)；[v0.1.0 历史](features/v0.1.0.md)。
- **范围:** [产品目标](PRODUCT.md)与 [MVP 目标](MVP.md)。

## Version Summary

| Version | Status | Planned | InProgress | Completed | Progress |
|---|---|---:|---:|---:|---:|
| v0.1.0 | InProgress | 2 | 3 | 19 | 19/24 |
| v0.2.0 | Released | 0 | 0 | 11 | 11/11 |
| v0.3.0 | InProgress | 25 | 1 | 7 | 7/33 |

本表按计划批次统计。v0.2.2 为已发布能力的 PATCH 修复版本，不新增或重复计算 Feature。

## Feature Index

| ID | Title | Category | Priority | Status | Planned | Blocked by | Design |
|---|---|---|---|---|---|---|---|
| 001 | 虚构企业、原始数据与基线 | New | High | Completed | v0.1.0 | 无 | [设计](features/v0.1.0.md#feature-001) |
| 002 | 初始本体与只读数据服务 | New | High | InProgress | v0.1.0 | 001 | [设计](features/v0.1.0.md#feature-002) |
| 003 | KodaX 与 NOOA 式企业主 Agent | New | High | Completed | v0.1.0 | 首段无；对象能力与 002 对接 | [设计](features/v0.1.0.md#feature-003) |
| 004 | 本体演变与结果恢复 | New | High | Planned | v0.1.0 | 003 | [设计](features/v0.1.0.md#feature-004) |
| 005 | 简单本地工作台 | New | High | InProgress | v0.1.0 | 001；维护页依赖 004 | [设计](features/v0.1.0.md#feature-005) |
| 006 | 对照实验与规模验证 | Internal | High | Planned | v0.1.0 | 001、002、004 | [设计](features/v0.1.0.md#feature-006) |
| 007 | 数据消费与访问治理 | New | High | Completed | v0.1.0 | 复用已实现的 003/005 | [设计](features/v0.1.0.md#feature-007) |
| 008 | 四页企业记忆的持续维护 | Enhancement | High | Completed | v0.1.0 | 复用 003/005/007 | [设计](features/v0.1.0.md#feature-008) |
| 009 | 第三方 Agent 接入与数据发布 | Enhancement | High | Completed | v0.1.0 | 007、008 | [设计](features/v0.1.0.md#feature-009) |
| 010 | 源系统连接与按需企业记忆 | New | High | Completed | v0.1.0 | 复用 003/009 | [设计](features/v0.1.0.md#feature-010) |
| 011 | 通用 Agent 搜索、Skill、MCP 与业务 SDK | Enhancement | High | Completed | v0.1.0 | 003、010 | [设计](features/v0.1.0.md#feature-011) |
| 012 | 三页结构、存量迁移与统一工作上下文 | Refactor | High | Completed | v0.1.0 | 复用 003/005/010/011 | [设计](features/v0.1.0.md#feature-012) |
| 013 | 企业基础本体 Skill 与三条起步路径 | New | High | Completed | v0.1.0 | 012（按票） | [设计](features/v0.1.0.md#feature-013) |
| 014 | 分类来源接入与多源语义融合 | Enhancement | High | Completed | v0.1.0 | 012/013（按票） | [设计](features/v0.1.0.md#feature-014) |
| 015 | 本体可视化、证据与内容治理 | Enhancement | High | Completed | v0.1.0 | 012/013/014（按票） | [设计](features/v0.1.0.md#feature-015) |
| 016 | 消费接口、契约生成与治理闭环 | Enhancement | High | Completed | v0.1.0 | 012/014/015（按票） | [设计](features/v0.1.0.md#feature-016) |
| 017 | 自定义模型 API 配置 | Enhancement | High | Completed | v0.1.0 | 016 | [设计](features/v0.1.0.md#feature-017) |

| 018 | 企业档案内容区重排 | Enhancement | High | Completed | v0.1.0 | 012、013、014 | [设计](features/v0.1.0.md#feature-018) |

| 019 | 服务连接向导与飞书只读接入 | Enhancement | High | InProgress | v0.1.0 | 010 | [设计](features/v0.1.0.md#feature-019) |
| 020 | Swagger/OpenAPI 来源导入 | Enhancement | High | Completed | v0.1.0 | 010、018 | [设计](features/v0.1.0.md#feature-020) |
| 021 | MCP 便捷接入与统一连接入口 | Enhancement | High | Completed | v0.1.0 | 复用已实现的 011/019 | [设计](features/v0.1.0.md#feature-021) |
| 022 | 动态三维本体空间与连续聚焦 | Enhancement | High | Completed | v0.1.0 | 012、015 | [设计](features/v0.1.0.md#feature-022) |
| 023 | 本体数据集与 MCP 消费工作台 | Enhancement | High | Completed | v0.1.0 | 013、016 | [设计](features/v0.1.0.md#feature-023) |

| 024 | 企业冷启动向导与金融行业本体包 | Enhancement | High | Completed | v0.1.0 | 013、017、020、021 | [设计](features/v0.1.0.md#feature-024) |

| 025 | 模型优先初始化与数据工作台 | Enhancement | High | Completed | v0.2.0 | 复用 017、020、021、024 | [设计](features/v0.2.0.md#feature-025) |
| 026 | Helix 程序化本体构建与数据运行 | Enhancement | High | Completed | v0.2.0 | 复用 010、013、014 | [设计](features/v0.2.0.md#feature-026) |
| 027 | 本体工作区与跨页 Agent 任务 | Enhancement | High | Completed | v0.2.0 | 复用 015、022；联调依赖 026 | [设计](features/v0.2.0.md#feature-027) |
| 028 | 数据底座版本发布与接入管理 | Enhancement | High | Completed | v0.2.0 | 复用 016、023；整链依赖 026、027 | [设计](features/v0.2.0.md#feature-028) |
| 029 | 外部 Agent 受限委托与插件能力 | Enhancement | High | Completed | v0.2.0 | 028 | [设计](features/v0.2.0.md#feature-029) |
| 030 | 0.2.0 整链验收与开发交付 | Enhancement | High | Completed | v0.2.0 | 025—029 | [设计](features/v0.2.0.md#feature-030) |
| 031 | 数据快照与执行服务 | Enhancement | High | Completed | v0.2.0 | 复用 010、026 | [设计](features/v0.2.0.md#feature-031) |
| 032 | 完整本体发现与映射编译 | Enhancement | High | Completed | v0.2.0 | 031 | [设计](features/v0.2.0.md#feature-032) |
| 033 | 执行验证与 Agent 辅助构建 | Enhancement | High | Completed | v0.2.0 | 032 | [设计](features/v0.2.0.md#feature-033) |
| 034 | 发布锁定数据与快照消费 | Enhancement | High | Completed | v0.2.0 | 031、033 | [设计](features/v0.2.0.md#feature-034) |
| 035 | 快照三页界面与整链验收 | Enhancement | High | Completed | v0.2.0 | 031—034 | [设计](features/v0.2.0.md#feature-035) |
| 036 | 主文档、ADR 与提示词对齐 | Internal | High | Completed | v0.3.0 | 无 | [设计](features/v0.3.0.md#feature-036) |
| 037 | 界面去内部化与交互止血 | Enhancement | High | Completed | v0.3.0 | 无 | [设计](features/v0.3.0.md#feature-037) |
| 038 | 读取合同对齐 | Enhancement | High | Completed | v0.3.0 | 无 | [设计](features/v0.3.0.md#feature-038) |
| 039 | 冻结旧消费接口 | Refactor | High | Completed | v0.3.0 | 无 | [设计](features/v0.3.0.md#feature-039) |
| 040 | 分层语义模型 | Refactor | High | Completed | v0.3.0 | 036 | [设计](features/v0.3.0.md#feature-040) |
| 041 | 统一变更流程与自动采用规则 | Enhancement | High | InProgress | v0.3.0 | 040 | [设计](features/v0.3.0.md#feature-041) |
| 042 | 关系发现修复与身份对应 | Enhancement | High | Planned | v0.3.0 | 040、041 | [设计](features/v0.3.0.md#feature-042) |
| 043 | 文档补充、证据库与待裁决 | Enhancement | High | Planned | v0.3.0 | 041、044 | [设计](features/v0.3.0.md#feature-043) |
| 044 | 待处理中心 | New | High | Planned | v0.3.0 | 041；界面依赖 048 | [设计](features/v0.3.0.md#feature-044) |
| 045 | 首次构建批量业务命名 | New | High | Planned | v0.3.0 | 041、044、047 | [设计](features/v0.3.0.md#feature-045) |
| 046 | Agent 面板与结构化消息 | Enhancement | High | Planned | v0.3.0 | 036、041、049 | [设计](features/v0.3.0.md#feature-046) |
| 047 | 会话、上下文与执行分池 | Enhancement | High | Completed | v0.3.0 | 036、037 | [设计](features/v0.3.0.md#feature-047) |
| 048 | 构建模式与工具收敛 | Refactor | High | Planned | v0.3.0 | 041、046 | [设计](features/v0.3.0.md#feature-048) |
| 049 | 事件推送与前端模块化 | Refactor | High | Completed | v0.3.0 | 无 | [设计](features/v0.3.0.md#feature-049) |
| 050 | 本体页重构 | Enhancement | High | Planned | v0.3.0 | 040、044、046 | [设计](features/v0.3.0.md#feature-050) |
| 051 | 查询层扩展与执行资源 | Enhancement | High | Planned | v0.3.0 | 038、040 | [设计](features/v0.3.0.md#feature-051) |
| 052 | 问答模式与回答卡 | New | High | Planned | v0.3.0 | 046、047、051 | [设计](features/v0.3.0.md#feature-052) |
| 053 | 答案联动可视化 | New | High | Planned | v0.3.0 | 050、052 | [设计](features/v0.3.0.md#feature-053) |
| 054 | 缺口单与问答到修复交接 | New | High | Planned | v0.3.0 | 044、048、052 | [设计](features/v0.3.0.md#feature-054) |
| 055 | 发布与接入页重构与对外接口扩展 | Enhancement | High | Planned | v0.3.0 | 039、041、051、052 | [设计](features/v0.3.0.md#feature-055) |
| 056 | 首次使用流程 | Enhancement | High | Planned | v0.3.0 | 045、052 | [设计](features/v0.3.0.md#feature-056) |
| 057 | 表格文件接入 | Enhancement | High | Planned | v0.3.0 | 037 | [设计](features/v0.3.0.md#feature-057) |
| 058 | 只读数据库连接器 | New | High | Planned | v0.3.0 | 037 | [设计](features/v0.3.0.md#feature-058) |
| 059 | API 连接器增强 | Enhancement | High | Planned | v0.3.0 | 037 | [设计](features/v0.3.0.md#feature-059) |
| 060 | 定时与增量同步、质量熔断 | New | High | Planned | v0.3.0 | 041、044 | [设计](features/v0.3.0.md#feature-060) |
| 061 | 数据页重构 | Enhancement | High | Planned | v0.3.0 | 037、060 | [设计](features/v0.3.0.md#feature-061) |
| 062 | 飞书多维表格与 PDF/DOCX | Enhancement | High | Planned | v0.3.0 | 043、060 | [设计](features/v0.3.0.md#feature-062) |
| 063 | 凭据加密、数据保留与备份恢复 | Enhancement | High | Planned | v0.3.0 | 无 | [设计](features/v0.3.0.md#feature-063) |
| 064 | 成本上限与角色权限 | New | High | Planned | v0.3.0 | 041、046 | [设计](features/v0.3.0.md#feature-064) |
| 065 | 指标引用 | New | High | Planned | v0.3.0 | 040、041、052 | [设计](features/v0.3.0.md#feature-065) |
| 066 | 持久层优化与规模验收集 | Internal | High | Planned | v0.3.0 | 040、057—060 | [设计](features/v0.3.0.md#feature-066) |
| 067 | 演示与分享走正式路径、旧接口下线 | Refactor | High | Planned | v0.3.0 | 039、049、050 | [设计](features/v0.3.0.md#feature-067) |
| 068 | v0.3.0 整链验收 | Internal | High | Planned | v0.3.0 | 036—067 | [设计](features/v0.3.0.md#feature-068) |

此表保留已有能力与票的实际完成记录，计数不代表新 MVP 体验的完成比例。本轮按 [MVP 完成条件](MVP.md)及 FEATURE_012—016 的任务依赖验收。006、远程 MCP 服务和旧票中尚未覆盖的完整回归/恢复保留为后续工作，不因范围调整标为完成。

**2026-09-08 历史接入定义纠正：**第二页的产品方向是连接企业数据源的 API/MCP，按需读取保留在原系统的数据，不以本地复制为主路径。彼时来源端连接器待开发，FEATURE_009 的 Completed 仅指第四页对外 MCP/HTTP 读取与既有记录发布。后续 FEATURE_010 已实现声明式来源连接，当前范围见其条目与[在线运行说明](experiment/LIVE_MEMORY.md)。


## Feature Details

### 001: 虚构企业、原始数据与基线

- **Status:** Completed
- **Category / Priority:** New / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-07 / 2026-09-07 / 2026-09-07
- **Description:** 构建澄川热力的经营设定、设施台账、监测、客服与维修记录及业务文档，再实现变化回放、隔离评测和原始资料基线。
- **Blocked by:** 无。
- **Design:** [FEATURE_001](features/v0.1.0.md#feature-001)。

### 002: 初始本体与只读数据服务

- **Status:** InProgress
- **Category / Priority:** New / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-07 / 2026-09-07 / —
- **Description:** 从可见来源提出本体与 Mapping 候选，经确认形成企业对象、证据、函数与只读 MCP，跑通外部消费。
- **Blocked by:** 001。
- **Design:** [FEATURE_002](features/v0.1.0.md#feature-002)。

### 003: KodaX 与 NOOA 式企业主 Agent

- **Status:** Completed
- **Category / Priority:** New / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-07 / 2026-09-07 / 2026-09-08
- **Description:** 已完成 T003-01/02/03/04：真实 KodaX 与对象工作区复用；新增每页单一有界上下文、实际完成后推进、聊天裁剪不删企业记忆。24 项 Agent 测试与真实画布链路见[运行记录](experiment/CANVAS.md)。
- **Blocked by:** 企业理解/来源首段无；后续对象与建模能力依赖 002，不等待完整 MCP。
- **Design:** [FEATURE_003](features/v0.1.0.md#feature-003)。

### 004: 本体演变与结果恢复

- **Status:** Planned
- **Category / Priority:** New / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-07 / — / —
- **Description:** 将候选建议接入基础检查、人工确认、新版本保存与重算，演示真实本体变化并恢复旧结果。
- **Blocked by:** 003。
- **Design:** [FEATURE_004](features/v0.1.0.md#feature-004)。

### 005: 简单本地工作台

- **Status:** InProgress
- **Category / Priority:** New / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-07 / 2026-09-07 / —
- **Description:** T005-04 将主界面改为记忆画布，007 扩展第四页；保持全高背景与前景对话/输入浮层。T005-05 新增澄川热力独立演示：8 份资料、35 个对象、3 份初始验证、3 个调用方，无需模型密钥即可查看四页并运行固定模拟问答。T005-06 将本体页改为定义关系图、实际对象局部探索与来源侧栏，保持候选采用和业务验证。T005-01/03 作为历史交付；T005-02 完整演变与对照视图暂缓。见[演示说明](experiment/HEATING_DEMO.md)。
- **Blocked by:** 基础查看依赖 001 和已有技术试样，不等待正式本体；维护页依赖 004。
- **Design:** [FEATURE_005](features/v0.1.0.md#feature-005)。
- **T005-07 已完成：**单文件 HTML 导出保留四页、关系图、对象与来源、验证和连接范围；隔离样本、无凭据、无网络请求。类型检查、67 项 Agent 测试和桌面/390px 离线浏览通过，见[分享说明](experiment/SHARE_HTML.md)。

### 006: 对照实验与规模验证

- **Status:** Planned
- **Category / Priority:** Internal / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-07 / — / —
- **Description:** 汇总原始、专用表、静态本体、动态本体的质量和成本，用同一案例扩展到超过 1M Token，记录有效、无效及不确定结论。
- **Blocked by:** 001、002、004；结果文件可独立运行，与 005 按契约对接。
- **Design:** [FEATURE_006](features/v0.1.0.md#feature-006)。

### 007: 数据消费与访问治理

- **Status:** Completed
- **Category / Priority:** New / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-08 / 2026-09-08 / 2026-09-08
- **Description:** T007-01/02 实现完成：采用本体后解锁第四页，对话提出调用方及字段/关系范围，用户确认后使用独立凭据访问只读 API；可查看真实记录并停用。类型检查与 35 项 Agent、22 项 Python 测试通过；真实模型、浏览器及两个独立客户端已验证不同范围、允许/拒绝、停用与重启，结果见[运行记录](experiment/CONSUMPTION.md)。
- **Blocked by:** 复用 T003-02/04 与 T005-04（已实现）；不等待远程 MCP 服务或企业 IAM。
- **Design:** [FEATURE_007](features/v0.1.0.md#feature-007)；[消费设计（已更新为三页目标）](DATA_CONSUMPTION_DESIGN.md)。

### 008: 四页企业记忆的持续维护

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-08 / 2026-09-08 / 2026-09-08
- **Description:** 自由往返四页；文档概念草稿、定义/对象/业务验证；跨页待确认与资料变化；来源用途和敏感列贯穿消费。
- **Validation:** 类型检查、51 项 Agent 和 22 项 Python 测试通过；真实 KodaX/DeepSeek、桌面/窄屏及补资料后重验完成，详见[维护验收](experiment/MAINTENANCE.md)。
- **Design:** [FEATURE_008](features/v0.1.0.md#feature-008)。

### 009: 第三方 Agent 接入与数据发布

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-08 / 2026-09-08 / 2026-09-08
- **Description:** 第四页展示第三方 Agent 的 MCP / HTTP 接入、独立密钥与明确权限；事实数据在检查后发布给指定调用方，保持本体、权限与接入凭据，支持版本冲突检查。本体语义变更仍单独确认。
- **Validation:** 类型检查与 66 项 Agent 测试通过；真实 MCP/HTTP 同密钥发布前后读取、版本冲突和停用，浏览器草稿/启用/检查/发布及窄屏均通过，见[接入验收](experiment/AGENT_CONNECTION.md)。
- **Design:** [FEATURE_009](features/v0.1.0.md#feature-009)。
- **页面名称（2026-09-08）：**第四页统一使用“连接”，同步导航、页面标题、返回入口与操作说明；浏览器验证入口和标题，JS 语法检查通过，功能状态不变。

### 010: 源系统连接与按需企业记忆

- **Status:** Completed
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-09 / 2026-09-09 / 2026-09-09
- **Description:** 将 API/MCP 来源连接、按需对象执行、KodaX 领域工具和四页维护接为实际链路；保留文件实验。
- **Design:** [FEATURE_010](features/v0.1.0.md#feature-010)。

- **Validation:** 类型检查、75 项测试、真实 KodaX/DeepSeek、本机第三方 MCP 与浏览器验收通过；范围和限制见[连接验收](experiment/LIVE_MEMORY.md)。

### 011: 通用 Agent 搜索、Skill、MCP 与业务 SDK

- **Status:** Completed
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-09 / 2026-09-09 / 2026-09-09
- **Description:** 用户明确同时需要 KodaX 原生通用能力及第三方 SDK 调用；开放搜索、渐进 Skill 加载、MCP 发现和授权调用、SDK 适配器注册，保留企业记忆对象工具。
- **Design:** [FEATURE_011](features/v0.1.0.md#feature-011)。

### 012: 三页结构、存量迁移与统一工作上下文

- **Status:** Completed
- **Category / Priority:** Refactor / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-11 / 2026-09-11 / 2026-09-11
- **Description:** 合并企业与来源页，迁移页面状态、历史引用与草稿，统一人和 Agent 的对象上下文。
- **Blocked by:** 复用 003/005/010/011；具体任务依赖见设计块。
- **Design:** [FEATURE_012](features/v0.1.0.md#feature-012)。

- **T012-01 已完成：**三页合并、版本化元数据迁移、旧历史按需读取、浏览器草稿恢复及旧 HTML 快照兼容。见[迁移验收](experiment/THREE_PAGE_MIGRATION.md)。

- **T012-02 已完成：**在线关系、属性与实例经服务解析同一引用，固定到消息并保留原范围/版本/草稿；真实源读取、响应丢失重试、停止迟到写入、重启和浏览器恢复通过。见[工作上下文验收](experiment/WORK_CONTEXT.md)。

### 013: 企业基础本体 Skill 与三条起步路径

- **Status:** Completed
- **Category / Priority:** New / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-11 / 2026-09-11 / 2026-09-11
- **Description:** 以运行 Skill 从对话、资料、确认企业后的公开研究建立有依据的基础本体；基础采用与来源映射分开。
- **Blocked by:** 012（按票）；具体任务依赖见设计块。
- **Design:** [FEATURE_013](features/v0.1.0.md#feature-013)。

- **T013-01 已完成：**真实 Skill 加载、对话基础候选、逐项原话、未知与冲突、同主体名称纠正、查看和采用。见[验收](experiment/COMPANY_FOUNDATION.md)。
- **T013-02 已完成：**Markdown/TXT 实际分段读取与引用、同一基础本体增量补充、冲突保留、坏文件失败、原版本定位及采用版本检查，见[资料验收](experiment/FOUNDATION_DOCUMENTS.md)。

- **T013-03 已完成：**确认企业后搜索并实际读取公开网页，保存 URL/时间/覆盖及精确片段，支持既有身份跨页复用、同名消歧、网页冲突与历史定位，见[验收](experiment/FOUNDATION_WEB.md)。三条起步路径均已验证。

### 014: 分类来源接入与多源语义融合

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-11 / 2026-09-11 / 2026-09-14
- **Description:** 接入文档、BI 与业务记录；基础概念绑定来源，以明确业务键实现同实体融合、逐字段取证和冲突处理。
- **Blocked by:** 012/013（按票）；具体任务依赖见设计块。
- **Design:** [FEATURE_014](features/v0.1.0.md#feature-014)。

- **T014-01 已完成：**统一目录保留文件与记录来源，支持获准 HTTP/MCP 知识查询、分段取证、候选引用、历史原文及撤销检查，见[知识来源验收](experiment/KNOWLEDGE_SOURCES.md)。

- **T014-02 已完成：**获准 HTTP/MCP 指标定义与观测、页面日期/维度预览、口径/单位/粒度校验、缺失与覆盖、停止和撤销检查，见[指标验收](experiment/METRICS.md)。

- **T014-03 已完成：**基础概念/关系绑定现有业务记录源，版本化检查与采用执行子集、同概念引用预览、当前与历史绑定区分及未映射内容保留，见[绑定验收](experiment/FOUNDATION_BINDINGS.md)。
- **T014-04 已完成：**主来源枚举、附来源按明确业务键补属性，保留冲突、缺失、未知与逐属性出处；页面/Agent/外部消费复用受限查询，见[融合验收](experiment/FUSION.md)。

- **T014-05 已完成：**文档、指标与业务对象共同取证，保留来源、范围、冲突、局部失败和历史记录；页面与 Agent 共用服务，见[验收](experiment/EVIDENCE.md)。

### 015: 本体可视化、证据与内容治理

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-11 / 2026-09-14 / 2026-09-14
- **Description:** 定义与对象双视角，映射/证据/差异逐层查看；直接编辑和 Agent 经共同服务完成局部纠正与全局修订。
- **Blocked by:** 012/013/014（按票）；具体任务依赖见设计块。
- **Design:** [FEATURE_015](features/v0.1.0.md#feature-015)。

- **T015-01 已完成：**基础定义图/等价列表、版本与搜索、共同细粒度引用、映射和冲突说明，见[验收](experiment/FOUNDATION_VISUALIZATION.md)。

- **T015-02 已完成：**页内在线对象图/表/详情、实际关系展开、属性证据与共同引用、短页分页和失败重试，见[验收](experiment/LIVE_OBJECTS.md)。

- **T015-03 已完成：**表单与 Agent 共用局部关系候选、版本检查与人工采用；保留源基线、责任主体和操作回执，见[验收](experiment/RELATION_CORRECTIONS.md)。

- **T015-04 已完成：**全局单规则修订、真实样本差异、共同变更与治理影响、检查及管理员采用，见[验收](experiment/MAPPING_CHANGES.md)。

### 016: 消费接口、契约生成与治理闭环

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-11 / 2026-09-14 / 2026-09-15
- **Description:** 生成许可消费契约与实际 API/MCP 接入说明，开放受控证据，处理变更影响与消费者迁移并验收三页整链。
- **Blocked by:** 012/014/015（按票）；具体任务依赖见设计块。
- **Design:** [FEATURE_016](features/v0.1.0.md#feature-016)。

### 017: 自定义模型 API 配置

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-15 / 2026-09-15 / 2026-09-15
- **Description:** 自定义 OpenAI/Anthropic 兼容 Base URL、模型与密钥，复用 KodaX 及连接测试，按地址隔离凭据。
- **Design:** [FEATURE_017](features/v0.1.0.md#feature-017)。

## Summary

- Total: 21
- Planned: 2
- InProgress: 3
- Completed: 16
- New: 8；Internal: 1；Enhancement: 11；Refactor: 1；High: 21。
- **已实现基础：FEATURE_011 已完成搜索、Skill、MCP 和业务 SDK 入口（[验收](experiment/AGENT_CAPABILITIES.md)）；FEATURE_010 已完成本地来源连接链路。HTTP/MCP 按需读取、Agent 本体候选、人工采用、第三方授权与源变化重读已验收；正式发布、多租户、专用 OAuth 连接器与自动演变仍未完成。**

**本轮 FEATURE_012—016 已完成。** T016-04 通过真实模型、独立 HTTP/MCP、浏览器治理和离线兼容验收，见[记录](experiment/FUSION_CHAIN.md)。旧 FEATURE_002/004/005 的未完验收保持原状态，不提前勾选；后续范围需另行明确。

项目初始化和开发文档已完成，记录在 [CHANGELOG](CHANGELOG.md)；它们不计入产品功能完成数。功能状态在本文维护，具体票的完成状态在对应设计块维护。

### 018: 企业档案内容区重排

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-15 / 2026-09-15 / 2026-09-15
- **Description:** 按确认的宽屏网页方案组织企业概览、业务全景、发展与组织、资料与数据；限定中间内容区，保留公共导航、Logo 和助手。
- **Blocked by:** 012、013、014。
- **Design:** [FEATURE_018](features/v0.1.0.md#feature-018)。

### 019: 服务连接向导与飞书只读接入

- **Status:** InProgress
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-15 / 2026-09-15 / —
- **Description:** 借鉴 Space 的官方网页授权流程，首个服务为飞书；实现向导、受控 CLI、只读 docx 与 wiki 文本附件。已有账号的真实 wiki Markdown 读取已验收；在线 docx 真实读取仍待验收。
- **验证补充:** [知识库附件读取修复](experiment/FEISHU_WIKI_FILES.md)，154 项 Node 与真实用户指定文件的网页读取通过。
- **Design:** [FEATURE_019](features/v0.1.0.md#feature-019)。

### 020: Swagger/OpenAPI 来源导入

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-16 / 2026-09-16 / 2026-09-16
- **Description:** 文档URL、JSON/YAML和文件导入，接口选择、认证、真实样本测试及保存HTTP来源。
- **Design:** [FEATURE_020](features/v0.1.0.md#feature-020)。
- **验证:** 137 项 Node 测试、类型检查与离线构建通过；独立工作区浏览器验证 URL/粘贴/上传、真实样本、保存刷新、关闭与窄屏；[使用与验收](experiment/OPENAPI_IMPORT.md)。

### 021: MCP 便捷接入与统一连接入口

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-16 / 2026-09-16 / 2026-09-17
- **Description:** API 保持 Swagger 导入；MCP 从企业页直达服务登录、已有连接或地址发现，取消常规路径的手写 JSON，统一能力选择与连接状态。
- **Design:** [FEATURE_021](features/v0.1.0.md#feature-021)。
- **验证:** 142 项 Node 测试、类型检查、离线构建及浏览器连接/权限/关闭/窄屏验收通过；[使用与验收](experiment/MCP_ONBOARDING.md)。真实飞书文档读取和通用 OAuth 不作为本轮完成项。

### 022: 动态三维本体空间与连续聚焦

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-17 / 2026-09-17 / 2026-09-17
- **Description:** 依据用户三张参考图，将本体页改为深色动态分子空间；点击自动进入全局、局部与具体内容，输入框随状态移动和变形，无三态切换按钮。
- **Design:** [FEATURE_022](features/v0.1.0.md#feature-022)。
- **验证:** 147 项 Node、类型检查、离线导出、桌面/窄屏交互及双轴复核通过；见[三维本体验收](experiment/ONTOLOGY_SPACE.md)及根目录视觉核对。

### 023: 本体数据集与 MCP 消费工作台

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-17 / 2026-09-17 / 2026-09-17
- **Description:** 将已采用本体的选定概念与关系及显式许可业务字段组织成可供其他 Agent 读取的数据集，重构第三页为 MCP 开放与管理工作台。
- **Design:** [FEATURE_023](features/v0.1.0.md#feature-023)。
- **验证:** 150 项 Node 测试、类型检查、离线构建通过；真实 MCP 客户端、页面创建/测试/停用、390px 窄屏及双轴评审见[数据集验收](experiment/ONTOLOGY_DATASETS.md)。

### 024: 企业冷启动向导与金融行业本体包

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-22 / 2026-09-22 / 2026-09-22
- **Description:** 居中五步冷启动：模型密钥持久保存、企业及行业研究、金融优先的行业定义模板、来源连接、结果与缺口；可恢复，完成进入原企业页。
- **Design:** [FEATURE_024](features/v0.1.0.md#feature-024)。
- **验证:** 类型检查、176 项 Node 测试、离线导出及 390px/1280px 浏览器验收通过；[冷启动验收](experiment/ENTERPRISE_ONBOARDING.md)记录真实范围与双轴复核。

### 025: 模型优先初始化与数据工作台

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.2.0 / v0.2.0
- **Created / Started / Completed:** 2026-10-14 / 2026-10-14 / 2026-10-14
- **Description:** 先配置模型，再选择 MCP/API/文件并进入数据页。无需企业问卷或预置数据；现有来源、样本、更新与错误成为第一页主体。
- **Blocked by:** 复用 017、020、021、024
- **Design:** [FEATURE_025](features/v0.2.0.md#feature-025)。

### 026: Helix 程序化本体构建与数据运行

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.2.0 / v0.2.0
- **Created / Started / Completed:** 2026-10-14 / 2026-10-14 / 2026-10-14
- **Description:** 移植 Helix 确定性发现与构建，将授权结构化来源形成可维护本体候选；程序处理确定部分，AI 辅助未决语义。
- **Blocked by:** 复用 010、013、014
- **Design:** [FEATURE_026](features/v0.2.0.md#feature-026)。

### 027: 本体工作区与跨页 Agent 任务

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.2.0 / v0.2.0
- **Created / Started / Completed:** 2026-10-14 / 2026-10-14 / 2026-10-14
- **Description:** 保留现有三维本体与共享助手，明确本体定义/实际对象入口、问题定位、差异和任务状态。
- **Blocked by:** 复用 015、022；联调依赖 026
- **Design:** [FEATURE_027](features/v0.2.0.md#feature-027)。

### 028: 数据底座版本发布与接入管理

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.2.0 / v0.2.0
- **Created / Started / Completed:** 2026-10-14 / 2026-10-14 / 2026-10-14
- **Description:** 第三页管理工作版差异、检查、发布版本与接入方；工作修改不影响既有外部消费者。
- **Blocked by:** 复用 016、023；整链依赖 026、027
- **Design:** [FEATURE_028](features/v0.2.0.md#feature-028)。

### 029: 外部 Agent 受限委托与插件能力

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.2.0 / v0.2.0
- **Created / Started / Completed:** 2026-10-14 / 2026-10-14 / 2026-10-14
- **Description:** 第三方除了直接查询，还能委托 ADE Agent 调查、解释获准数据，获取进度、结果与依据。
- **Blocked by:** 028
- **Design:** [FEATURE_029](features/v0.2.0.md#feature-029)。

### 030: 0.2.0 整链验收与开发交付

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.2.0 / v0.2.0
- **Created / Started / Completed:** 2026-10-14 / 2026-10-14 / 2026-10-14
- **Description:** 完成空状态、隔离端到端、浏览器、双轴评审和开发文档，为下一轮真实场景验证准备产品。
- **Blocked by:** 025—029
- **Design:** [FEATURE_030](features/v0.2.0.md#feature-030)。

### 031: 数据快照与执行服务

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.2.0 / v0.2.1
- **Created / Started / Completed:** 2026-10-15 / 2026-10-15 / 2026-10-15
- **Description:** 结构化来源同步为不可变 Parquet 快照，带完整画像、指纹、结构漂移待确认与质量问题；隔离子进程执行只读查询。
- **Blocked by:** 复用 010、026
- **Design:** [FEATURE_031](features/v0.2.0.md#feature-031)。

### 032: 完整本体发现与映射编译

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.2.0 / v0.2.1
- **Created / Started / Completed:** 2026-10-15 / 2026-10-15 / 2026-10-15
- **Description:** 移植 Helix 完整发现（键、关系、跨源身份、合并分组、两跳去冗余）与映射编译，在全量快照上形成可维护候选。
- **Blocked by:** 031
- **Design:** [FEATURE_032](features/v0.2.0.md#feature-032)。

### 033: 执行验证与 Agent 辅助构建

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.2.0 / v0.2.1
- **Created / Started / Completed:** 2026-10-15 / 2026-10-15 / 2026-10-15
- **Description:** 真实执行映射与检查，报告唯一性、匹配率和影响；KodaX 获得数据概览、同步、发现解释与只读快照查询工具。
- **Blocked by:** 032
- **Design:** [FEATURE_033](features/v0.2.0.md#feature-033)。

### 034: 发布锁定数据与快照消费

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.2.0 / v0.2.1
- **Created / Started / Completed:** 2026-10-15 / 2026-10-15 / 2026-10-15
- **Description:** 发布固定本体、映射与快照版本，展示数据差异；旧发布消费者持续读取锁定快照。
- **Blocked by:** 031、033
- **Design:** [FEATURE_034](features/v0.2.0.md#feature-034)。

### 035: 快照三页界面与整链验收

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.2.0 / v0.2.1
- **Created / Started / Completed:** 2026-10-15 / 2026-10-15 / 2026-10-15
- **Description:** 数据、本体、发布三页展示快照、发现依据、验证与数据差异，完成整链和浏览器验收。
- **Blocked by:** 031—034
- **Design:** [FEATURE_035](features/v0.2.0.md#feature-035)。

### 036: 主文档、ADR 与提示词对齐

- **Status:** Completed
- **Category / Priority:** Internal / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / 2026-10-19 / 2026-10-19
- **Description:** 主文档按蓝图同步，新增 ADR-005—008；提示词按身份/通用规则重写，清理冲突 Skill，增加提示词—工具—页面名称一致性检查。
- **Blocked by:** 无。
- **Design:** [FEATURE_036](features/v0.3.0.md#feature-036)。
- **Verification:** [M0 隔离验收](experiment/V030_M0_2026_10_19.md)，提示词一致性、29 项相关回归、真实模型修订与查询；当前保持单一模式。

### 037: 界面去内部化与交互止血

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / 2026-10-19 / 2026-10-19
- **Description:** 开发者视图之外不显示 JSON、UUID 与内部字段；三页共用来源投影；删除口令采用；对话历史不再物理删除；修正发布页引导。
- **Blocked by:** 无。
- **Design:** [FEATURE_037](features/v0.3.0.md#feature-037)。
- **Verification:** [M0 隔离验收](experiment/V030_M0_2026_10_19.md)，历史保留 / 分页、聊天不能采用、统一来源投影、开发者开关及 1440 / 390px 检查通过。

### 038: 读取合同对齐

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / 2026-10-19 / 2026-10-19
- **Description:** 工作区默认读已采用快照，实时为显式选择；结果附读取模式、版本、数据截至与覆盖；工具说明由执行合同生成。
- **Blocked by:** 无。
- **Design:** [FEATURE_038](features/v0.3.0.md#feature-038)。
- **Verification:** [M0 隔离验收](experiment/V030_M0_2026_10_19.md)，可变真实 HTTP 来源、工作区 / Agent / MCP / context_read、旧发布固定数据及浏览器读取模式通过。

### 039: 冻结旧消费接口

- **Status:** Completed
- **Category / Priority:** Refactor / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / 2026-10-19 / 2026-10-19
- **Description:** v1/v2/v3 与旧数据集工作台冻结为只读，对外只保留发布 + 接入方 + v4/MCP；移除 Agent 旧接入工具。
- **Blocked by:** 无。
- **Design:** [FEATURE_039](features/v0.3.0.md#feature-039)。
- **Verification:** [M0 隔离验收](experiment/V030_M0_2026_10_19.md)，旧写冻结、历史分页、来源停用 / 证据授权 / 撤销、v4 发布及浏览器检查通过。

### 040: 分层语义模型

- **Status:** Completed
- **Category / Priority:** Refactor / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / 2026-10-19 / 2026-10-19
- **Description:** 语义层（实体、属性、关系类型）与绑定层分离，稳定 ID、复合身份、中间表；存量迁移，旧发布可读。
- **Blocked by:** 036。
- **Design:** [FEATURE_040](features/v0.3.0.md#feature-040)。
- **Verification:** [分层与迁移](experiment/V030_040_MIGRATION_2026_10_19.md)，稳定身份、复合键 / 中间表、旧映射编辑、说明不重绑、固定发布与关系纠正回归；热力数据与实际历史发布的证据限制如实保留。

### 041: 统一变更流程与自动采用规则

- **Status:** InProgress
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / 2026-10-19 / —
- **Description:** 程序/人/Agent 变更统一提议、复验、采用；拒绝指纹；自动采用只限首次构建与同结构重绑；工作版组合；治理决定进入发布。
- **Blocked by:** 040。
- **Design:** [FEATURE_041](features/v0.3.0.md#feature-041)。
- **Verification:** `tests/agent/ontology-changes.test.ts`（变更状态机与复验）、`tests/agent/workspace-corrections.test.ts`（工作版、发布纠正与旧发布隔离、纠正采用的台账登记）、`tests/agent/structure-approval.test.ts`（首次构建自动采用、结构变化阻断、同结构刷新、按选择部分采用）；当前 T041-01—03 与 04a 完成，04b/04c 未开始。

### 042: 关系发现修复与身份对应

- **Status:** Planned
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 修复唯一外键、责任字段、自引用发现；身份规则 same_as/belongs_to 与记录级决定；去冗余与活动流改为提议。
- **Blocked by:** 040、041。
- **Design:** [FEATURE_042](features/v0.3.0.md#feature-042)。

### 043: 文档补充、证据库与待裁决

- **Status:** Planned
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 文档按批次产生一个工作版；依据外置证据库；冲突与未知进入待裁决；取消整体拒绝上限。
- **Blocked by:** 041、044。
- **Design:** [FEATURE_043](features/v0.3.0.md#feature-043)。

### 044: 待处理中心

- **Status:** Planned
- **Category / Priority:** New / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 结构变更、命名、待裁决、缺口、数据问题集中为一个队列，服务端统一计数，取代分散采用入口。
- **Blocked by:** 041；界面依赖 048。
- **Design:** [FEATURE_044](features/v0.3.0.md#feature-044)。

### 045: 首次构建批量业务命名

- **Status:** Planned
- **Category / Priority:** New / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 首次构建后由 Agent 提出整套中文名称、别名与说明，作为一项命名变更由用户确认。
- **Blocked by:** 041、044、047。
- **Design:** [FEATURE_045](features/v0.3.0.md#feature-045)。

### 046: Agent 面板与结构化消息

- **Status:** Planned
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 三页统一面板；执行卡、变更清单、决定卡、Markdown；停止与超时部分完成回执；成本显示。
- **Blocked by:** 036、041、049。
- **Design:** [FEATURE_046](features/v0.3.0.md#feature-046)。

### 047: 会话、上下文与执行分池

- **Status:** Completed
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / 2026-10-19 / 2026-10-19
- **Description:** 会话长期保存；模型上下文由摘要与近期窗口组成并设上限；交互与后台分池；页面状态前端化。
- **Blocked by:** 036、037。
- **Design:** [FEATURE_047](features/v0.3.0.md#feature-047)。
- **Verification:** [会话与执行池](experiment/V030_047_2026_10_19.md)，长期分页、初始上下文上限、真实模型标题与同题比较、后台并行、重启 / 多标签 / 版本冲突通过。

### 048: 构建模式与工具收敛

- **Status:** Planned
- **Category / Priority:** Refactor / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 工具按模式选择；统一提议、复验、预览、待处理、决定工具；Agent 只提议不采用结构；下线旧工具。
- **Blocked by:** 041、046。
- **Design:** [FEATURE_048](features/v0.3.0.md#feature-048)。

### 049: 事件推送与前端模块化

- **Status:** Completed
- **Category / Priority:** Refactor / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / 2026-10-19 / 2026-10-19
- **Description:** SSE 事件替代全量轮询与整页重建；前端拆分模块；删除旧四页渲染路径。
- **Blocked by:** 无。
- **Design:** [FEATURE_049](features/v0.3.0.md#feature-049)。
- **Verification:** [事件与前端](experiment/V030_049_2026_10_19.md)，事件重放 / 重启快照、桌面与窄屏、表单 / 滚动 / 草稿 / 晚回执、双标签及离线导出通过。

### 050: 本体页重构

- **Status:** Planned
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 图 + 详情侧栏 + 待处理队列；首屏待处理与下一步；删除四个弹窗入口；图状态编码与业务化详情。
- **Blocked by:** 040、044、046。
- **Design:** [FEATURE_050](features/v0.3.0.md#feature-050)。

### 051: 查询层扩展与执行资源

- **Status:** Planned
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 过滤、排序、多跳、自引用路径、聚合由语义层编译执行；快照读取接入执行器；补充来源批量匹配。
- **Blocked by:** 038、040。
- **Design:** [FEATURE_051](features/v0.3.0.md#feature-051)。

### 052: 问答模式与回答卡

- **Status:** Planned
- **Category / Priority:** New / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 只读问答工具与三种数据视图；结构化回答卡与答不出原因；本体页默认问答；建议切换卡。
- **Blocked by:** 046、047、051。
- **Design:** [FEATURE_052](features/v0.3.0.md#feature-052)。

### 053: 答案联动可视化

- **Status:** Planned
- **Category / Priority:** New / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 回答驱动本体图与详情侧栏：路径高亮、结果集、聚合分组、缺失关系标记。
- **Blocked by:** 050、052。
- **Design:** [FEATURE_053](features/v0.3.0.md#feature-053)。

### 054: 缺口单与问答到修复交接

- **Status:** Planned
- **Category / Priority:** New / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 问答答不出时创建缺口单，转构建模式修复，采用后问答复问确认。
- **Blocked by:** 044、048、052。
- **Design:** [FEATURE_054](features/v0.3.0.md#feature-054)。

### 055: 发布与接入页重构与对外接口扩展

- **Status:** Planned
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 差异按对象列出；检查规则；接入方流程与试问；对外 MCP 增加遍历、聚合、检索。
- **Blocked by:** 039、041、051、052。
- **Design:** [FEATURE_055](features/v0.3.0.md#feature-055)。

### 056: 首次使用流程

- **Status:** Planned
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 模型 → 来源 → 构建 → 命名 → 本体页 → 示例问题，10 分钟内得到第一个正确答案。
- **Blocked by:** 045、052。
- **Design:** [FEATURE_056](features/v0.3.0.md#feature-056)。

### 057: 表格文件接入

- **Status:** Planned
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** Excel 多 sheet、多编码与多分隔符 CSV，上传上限提高到 100MB。
- **Blocked by:** 037。
- **Design:** [FEATURE_057](features/v0.3.0.md#feature-057)。

### 058: 只读数据库连接器

- **Status:** Planned
- **Category / Priority:** New / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** MySQL、PostgreSQL 只读连接，选择表接入并形成快照。
- **Blocked by:** 037。
- **Design:** [FEATURE_058](features/v0.3.0.md#feature-058)。

### 059: API 连接器增强

- **Status:** Planned
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 分页策略、OAuth2 令牌刷新、嵌套展开、内网放行、有限重试、MCP 目录分页。
- **Blocked by:** 037。
- **Design:** [FEATURE_059](features/v0.3.0.md#feature-059)。

### 060: 定时与增量同步、质量熔断

- **Status:** Planned
- **Category / Priority:** New / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 按周期自动同步，增量、断点续传与重试；质量异常的新快照不生效并进入待处理。
- **Blocked by:** 041、044。
- **Design:** [FEATURE_060](features/v0.3.0.md#feature-060)。

### 061: 数据页重构

- **Status:** Planned
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 按表格/文档/指标分类，三档状态、一个主动作、数据截至；详情一步可见字段与样本。
- **Blocked by:** 037、060。
- **Design:** [FEATURE_061](features/v0.3.0.md#feature-061)。

### 062: 飞书多维表格与 PDF/DOCX

- **Status:** Planned
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 飞书多维表格作为表格来源；PDF、DOCX 作为文档来源。
- **Blocked by:** 043、060。
- **Design:** [FEATURE_062](features/v0.3.0.md#feature-062)。

### 063: 凭据加密、数据保留与备份恢复

- **Status:** Planned
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 凭据统一加密保存；快照与原文保留策略；一键备份与恢复。
- **Blocked by:** 无。
- **Design:** [FEATURE_063](features/v0.3.0.md#feature-063)。

### 064: 成本上限与角色权限

- **Status:** Planned
- **Category / Priority:** New / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 模型用量与上限；决定记录操作者；管理员、维护者、查看者三种角色。
- **Blocked by:** 041、046。
- **Design:** [FEATURE_064](features/v0.3.0.md#feature-064)。

### 065: 指标引用

- **Status:** Planned
- **Category / Priority:** New / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 指标挂到实体与属性，问答与对外可读指标并说明口径与版本。
- **Blocked by:** 040、041、052。
- **Design:** [FEATURE_065](features/v0.3.0.md#feature-065)。

### 066: 持久层优化与规模验收集

- **Status:** Planned
- **Category / Priority:** Internal / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 成果索引与大内容外置；发现过程优化；企业真实形态规模验收集作为发布门槛。
- **Blocked by:** 040、057—060。
- **Design:** [FEATURE_066](features/v0.3.0.md#feature-066)。

### 067: 演示与分享走正式路径、旧接口下线

- **Status:** Planned
- **Category / Priority:** Refactor / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 演示与离线分享使用正式渲染；经用户确认后移除 v1/v2/v3 接口。
- **Blocked by:** 039、049、050。
- **Design:** [FEATURE_067](features/v0.3.0.md#feature-067)。

### 068: v0.3.0 整链验收

- **Status:** Planned
- **Category / Priority:** Internal / High
- **Planned / Released:** v0.3.0 / —
- **Created / Started / Completed:** 2026-10-19 / — / —
- **Description:** 星桥与留出样本整链验收，记录成功指标基线与未覆盖项。
- **Blocked by:** 036—067。
- **Design:** [FEATURE_068](features/v0.3.0.md#feature-068)。
