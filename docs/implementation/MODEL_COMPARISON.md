# CSV 与 CSV＋PDF 本体发现耗时对比

仅比较两种来源组合，不加入实验 label 或行业限定。固定模型、提示、预算和来源版本，观察加入 PDF 后的模型运行耗时、迭代及提交失败变化。不自动调用模型。

## 开启追踪

在根目录 `.env` 设置，重启服务后新建包含 CSV 和 PDF 的候选本体任务：

```dotenv
CONTEXT_OS_KNOWLEDGE_MODEL_TRACE=1
CONTEXT_OS_KNOWLEDGE_MODEL_TRACE_DIRECTORY=local-state/model-traces
```

运行日志 model.trace.created 显示目录。每次调用独立 UUID 目录：

- request.json：实际传给 KodaX 的 system/input/tools、完整样本和 Schema、来源种类、模型预算、jobId/attempt、输入哈希。
- events.jsonl：可见文本增量、轮次、工具提交原文、校验接受/拒绝及结束事件；运行中可以 tail -f。
- output.json：通过结构校验的提交，不代表后续领域证据校验通过。
- summary.json：结束时的总耗时、首个可见响应时间、轮数、提交和拒绝次数、字节数、usage（未知为 null）。

这是应用与 KodaX 的边界，不是提供方 HTTP 报文；SDK 模板开销未捕获。不记录认证头或密钥配置，不包含隐藏推理。首个可见响应可能是文本或工具提交，不等同提供方首 token 延迟，无法单独区分排队和内部计算。

追踪含原始业务内容，默认关闭；不自动轮转，实验后自行删除。目录 0700、文件 0600，默认位于 Git 忽略的 local-state。强杀可能没有 summary，但已落盘事件保留。

## 同一冻结输入比较两组

以下两个命令必须使用同一份含 CSV＋PDF 的 request.json。对比时清空 baseOntology，避免上次生成结果进入下一轮输入。仅 CSV 保留 CSV 来源；csv+pdf 保留两种来源并要求 PDF 存在。请先预览来源列表。

```sh
# 只预览，不调用模型
npm run knowledge:compare -- --input 实际路径/request.json --sources csv
npm run knowledge:compare -- --input 实际路径/request.json --sources csv+pdf

# 加 --run 才发起真实模型调用，可能计费
npm run knowledge:compare -- --input 实际路径/request.json --sources csv --run
npm run knowledge:compare -- --input 实际路径/request.json --sources csv+pdf --run

# 汇总时间、来源种类、轮次、提交和拒绝次数
npm run knowledge:compare -- --report
```

命令使用当前代码和模型配置，不重放旧提示；两组之间不改代码、模型、超时及迭代预算。每组建议重复至少 3 次并交替运行，观察波动。对比输出不写产品数据库；当前版本与正式发现共用候选校验器并输出独立校验报告，但不自动证明业务语义。旧版未执行该领域校验的记录仍按当时边界解读。使用 summary 的状态与 submitted 联合判断成功，不能仅看 output.json 是否存在。

普通任务日志保留来源读取、模型及领域校验/保存事件的相对时间。结合追踪区分等待响应、迭代、工具提交校验耗时；不能把观察到的所有耗时归为 PDF 解析。

## 验证

类型检查及 logger/model 共 6 项测试通过，覆盖原文请求、响应、提交、失败摘要及原有诊断。未发起真实付费调用；真实耗时结论等待用户执行实验。原文追踪和对比之外的工作区改动保留。

## HTTP 边界诊断补充

当 `CONTEXT_OS_KNOWLEDGE_MODEL_TRACE=1` 时，当前 custom 提供方的真实 HTTP 请求也写入同一次 events.jsonl；不替换全局 fetch，不影响固定提供方和数据连接器。request.json 仍是应用层输入，实际 SDK 组装的消息和参数在 `http.request.data.body` 查看，包括 thinking/reasoning、max_tokens 等是否发送（未出现的参数不等于服务商一定关闭该能力）。认证头、URL 查询参数、用户名密码不记录，正文中的显式凭据字段脱敏；消息正文含业务资料，仍只用于本地实验。

关键事件：

- http.request：真实请求序号、根地址与路径、请求体、SDK 提供的 retry-count（缺失为 null）。多次请求也可能是模型第二轮正常调用，不能直接把请求总数当重试次数。
- http.headers：状态码、响应头到达时间、服务商 request-id（若有）、retry-after。
- http.first_chunk / http.chunk：收到流数据的时间与字节；首块可能是 SSE 心跳，不等于首个模型 token。
- http.first_reasoning_delta / http.first_text / http.first_tool_delta：首次观察到对应内容类别的时间，不记录推理正文。
- http.usage：服务商原始 usage 对象，包括其实际返回的 reasoning 明细；不存在时不猜测。
- http.finish_reason / http.sse_done / http.end：结束原因与耗时、总字节及数据块数。
- http.failed / http.stream_failed / http.cancelled：请求、流或取消状态，不写原始异常全文。

summary.json 增加 httpRequests、httpUsage、iterationUsage 和 sdkUsageTotals。SDK 用量按 sampleId 去重后汇总，原始 HTTP 用量单独保存，二者不能再次相加；不是费用估算。最终 outcome.usage 仍可能为 null。--report 增加 HTTP 请求数和 SDK 输出 tokens。

判断顺序：先确认实际 thinking/reasoning 参数与原始 usage，再看响应头前等待、首块与首工具参数之间的间隔、持续流式输出时间、状态码和 retry-count。只能记录服务商返回的信息，无法透视其内部排队和计算；没有 reasoning 明细不能据此认定未推理。不是所有 SSE 协议变体都有相同字段，当前解析 OpenAI Chat Completions 和 Anthropic 常见事件；代理层内部重试不可见。非流式响应仅在结束时解析 usage（最多 4 百万字符），超出会明确标记；原始响应字节始终原样传给 SDK。

