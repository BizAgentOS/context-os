# Agent DataEngine

一个用 Agent 建立、使用和持续维护企业记忆的本地 MVP 项目。

**产品目标：**用户通过 Agent 对话了解企业、接入资料、辅助构建本体并使用企业记忆；底层形成可理解、可计算、可追溯的企业对象，让多个任务与 Agent 复用。

**本次 MVP：**展现并跑通“Agent 建立企业理解 → 接入数据 → 辅助构建本体 → 生成简易报告 → 维护记忆”的完整体验。使用虚构热力企业的小样，全面方法对照和规模验证留到后续。

## 从这里开始

- [产品目标](docs/PRODUCT.md)：产品是什么、解决什么问题、边界在哪里。
- [MVP 目标](docs/MVP.md)：首轮体验、最小范围、验收方式。
- [主 Agent 设计](docs/AGENT_DESIGN.md)：职责、下一步选择、任务与记忆、用户协作、热力对话及完成条件；附 KodaX / NOOA 技术参考。
- [澄川热力公司设定](data/samples/chengchuan-heating/sources/company/company-brief.md)：第一家虚构企业的经营、片区和部门职责。
- [企业数据样本](data/samples/chengchuan-heating/README.md)与 [实验说明](docs/experiment/README.md)：业务资料、公开开发问题和输入边界。
- [执行清单](docs/PLAN.md)：每次完成一个部分，记录真实进度。
- [功能与版本台账](docs/FEATURE_LIST.md)：当前计划版本、功能状态和依赖。
- [v0.1.0 设计与开发步骤](docs/features/v0.1.0.md)：六项功能的设计、开发任务及验收。
- [开发流程](docs/DEVELOPMENT.md)与 [变更日志](docs/CHANGELOG.md)：CodingSkills 使用方式和已发生的变更。

## 当前状态

**目标版本 v0.1.0，开发中，尚未发布。** 已构建澄川热力的企业设定和第一批固定来源样本：1 个热源接入点、2 座换热站、4 个小区、12 栋楼、两周记录。17 份来源文件包含 738 条 CSV 记录及 8 份业务文档。

FEATURE_001 已完成企业样本、可重复生成与历史回放，以及10题原始资料基线。操作见 [生成说明](docs/experiment/GENERATOR.md)和 [基线说明](docs/experiment/BASELINE.md)，实际表现与限制见 [首跑结果](docs/experiment/BASELINE_RESULT.md)。T002-01 正在设计本体建模能力，见 [流程设计草案](docs/experiment/ONTOLOGY_MODELING.md)。此前9类对象及738个实例保留为技术试样，其导入与追溯可运行，业务模型尚未定稿；见 [试样说明](docs/experiment/ONTOLOGY_REVIEW.md)。本地实验室前端与建模同步建设，见[工作台使用说明](docs/experiment/LAB.md)。维护 Agent 和方法对照继续按 [功能台账](docs/FEATURE_LIST.md)推进。

## 工作方式

当前先评审主 Agent 行为规格草案，明确它如何围绕目标查证、操作、提问、保存和结束，再进入实现安排。首轮将围绕一条工作体验接通可核查的产物，再扩展数据量和方法评测。当前页面是浏览型实验室，Agent 主入口、企业初始化、接入及报告体验仍待实现；已有浮窗不算完整 Agent 产品。

检查第一批样本（Python 3.9+，仅标准库）：

```sh
python3 scripts/validate_heating_sample.py
```

它检查来源清单、哈希、记录引用、时间与数量关系；也可用 `--dataset` 检查生成的快照。生成器使用 `scripts/heating_data.py` 的 `generate`、`export`、`diff` 三个命令，完整示例见上述说明。

启动本地实验室（无新增依赖）：

```sh
python3 scripts/lab_server.py
```

打开 http://127.0.0.1:8787。可查看企业来源、建模过程、概念/对象试样与证据，保存步骤笔记，并通过浮窗问答；DeepSeek 凭据沿用服务端 `DEEPSEEK_API_KEY` 环境变量。KodaX 维护 Runtime 仍未接入。

外层目录中的调研资料、星桥软件数据和旧方案保留为参考。本项目当前执行范围以本仓库的产品目标、MVP 目标和执行清单为准，旧方案中的完整平台能力不自动进入本次实验。
