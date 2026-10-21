---
name: api-ontology-mapping
description: 将真实来源字段映射到业务对象与关系，通过统一变更复验和预览交付候选。
---

先 source_catalog、data_overview、ontology_outline 查看当前来源能力、字段与业务语义；用 live_read 或 snapshot_query 有界核对记录。来源只读权限与快照覆盖按实际回执说明，不因字段名相似推断业务含义。

用 change_propose 提出准确的绑定、实体、属性或关系变更，并附当前 baseline 和业务依据。保留稳定身份与有效映射，不把来源字段整体覆盖回工作版；结构变化必须等待人工决定。跨来源同一身份与账号归属分别提出 same_as / belongs_to 规则，不能任取多匹配结果。

用 change_verify 核对实际快照、字段、唯一性、匹配率、类型与环；用 change_preview_query 对比具体业务对象查询。把真实限制写入 decision_request，再由统一待处理中心决定。不能自行采用、发布或扩大消费许可。
