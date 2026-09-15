# Data Engine 文档中心

更新：2026-09-15。文档按基于 KodaX 的领域 Agent 产品组织：产品目标 → 系统职责 → Agent 方法与运行 → 共同语义契约 → 人类交互和外部消费 → 实施与验证。

**产品核心：本体驱动异构多源数据融合与语义打通。** 内部 Agent 协助构建和治理；人类用户与外部 Agent 消费同一企业语义层。三个页面是工作入口，内部保持一个 Agent，不为每页创建独立 Agent 或事实库。

当前运行已为“企业与数据、本体工作区、消费与治理”三页；FEATURE_012 的存量迁移、草稿恢复与消息工作上下文已实现。FEATURE_013 已接入基础本体 Skill 的对话、Markdown/TXT 资料与确认企业后的公开研究路径，支持实际引文、原文定位和采用；T014-01 已接入统一来源目录、HTTP/MCP 知识片段查询与引用，T014-02 已接入 BI 指标定义与观测，T014-03 已支持基础概念绑定真实业务来源，T014-04 已支持同实体多源属性融合与逐属性依据，T014-05 已支持文档、指标与业务对象共同取证，T015-01 已完成基础定义与映射局部可视化，T015-02 已完成在线对象、融合属性与证据探索，T015-03 已完成局部关系纠正闭环，T015-04 已完成全局映射修订与治理影响，T016-01 已完成融合对象的许可消费视图，T016-02 已完成按需证据与生成接入说明，T016-03 已完成变更影响与消费者迁移，下一项为 T016-04（三页数据融合整链验收）。本文不维护第二套功能状态，详见[功能台账](FEATURE_LIST.md)。

## 按问题选择文档

| 要回答的问题 | 主文档 | 负责的内容 |
|---|---|---|
| 产品为什么存在、给谁用、Agent 带来什么价值 | [产品需求（PRD）](PRODUCT.md) | 用户、业务任务、能力闭环、三页职责、成功判据 |
| 系统由谁负责什么 | [总体架构（HLD）](DATA_ENGINE_DESIGN.md) | KodaX、应用宿主、领域服务、来源、前端与消费边界 |
| 内部 Agent 如何工作和完成任务 | [Agent 设计](AGENT_DESIGN.md) | 身份、工作方式、运行装配、能力使用、状态、停止和恢复 |
| KodaX 哪些能力真的接入了 | [KodaX 能力接入记录](KODAX_CAPABILITY_LEDGER.md) | 当前 SDK 依据、本产品调用路径、证据和缺口 |
| 产品 Skill 如何组织和维护 | [内置 Skill](BUILTIN_SKILLS.md) | 目录、发现、加载、依赖、方法与工具的分工 |
| 基础本体 Skill 具体怎么做 | [企业基础本体 Skill](COMPANY_FOUNDATION_SKILL.md) | 对话、资料、公开研究三路径的输入、依据和交付 |
| 对象、证据、方法和权限如何定义 | [语义与操作契约](SEMANTIC_CONTRACTS.md) | 领域身份、断言、版本、操作、查询和提交回执 |
| 人和 Agent 如何对准同一内容 | [人机协作契约](AGENT_UI_DESIGN.md) | 固定到消息的工作上下文、展示意图、草稿与回执投影 |
| 用户看见什么、怎样查看和修改 | [画布与可视化](CANVAS_DESIGN.md) | 三页交互、图表详情、差异、键盘和窄屏 |
| 其他 Agent 怎样独立使用数据 | [消费与治理](DATA_CONSUMPTION_DESIGN.md) | 消费视图、API/MCP、说明生成、发布迁移与撤销 |
| 为什么这样划分职责 | [架构决策 ADR](ADR/README.md) | 稳定决定、替代方案、代价与重新讨论条件 |
| 本轮做到哪里、按什么顺序开发 | [MVP](MVP.md)、[三页实施计划](THREE_PAGE_PLAN.md) | 交付范围、存量迁移、开发顺序与集成验收 |
| 开发哪张票、什么算完成 | [功能台账](FEATURE_LIST.md)、[版本设计块](features/v0.1.0.md) | 功能状态、18 张票的依赖与验收；状态各有唯一位置 |
| 现在怎样运行、当时验证了什么 | [项目运行入口](../README.md)、[实验与运行索引](experiment/README.md) | 实际命令、现有能力与带日期的验证证据 |
| 怎样维护文档与实现 | [开发流程](DEVELOPMENT.md)、[变更记录](CHANGELOG.md) | Feature 流程、文档变更归属、实际交付记录 |

保留 `PRODUCT.md` 和 `DATA_ENGINE_DESIGN.md` 的现有路径，分别承担 PRD 和 HLD 的职责，不再新建同义长文。

## Agent 产品的阅读与开发顺序

首次理解项目先读产品需求、总体架构和当前 Feature。实现 Agent 行为时再读 Agent 设计、能力接入记录和相关 Skill；修改业务操作时先读语义契约；改交互时读人机协作与画布；改外部接口时读消费设计。

新增能力必须能回答：用户任务是什么 → 操作哪个领域对象 → 由哪个服务实施 → Agent 用什么方法与工具完成 → 人怎样检查结果 → 外部消费是否受影响。页面只是入口，不充当权限或业务规则的维护位置。

开发用 [AGENTS.md](../AGENTS.md) 指导开发者/编码 Agent；产品运行身份与方法由 `config/agent/`、`config/skills/` 和已实现工具提供。文档不会自动成为运行时提示词，改文档也不会自动改变模型行为。

## 文档状态与唯一维护位置

- **目标与契约**：产品需求、Agent 设计、语义、人机协作、画布、消费及 Skill 规格描述已确定的设计，未完成部分必须关联 Feature。
- **当前实现**：能力接入记录和 HLD 的当前实现小节以实际源码为依据；运行记录保留当时的版本、方法和限制。源码、已安装 SDK、验证记录分别说明，不用版本号推断能力。
- **实施状态**：Feature 状态只在 `FEATURE_LIST.md`；票勾选和依赖只在 `features/v0.1.0.md`。能力接入记录记录集成事实，不单独排期。
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
