# 架构决定记录

ADR 保存会影响后续功能设计的长期架构决定，并记录为什么采用、放弃什么以及何时重议。
它不是接口规范、开发任务清单或第二套功能状态台账。

## 已接受决定

| 编号 | 决定 | 状态 | 日期 |
|---|---|---|---|
| [ADR-001](ADR-001-kodax-runtime-boundary.md) | KodaX 单循环与产品宿主分工 | Accepted | 2026-09-11 |
| [ADR-002](ADR-002-shared-ontology-operations.md) | 共同本体操作服务与多客户端 | Accepted | 2026-09-11 |
| [ADR-003](ADR-003-state-and-source-separation.md) | 来源、语义与各类工作状态分离 | Accepted | 2026-09-11 |

**Accepted 表示设计决定已接受，不表示相关功能已经实现或验证完成。**
三条决定适用于当前本地实验，不自动引入生产平台、额外运行框架或新的开发票。

## 与其他文档的关系

- [DATA_ENGINE_DESIGN](../DATA_ENGINE_DESIGN.md) 是产品主设计与高层架构，不另建一份重复的 HLD。
- [AGENT_DESIGN](../AGENT_DESIGN.md) 细化内部 Agent 的运行与能力组织。
- [AGENT_UI_DESIGN](../AGENT_UI_DESIGN.md) 定义人类工作区与 Agent 的协作方式。
- [SEMANTIC_CONTRACTS](../SEMANTIC_CONTRACTS.md) 细化对象、证据、操作与版本契约；字段和签名不在 ADR 冻结。
- [KODAX_CAPABILITY_LEDGER](../KODAX_CAPABILITY_LEDGER.md) 登记实际可用的底座能力及产品适配边界。
- [BUILTIN_SKILLS](../BUILTIN_SKILLS.md) 约束产品运行 Skill 的职责和交付方式。
- [THREE_PAGE_PLAN](../THREE_PAGE_PLAN.md) 与 [Feature 设计块](../features/v0.1.0.md) 承接实施顺序和验收。

当前运行界面仍为四页，目标为企业与数据、本体工作区、消费与治理三页。
FEATURE_012—016 的既有 18 张票承接这一目标；ADR 不改变其数量、范围或状态。
功能完成情况以功能台账、代码和实际验证为准，不能从 ADR 的 Accepted 状态推导。

## 维护方式

每条记录包含背景、决定、取舍、后果、实施关联与重议条件。
补充解释可以修订原记录；推翻核心决定时新增 ADR，说明替代关系并更新索引。
重议应有具体需求或运行证据，不因参考项目采用另一套架构而直接迁移。
新功能先服从这些边界，再在对应 Feature 中定稿具体接口和实施步骤。
若用户要求改变范围，先明确受到影响的决定与验收，再同步相关设计记录。
