# 开发与版本管理

本项目使用 [CodingSkills](https://github.com/icetomoyo/CodingSkills) 的 Feature、设计块和 CHANGELOG 结构，项目内固定来源见 [.agents/CODINGSKILLS.md](../.agents/CODINGSKILLS.md)。

## 文件各自负责什么

| 文件 | 职责 |
|---|---|
| `PRODUCT.md` / `MVP.md` | 产品方向与当前实验范围 |
| `FEATURE_LIST.md` | 唯一功能状态台账、计划版本和实际发布版本 |
| `features/v0.1.0.md` | 版本目标，以及每个 Feature 的六节设计、票依赖和验收 |
| `AGENT_BLUEPRINT.md` / `AGENT_DESIGN.md` | FEATURE_003 设计附件：前者为组成、配置与契约；后者为行为规则及技术参考，不单独维护进度 |
| `PLAN.md` | 六部分导航和下一项入口，状态查询指向台账 |
| `CHANGELOG.md` | 已发生的变更；未发布内容放在 `[Unreleased]` |

## 使用顺序

1. **feature-manager：**登记或开始明确的 Feature，读取它的设计块和依赖。
2. **to-spec：**依据已确认的产品范围补齐当前 Feature 的设计与验收；核实开工所需的业务及技术事实。
3. **to-tickets：**把当前 Feature 细化成可独立检查的任务，明确依赖。本轮已按用户要求，将此前步骤写入设计块；新范围再单独对齐。
4. **implement：**沿任务依赖逐项实现，使用适合当前行为的 TDD、检查与代码评审，并提交到本地 Git。
5. **feature-manager：**实际开工改为 `InProgress`；验收通过后更新票状态及 `Completed`，记录证据。尚未发布时 `Released` 保持空。
6. **smart-release：**从已提交变更维护 `[Unreleased]` 和同步标记；实际发布时才同步运行包版本、填写发布记录和执行选定发布操作。

用户可以用自然语言指定下一项，例如“开始 001 的企业设定”；也可以使用 `/feature-manager`、`/to-spec`、`/to-tickets`、`/implement`、`/smart-release`。按用户指定范围推进，不自动把整份路线图都执行完。

## 本项目的使用约定

- 管理文件沿用本项目 `docs/`。本轮首个目标版本采用 v0.1.0，处于计划状态；当前没有发布版本，不为文档规划伪造发布 Tag 或运行包版本。
- 这轮已授权的范围是建立版本管理并沉淀既有步骤。目录、编号和文档整理直接完成，不为这些常规选择额外增加确认环节。
- Git 以本地提交为当前工作方式。此项目尚未配置远程仓库；推送、发布 Tag 和 GitHub Release 不属于本轮文档整理。
- Feature 状态只在台账维护，任务勾选只在设计块维护；状态改变后同步摘要。完成文档初始化不等于任何实验功能已经实现。
- 本轮仍是简单实验。对数据、计算、版本和消费路径做有意义的验证；只有对应工具链存在时才运行其 lint、类型或构建检查，不为文档新增空测试。
- 后续技能升级先检查差异、按需引入并更新来源记录。优先读取项目内对应 `SKILL.md`，避免与全局定制副本混用。
