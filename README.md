# Context OS

**第一阶段验证更新：**用户授权后已完成类型检查、新核心 16 项、现有回归 680 项及 CLI/浏览器检查，修复启动、权限、分页和模型适配问题，并用已配置 GLM 5.3 完成合成资料小样本验证。详情见[运行记录](docs/implementation/PHASE1_VERIFICATION.md)；实际企业资料与生产条件仍待验收。

> **当前开发方向：单企业实例的对象式知识核心。** 新阶段以 [实施决定](docs/implementation/PHASE1_DECISION.md)为准，代码入口已改为 PostgreSQL 知识核心，使用步骤与配置见[开发交接](docs/implementation/PHASE1_DEVELOPMENT.md)。首轮按用户要求仅编写实现，授权后的运行结果见上方更新；下方旧版验收为历史记录。`npm start` 使用新入口；旧入口为 `npm run legacy:start`。

本体驱动的通用多源数据底座。把散落在不同系统的数据接进来，构建可溯源、有依据的本体，按版本发布给人和外部 Agent 使用。程序负责构建结构，KodaX Agent 协助接入、解释与修订。投研作为后续验证场景。

## 当前版本：v0.3.1

v0.3.0 的 FEATURE_036—068 已完成 **33/33**：分层本体、统一变更与身份治理、构建 / 问答双模式 Agent、企业数据接入、凭据与角色、备份恢复及旧接口下线。设计见 [v0.3.0 设计与任务](docs/features/v0.3.0.md)及[目标蓝图](docs/features/v0.3.0-blueprint.md)，功能状态见[台账](docs/FEATURE_LIST.md)。

2026-10-22 本地发布 v0.3.0，同日发布交互修复 v0.3.1（Agent 面板改为浮在内容底部并随本体浏览状态移动）。最终全量 **645/645**、规模验收 **79/79** 与类型检查通过；星桥和独立留出样本走通发布、HTTP / MCP 双消费者、升级撤销及冷恢复。真实模型表现、失败重试、恢复结果与未覆盖范围见[最终验收](docs/experiment/V030_ACCEPTANCE_2026_10_22.md)。

## 已发布版本

| 版本 | 日期 | 提交 / Tag | 内容 |
|---|---|---|---|
| **0.3.1**（最近发布） | 2026-10-22 | Tag `v0.3.1` | 修复 v0.3.0 交互：Agent 面板取消固定右侧，数据与发布页底部居中，本体页随总览 / 聚焦 / 详情移动；645/645 测试通过 |
| 0.3.0 | 2026-10-22 | Tag `v0.3.0` | FEATURE_036—068 共 33 项完成；分层语义与身份治理、双模式 Agent、企业接入和试点治理；645 项全量、79 项规模及两样本发布 / 消费 / 冷恢复验收通过 |
| 0.2.3 | 2026-10-16 | Tag `v0.2.3` | 基础本体改由规则构建、Agent 只修正；本体页按程序发现结果展示；修复替换 CSV 后重建失败。发布当时 228 项测试通过、14 项旧流程测试暂跳过，后续处理见 [ISSUES](docs/ISSUES.md) |
| 0.2.2 | 2026-10-15 | Tag `v0.2.2` | 修复快照保留、来源覆盖、旧发布接入、同名字段及日期原值等 7 项问题；231 项测试与整链验收通过 |
| 0.2.1 | 2026-10-15 | Tag `v0.2.1` | 移植 Helix 快照底座：全量快照、全量本体发现与检查、发布锁定数据（FEATURE_031—035）及后续修复 |
| 0.2.0 | 2026-10-14 | `930b10e` / Tag `v0.2.0` | 数据 · 本体 · 发布与接入三页工作台（FEATURE_025—030） |

