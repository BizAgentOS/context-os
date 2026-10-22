# Data Engine 文档中心

更新：2026-10-22。文档按基于 KodaX 的领域 Agent 产品组织：产品目标 → 系统职责 → Agent 方法与运行 → 共同语义契约 → 人类交互和外部消费 → 实施与验证。

**产品核心：本体驱动异构多源数据融合与语义打通。** 内部 Agent 协助构建和治理；人类用户与外部 Agent 消费同一企业语义层。三个页面是工作入口，内部保持一个 Agent，不为每页创建独立 Agent 或事实库。

**当前版本：v0.3.1，2026-10-22 本地发布。**本次修复浮动助手及本体浏览状态联动；v0.3.0 的 FEATURE_036—068 已完成 33/33，覆盖显式分层本体、统一变更与待处理中心、构建与问答双模式 Agent、企业数据接入及试点治理。设计与任务保留在[v0.3.0 设计块](features/v0.3.0.md)及[目标产品蓝图](features/v0.3.0-blueprint.md)，功能状态以[台账](FEATURE_LIST.md)为准；本次不登记下一开发版本。

**最终验收：**[10-22 验收汇总](experiment/V030_ACCEPTANCE_2026_10_22.md)记录 645/645 全量、79/79 规模及星桥 / 留出样本的真实模型、发布、双消费者升级撤销和冷恢复。模型用量、协议夹具、失败重试与未覆盖范围分别记录；[发布准备记录](experiment/V030_RELEASE_READINESS.md)保留集中检查过程与资源基线。

**分阶段证据：**M0 清理与对齐见[隔离记录](experiment/V030_M0_2026_10_19.md)；040、047、049 见[基础批次验收](experiment/V030_M1_FOUNDATIONS_2026_10_19.md)。041 的统一变更、逐项采用 / 拒绝、历史恢复见[闭环验收](experiment/V030_041_2026_10_21.md)，042 的关系发现、身份规则 / 决定和固定发布 / 恢复见[同日验收](experiment/V030_042_2026_10_21.md)。这些带日期记录保留当时的未发布状态，不代表当前发布状态。

文档证据、统一待处理、问答、语义查询和企业数据接入的前期实现、真实模型与浏览器检查见[数据与问答集成记录](experiment/V030_DATA_QA_2026_10_21.md)。其当时待收口范围的后续结果见最终验收，不替代功能台账。

**历史基线：**[v0.2.0 设计与任务](features/v0.2.0.md)记录模型优先接入、Helix 程序构建、本体修订、发布版本和外部受限委托。FEATURE_025—035 已完成隔离验收，状态只在[功能台账](FEATURE_LIST.md)；v0.2.3 于 2026-10-16 本地发布，是本轮开发基线，随后修复见[2026-10-17 验收](experiment/ISSUES_2026_10_17.md)。历史发布、当时的测试及限制保留在[CHANGELOG](CHANGELOG.md)，旧版本未完成项仍在台账保留。

0.2.0 将当前三页更新为“数据、本体、发布与接入”；以下为已交付历史能力；FEATURE_012 的存量迁移、草稿恢复与消息工作上下文已实现。FEATURE_013 已接入基础本体 Skill 的对话、Markdown/TXT 资料与确认企业后的公开研究路径，支持实际引文、原文定位和采用；T014-01 已接入统一来源目录、HTTP/MCP 知识片段查询与引用，T014-02 已接入 BI 指标定义与观测，T014-03 已支持基础概念绑定真实业务来源，T014-04 已支持同实体多源属性融合与逐属性依据，T014-05 已支持文档、指标与业务对象共同取证，T015-01 已完成基础定义与映射局部可视化，T015-02 已完成在线对象、融合属性与证据探索，T015-03 已完成局部关系纠正闭环，T015-04 已完成全局映射修订与治理影响，T016-01 已完成融合对象的许可消费视图，T016-02 已完成按需证据与生成接入说明，T016-03 已完成变更影响与消费者迁移，T016-04 已完成三页数据融合整链验收，见[整链记录](experiment/FUSION_CHAIN.md)。本文不维护第二套功能状态，详见[功能台账](FEATURE_LIST.md)。

## 按问题选择文档

星桥软件原始数据的清空重建、构建阻断修复与剩余关系发现缺口见[2026-10-18 重建验收](experiment/STARBRIDGE_REBUILD_2026_10_18.md)。

