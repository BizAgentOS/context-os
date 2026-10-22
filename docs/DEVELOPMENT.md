# 开发与版本管理

本项目使用 [CodingSkills](https://github.com/icetomoyo/CodingSkills) 的 Feature、设计块和 CHANGELOG 结构，项目内固定来源见 [.agents/CODINGSKILLS.md](../.agents/CODINGSKILLS.md)。

## 文档按 Agent 产品职责维护

完整职责表见[文档中心](README.md)，不在此维护第二份目录。产品需求定义为什么做，总体架构定义服务分工，Agent 设计定义工作与运行，语义契约定义共同业务边界，人机契约与画布定义协作和可视化，消费设计定义外部使用。

新增或修改能力时，先确定它归 KodaX 接入、产品宿主、领域服务、来源适配、Skill 方法还是界面。涉及 SDK 的实现核对[能力接入记录](KODAX_CAPABILITY_LEDGER.md)；涉及方法的实现核对[运行 Skill](BUILTIN_SKILLS.md)。不因上游存在接口就标为已接入，不用 Prompt 承担应由代码执行的约束。

- `FEATURE_LIST.md`：唯一功能状态台账与计划/发布版本。
- `features/v0.3.0.md`：v0.3.0 已交付 Feature 设计、票依赖及完成勾选；`features/v0.2.0.md` 与 `features/v0.1.0.md` 保留历史。下一开发版本尚未登记。
- `MVP.md`：v0.3.0 范围说明；`THREE_PAGE_PLAN.md` 保留 v0.1.0 三页迁移历史；`PLAN.md` 只导航。
- `ADR/`：长期架构决定与取舍；Accepted 不表示实现完成。
- `experiment/`：实际运行和验证的历史证据；新增结果带版本与限制。
- `archive/`：已被替代的设计，历史 Feature 链接仍指向当时正文。
- `CHANGELOG.md`：实际发生的变更，未发布内容放在 `[Unreleased]`；每个发布版本一段，版本号与 `package.json`、Git Tag 一致。

一次实现先对齐当前票涉及的主契约，再更新代码、必要运行方法和证据。仅界面变化不改业务语义；仅文档整理不改 Feature 完成状态。产品运行配置与设计规格分别维护，不能靠改文档声称模型行为已改变。

## 使用顺序

1. **feature-manager：**登记或开始明确的 Feature，读取它的设计块和依赖。
2. **to-spec：**依据已确认的产品范围补齐当前 Feature 的设计与验收；核实开工所需的业务及技术事实。
3. **to-tickets：**把当前 Feature 细化成可独立检查的任务，明确依赖。本轮已按用户要求，将此前步骤写入设计块；新范围再单独对齐。
4. **implement：**沿任务依赖逐项实现，使用适合当前行为的 TDD、检查与代码评审，并提交到本地 Git。
5. **feature-manager：**实际开工改为 `InProgress`；验收通过后更新票状态及 `Completed`，记录证据。尚未发布时 `Released` 保持空。
6. **smart-release：**从已提交变更维护 `[Unreleased]` 和同步标记；实际发布时才同步运行包版本、填写发布记录和执行选定发布操作。

用户可以用自然语言指定下一项，例如“开始 001 的企业设定”；也可以使用 `/feature-manager`、`/to-spec`、`/to-tickets`、`/implement`、`/smart-release`。按用户指定范围推进，不自动把整份路线图都执行完。

## 本项目的使用约定

- 管理文件沿用本项目 `docs/`。当前发布版本为 v0.3.1（2026-10-22），FEATURE_036—068 已完成 33/33；645 项全量、79 项规模及两样本整链证据见[最终验收](experiment/V030_ACCEPTANCE_2026_10_22.md)。v0.2.3（2026-10-16）保留为历史开发基线；旧版本未完成项继续在台账中保留，不自行登记下一版本。版本号、发布步骤与 Tag 规则统一见 [AGENTS.md · 版本与发布](../AGENTS.md#版本与发布)，本文不重复。
- 文档整理、设计与拆票按用户已授权范围直接完成。新增实现或范围调整按当前任务处理，不为已明确的常规选择额外增加确认环节。
- 代码托管在组织私有仓库 [BizAgentOS/context-os](https://github.com/BizAgentOS/context-os)，默认分支为 `main`。使用功能分支与 Pull Request 协作，拉取、验证和提交步骤见 [CONTRIBUTING](../CONTRIBUTING.md)。GitHub Release 由 NoraJing 按[发布流程](RELEASING.md)确认后执行；双方写权限保持，流程外的直接 Release 权限仍在。线上部署按单独明确授权执行；上传代码不改变包版本或已有 Tag。
- Feature 状态只在台账维护，任务勾选只在设计块维护；状态改变后同步摘要。完成文档初始化不等于任何实验功能已经实现。
- 本轮仍是简单实验。对数据、计算、版本和消费路径做有意义的验证；只有对应工具链存在时才运行其 lint、类型或构建检查，不为文档新增空测试。
- 后续技能升级先检查差异、按需引入并更新来源记录。优先读取项目内对应 `SKILL.md`，避免与全局定制副本混用。
