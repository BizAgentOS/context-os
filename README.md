# DataEngine

一个基于本体、由 Agent 协助创建企业记忆的本地 MVP 项目。

**产品目标：**创建企业级记忆系统。用户通过输入框说明和修改，页面逐步形成企业信息、数据来源、本体与对象。第三页通过定义关系图、具体对象的局部关联和业务验证检查记忆，后续补资料继续维护。企业记忆持续保留，对话只是创建手段。

**本次 MVP：**四个页面：企业是什么、接入什么资料、如何构建本体与对象、谁通过 API 消费记忆。第四页已实现调用方、明确授权、只读接口、真实访问记录与停用，并完成整条体验验收。采用纯黑白记忆画布，底部对话与输入框作为前景浮层叠放，不提供任务或历史会话管理；报告和更新专页暂不做。用虚构热力企业小样验证链路，全面方法对照与规模验证留到后续。

## 从这里开始

- [产品目标](docs/PRODUCT.md)：产品是什么、解决什么问题、边界在哪里。
- [MVP 目标](docs/MVP.md)：首轮体验、最小范围、验收方式。
- [记忆画布设计](docs/CANVAS_DESIGN.md)：四页目标、对话渐隐、上下文与持久化边界。
- [连接与访问治理](docs/DATA_CONSUMPTION_DESIGN.md)：第四页的调用方、字段/关系权限与实际访问记录。
- [画布运行与验收](docs/experiment/CANVAS.md)：启动、创建企业、接入来源与构建本体。
- [四页维护与业务验证](docs/experiment/MAINTENANCE.md)：文档概念草稿、实际对象验证、资料更新和来源使用限制。
- [第三方 Agent 接入与数据发布](docs/experiment/AGENT_CONNECTION.md)：本地 MCP、HTTP、独立密钥、同连接的数据更新与实际验收。
- [消费链运行与验收](docs/experiment/CONSUMPTION.md)：调用方启用、独立客户端访问、拒绝与停用。
- [历史 Agent 验收](docs/experiment/AGENT.md)：此前模型、对象、报告与维护能力的运行记录。
- [Agent 设计方案](docs/AGENT_BLUEPRINT.md)：组成、身份说明、五种工作方法、上下文、对象工作区及应用接口。
- [Agent 行为与技术依据](docs/AGENT_DESIGN.md)：下一步选择、任务与记忆、用户协作、热力对话及完成条件；附 KodaX / NOOA 技术参考。
- [澄川热力公司设定](data/samples/chengchuan-heating/sources/company/company-brief.md)：第一家虚构企业的经营、片区和部门职责。
- [企业数据样本](data/samples/chengchuan-heating/README.md)与 [实验说明](docs/experiment/README.md)：业务资料、公开开发问题和输入边界。
- [执行清单](docs/PLAN.md)：每次完成一个部分，记录真实进度。
- [功能与版本台账](docs/FEATURE_LIST.md)：当前计划版本、功能状态和依赖。
- [v0.1.0 设计与开发步骤](docs/features/v0.1.0.md)：九项功能的设计、开发任务及验收。
- [开发流程](docs/DEVELOPMENT.md)与 [变更日志](docs/CHANGELOG.md)：CodingSkills 使用方式和已发生的变更。

## 当前状态

**目标版本 v0.1.0，开发中，尚未发布。** 已构建澄川热力的企业设定和第一批固定来源样本：1 个热源接入点、2 座换热站、4 个小区、12 栋楼、两周记录。17 份来源文件包含 738 条 CSV 记录及 8 份业务文档。

FEATURE_001 已完成企业样本、可重复生成与历史回放，以及10题原始资料基线。操作见 [生成说明](docs/experiment/GENERATOR.md)和 [基线说明](docs/experiment/BASELINE.md)，实际表现与限制见 [首跑结果](docs/experiment/BASELINE_RESULT.md)。T002-01 正在设计本体建模能力，见 [流程设计草案](docs/experiment/ONTOLOGY_MODELING.md)。此前9类对象及738个实例保留为技术试样，其导入与追溯可运行，业务模型尚未定稿；见 [试样说明](docs/experiment/ONTOLOGY_REVIEW.md)。本地实验室前端与建模同步建设，见[工作台使用说明](docs/experiment/LAB.md)。维护 Agent 和方法对照继续按 [功能台账](docs/FEATURE_LIST.md)推进。

## 工作方式

底层已接通真实 KodaX SDK、资料保存、本体候选/采用和对象关系查证；当前前端按企业、数据、本体、连接四个记忆画布组织。四页可随时查看和往返；采用本体后才能启用连接。用户在具体授权范围上启用访问，接口按保存的本体与来源版本读取。用户通过对话创建内容，Agent 运行和任务状态留在内部。

先看填好内容的热力公司演示，无需模型 API Key：

```sh
npm ci
npm run demo
```

打开终端给出的管理链接（默认端口 8794）。四页已填入澄川热力的企业信息、业务资料、本体与对象、业务验证和调用方。右上角标记“演示数据”；输入框提供固定的模拟问答。对象读取、证据追溯、编辑与访问限制由本地程序实际执行；没有调用模型，也没有连接真实企业或外部应用。演示状态单独保存在 `local-state/heating-demo`，重启保留修改。详见[热力公司演示](docs/experiment/HEATING_DEMO.md)。

启动 DataEngine（Node.js 22.18+）：

```sh
npm ci
npm start
```

首次打开终端输出的本机管理链接（默认端口 8788），页面会移除地址中的管理凭据片段并建立浏览器管理会话；同一浏览器后续可直接打开 <http://127.0.0.1:8788>。在模型设置中配置模型凭据，或沿用宿主环境变量。管理凭据与消费方 API Key 分开：消费方使用第四页启用时单独交付的密钥，只能访问其明确范围。详情见[画布运行与验收](docs/experiment/CANVAS.md)和[消费链运行与验收](docs/experiment/CONSUMPTION.md)。

`npm run check` 已通过类型检查与 66 项 Agent 测试，包括第三方 MCP 接入与数据版本发布、热力演示、四页维护、文档概念、业务验证与第四页上下文、真实 HTTP 权限检查、访问记录及重启后的停用结果；此前 22 项 Python 回归测试也通过；浏览器与真实模型及两个客户端的历史验收记录单独保存，本次演示入口使用本地模拟问答。

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