代码仓库：[BizAgentOS/context-os](https://github.com/BizAgentOS/context-os)（私有），默认分支为 `main`。历史版本 Tag 与提交记录保留；GitHub Release 和线上部署单独管理。完整变更见 [CHANGELOG](docs/CHANGELOG.md)，功能状态见[功能台账](docs/FEATURE_LIST.md)，协作步骤见[贡献指南](CONTRIBUTING.md)。

## 三个页面

- **数据**：接入文件、HTTP API 与 MCP 来源；把结构化记录同步为不可变快照，查看行数、字段画像与样本；来源字段结构变化时列出逐字段差异，确认后才生效；可把单个数据集改为实时读取。
- **本体**：程序基于快照生成独立实体初稿与关系、身份等提议；结构变化经统一流程提议、复验并明确采用或拒绝，保留记录级身份决定和历史工作版。首次独立实体与同结构重绑适用有界自动采用规则。
- **发布与接入**：发布固定工作版、本体、映射、来源快照与已采用的治理决定；发布与升级前显示定义差异和行级数据差异；为接入方选择范围、签发密钥、显式升级或撤销；可单独开启受限的 Context OS Agent 委托。

本体构建方法移植自 Helix Foundry（Apache-2.0），许可与逐文件修改记录见[第三方说明](third_party/helix-foundry/MODIFICATIONS.md)，设计决定见 [ADR-004](docs/ADR/ADR-004-managed-snapshots-and-pinned-releases.md)。

## 快速开始

需要 Node.js 22.18+，以及该私有仓库的访问权限。

```sh
git clone https://github.com/BizAgentOS/context-os.git
cd context-os
npm ci
npm start
```

打开终端输出的本机管理链接（默认端口 8788）。页面会移除地址中的管理凭据片段并建立浏览器管理会话，之后同一浏览器可直接打开 <http://127.0.0.1:8788>。新空间先进入初始化，存量企业可从“完善初始化”重新进入，见[冷启动使用与验收](docs/experiment/ENTERPRISE_ONBOARDING.md)。结构化来源的首轮构建不需要模型。

**模型配置**：在模型设置中配置凭据，或沿用宿主环境变量。页面保存的模型密钥进入本机凭据库：macOS 使用 Keychain，其他环境使用独立机器密钥加密文件；旧明文凭据经核验后迁移。凭据跨刷新和重启保留，可主动删除。GLM 可选“智谱 GLM · 普通 API”“智谱 GLM · Coding Plan”或“Z.ai GLM · Coding Plan”，分别使用 `ZHIPU_API_KEY`、`ZHIPU_CODING_API_KEY`、`ZAI_CODING_API_KEY`；也可选“自定义 API”填写 OpenAI/Anthropic 兼容 Base URL、模型 ID 和密钥，见[自定义接口说明](docs/experiment/CUSTOM_MODEL_API.md)。

**凭据分开**：管理凭据只用于本机管理；接入方使用第三页签发的独立密钥，只能访问其授权范围，升级会撤销旧密钥。

## 名称与已有配置迁移

产品名称统一为 **Context OS**，包名和技术标识为 `context-os`。产品 Git 目录为 `Context OS/context-os/`，在该目录执行产品命令；已有企业状态、来源、发布、接入密钥和模型凭据继续使用。此次仅更名，包版本保持 `0.3.1`，已有发布 Tag 不移动。

新配置统一使用 `CONTEXT_OS_` 环境变量，例如 `CONTEXT_OS_PORT`、`CONTEXT_OS_STATE_DIR`、`CONTEXT_OS_URL`、`CONTEXT_OS_CONSUMER_KEY` 与 `CONTEXT_OS_SNAPSHOT_MAX_ROWS`；本机管理请求使用 `X-ContextOS-Token`。MCP 入口为 `scripts/context-os-mcp.ts`，服务标识为 `context-os-memory`；受限委托工具为 `submit_context_os_task`、`read_context_os_task`、`cancel_context_os_task`。

为保持已有接入可用，旧 `DATAENGINE_` / `ADE_` 环境变量、`X-DataEngine-Token`、`scripts/dataengine-mcp.ts` 和 `submit_ade_task` / `read_ade_task` / `cancel_ade_task` 保留为兼容入口；新环境变量优先。旧目录通过兼容软链接继续定位到新目录。历史验收的 `output/ade-*`、`/tmp/ade-*` 和运行编号保留真实名称；既有凭据库、业务记录与存储格式中的旧标识只为兼容读取保留，不作为产品显示名称。

## 验证

| 命令 | 内容 | 是否调用模型 |
|---|---|---|
| `npm run check` | 类型检查与全部 Agent 测试；v0.3.0 最终 645/645，见[最终验收](docs/experiment/V030_ACCEPTANCE_2026_10_22.md) | 否 |
| `npm run verify:snapshots` | 经 HTTP 接口走完快照整链：同步 → 独立实体构建 → 明确采用身份与关系 → 发布 → 来源更新与字段类型变化 → 再发布 → 升级 → 撤销，见[验收](docs/experiment/V030_042_2026_10_21.md) | 否 |
| `npm run verify:chain` | 当前正式 v4 HTTP / MCP 融合整链：表格 / 文档 / 指标、双消费者范围、固定版本、升级与撤销；使用明确的协议夹具，不代表真实模型质量验收 | 否 |
| `npm run verify:scale` | 持久层、发现、文件、查询与来源五组规模门槛；79/79，通过十万行查询原 15 秒上限，见[规模记录](docs/experiment/V030_RELEASE_READINESS.md#本次规模验收) | 否 |

真实 KodaX 在星桥和留出样本上的操作、首答计时、失败重试与未覆盖项另见[本轮验收](docs/experiment/V030_ACCEPTANCE_2026_10_22.md)，不与无模型的协议测试混算。

## 数据存储与边界

- 结构化记录默认复制为快照，保存在本机状态目录下的 `data/`（Parquet，未加密）。每个数据集保留最近 5 个版本，被发布引用的版本不清理；单次快照默认上限 100 万行（`CONTEXT_OS_SNAPSHOT_MAX_ROWS`），超限明确标注不完整。
- 内容和来源覆盖都不变时复用快照；覆盖变化生成新版本。覆盖不完整时检查与发布会提醒，消费结果保持 `complete:false`、`total:null`，不能把保存范围当作全量。间接合并及忽略大小写关联仍可能只形成候选，是否可查询以执行映射为准。
- 文档与知识片段、指标观测，以及用户设为实时读取的数据集仍按需回源读取；发布时标注为非锁定，接入方能看到。
- 程序检查证明的是结构与数据一致性（身份、匹配率、合并），不证明业务含义；业务含义由人或 Agent 核对。
- 设置支持本地管理员、维护者和只读用户，以及用量上限、保留策略、完整备份和恢复。备份不携带可直接使用的外部服务凭据，恢复后按本机凭据库重新连接；已被发布引用的数据不随一般保留清理删除。
- 当前为本地单企业实验：没有远程存储、多租户或记录级权限。已使用虚构公开样本和真实 KodaX 验证场景；商业飞书 / BI 账号与真实生产企业数据未覆盖，完整限制以[本轮验收](docs/experiment/V030_ACCEPTANCE_2026_10_22.md)为准。

## 版本与发布管理

- **包版本号只有一个来源**：`package.json` 的 `version`。开发期间不加 `-dev` 后缀，保持最近一次发布的版本号，未发布内容记在 CHANGELOG 的 `[Unreleased]`。当前开发版本由功能台账和对应设计块标明，不能仅凭包版本判断开发范围。
- **发布步骤**（由用户确认版本号后执行）：同步 `package.json` / `package-lock.json` 和代码中对外报告的版本号 → CHANGELOG 把 `[Unreleased]` 整理成 `[x.y.z] - 日期` → 功能台账填写 `Released` → 本地提交 `chore(release): vx.y.z` → 打附注 Tag `vx.y.z`。
- **Tag 一经发布不移动**；发现问题就发下一个补丁版本。日常开发通过分支和 Pull Request 协作；GitHub Release 由 NoraJing 在[专用工作流](https://github.com/BizAgentOS/context-os/actions/workflows/release.yml)中确认版本标签和完整 SHA 后发布，见[发布指南](docs/RELEASING.md)。这是保留双方写权限的流程门禁，GitHub 网页/API 的直接发布权限仍然保留；线上部署按单独授权执行。
- 完整规则见 [AGENTS.md](AGENTS.md#版本与发布) 与[开发流程](docs/DEVELOPMENT.md)。

## 文档入口

- [文档中心](docs/README.md)：按 Agent 产品职责组织的完整入口，区分当前设计、接入事实与历史。
- [产品需求](docs/PRODUCT.md)与[总体架构](docs/CONTEXT_OS_DESIGN.md)：本体融合价值、用户与系统分工。
- [内部 Agent](docs/AGENT_DESIGN.md)、[KodaX 接入记录](docs/KODAX_CAPABILITY_LEDGER.md)和[运行 Skill](docs/BUILTIN_SKILLS.md)：方法、能力与运行边界。
- [语义契约](docs/SEMANTIC_CONTRACTS.md)、[人机协作](docs/AGENT_UI_DESIGN.md)、[画布](docs/CANVAS_DESIGN.md)、[消费](docs/DATA_CONSUMPTION_DESIGN.md)：同一对象与操作如何服务人和其他 Agent。
- [v0.3.0 设计与任务](docs/features/v0.3.0.md)、[功能台账](docs/FEATURE_LIST.md)、[开发流程](docs/DEVELOPMENT.md)、[Agent 工作约定](AGENTS.md)：当前开发入口、实际状态与开发规则；[0.2.x 设计](docs/features/v0.2.0.md)保留历史。

## 演示与历史能力

以下是既有固定样本与历史验收，和空工作台及 0.2.x 验收分开。

**热力公司演示**（无需模型 API Key）：

```sh
npm ci
npm run demo
```

打开终端给出的管理链接（默认端口 8794）。三页使用正式渲染，填入澄川热力的企业信息、业务资料、本体与对象，右上角标记“演示数据”。输入框提供固定问题；对象与依据由正式只读服务实际查询，不调用模型。演示写入明确返回模拟结果，不保存变更或签发密钥；离线 HTML 同样不包含外部授权。演示状态单独保存在 `local-state/heating-demo`。详见[热力公司演示](docs/experiment/HEATING_DEMO.md)。

**单文件 HTML 演示**：`npm run export:html` 生成 `output/share/Context-OS-热力公司-演示.html`，下载后用浏览器离线打开；使用隔离的虚构样本，不包含当前空间凭据或用户资料。详见[分享说明](docs/experiment/SHARE_HTML.md)。

**在线读取体验**：`npm run live:demo` 启动 8796 端口，两个独立热力源（投诉 API、回访 MCP）按需读取，聊天使用真实 KodaX，见[运行说明](docs/experiment/LIVE_MEMORY.md)。这是 0.1.x 时期的在线读取方式；0.2.1 起结构化来源默认同步为快照。

**Agent 通用能力**：三页 Agent 已接入 KodaX 网页搜索/读取、Skill 加载、通用 MCP 发现与授权调用，以及可信业务 SDK 注册表，开发者视图中的顶部“能力”入口管理配置，见[Agent 能力说明](docs/experiment/AGENT_CAPABILITIES.md)。

**历史验收**：此前三页融合的十八张票（T014-01 至 T016-04）已完成，覆盖统一来源目录、知识与指标取证、概念绑定、多源融合、共同取证、可视化、关系纠正、映射修订、许可消费视图与消费者迁移，验收文档在 `docs/experiment/`，汇总见[整链验收](docs/experiment/FUSION_CHAIN.md)。升级前仍打开旧页面的用户，先导出未发送草稿再重启并导入，见[三页迁移说明](docs/experiment/THREE_PAGE_MIGRATION.md)。

**热力样本与实验室**：澄川热力企业设定与第一批固定来源样本（17 份来源文件、738 条 CSV 记录及 8 份业务文档）；FEATURE_001 完成样本生成、历史回放及 10 题基线，见[生成说明](docs/experiment/GENERATOR.md)、[基线说明](docs/experiment/BASELINE.md)和[首跑结果](docs/experiment/BASELINE_RESULT.md)。检查样本：`python3 scripts/validate_heating_sample.py`（Python 3.9+，可加 `--dataset` 检查生成的数据集）。旧版本地实验室：`python3 scripts/lab_server.py`，打开 <http://127.0.0.1:8787>，见[工作台说明](docs/experiment/LAB.md)。

外层目录中的调研资料和旧方案仅供参考；当前执行范围以本仓库的功能台账和设计文档为准。
