# DataEngine Feature List

Last Updated: 2026-09-08

## Version Info

- **Current Release:** 无，尚未发布产品版本。
- **Planned Version:** v0.1.0 开发档案 — 首轮交付企业记忆画布。
- **版本状态:** InProgress；首个实验版本开发中，尚未发布。
- **状态规则:** `Planned → InProgress → Completed`；`Released` 仅填写实际发布版本。
- **设计:** [v0.1.0 设计与开发步骤](features/v0.1.0.md)。
- **范围:** [产品目标](PRODUCT.md)与 [MVP 目标](MVP.md)。

## Version Summary

| Version | Status | Planned | InProgress | Completed | Progress |
|---|---|---:|---:|---:|---:|
| v0.1.0 | InProgress | 2 | 2 | 2 | 2/6 |

## Feature Index

| ID | Title | Category | Priority | Status | Planned | Blocked by | Design |
|---|---|---|---|---|---|---|---|
| 001 | 虚构企业、原始数据与基线 | New | High | Completed | v0.1.0 | 无 | [设计](features/v0.1.0.md#feature-001) |
| 002 | 初始本体与只读数据服务 | New | High | InProgress | v0.1.0 | 001 | [设计](features/v0.1.0.md#feature-002) |
| 003 | KodaX 与 NOOA 式企业主 Agent | New | High | Completed | v0.1.0 | 首段无；对象能力与 002 对接 | [设计](features/v0.1.0.md#feature-003) |
| 004 | 本体演变与结果恢复 | New | High | Planned | v0.1.0 | 003 | [设计](features/v0.1.0.md#feature-004) |
| 005 | 简单本地工作台 | New | High | InProgress | v0.1.0 | 001；维护页依赖 004 | [设计](features/v0.1.0.md#feature-005) |
| 006 | 对照实验与规模验证 | Internal | High | Planned | v0.1.0 | 001、002、004 | [设计](features/v0.1.0.md#feature-006) |

此表保留已有能力与票的实际完成记录，计数不代表新 MVP 体验的完成比例。首轮按 [MVP 完成条件](MVP.md)验收，不等待全部六项扩展能力。未完成票的依赖将在主 Agent 体验设计后重排；006、完整外部消费和完整回归/恢复保留为后续工作，不因范围调整标为完成。

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
- **Description:** T005-04 已将主界面改为企业、数据、本体与对象三个记忆画布；底部输入、近清远淡对话，真实成果可直接查看。T005-01/03 作为历史交付；T005-02 完整演变与对照视图暂缓。
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
- Planned: 2
- InProgress: 2
- Completed: 2
- New: 5；Internal: 1；High: 6。
- **当前：按用户手绘与产品定位实现[企业记忆画布](CANVAS_DESIGN.md)，T003-04 / T005-04 已完成，验证见[画布运行记录](experiment/CANVAS.md)。既有 KodaX 与企业记忆能力复用；前端只创建企业、接入资料、建立本体与对象，去掉任务/历史聊天/报告与更新页。旧完成记录保留，T004/T006 的扩展能力继续延后。**

项目初始化和开发文档已完成，记录在 [CHANGELOG](CHANGELOG.md)；它们不计入产品功能完成数。功能状态在本文维护，具体票的完成状态在对应设计块维护。
