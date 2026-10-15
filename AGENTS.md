# Data Engine 开发工作约定

本目录是产品 Git 根目录；外层是调研工作区。Git 与产品命令在本目录执行。

## 先读什么

1. [文档中心](docs/README.md)：按任务选择主文档，区分目标设计、当前接入事实与历史。
2. 首次理解产品读[产品需求](docs/PRODUCT.md)和[总体架构](docs/DATA_ENGINE_DESIGN.md)；执行任务读[功能台账](docs/FEATURE_LIST.md)及当前 Feature 设计块。
3. Agent 工作读[Agent 设计](docs/AGENT_DESIGN.md)、[KodaX 能力记录](docs/KODAX_CAPABILITY_LEDGER.md)与[内置 Skill](docs/BUILTIN_SKILLS.md)；领域操作读[语义契约](docs/SEMANTIC_CONTRACTS.md)；界面读[协作契约](docs/AGENT_UI_DESIGN.md)和[画布](docs/CANVAS_DESIGN.md)；对外接口读[消费设计](docs/DATA_CONSUMPTION_DESIGN.md)。

用户最新明确指示优先。各主文档只管理其职责，不必每次加载全部长文；旧调研和归档不能自动成为新需求。

## 不变的产品约束

- 核心是本体驱动异构多源数据融合与语义打通。内部 Agent 降低构建和治理成本；人和外部 Agent 是使用者。
- 从业务对象、关系、依据和操作出发。前端与 Agent 调用共同服务；领域身份、权限、版本与回执不在客户端各自实现。
- KodaX 负责唯一内部模型/工具循环；宿主绑定身份、范围和运行有效性。NOOA 提供对象方法设计参考，Skill 提供方法，不代替实现或授权。
- 领域定义、事实、治理记录、临时运行和 UI 状态分离。结构化来源默认同步为不可变快照，发布锁定快照版本；实时读取是显式例外并标注（[ADR-004](docs/ADR/ADR-004-managed-snapshots-and-pinned-releases.md)）。保留未知、冲突、实际读取时间和覆盖；不得把结构校验当作业务真实，不得声称不存在的快照或历史版本。
- 有界发现并逐步读取对象/证据，不把企业全量内容放入上下文。已授权普通操作直接推进；需业务决定时先提供具体候选与影响，不重复确认相同决定。
- 依据实际服务回执报告保存、采用、失败和完成。参考项目或 SDK 有能力不等于本产品已接入；文档设计不使 Feature 自动完成。

理由和取舍在 [ADR](docs/ADR/README.md) 维护，具体合同在对应主文档维护。本文件不重复完整产品规格。

## 当前范围与开发方式

当前版本 0.2.2：数据、本体、发布与接入三页工作台，结构化来源同步为快照，Helix 全量发现与检查，发布锁定快照；本次修复快照保留、覆盖及旧发布接入等 7 项问题。范围与验收看 [0.2.x 设计](docs/features/v0.2.0.md)、[功能台账](docs/FEATURE_LIST.md)和[整体验收](docs/experiment/ENGINE_WORKBENCH.md)。v0.1.0 未单独发布，002、004、005、006、019 仍未完成，台账保留。保持本地单企业实验范围，按当前授权任务推进，不自动展开全部路线图。

使用项目内 `.agents/skills/` 的开发技能，来源固定在 [.agents/CODINGSKILLS.md](.agents/CODINGSKILLS.md)。产品运行身份位于 `config/agent/`，运行 Skill 位于 `config/skills/`；它们与本文件、开发技能和 `docs/` 规格是不同角色，不能把设计文档自动装入模型。

按 [DEVELOPMENT](docs/DEVELOPMENT.md) 管理 Feature：功能状态只在台账，票勾选和依赖只在设计块。开工、完成和验证均记录实际发生内容；`PLAN.md` 只作导航。

使用适合改动的验证，优先沿现有公共边界核查来源、领域操作和外部结果，不用只重复实现的测试充数。评测答案、生成器内部信息和未来事件不能进入被测 Agent 的输入。

保留用户工作与历史验收，不提交凭据、日志或大体积生成数据。第三方参考资料留在外层调研目录；产品只记录必要决定与来源链接。SDK 升级、新执行环境或发布按明确任务处理。

## 版本与发布

- **当前版本记录在三处，必须一致**：`package.json` 的 `version`、CHANGELOG 最新的已发布段落、最新的 Git Tag。README 的“当前版本”表随发布更新。
- **版本号**：`MAJOR.MINOR.PATCH`。修复与补齐已承诺范围用 PATCH，新的功能批次用 MINOR。开发期间不加 `-dev` 后缀，`package.json` 保持最近一次发布的版本，未发布内容写在 CHANGELOG 的 `[Unreleased]`。
- **功能与版本**：台账中 `Planned` 是计划版本，`Released` 只填实际包含它的发布版本（如 031—035 计划于 v0.2.0、发布于 v0.2.1）。每次完成功能就在 `[Unreleased]` 追加一条，写清做了什么、怎么验证、有什么限制。
- **发布只在用户确认版本号后进行**，步骤：
  1. 跑 `npm run check`；涉及快照、构建或发布链路时再跑 `npm run verify:snapshots`。
  2. 同步版本号：`package.json`、`package-lock.json`（两处）、`scripts/dataengine-mcp.ts` 与 `src/live/sources.ts` 中对外报告的版本。
  3. CHANGELOG：`[Unreleased]` 改为 `[x.y.z] - YYYY-MM-DD` 并写一段发布摘要，上方留空的 `[Unreleased]`，更新 `last-sync` 标记。
  4. 台账填写 `Released` 与版本状态；README“当前版本”表与 AGENTS“当前范围”更新。
  5. 本地提交 `chore(release): vx.y.z`，再打附注 Tag：`git tag -a vx.y.z -m "ADE vx.y.z"`。
- **Tag 一经发布不移动、不复用**。发布后发现问题，修复后发下一个 PATCH。打 Tag 前先用 `git tag` 确认版本号未被占用，包括在仓库外发出过的版本。
- 仓库没有配置远程；推送、GitHub Release 或部署需用户另行明确同意。
- 带日期的验收与设计记录保留当时原文；后续变化以追加段落或标注说明，不改写历史。

