# ADE · Agent Data Engine

本体驱动的通用多源数据底座。把散落在不同系统的数据接进来，构建可溯源、有依据的本体，按版本发布给人和外部 Agent 使用。程序负责构建结构，KodaX Agent 协助接入、解释与修订。投研作为后续验证场景。

## 当前开发：v0.3.0

当前源码正在实现 v0.3.0 的 FEATURE_036—068，范围为分层本体、统一变更与身份治理、构建 / 问答双模式 Agent 和企业数据接入。开发入口见 [v0.3.0 设计与任务](docs/features/v0.3.0.md)及[目标蓝图](docs/features/v0.3.0-blueprint.md)，实际进度以[功能台账](docs/FEATURE_LIST.md)为准；最近完成的 041 / 042 见[统一变更验收](docs/experiment/V030_041_2026_10_21.md)和[关系与身份验收](docs/experiment/V030_042_2026_10_21.md)。

v0.3.0 尚未发布。按仓库版本规则，`package.json` 和最新 Git Tag 保留最近发布的 v0.2.3，当前源码包含其后的 v0.3.0 开发改动。

## 已发布版本

| 版本 | 日期 | 提交 / Tag | 内容 |
|---|---|---|---|
| **0.2.3**（最近发布） | 2026-10-16 | Tag `v0.2.3` | 基础本体改由规则构建、Agent 只修正；本体页按程序发现结果展示；修复替换 CSV 后重建失败。发布当时 228 项测试通过、14 项旧流程测试暂跳过，后续处理见 [ISSUES](docs/ISSUES.md) |
| 0.2.2 | 2026-10-15 | Tag `v0.2.2` | 修复快照保留、来源覆盖、旧发布接入、同名字段及日期原值等 7 项问题；231 项测试与整链验收通过 |
| 0.2.1 | 2026-10-15 | Tag `v0.2.1` | 移植 Helix 快照底座：全量快照、全量本体发现与检查、发布锁定数据（FEATURE_031—035）及后续修复 |
| 0.2.0 | 2026-10-14 | `930b10e` / Tag `v0.2.0` | 数据 · 本体 · 发布与接入三页工作台（FEATURE_025—030） |

