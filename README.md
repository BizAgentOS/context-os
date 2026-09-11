# DataEngine

一个通过本体统一多源数据的概念、身份和关系，由 Agent 协助构建与治理的本地 MVP 项目。

**设计起点：**先建立 AI 可理解、可操作的企业本体与对象契约，再提供人类查看、查询和治理的前端。人类前端、内部治理 Agent 与外部消费 Agent 使用同源语义和操作服务，各自按身份取得能力。当前系统分工见[总体架构](docs/DATA_ENGINE_DESIGN.md)；这是后续设计基线，不代表所有契约已实现。

**2026-09-11 开发目标：**本体驱动的数据融合与语义打通，页面调整为“企业与数据 · 本体工作区 · 消费与治理”。第一页面向基础本体 Skill 和来源接入，第二页可视化理解融合并修订，第三页提供受控 API/MCP 与消费治理。沿用原样式，计划与十八张任务见[三页产品计划](docs/THREE_PAGE_PLAN.md)；FEATURE_012 已实现三页、存量迁移与在线本体工作上下文，基础本体 Skill 和融合继续按票开发。

**数据接入原则：**来源侧通过 API 或 MCP 连接企业原系统，数据按授权按需读取；DataEngine 保存企业理解、本体、映射与引用。消费侧向第三方提供本体数据接口，两者方向和权限分别管理。已实现 HTTP GET / MCP Streamable HTTP 记录源和按需对象查询；文档/BI 语义、同实体多源融合与细粒度证据列入新计划，旧文件链保留。

**当前可运行基线：**三个页面，复用已有企业、来源、本体和消费能力。采用纯黑白画布、前景对话与输入浮层，不提供任务或历史会话管理。下方运行命令启动三页；完整融合范围以[当前 MVP](docs/MVP.md)与功能台账为准。

## 连接源系统的实际版本

`npm run live:demo` 启动 **8796** 体验：两个独立热力源（投诉 API、回访 MCP）、实际本体映射、第三方只读访问。源记录修改后，下一次查询能读到变化，数据不整体导入本地。首次候选由用户采用，聊天使用真实 KodaX。完整配置、验证及限制见[运行说明](docs/experiment/LIVE_MEMORY.md)。

## 从这里开始

