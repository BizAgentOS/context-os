# DataEngine Feature List

Last Updated: 2026-09-07

## Version Info

- **Current Release:** 无，尚未发布产品版本。
- **Planned Version:** v0.1.0 — 本地方法验证实验。
- **版本状态:** InProgress；首个实验版本开发中，尚未发布。
- **状态规则:** `Planned → InProgress → Completed`；`Released` 仅填写实际发布版本。
- **设计:** [v0.1.0 设计与开发步骤](features/v0.1.0.md)。
- **范围:** [产品目标](PRODUCT.md)与 [MVP 目标](MVP.md)。

## Version Summary

| Version | Status | Planned | InProgress | Completed | Progress |
|---|---|---:|---:|---:|---:|
| v0.1.0 | InProgress | 3 | 2 | 1 | 1/6 |

## Feature Index

| ID | Title | Category | Priority | Status | Planned | Blocked by | Design |
|---|---|---|---|---|---|---|---|
| 001 | 虚构企业、原始数据与基线 | New | High | Completed | v0.1.0 | 无 | [设计](features/v0.1.0.md#feature-001) |
| 002 | 初始本体与只读数据服务 | New | High | InProgress | v0.1.0 | 001 | [设计](features/v0.1.0.md#feature-002) |
| 003 | KodaX 与 NOOA 式维护 Agent | New | High | Planned | v0.1.0 | 002 | [设计](features/v0.1.0.md#feature-003) |
| 004 | 本体演变与结果恢复 | New | High | Planned | v0.1.0 | 003 | [设计](features/v0.1.0.md#feature-004) |
| 005 | 简单本地工作台 | New | High | InProgress | v0.1.0 | 001；维护页依赖 004 | [设计](features/v0.1.0.md#feature-005) |
| 006 | 对照实验与规模验证 | Internal | High | Planned | v0.1.0 | 001、002、004 | [设计](features/v0.1.0.md#feature-006) |

以设计块中的票依赖决定可开始的工作。005 和 006 可随前面的链路逐步建设；v0.1.0 的完整验收包含全部六项。

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

### 003: KodaX 与 NOOA 式维护 Agent

- **Status:** Planned
- **Category / Priority:** New / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-07 / — / —
- **Description:** 实际接入 Runtime，通过稳定对象引用、类型化工具、按需读取和受限代码执行调查问题，产生有依据的修改建议。
- **Blocked by:** 002。
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
- **Description:** 同步呈现实验目标、企业资料、本体建模过程、概念/对象试样和 Agent 设计；提供本地笔记与只读问答浮窗，维护结果随 004 接入。
- **Blocked by:** 基础查看依赖 001 和已有技术试样，不等待正式本体；维护页依赖 004。
- **Design:** [FEATURE_005](features/v0.1.0.md#feature-005)。

### 006: 对照实验与规模验证

- **Status:** Planned
- **Category / Priority:** Internal / High
- **Planned / Released:** v0.1.0 / —
- **Created / Started / Completed:** 2026-09-07 / — / —
- **Description:** 汇总原始、专用表、静态本体、动态本体的质量和成本，用同一案例扩展到超过 1M Token，记录有效、无效及不确定结论。
- **Blocked by:** 001、002、004；结果文件可独立运行，与 005 按契约对接。
- **Design:** [FEATURE_006](features/v0.1.0.md#feature-006)。

## Summary

- Total: 6
- Planned: 3
- InProgress: 2
- Completed: 1
- New: 5；Internal: 1；High: 6。
- **当前：FEATURE_005 / T005-01 已完成同步前端，T005-02等待实际维护链路；下一步继续 FEATURE_002 / T002-01 的业务范围与建模任务。旧产物保留为技术试样，直接确认请求已撤回。见[工作台说明](experiment/LAB.md)与[流程草案](experiment/ONTOLOGY_MODELING.md)。**

项目初始化和开发文档已完成，记录在 [CHANGELOG](CHANGELOG.md)；它们不计入产品功能完成数。功能状态在本文维护，具体票的完成状态在对应设计块维护。