版本只在本地 Git 发布，仓库没有配置远程。完整变更见 [CHANGELOG](docs/CHANGELOG.md)，功能状态见[功能台账](docs/FEATURE_LIST.md)，版本规则见下方[版本与发布管理](#版本与发布管理)。

## 三个页面

- **数据**：接入文件、HTTP API 与 MCP 来源；把结构化记录同步为不可变快照，查看行数、字段画像与样本；来源字段结构变化时列出逐字段差异，确认后才生效；可把单个数据集改为实时读取。
- **本体**：程序基于快照生成独立实体初稿与关系、身份等提议；结构变化经统一流程提议、复验并明确采用或拒绝，保留记录级身份决定和历史工作版。首次独立实体与同结构重绑适用有界自动采用规则。
- **发布与接入**：发布固定工作版、本体、映射、来源快照与已采用的治理决定；发布与升级前显示定义差异和行级数据差异；为接入方选择范围、签发密钥、显式升级或撤销；可单独开启受限的 ADE Agent 委托。

本体构建方法移植自 Helix Foundry（Apache-2.0），许可与逐文件修改记录见[第三方说明](third_party/helix-foundry/MODIFICATIONS.md)，设计决定见 [ADR-004](docs/ADR/ADR-004-managed-snapshots-and-pinned-releases.md)。

## 快速开始

需要 Node.js 22.18+。

```sh
npm ci
npm start
```

打开终端输出的本机管理链接（默认端口 8788）。页面会移除地址中的管理凭据片段并建立浏览器管理会话，之后同一浏览器可直接打开 <http://127.0.0.1:8788>。新空间先进入初始化，存量企业可从“完善初始化”重新进入，见[冷启动使用与验收](docs/experiment/ENTERPRISE_ONBOARDING.md)。结构化来源的首轮构建不需要模型。

**模型配置**：在模型设置中配置凭据，或沿用宿主环境变量。页面保存的模型密钥写入本机独立受限凭据文件，跨刷新和重启保留，可主动删除。GLM 可选“智谱 GLM · 普通 API”“智谱 GLM · Coding Plan”或“Z.ai GLM · Coding Plan”，分别使用 `ZHIPU_API_KEY`、`ZHIPU_CODING_API_KEY`、`ZAI_CODING_API_KEY`；也可选“自定义 API”填写 OpenAI/Anthropic 兼容 Base URL、模型 ID 和密钥，见[自定义接口说明](docs/experiment/CUSTOM_MODEL_API.md)。

**凭据分开**：管理凭据只用于本机管理；接入方使用第三页签发的独立密钥，只能访问其授权范围，升级会撤销旧密钥。

## 验证

| 命令 | 内容 | 是否调用模型 |
|---|---|---|
| `npm run check` | 类型检查与全部 Agent 测试；最近一次 v0.3.0 验收见 [042 记录](docs/experiment/V030_042_2026_10_21.md) | 否 |
| `npm run verify:snapshots` | 经 HTTP 接口走完快照整链：同步 → 独立实体构建 → 明确采用身份与关系 → 发布 → 来源更新与字段类型变化 → 再发布 → 升级 → 撤销，见[验收](docs/experiment/V030_042_2026_10_21.md) | 否 |
| `npm run verify:chain -- --real` | 真实模型、双消费者的历史融合整链，见[整链验收](docs/experiment/FUSION_CHAIN.md) | 是，会产生费用 |

## 数据存储与边界

- 结构化记录默认复制为快照，保存在本机状态目录下的 `data/`（Parquet，未加密）。每个数据集保留最近 5 个版本，被发布引用的版本不清理；单次快照默认上限 100 万行（`ADE_SNAPSHOT_MAX_ROWS`），超限明确标注不完整。
- 内容和来源覆盖都不变时复用快照；覆盖变化生成新版本。覆盖不完整时检查与发布会提醒，消费结果保持 `complete:false`、`total:null`，不能把保存范围当作全量。间接合并及忽略大小写关联仍可能只形成候选，是否可查询以执行映射为准。
- 文档与知识片段、指标观测，以及用户设为实时读取的数据集仍按需回源读取；发布时标注为非锁定，接入方能看到。
- 程序检查证明的是结构与数据一致性（身份、匹配率、合并），不证明业务含义；业务含义由人或 Agent 核对。
- 当前为本地单企业实验：没有远程存储、多租户或记录级权限，尚未用真实业务数据和真实模型做场景验证。完整限制见[验收文档](docs/experiment/ENGINE_WORKBENCH.md)。

## 版本与发布管理

- **包版本号只有一个来源**：`package.json` 的 `version`。开发期间不加 `-dev` 后缀，保持最近一次发布的版本号，未发布内容记在 CHANGELOG 的 `[Unreleased]`。当前开发版本由功能台账和对应设计块标明，不能仅凭包版本判断开发范围。
- **发布步骤**（由用户确认版本号后执行）：同步 `package.json` / `package-lock.json` 和代码中对外报告的版本号 → CHANGELOG 把 `[Unreleased]` 整理成 `[x.y.z] - 日期` → 功能台账填写 `Released` → 本地提交 `chore(release): vx.y.z` → 打附注 Tag `vx.y.z`。
- **Tag 一经发布不移动**；发现问题就发下一个补丁版本。推送远程和 GitHub Release 需用户另行确认。
- 完整规则见 [AGENTS.md](AGENTS.md#版本与发布) 与[开发流程](docs/DEVELOPMENT.md)。

## 文档入口

- [文档中心](docs/README.md)：按 Agent 产品职责组织的完整入口，区分当前设计、接入事实与历史。
- [产品需求](docs/PRODUCT.md)与[总体架构](docs/DATA_ENGINE_DESIGN.md)：本体融合价值、用户与系统分工。
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

打开终端给出的管理链接（默认端口 8794）。三页已填入澄川热力的企业信息、业务资料、本体与对象和业务验证，右上角标记“演示数据”，输入框提供固定的模拟问答；对象读取、证据追溯、编辑与访问限制由本地程序实际执行，不调用模型。演示状态单独保存在 `local-state/heating-demo`；新演示不预建外部调用方，接入需走正式发布流程。详见[热力公司演示](docs/experiment/HEATING_DEMO.md)。

**单文件 HTML 演示**：`npm run export:html` 生成 `output/share/DataEngine-热力公司-演示.html`，下载后用浏览器离线打开；使用隔离的虚构样本，不包含当前空间凭据或用户资料。详见[分享说明](docs/experiment/SHARE_HTML.md)。

**在线读取体验**：`npm run live:demo` 启动 8796 端口，两个独立热力源（投诉 API、回访 MCP）按需读取，聊天使用真实 KodaX，见[运行说明](docs/experiment/LIVE_MEMORY.md)。这是 0.1.x 时期的在线读取方式；0.2.1 起结构化来源默认同步为快照。

**Agent 通用能力**：三页 Agent 已接入 KodaX 网页搜索/读取、Skill 加载、通用 MCP 发现与授权调用，以及可信业务 SDK 注册表，开发者视图中的顶部“能力”入口管理配置，见[Agent 能力说明](docs/experiment/AGENT_CAPABILITIES.md)。

**历史验收**：此前三页融合的十八张票（T014-01 至 T016-04）已完成，覆盖统一来源目录、知识与指标取证、概念绑定、多源融合、共同取证、可视化、关系纠正、映射修订、许可消费视图与消费者迁移，验收文档在 `docs/experiment/`，汇总见[整链验收](docs/experiment/FUSION_CHAIN.md)。升级前仍打开旧页面的用户，先导出未发送草稿再重启并导入，见[三页迁移说明](docs/experiment/THREE_PAGE_MIGRATION.md)。

**热力样本与实验室**：澄川热力企业设定与第一批固定来源样本（17 份来源文件、738 条 CSV 记录及 8 份业务文档）；FEATURE_001 完成样本生成、历史回放及 10 题基线，见[生成说明](docs/experiment/GENERATOR.md)、[基线说明](docs/experiment/BASELINE.md)和[首跑结果](docs/experiment/BASELINE_RESULT.md)。检查样本：`python3 scripts/validate_heating_sample.py`（Python 3.9+，可加 `--dataset` 检查生成的数据集）。旧版本地实验室：`python3 scripts/lab_server.py`，打开 <http://127.0.0.1:8787>，见[工作台说明](docs/experiment/LAB.md)。

外层目录中的调研资料和旧方案仅供参考；当前执行范围以本仓库的功能台账和设计文档为准。