补充验证：类型检查、13 项日志/模型/HTTP 诊断及运行时回归测试通过；以伪造传输验证拆分 SSE、原样转发、凭据排除、原始 reasoning usage、作用域请求计数、异常和 SDK 用量去重。未执行真实付费调用，也没有改变模型推理或输出预算参数。请用新进程重新执行原有两组命令，旧追踪无法补回 HTTP 信息。

## 2026-11-03 运行控制修复

针对 trace `11d59e91-c0e5-4706-a103-6ac48e313909`：首次响应在约 98 秒后停止数据，约 27 分钟流错误后再次发送请求，1800 秒预算最终到约 2598 秒才报告。模型输入为已解析的 340 字符 PDF 文本，不需要多模态。历史记录不足以确定定时器延后的根因，不能声称已证实是 SDK、休眠或事件循环某一原因。

知识模型现增加独立宿主总预算：不依赖 SDK 先完成 abort 才返回；禁止超时后的迟到提交。custom 提供方增加响应头等待/连续无数据时限，默认 120 秒（CONTEXT_OS_KNOWLEDGE_MODEL_IDLE_TIMEOUT_MS，允许 1000–300000 毫秒）。HTTP 非成功状态、连接失败、断流或空闲超时会锁定本次运行的失败状态：SDK 客户端 maxRetries=0，后续重发也在 transport 边界拦截，不再产生第二个网络请求。正常工具迭代仍可发送下一轮请求。停止失败的 SDK 尚未退出时拒绝新任务调用该 driver，避免重叠调用；清理最多等待 5 秒。

GLM-5.3 官方明确不能关闭 thinking，支持 low/high/max；默认可能采用 max。依据 https://docs.z.ai/guides/capabilities/thinking ，auto 对以 glm-5.3 命名的模型路由（包括 glm/glm-5.3）显式发送 thinking.type=enabled、reasoning_effort=low。CONTEXT_OS_KNOWLEDGE_MODEL_REASONING=default 可保留上游默认，low/high/max 可选；其他模型不猜测私有参数。没有改 .env 中模型或接口地址，也没有换网关。低推理可能影响结果质量，真实效果仍需检查；网关可能忽略或不支持参数，以 HTTP 追踪和响应回执为准。

配置示例（编辑后重启网页服务，CLI 每次自动重新加载）：

```dotenv
CONTEXT_OS_KNOWLEDGE_MODEL_TIMEOUT_MS=600000
CONTEXT_OS_KNOWLEDGE_MODEL_IDLE_TIMEOUT_MS=120000
CONTEXT_OS_KNOWLEDGE_MODEL_REASONING=auto
CONTEXT_OS_KNOWLEDGE_MODEL_TRACE=1
```

错误分类写入尝试记录/追踪：MODEL_IDLE_TIMEOUT、MODEL_DEADLINE、MODEL_STREAM_FAILED、MODEL_CONNECTION_FAILED、MODEL_HTTP_状态码。保护与原文追踪开关独立，关闭 trace 仍生效。Node 进程休眠/事件循环阻塞期间无法准点执行计时器；恢复后在下一次请求、读流或提交时核对绝对截止时间，拒绝超预算工作。取消本地请求不等于服务商确认停止计算或停止计费，未收到的 usage 仍保持未知。

验证：类型检查及 19 项 transport/trace/model/runtime/logger 测试通过，覆盖停滞取消、失败重发拦截、SDK abort 不返回时的总预算、迟到提交拒绝、GLM 参数和非 GLM 路由不变、HTTP 429 不重试。未调用真实付费模型。原有成功实验保留原样，新配置与旧实验不同，需新建任务重测。

另有现有 custom-model 本地模拟网关回归 1 项通过，覆盖认证隔离、重定向保护及 OpenAI/Anthropic 路径；本轮合计 20 项相关测试通过。新增“等待响应头且底层忽略 AbortSignal”用例验证宿主仍能返回总预算错误。


## 2026-11-03 证据目录与统一校验

新 discover 使用 evidenceCatalog / evidenceReferences 候选契约，不由模型生成引文和偏移；应用回填正式 discoveryEvidence。对比脚本与正式任务共用校验，除了追踪 output.json，还在 local-state/model-comparison-validations/ 写独立校验报告。通过只意味着结构及目录引用有效，semanticVerified 仍为 false，需逐项审核。--report 的 generationStatus 不能当领域成功率。

旧 request.json 的原始样本仍可用于当前代码比较；新目录请求仅复用已展示目录条目，辅助重建文本仅用于检查已有片段，不声称还原未展示的字符。CSV 与 CSV＋PDF 选择过滤同一份冻结目录，两组不更改配置。没有 --run 不调用模型；本轮未执行这些命令。

新规则会拒绝原先“未声明币种”等结构可接受值，不能直接把前后成功率并表而不注明契约/提示变化。源码中 discovery.test.ts 补充目录、属性覆盖、伪引用、口径及审核失效用例；本轮未运行测试。


### 人工介入规则更新

当前校验报告 issues 仅是重大节点事件，不再一成员一问题；uncertainties 暂缓的原候选在 deferred 中保留，其他明确内容可以继续。schema/evidence 通过仍不等于语义已被机器证明。对比时应同时报告暂缓数量及遗漏，不能通过暂缓困难项虚增准确率。本轮未运行对比或测试。
