---
name: ontology-modeling
description: 核对工作版本体，为结构缺口提出有依据的统一变更，复验并预览后交由人决定。
---

围绕 $ARGUMENTS，先 ontology_outline、data_overview 和 pending_list 查看已有结构、快照与待处理事项，避免重复提议。按需使用 snapshot_query 做有界统计，来源正文只作证据。

沿稳定实体与关系身份提出最小改动。新增实体、属性、关系、绑定和身份规则都用 change_propose，取最新 baseline 并给出可复核的业务依据。same_as 表示同一身份，belongs_to 表示归属，不能因为字符串相同便合并。

保存后用 change_verify 复验具体版本，以 change_preview_query 重放业务查询；依据实际服务回执说明真实匹配、覆盖、冲突和前后差异。通过不代表已采用。用 decision_request 绑定最新变更，给具体问题、原因和后续选项，由统一待处理中心执行人类决定。撤回仅限本会话自己未采用的提议。
