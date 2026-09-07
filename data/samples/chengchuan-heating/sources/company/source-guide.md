# 部门资料目录与字段说明

- source_id: COMP-SOURCES-001
- owner: 运行调度、客户服务
- published_at / available_at: 2026-01-18T20:00:00+08:00
- status: approved
- approved_by: 运行主管、客服负责人

## 去哪里找记录

| 部门资料 | 文件 | 含义 |
|---|---|---|
| 设施台账 | assets/stations.csv、buildings.csv、equipment.csv | 站点、楼栋和设备登记；设施编号在台账内使用 |
| 运行监测 | monitoring/station-hourly.csv | 按监测站点标签导出的小时记录 |
| 气象资料 | monitoring/weather-daily.csv | 北城观测点日均室外气温 |
| 监测接入交接 | monitoring/handover-note.md | 控制柜标签、站点位置、记录区间与质量含义 |
| 客服资料 | service/tickets.csv、callbacks.csv、room-measurements.csv | 接诉、回访和入户测温，分别保留各自单号和时间 |
| 客服地址说明 | service/address-book-note.md | 来电原始地址与物业正式命名的说明 |
| 维修资料 | maintenance/work-orders.csv | 派单、地点、设备、现场检查及完成记录 |
| 值班与讨论 | operations/ 下的文档 | 当班观察、采集缺失说明和未审批的讨论 |

## 字段口径

`available_at` 为该行版本或文档在导出系统内可见的时间。`opened_at`、`closed_at`、`completed_at`、`called_at`、`measured_at` 分别表示对应行为发生时间；不使用文件名或行顺序代替行为时间。`status_as_of_snapshot` 为本次导出时的状态。

设施登记的 `supplied_area_m2` / `service_area_m2` 在本片区均按台账服务楼栋的建筑面积填写，单位平方米，不能直接作为收费或故障影响面积。`contract_households` 是楼栋合同户数，不是本次实测户数。

监测列 `secondary_supply_c` / `secondary_return_c` 为二次侧供回水温度（℃）；`secondary_flow_m3_h` 为二次侧流量（m³/h）；`secondary_supply_mpa` / `secondary_return_mpa` 为二次侧供回水压力（MPa）；`interval_heat_gj` 为小时区间热量（GJ）。`quality` 取 `ok` 或 `missing`，缺失时数值为空。

`outdoor_mean_c` 是当日日均室外气温（℃），次日完成记录；它不能说明小时级气温变化。`indoor_c` 是指定住户与测量位置的室温（℃）；测温未覆盖的住户不产生推算值。

回访 `result` 中 `improved` 为明确改善，`not_improved` 为明确未改善，`unreachable` 为未接通，`uncertain` 为其他/不确定；同一投诉的不同回访单分别保留。各指标按 COMP-RULES-001 计算。

## 信息冲突如何处理

设施登记查台账，站内工况查对应时间的监测和现场记录，户内情况查测温与居民反馈，统计定义查已批准且生效的规则。不同记录各有适用范围；没有一个系统在所有问题上都优先。未经审批的讨论可用于发现分歧，不能替代正式规则。
