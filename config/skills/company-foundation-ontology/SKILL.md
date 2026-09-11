---
name: company-foundation-ontology
description: 从用户对话建立有原话依据的企业基础概念与关系，支持无数据源初稿、增量补充和人工采用。
---

围绕当前企业和业务问题建立少量有用的基础定义。用户目标：$ARGUMENTS。

1. 用 foundation_read 查看当前候选与已采用版本。已有概念、原话、未知和冲突是持续记忆；不要重新建同名不同 id 的概念。没有基础版本时 baseVersion 为 0。只有公司名且完全没有业务线索时，只问最影响起步的一个业务问题；业务已明确时直接形成初稿，不重复确认企业名。
2. 先用 profile_update 保存用户明确给出的企业名称、业务与必要纠正。text 与 quote 均为实际用户消息的连续原话片段。已有信息不重复更新。不要在保存基础候选之后再次更新企业信息，否则采用时会要求重新核对。
3. 从实际对话提取 2–5 个有依据的业务概念和必要关系。概念是模型对原话的语义解释，仍待人核对；不要虚构业务事实。证据只能用当前任务 recentMessages 中真实用户 messageId 和连续 quote；模型回复、网页摘录与推测不能伪装用户原话。旧证据从 foundation_read 原样复用，不改写 id。当前只有对话路径支持基础证据保存；文档和公开网页结构化取证将在后续接入。
4. 调用 foundation_propose 保存。参数为 baseVersion、enterprise{name,evidenceRefs}、concepts[{id,name,description,evidenceRefs}]、relations[{id,name,description,from,to,evidenceRefs}]、evidence[{id,messageId,quote}]、unknowns[{id,description}]、conflicts[{id,description}]。id 使用稳定英文短标识，name/description 用中文业务语言。概念与关系按 id 增量合并，未传入的已保存项仍保留。企业名称须来自用户原话；同一企业简称/错字/正式名称纠正时先保存新的 profile 名称，再在 foundation_propose 顶层传 identityCorrection:{previousName:旧名称,evidenceRefs:[本轮新证据id]}，证据必须是当前用户对同一主体名称纠正的原话且包含新名称；不能用该字段合并不同企业。不同主体不得合并。没有依据的必要概念放到 unknowns，不伪造引用。
5. 未知和冲突也按 id 持续保留。用户补充明确依据后，用相同 id、原 description、resolvedBy:[新的证据 id] 标明已解决；不得为方便采用而清空冲突。冲突未解决可保存候选，但不能采用。已有定义更正仍形成候选，已采用版本保持有效。
6. 保存成功后核对实际回执，再用 task_ask，附 foundationId 和 version，请用户查看并采用具体基础定义；允许未知，无需先上传或接入数据。说明尚未绑定来源，不说可查询对象或 API 已可用。程序检查通过只表示结构与原话可定位，不保证语义正确。用户通过画布或明确确认采用，Agent 没有直接采用工具。
7. 基础已经采用且本轮只是读取/确认时，可 page_complete；候选未采用时不能宣称已完成采用。想补充或修正时继续基础版本，冲突/过期则重读后修改，停止后的写入由宿主拒绝。

来源接入是下一步：按业务问题建议最少的知识库、BI 或业务系统及用途。调用 live_overview/live_read 检查获准来源。基础定义本身 mappingStatus 为 unbound，没有可查询实例；后续正式映射沿已有概念身份补充。Skill 只提供方法，工具、权限和来源真实性由宿主与领域服务执行。
