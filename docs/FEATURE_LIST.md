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
| v0.1.0 | InProgress | 2 | 2 | 5 | 5/9 |

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

此表保留已有能力与票的实际完成记录，计数不代表新 MVP 体验的完成比例。首轮按 [MVP 完成条件](MVP.md)验收，不等待全部后续扩展能力。未完成票的依赖将在主 Agent 体验设计后重排；006、远程 MCP 服务和完整回归/恢复保留为后续工作，不因范围调整标为完成。

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
- **Design:** [FEATURE_007](features/v0.1.0.md#feature-007)；[第四页设计](DATA_CONSUMPTION_DESIGN.md)。

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

## Summary

- Total: 9
- Planned: 2
- InProgress: 2
- Completed: 5
- New: 6；Internal: 1；Enhancement: 2；High: 9。
- **当前：FEATURE_009 已完成：第三方 Agent 可通过本地 MCP 或 HTTP 读取获准的企业记忆，第四页提供配置、独立接入与事实数据检查/发布；同一密钥保持本体和权限，只切换明确发布的记录版本。66 项自动检查、真实 MCP/HTTP 与桌面/窄屏浏览器验证通过。完整方法评测、远程部署和自动来源同步继续按后续范围推进。**

项目初始化和开发文档已完成，记录在 [CHANGELOG](CHANGELOG.md)；它们不计入产品功能完成数。功能状态在本文维护，具体票的完成状态在对应设计块维护。
