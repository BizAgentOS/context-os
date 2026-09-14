# DataEngine Feature List

Last Updated: 2026-09-14

**2026-09-10 文档整理：**新增[产品与架构](DATA_ENGINE_DESIGN.md)、[语义契约](SEMANTIC_CONTRACTS.md)、[Agent 与前端协作](AGENT_UI_DESIGN.md)，并更新 `AGENTS.md` 阅读入口。只沉淀设计与纠正历史描述，未新增实现票、改变功能状态或运行产品验收。

**2026-09-14 当前计划：**产品核心明确为本体驱动多源数据融合，目标调整为企业与数据、本体工作区、消费与治理三页。新增 FEATURE_012—016，十八张任务中 T012-01、T012-02、T013-01、T013-02、T013-03、T014-01、T014-02、T014-03、T014-04、T014-05、T015-01、T015-02、T015-03 已完成；计划见[三页设计](THREE_PAGE_PLAN.md)。当前三页已可运行，其余融合和 Agent 方法仍按票实施。

**2026-09-11 Agent 产品文档整理：**参考 KodaX-Space 的职责分层，建立[文档中心](README.md)、当前 Agent 契约、KodaX 接入记录、内置 Skill 和 ADR；旧 Agent 设计归档。三页需求和十八张票、依赖与状态不变。

## Version Info

- **Current Release:** 无，尚未发布产品版本。
- **Planned Version:** v0.1.0 开发档案 — 当前目标为三页数据融合闭环，保留历史能力档案。
- **版本状态:** InProgress；首个实验版本开发中，尚未发布。
- **状态规则:** `Planned → InProgress → Completed`；`Released` 仅填写实际发布版本。
- **设计:** [v0.1.0 设计与开发步骤](features/v0.1.0.md)。
- **范围:** [产品目标](PRODUCT.md)与 [MVP 目标](MVP.md)。

## Version Summary

| Version | Status | Planned | InProgress | Completed | Progress |
|---|---|---:|---:|---:|---:|
| v0.1.0 | InProgress | 3 | 3 | 10 | 10/16 |

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
| 015 | 本体可视化、证据与内容治理 | Enhancement | High | InProgress | v0.1.0 | 012/013/014（按票） | [设计](features/v0.1.0.md#feature-015) |
| 016 | 消费接口、契约生成与治理闭环 | Enhancement | High | Planned | v0.1.0 | 012/014/015（按票） | [设计](features/v0.1.0.md#feature-016) |

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

- **Status:** InProgress
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-11 / 2026-09-14 / —
- **Description:** 定义与对象双视角，映射/证据/差异逐层查看；直接编辑和 Agent 经共同服务完成局部纠正与全局修订。
- **Blocked by:** 012/013/014（按票）；具体任务依赖见设计块。
- **Design:** [FEATURE_015](features/v0.1.0.md#feature-015)。

- **T015-01 已完成：**基础定义图/等价列表、版本与搜索、共同细粒度引用、映射和冲突说明，见[验收](experiment/FOUNDATION_VISUALIZATION.md)。

- **T015-02 已完成：**页内在线对象图/表/详情、实际关系展开、属性证据与共同引用、短页分页和失败重试，见[验收](experiment/LIVE_OBJECTS.md)。

- **T015-03 已完成：**表单与 Agent 共用局部关系候选、版本检查与人工采用；保留源基线、责任主体和操作回执，见[验收](experiment/RELATION_CORRECTIONS.md)。

### 016: 消费接口、契约生成与治理闭环

- **Status:** Planned
- **Category / Priority:** Enhancement / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-11 / — / —
- **Description:** 生成许可消费契约与实际 API/MCP 接入说明，开放受控证据，处理变更影响与消费者迁移并验收三页整链。
- **Blocked by:** 012/014/015（按票）；具体任务依赖见设计块。
- **Design:** [FEATURE_016](features/v0.1.0.md#feature-016)。

## Summary

- Total: 16
- Planned: 3
- InProgress: 3
- Completed: 10
- New: 8；Internal: 1；Enhancement: 6；Refactor: 1；High: 16。
- **已实现基础：FEATURE_011 已完成搜索、Skill、MCP 和业务 SDK 入口（[验收](experiment/AGENT_CAPABILITIES.md)）；FEATURE_010 已完成本地来源连接链路。HTTP/MCP 按需读取、Agent 本体候选、人工采用、第三方授权与源变化重读已验收；正式发布、多租户、专用 OAuth 连接器与自动演变仍未完成。**

**下一项：T015-04。** FEATURE_012/013/014 已完成；FEATURE_015 开发中，T015-01/02/03 已完成，接下来进行全局映射修订与治理影响。新票如覆盖旧 FEATURE_002/004/005 的未完验收，应复用同一实现和证据，再按真实结果更新旧票，不重复建设或提前勾选。

项目初始化和开发文档已完成，记录在 [CHANGELOG](CHANGELOG.md)；它们不计入产品功能完成数。功能状态在本文维护，具体票的完成状态在对应设计块维护。
