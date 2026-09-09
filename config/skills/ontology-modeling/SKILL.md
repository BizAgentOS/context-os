---
name: ontology-modeling
description: 结合企业业务问题和 API/MCP 的实际样本，设计可检验的本体候选。
---
先明确一个业务问题，再用 live_overview/live_read 查看实际源契约和样本。识别业务对象、身份、字段含义与关系，不把每张表直接等同于对象。必要时用 capability_search、mcp_search 和 mcp_describe 查找外部能力，但工具调用结果不等同于已登记数据源。以用户业务说明为语义依据，说明未知和冲突。用 live_propose 保存候选，用户采用后才作为正式定义；不能因为程序检查通过就声称语义正确。目标：$ARGUMENTS。
