# Agent DataEngine

一个用于验证企业数据组织与动态本体维护方法的本地实验项目。

**产品目标：**把分散的企业数据加工为可理解、可计算、可追溯的企业对象，让多个 Agent 复用；使用内部 Agent 辅助维护数据语义与本体。

**本次 MVP：**用一个虚构企业，跑通数据、本体、维护 Agent、简单前端和外部消费对照，判断这个方法是否有效、在哪些问题上值得采用。

## 从这里开始

- [产品目标](docs/PRODUCT.md)：产品是什么、解决什么问题、边界在哪里。
- [MVP 目标](docs/MVP.md)：实验假设、最小范围、验收方式。
- [澄川热力公司设定](data/samples/chengchuan-heating/sources/company/company-brief.md)：第一家虚构企业的经营、片区和部门职责。
- [企业数据样本](data/samples/chengchuan-heating/README.md)与 [实验说明](docs/experiment/README.md)：业务资料、公开开发问题和输入边界。
- [执行清单](docs/PLAN.md)：每次完成一个部分，记录真实进度。
- [功能与版本台账](docs/FEATURE_LIST.md)：当前计划版本、功能状态和依赖。
- [v0.1.0 设计与开发步骤](docs/features/v0.1.0.md)：六项功能的设计、开发任务及验收。
- [开发流程](docs/DEVELOPMENT.md)与 [变更日志](docs/CHANGELOG.md)：CodingSkills 使用方式和已发生的变更。

## 当前状态

**目标版本 v0.1.0，开发中，尚未发布。** 已构建澄川热力的企业设定和第一批固定来源样本：1 个热源接入点、2 座换热站、4 个小区、12 栋楼、两周记录。17 份来源文件包含 738 条 CSV 记录及 8 份业务文档。

FEATURE_001 已完成企业样本、可重复生成与历史回放，以及10题原始资料基线。操作见 [生成说明](docs/experiment/GENERATOR.md)和 [基线说明](docs/experiment/BASELINE.md)，实际表现与限制见 [首跑结果](docs/experiment/BASELINE_RESULT.md)。T002-01 已生成9类本体候选及738个可追溯对象预览，待用户确认后保存正式v1；见 [确认摘要](docs/experiment/ONTOLOGY_REVIEW.md)与 [对象使用说明](docs/experiment/ONTOLOGY.md)。维护 Agent、前端和方法对照继续按 [功能台账](docs/FEATURE_LIST.md)推进。

## 工作方式

先做小规模可核查样本，逐步接通完整链路，再扩展数据量和评测。采用能完成实验的简单实现，遇到实际需要时再增加组件。

检查第一批样本（Python 3.9+，仅标准库）：

```sh
python3 scripts/validate_heating_sample.py
```

它检查来源清单、哈希、记录引用、时间与数量关系；也可用 `--dataset` 检查生成的快照。生成器使用 `scripts/heating_data.py` 的 `generate`、`export`、`diff` 三个命令，完整示例见上述说明；当前没有应用服务进程。

外层目录中的调研资料、星桥软件数据和旧方案保留为参考。本项目当前执行范围以本仓库的产品目标、MVP 目标和执行清单为准，旧方案中的完整平台能力不自动进入本次实验。
