# 原始资料基线实验

T001-03 使用一个 Python 脚本调用模型，通过受限数据工具回答热力公司的问题。只依赖标准库；没有新服务、向量库、本体或多 Agent 编排。这里的基线 Agent 是每题独立的模型工具调用循环，后续 KodaX 维护 Agent 仍在 FEATURE_003 实现。

## 实验冻结

首轮共 10 题：5 道公开开发题、5 道留出题。开发题在 `config/evaluation/development.json`；留出题、预期字段和人工评分依据保存在本地忽略目录 `data/private/chengchuan-heating/evaluation/`。留出题在冻结后运行，首跑前不用于调试或修改提示词。

`config/evaluation/freeze.json` 记录题目、私有答案、评分依据、系统提示、预算及实现文件的 SHA256，并记录两个数据时点的 manifest 哈希。模型只收到当前问题、时点、来源导航和工具输出，不收到整套题、划分标签、答案或评分依据。每道题新建会话和内存数据连接，不继承前题内容。

留出指题面未用于调试，不代表独立企业样本。10 题的正确率只描述这个小案例，不构成统计显著或泛化结论。冻结后的代码或题目变更会使入口拒绝继续运行，应建立另一个明确记录的实验版本，不能覆盖已有首跑记录。

## 模型和预算

模型使用 `deepseek-v4-flash`，已通过官方模型列表核实可用。接口采用 [DeepSeek 官方 Chat Completions 协议](https://api-docs.deepseek.com/)，凭据仅从环境变量 `DEEPSEEK_API_KEY` 读取。

预算在 `config/evaluation/raw-budget.json`：每题最多 12 轮，每轮最多 2,400 个输出 Token，temperature 为 0，关闭 thinking；每次请求超时 45 秒，每题循环时间预算 240 秒。只发起单轮请求，不自动重试失败或追加纠错运行。输入量通过读取/搜索/SQL 返回上限控制；没有声称硬性限制总 Token。网络超时按 HTTP 客户端语义执行，耗时以实际测量记录。

保存 API 返回的 prompt/completion Token 用量、实际模型字段、响应、工具请求与结果、结束状态和耗时。供应商可能更新模型别名；请求参数固定不保证模型生成逐字节可复现。无法获得用量时明确标记缺失或不完整，不能将超时误报为零成本成功。

## 模型能访问什么

脚本按题目时点从作者历史导出快照，核对冻结哈希及源数据，然后仅将清单里的来源加载到内存。Agent 工具包括：

| 工具 | 能力与限制 |
|---|---|
| list | 查看当前来源 ID、路径、原始列名及 CSV 对应临时表名 |
| read | 只读当前清单内的来源；每页最多 12,000 字符，可继续分页 |
| search | 对来源做字面搜索；最多 40 行，显式标记截断 |
| sql | 对每张原始 CSV 对应的内存表做只读筛选、关联和计算；最多 100 行、16,000 字符；超时中断 |

一张 CSV 原样装入一张临时表，所有字段保持 TEXT，不预先清洗、对齐身份、添加全局对象或封装业务函数。SQL 是通用计算工具，后续专用表/本体组仍须使用相同原始信息。模型自行查规则和证据、选择连接方式；数字计算由 SQL 执行。

工具没有 shell、任意 Python 执行、宿主文件读取或网络调用。SQL authorizer 只允许读取与列明的计算函数，拒绝 ATTACH、PRAGMA、扩展、写入和递归查询。来源读入后只访问内存副本，拒绝符号链接。源文档里的指令无法增加工具权限。

这是模型工具能力的隔离；本地评测进程仍受信任并能读取作者历史与私有评分文件，不声称它是通用操作系统沙箱。隔离测试覆盖绝对路径、目录穿越、未来文档、未知工具、数据库外连/写入、符号链接和私有字段不进入模型请求。

## 运行方法

在产品 Git 根目录运行。先按 [生成说明](GENERATOR.md) 创建 `data/generated/chengchuan-run-v1`。已有冻结文件直接使用；不要重复执行 freeze 或覆盖原实验。

```sh
python3 scripts/raw_baseline.py run --author-run data/generated/chengchuan-run-v1 --suite development --output runs/raw-baseline-v1-development
python3 scripts/raw_baseline.py score --author-run data/generated/chengchuan-run-v1 --output runs/raw-baseline-v1-development
python3 scripts/raw_baseline.py run --author-run data/generated/chengchuan-run-v1 --suite holdout --output runs/raw-baseline-v1-holdout
python3 scripts/raw_baseline.py score --author-run data/generated/chengchuan-run-v1 --output runs/raw-baseline-v1-holdout
```

每次 run 必须使用新输出目录；每题完成即保存，包括失败。复跑请改目录名，报告时保留尝试次数，不用最好的一次覆盖首次表现。私有材料不随 Git 发布：新机器只有代码和开发题，需要实验保管者提供与冻结哈希匹配的私有文件后才能复现完整实验。freeze 命令仅用于首次建立冻结清单，当前仓库已完成。

## 如何评分

模型最终返回中文答案、题目所要求的 claims 字段与原文引文。自动评分分别检查字段值是否符合冻结预期、引文是否确实存在于该时点来源。不用另一个模型猜测正确率。

原文存在不意味着能支撑结论。必须另行复核推理、来源范围、实际 SQL 计算和口径；尤其不能把办结当成恢复、把重复回访算成不同投诉或使用未公开的未来资料。本次由开发助手逐题复核，记录放在运行目录；独立业务人员人工复核尚未进行。汇总报告只发布数量和限制，不公开留出题答案。自动字段、原文引文和本次证据复核分别报告，不把助手复核标作人工评分。首跑结果见 [结果记录](BASELINE_RESULT.md)。

```sh
python3 -m unittest discover -s tests -v
python3 -m compileall -q scripts tests
```

测试里的脚本化模型响应只用于验证工具循环与失败处理，不计为实际模型基线。真实调用的结果另外保存，模型失败不等同于脚本未实现。
