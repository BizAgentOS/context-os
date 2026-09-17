---
name: api-ontology-mapping
description: 将真实 API 字段与样本绑定到已有基础概念，核对关系端点、稳定身份和完整映射；仅在宿主自动构建授权下直接生效。
---

## API 自动构建模式

宿主输入 `mode: automatic-api-ontology` 时，用户已授权自动保存并采用映射，无需确认。本模式只执行下面流程，跳过其余对话、网页、知识与消费流程：

1. 并行读取 foundation_read 与 live_overview，再用 foundation_api_read 读取本次连接每个 records 能力；一次最多 3 条实际样本。
2. 已有对应概念时直接复用，**不调用 foundation_propose**。需要新增概念或基础关系才用 API readId 与原文引文补充并读取实际采用回执。`rebindOnly: true` 时禁止修改基础定义。
3. live_propose 的 types 每项使用现有 conceptId，**name、description 逐字复制基础概念**；fields 是 `{业务属性名: 实际源字段名}`，`$id` 由来源 idField 提供。完整保留已有执行映射。
4. **执行关系的 from/to 必须填写 types 的 name（中文业务名称），不能填基础概念 ID。** relationId 是基础关系 id，name 是基础关系 name。根据基础关系 from/to 的概念 ID 找到 types 中对应项，再取其 name。fromField/toField 必须填写映射后的业务属性名或 `$id`，不能直接填尚未映射的物理列。举例：基础关系 from=`sale`, to=`store`，执行类型 name 为「销售」「门店」，则执行关系 from=`销售`, to=`门店`，而非 `sale`/`store`。方向逐字遵循基础关系，不能反转后还复用相同 relationId。缺少实际键或目标过滤能力时不绑定该关系，基础层保留未映射关系。
5. foundationRef 使用当前已采用基础版本，baseModelRef 为最新已采用执行模型引用或 null。记录金额单位、统计期间等真实口径。简短说明即可，尽快提交 live_propose，不先输出长篇分析或完整参数文本。工具返回错误时按错误修正再调用；保存成功即结束，由宿主复检并自动采用。

不得编造记录或关联；附来源必须有实际唯一匹配；不自动发布或授权外部消费者。