| 要回答的问题 | 主文档 | 负责的内容 |
|---|---|---|
| 产品为什么存在、给谁用、Agent 带来什么价值 | [产品需求（PRD）](PRODUCT.md) | 用户、业务任务、能力闭环、三页职责、成功判据 |
| 系统由谁负责什么 | [总体架构（HLD）](DATA_ENGINE_DESIGN.md) | KodaX、应用宿主、领域服务、来源、前端与消费边界 |
| 内部 Agent 如何工作和完成任务 | [Agent 设计](AGENT_DESIGN.md) | 身份、工作方式、运行装配、能力使用、状态、停止和恢复 |
| KodaX 哪些能力真的接入了 | [KodaX 能力接入记录](KODAX_CAPABILITY_LEDGER.md) | 当前 SDK 依据、本产品调用路径、证据和缺口 |
| 0.2.0 三页怎样运行与验收 | [数据底座工作台](experiment/ENGINE_WORKBENCH.md) | 模型优先、程序构建、修订、发布接入与受限委托 |
| 首次怎样建立企业、行业定义和来源 | [企业冷启动](experiment/ENTERPRISE_ONBOARDING.md) | 五步向导、金融优先模板、密钥保存、恢复及实际接入范围 |
| API 接入后怎样自动成为可查询本体 | [API 自动本体化](experiment/AUTOMATIC_API.md) | 连接排队、真实样本、基础概念与自动映射、状态和失败重试 |
| 怎样用接口文档接入 HTTP API | [Swagger/OpenAPI 导入](experiment/OPENAPI_IMPORT.md) | 文档导入、接口选择、认证、样本测试、保存与当前限制 |
| 服务登录与 MCP 接入如何处理 | [连接向导设计](CONNECTOR_ONBOARDING_DESIGN.md)、[便捷接入验收](experiment/MCP_ONBOARDING.md) | 飞书官方 CLI、账号复用、URL 发现与能力选择；已验证 wiki Markdown 读取、保存与本体候选入口；真实 docx 仍待验收 |
| 产品 Skill 如何组织和维护 | [内置 Skill](BUILTIN_SKILLS.md) | 目录、发现、加载、依赖、方法与工具的分工 |
| 基础本体 Skill 具体怎么做 | [企业基础本体 Skill](COMPANY_FOUNDATION_SKILL.md) | 对话、资料、公开研究三路径的输入、依据和交付 |
| 对象、证据、方法和权限如何定义 | [语义与操作契约](SEMANTIC_CONTRACTS.md) | 领域身份、断言、版本、操作、查询和提交回执 |
| 人和 Agent 如何对准同一内容 | [人机协作契约](AGENT_UI_DESIGN.md) | 固定到消息的工作上下文、展示意图、草稿与回执投影 |
| 企业档案内容区后续如何扩展 | [排版开发 Skill](../.agents/skills/enterprise-profile-layout/SKILL.md) | 已确认的内容结构、页面边界、真实数据与响应式规则 |
| 三维本体空间怎样探索 | [三维本体验收](experiment/ONTOLOGY_SPACE.md) | 点击聚焦、关联扇区、深色详情与随状态移动的共享输入框 |
| 用户看见什么、怎样查看和修改 | [画布与可视化](CANVAS_DESIGN.md) | 三页交互、图表详情、差异、键盘和窄屏 |
| 其他 Agent 怎样独立使用数据 | [消费与治理](DATA_CONSUMPTION_DESIGN.md) | 消费视图、API/MCP、说明生成、发布迁移与撤销 |
| 为什么这样划分职责 | [架构决策 ADR](ADR/README.md) | 稳定决定、替代方案、代价与重新讨论条件 |
| 本轮做到哪里、按什么顺序开发 | [v0.3.0 设计与任务](features/v0.3.0.md)、[功能台账](FEATURE_LIST.md)、[MVP](MVP.md) | 当前交付范围、依赖与集成验收；[三页迁移计划](THREE_PAGE_PLAN.md)保留历史 |
| 开发哪张票、什么算完成 | [功能台账](FEATURE_LIST.md)、[v0.3.0 设计块](features/v0.3.0.md)（目标设计见[蓝图](features/v0.3.0-blueprint.md)）、[v0.2.0 设计块](features/v0.2.0.md) | 功能状态、当前票的依赖与验收；状态各有唯一位置 |
| 现在怎样运行、当时验证了什么 | [项目运行入口](../README.md)、[实验与运行索引](experiment/README.md) | 实际命令、现有能力与带日期的验证证据 |
| 怎样维护文档与实现 | [开发流程](DEVELOPMENT.md)、[变更记录](CHANGELOG.md) | Feature 流程、文档变更归属、实际交付记录 |
| 还有哪些已知问题待修 | [问题与处理状态](ISSUES.md)、[本轮验收](experiment/ISSUES_2026_10_17.md) | 原始问题、当前修复证据与尚待验证项；不代替台账状态 |