- [文档中心](docs/README.md)：按 Agent 产品职责组织的完整入口，区分当前设计、接入事实与历史。
- [产品需求](docs/PRODUCT.md)与[总体架构](docs/DATA_ENGINE_DESIGN.md)：本体融合价值、用户与系统分工。
- [内部 Agent](docs/AGENT_DESIGN.md)、[KodaX 接入记录](docs/KODAX_CAPABILITY_LEDGER.md)和[运行 Skill](docs/BUILTIN_SKILLS.md)：方法、能力与运行边界。
- [语义契约](docs/SEMANTIC_CONTRACTS.md)、[人机协作](docs/AGENT_UI_DESIGN.md)、[画布](docs/CANVAS_DESIGN.md)、[消费](docs/DATA_CONSUMPTION_DESIGN.md)：同一对象与操作如何服务人和其他 Agent。
- [三页实施计划](docs/THREE_PAGE_PLAN.md)、[MVP](docs/MVP.md)与[开发任务](docs/features/v0.1.0.md#feature-012)：范围、迁移、18 张票和验收。
- [功能台账](docs/FEATURE_LIST.md)、[开发流程](docs/DEVELOPMENT.md)、[Agent 工作约定](AGENTS.md)：实际状态与开发规则。
- [当前在线运行](docs/experiment/LIVE_MEMORY.md)、[通用能力](docs/experiment/AGENT_CAPABILITIES.md)、[历史设计](docs/archive/README.md)：现有命令、验证与参考。

## 当前状态

升级前仍打开旧页面的用户，先导出未发送草稿，再重启并导入；方法与边界见[三页迁移说明](docs/experiment/THREE_PAGE_MIGRATION.md)。

**下一项：T014-02（BI 指标语义接入）。** T014-01 已接入统一来源目录与 HTTP/MCP 知识文档查询、分段取证和原文定位，真实 KodaX 可据此补充同一基础本体，见[知识来源验收](docs/experiment/KNOWLEDGE_SOURCES.md)。以下保留旧四页与样本能力的实际档案，不作为新任务优先级。

**目标版本 v0.1.0，开发中，尚未发布。** 已构建澄川热力的企业设定和第一批固定来源样本：1 个热源接入点、2 座换热站、4 个小区、12 栋楼、两周记录。17 份来源文件包含 738 条 CSV 记录及 8 份业务文档。

FEATURE_001 已完成企业样本、可重复生成与历史回放，以及10题原始资料基线。操作见 [生成说明](docs/experiment/GENERATOR.md)和 [基线说明](docs/experiment/BASELINE.md)，实际表现与限制见 [首跑结果](docs/experiment/BASELINE_RESULT.md)。T002-01 的早期建模方案见 [流程设计草案](docs/experiment/ONTOLOGY_MODELING.md)，当前任务顺序以三页实施计划为准。此前9类对象及738个实例保留为技术试样，其导入与追溯可运行，业务模型尚未定稿；见 [试样说明](docs/experiment/ONTOLOGY_REVIEW.md)。本地实验室前端与建模同步建设，见[工作台使用说明](docs/experiment/LAB.md)。维护 Agent 和方法对照继续按 [功能台账](docs/FEATURE_LIST.md)推进。

## 工作方式

底层已接通真实 KodaX SDK、资料保存、本体候选/采用和对象关系查证；当前前端按企业与数据、本体工作区、消费与治理三个画布组织。三页可随时查看和往返；采用本体后才能启用连接。用户在具体授权范围上启用访问，接口按保存的本体与来源版本读取。用户通过对话创建内容，Agent 运行和任务状态留在内部。

先看填好内容的热力公司演示，无需模型 API Key：

```sh
npm ci
npm run demo
```

生成可发给他人的单文件 HTML 演示：

```sh
npm run export:html
```

文件位于 `output/share/DataEngine-热力公司-演示.html`，下载后用浏览器打开即可。企业、资料、本体关系与连接范围都可离线查看；示例问答为本地演示，不连接模型或服务端。导出使用隔离的虚构热力样本，不包含当前空间凭据或用户新增资料。详见[分享说明](docs/experiment/SHARE_HTML.md)。

打开终端给出的管理链接（默认端口 8794）。三页已填入澄川热力的企业信息、业务资料、本体与对象、业务验证和调用方。右上角标记“演示数据”；输入框提供固定的模拟问答。对象读取、证据追溯、编辑与访问限制由本地程序实际执行；没有调用模型，也没有连接真实企业或外部应用。演示状态单独保存在 `local-state/heating-demo`，重启保留修改。详见[热力公司演示](docs/experiment/HEATING_DEMO.md)。

启动 DataEngine（Node.js 22.18+）：

```sh
npm ci
npm start
```

首次打开终端输出的本机管理链接（默认端口 8788），页面会移除地址中的管理凭据片段并建立浏览器管理会话；同一浏览器后续可直接打开 <http://127.0.0.1:8788>。在模型设置中配置模型凭据，或沿用宿主环境变量。管理凭据与消费方 API Key 分开：消费方使用第三页启用时单独交付的密钥，只能访问其明确范围。详情见[画布运行与验收](docs/experiment/CANVAS.md)和[消费链运行与验收](docs/experiment/CONSUMPTION.md)。

`npm run check` 已通过类型检查与 85 项 Agent 测试，包括第三方 MCP 接入与数据版本发布、热力演示、三页与存量迁移、文档概念、业务验证与消费页上下文、真实 HTTP 权限检查、访问记录及重启后的停用结果；此前 22 项 Python 回归测试也通过；浏览器与真实模型及两个客户端的历史验收记录单独保存，本次演示入口使用本地模拟问答。

检查第一批样本（Python 3.9+，仅标准库）：

```sh
python3 scripts/validate_heating_sample.py
```

它检查来源清单、哈希、记录引用、时间与数量关系；也可用 `--dataset` 检查生成的快照。生成器使用 `scripts/heating_data.py` 的 `generate`、`export`、`diff` 三个命令，完整示例见上述说明。

启动本地实验室（无新增依赖）：

```sh
python3 scripts/lab_server.py
```

打开 http://127.0.0.1:8787。可查看企业来源、建模过程、概念/对象试样与证据，保存步骤笔记，并通过浮窗问答；DeepSeek 凭据沿用服务端 `DEEPSEEK_API_KEY` 环境变量。此 8787 页面保留为旧浏览入口；企业记忆画布使用上面的 8788 入口。

外层目录中的调研资料、星桥软件数据和旧方案保留为参考。本项目当前执行范围以本仓库的产品目标、MVP 目标和执行清单为准，旧方案中的完整平台能力不自动进入本次实验。

### Agent 通用能力

三页 Agent 已接入 KodaX 网页搜索/读取、Skill 加载、通用 MCP 发现与授权调用，以及可信业务 SDK 注册表。顶部“能力”管理配置。当前业务 SDK 示例为 Octokit 公开仓库查询；详细边界、体验方法和真实验证见[Agent 能力说明](docs/experiment/AGENT_CAPABILITIES.md)。
