# 热力公司数据生成与回放

T001-02 的本地实现：一个配置、一个生成/导出脚本，复用原来的校验脚本。只使用 Python 3.9+ 标准库，不需要数据库、模型 API 或服务进程。

## 生成什么

以版本化的两周小样为固定起点，补造客服受理、派单和维修单创建的历史版本，再生成后续监测和少量业务变化。初始站点、楼栋、案例和前两周监测保持固定；历史创建记录是实验构造，不能当作从真实系统恢复出来的日志。

`config/heating.json` 的参数：

| 参数 | 作用 |
|---|---|
| seed | 控制第 15 天起新增气温、流量和水温的轻微随机波动；不改变固定事故故事 |
| days | 从 2026-01-05 起的总天数，14—31；默认 22，即生成到 1 月 27 日 00:00 |
| changes.facts | 是否增加 1 月 19 日的一次接诉、派单、维修与回访 |
| changes.mapping | 是否在 1 月 21 日更换育新站监测标签 |
| changes.rules | 是否发布事件管理制度并增加业务事件登记 |

增加天数总会延长监测和日均气温；facts 开关只控制新增服务案例。企业规模固定为 2 座站、4 个小区。窗口外的事件不写入该次生成历史。同一代码和固定样本版本、配置与种子产生逐字节相同的结果；没有当前系统时间或绝对工作目录混入文件内容。

## 最短运行方式

在产品 Git 根目录执行：

```sh
python3 scripts/heating_data.py generate --config config/heating.json --output data/generated/chengchuan-run-v1
python3 scripts/heating_data.py export --run data/generated/chengchuan-run-v1 --as-of 2026-01-19T00:00:00+08:00 --output data/generated/chengchuan-20260119
python3 scripts/validate_heating_sample.py --dataset data/generated/chengchuan-20260119
```

已有输出目录会被拒绝，避免覆盖资料；再次运行请换一个目录名。每次导出先在临时目录写入并校验，通过后才成为正式输出。初始导出比 T001-01 小样多一张业务用监测接入登记表，方便按有效时间核查标签与站点关系。

## 时间与历史

作者工作目录包含 `run.json` 和 `history.jsonl`：配置、来源定义、数据与文档版本、历史校验和，以及固定样本清单校验和。它包含完整已生成时间范围的资料，不能直接提供给被测 Agent。

导出按 `available_at <= as_of` 筛选，保留每个源系统记录在该时点的最新版本；同一截止时点重导出不会受到之前导出操作影响。业务发生时间仍留在行内。例如维修 09:45 完成、10:00 才录入，在 09:50 导出时维修单仍为未完成状态，现场结论尚不可见。

制度在发布后即可阅读，按其 `effective_at` 判断是否已经生效。导出保留原文日期，不把未来生效制度改写为现行制度。未发布文档和尚未出现的业务表不列入快照清单。

小时监测只导出完整且已可见的小时区间；日均气温在次日 00:00 可见。空表保留已存在系统的列名；缺失采集保留空数值与质量标记。最早支持 1 月 5 日 00:00，最晚为本次配置的生成终点，均包含该时点已可见的信息。

## 三类变化的演示

这是作者侧说明，不属于 Agent 输入。

| 对照时点 | 变化 | 可观察结果 |
|---|---|---|
| 1 月 19 日 → 1 月 20 日 | 普通事实 | 新监测、投诉 CS-022、派单、处理及回访按各自时间出现 |
| 1 月 20 日 → 1 月 22 日 | 来源映射 | 1 月 21 日 00:00 起，YX_RT_V2 对应原育新站；交接文档和接入登记有有效时间，历史标签保留 |
| 1 月 22 日 → 1 月 25 日 | 业务定义 | 1 月 23 日 09:00 发布制度，1 月 24 日生效；24 日 09:00 补登记一条供热事件，关联既有投诉，仍保留待核查状态 |

第三类提供真实的虚构业务依据与新记录。这里只准备材料，尚未抽取或修改本体，也不预设 Agent 必须生成某个唯一 schema。源系统内的事件登记不是实验评分答案。

```sh
python3 scripts/heating_data.py export --run data/generated/chengchuan-run-v1 --as-of 2026-01-20T00:00:00+08:00 --output data/generated/chengchuan-20260120
python3 scripts/heating_data.py export --run data/generated/chengchuan-run-v1 --as-of 2026-01-22T00:00:00+08:00 --output data/generated/chengchuan-20260122
python3 scripts/heating_data.py export --run data/generated/chengchuan-run-v1 --as-of 2026-01-25T00:00:00+08:00 --output data/generated/chengchuan-20260125
python3 scripts/heating_data.py diff --before data/generated/chengchuan-20260119 --after data/generated/chengchuan-20260120 --output data/generated/chengchuan-facts
python3 scripts/heating_data.py diff --before data/generated/chengchuan-20260120 --after data/generated/chengchuan-20260122 --output data/generated/chengchuan-mapping
python3 scripts/heating_data.py diff --before data/generated/chengchuan-20260122 --after data/generated/chengchuan-20260125 --output data/generated/chengchuan-rules
```

变化包包含 `changes.json` 和 `files/` 下新增/改动文件的完整新版本。清单有基准与目标 manifest 哈希、前后时点、新增/修改/删除路径；不包含作者历史或配置。它是文件级增量，不是数据库 CDC。按清单在基准副本删除、替换文件即可重建目标快照；测试会核对重建结果与直接导出的所有文件完全一致。

比较时使用同一次作者运行导出的快照。命令检查输入数据、格式及时间顺序，不会判断不同运行是否用了同一种子。恢复旧资料直接再次导出旧时点，不覆盖现有目录。

## 验收与下一步

```sh
python3 -m unittest discover -s tests -v
python3 -m compileall -q scripts tests
```

CLI 测试覆盖重复生成、种子效果、历史状态、信息可见时间、三类变化开关、制度发布/生效边界、空表/部分日覆盖、文件变化包重建、错误输入及已有目录保护；校验器同时保留固定小样支持，并检查未来记录、源引用、面积与热量关系。

所有生成结果写入 Git 忽略的 `data/generated/`。给 Agent 的材料限于指定导出目录的 `sources/` 与 `manifest.json`；项目代码、配置、作者工作目录、其他时点快照和评分资料都不挂载。文件导出时间过滤已测试；T001-03 的模型工具隔离与真实原始基线见 [基线说明](BASELINE.md)。生成器本身不调用模型。