保留 `PRODUCT.md` 和 `DATA_ENGINE_DESIGN.md` 的现有路径，分别承担 PRD 和 HLD 的职责，不再新建同义长文。

## Agent 产品的阅读与开发顺序

首次理解项目先读产品需求、总体架构和当前 Feature。实现 Agent 行为时再读 Agent 设计、能力接入记录和相关 Skill；修改业务操作时先读语义契约；改交互时读人机协作与画布；改外部接口时读消费设计。

新增能力必须能回答：用户任务是什么 → 操作哪个领域对象 → 由哪个服务实施 → Agent 用什么方法与工具完成 → 人怎样检查结果 → 外部消费是否受影响。页面只是入口，不充当权限或业务规则的维护位置。

开发用 [AGENTS.md](../AGENTS.md) 指导开发者/编码 Agent；产品运行身份与方法由 `config/agent/`、`config/skills/` 和已实现工具提供。文档不会自动成为运行时提示词，改文档也不会自动改变模型行为。

## 文档状态与唯一维护位置

- **目标与契约**：产品需求、Agent 设计、语义、人机协作、画布、消费及 Skill 规格描述已确定的设计，未完成部分必须关联 Feature。
- **当前实现**：能力接入记录和 HLD 的当前实现小节以实际源码为依据；运行记录保留当时的版本、方法和限制。源码、已安装 SDK、验证记录分别说明，不用版本号推断能力。
- **实施状态**：Feature 状态只在 `FEATURE_LIST.md`；票勾选和依赖只在各 `features/v*.md` 设计块。能力接入记录记录集成事实，不单独排期。
- **决策**：ADR 的 Accepted 表示采纳设计，不表示代码完成；变化时新增或更新决策状态，保留旧决定的上下文。
- **历史**：[早期设计归档](archive/README.md)及实验验收不按新界面改写。历史 Feature 链接继续指向其当时设计，不能悄悄改为新规范。

发现矛盾时，用户最新明确要求优先；具体领域问题归各自主文档，Feature 决定本轮范围，代码与验证决定“已经支持什么”。先消除冲突再实现，不能挑一份较宽松的旧文档作为依据。

## KodaX-Space 的借鉴与本产品取舍

对照固定源码 [84352756](https://github.com/icetomoyo/KodaX-Space/tree/84352756f9d792c6f327a506cede062e809392e1)，读取其文档中心、PRD、HLD、能力台账、内置 Skill 维护和 ADR。原项目文档中正式发布与源码候选分开描述；本次借鉴组织方式，不采用其 SDK 版本或声明其能力已在 Data Engine 接入。

| 参考结构 | Data Engine 的对应调整 |
|---|---|
| [文档中心](https://github.com/icetomoyo/KodaX-Space/blob/84352756f9d792c6f327a506cede062e809392e1/docs/README.md)按目标导航、区分当前与历史 | 当前文档职责表、按任务阅读、历史 Agent 归档 |
| [PRD](https://github.com/icetomoyo/KodaX-Space/blob/84352756f9d792c6f327a506cede062e809392e1/docs/PRD.md)与 [HLD](https://github.com/icetomoyo/KodaX-Space/blob/84352756f9d792c6f327a506cede062e809392e1/docs/HLD.md)分开产品与技术责任 | 产品围绕本体融合工作闭环；架构明确 SDK、宿主与领域服务的职责 |
| [能力台账](https://github.com/icetomoyo/KodaX-Space/blob/84352756f9d792c6f327a506cede062e809392e1/docs/KODAX_CAPABILITY_LEDGER.md)区分上游合同与产品接入 | 列出本项目实际调用、限制与待实现能力，避免把 SDK 支持当成本产品完成 |
| [内置 Skill 维护](https://github.com/icetomoyo/KodaX-Space/blob/84352756f9d792c6f327a506cede062e809392e1/docs/BUILTIN_SKILLS.md)独立管理方法资源 | 管理本项目方法、实际工具依赖与可验证产物；首轮没有复制其完整分发工具链 |
| [ADR 索引](https://github.com/icetomoyo/KodaX-Space/blob/84352756f9d792c6f327a506cede062e809392e1/docs/ADR/README.md)保留决策与取舍 | 固定单循环、共同领域操作边界、状态与来源分离三项决定 |

Data Engine 当前是 Node HTTP 服务与 Web 画布。Space 的 Electron、Coder/Partner、共享 daemon、桌面面板及权限档位有各自产品背景，本轮不引入这些结构。外部数据消费仍是独立的确定性服务入口，无需经过内部模型。
