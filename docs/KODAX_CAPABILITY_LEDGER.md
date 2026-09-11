# KodaX 能力与 DataEngine 接入台账

更新：2026-09-11。用途：说明本产品实际使用哪些 KodaX 契约、由谁补齐产品职责，以及哪些能力尚未验证。
本地核对基线为 `0b264fa6eb34668b9741af2208098d07334f61c0`；[package.json](../package.json)固定 `@kodax-ai/kodax@0.7.96-beta.2`。
本表核对本地 adapter 与能力服务，不是完整 SDK 源码审计。T013-01 新增的基础本体方法已做真实 KodaX/DeepSeek 验证，见[基础本体验收](experiment/COMPANY_FOUNDATION.md)。
旧官方源码核对版本与链接保存在[历史 Agent 设计](archive/AGENT_DESIGN_2026-09-07.md)；不能拿旧源码版本替代当前安装版本。

## 1. 如何读这份台账

- **已接入**：产品代码存在实际调用或 adapter；具体运行验证仍看有日期的验收记录。
- **限制使用**：底座入口已用，但本产品明确缩小模式、范围或支持的内容。
- **未接入 / 未验证**：不能向用户承诺可用；未验证也不等于 SDK 没有该能力。
- SDK 有能力不等于本产品已接入；KodaX Space 的宿主或产品能力也不等于 DataEngine 支持。

行为与生命周期以[Agent 契约](AGENT_DESIGN.md)为准；此处集中维护 SDK 接法，避免在产品页规格中复制 API 细节。

## 2. 已核对的运行契约

| SDK 契约 | 本产品接入 | 代码证据 | 限制与缺口 |
|---|---|---|---|
| `createKodaXRuntime` | 已接入 `embedded/inline`，独立 homeDir、sessionsDir、profile | [runtime.ts](../src/agent/runtime.ts) `initialize` | 本地 Node 宿主；未建立独立进程沙箱 |
| `sessions.create/load/delete` | 画布每轮新建并删除；旧 task 路径加载会话 | [runtime.ts](../src/agent/runtime.ts) `run`；[app.ts](../src/agent/app.ts) `run` | 页面持续状态由应用保存；无当前 UI 会话管理产品 |
| `runs.start` 与运行 handle | 已接入 `sa`、模型参数、result、usage 与失败结果 | [runtime.ts](../src/agent/runtime.ts) `run` | 只用单循环；多 Agent 模式未接入 |
| `runs.abort`、`runtime.close` | 停止和关闭 SDK 运行 | [runtime.ts](../src/agent/runtime.ts) `stop/close` | 迟到写入拒绝、已保存成果保留由宿主实现 |
| `events.subscribe` | 读取 assistant.delta、run.progress、工具和权限事件，结束关闭订阅 | [runtime.ts](../src/agent/runtime.ts) `subscription` | 只转换本产品需要的事件；未审查全部 SDK 事件语义 |
| `permissions.respond` | 对本轮 allowed 工具 allow_once，否则 reject | [runtime.ts](../src/agent/runtime.ts) 权限事件处理 | 不是企业授权系统；上游能力授权和领域校验另行执行 |
| `context.agentProfile/systemPromptOverride` | 注入 DataEngine 身份和当前系统说明 | [runtime.ts](../src/agent/runtime.ts) `runs.start` | 身份/说明由宿主提供，不自动生成业务规则 |
| `toolVisibilityPolicy/assertReadablePath` | 限定本轮工具，直接文件读取要求改走来源对象 | [runtime.ts](../src/agent/runtime.ts) `context` | 可见性不是授权；不是通用安全隔离证明 |
| `extensionRuntime.listRunTools/executeCapability` | 注册领域工具的描述、输入 schema、副作用和实际执行 | [runtime.ts](../src/agent/runtime.ts) `extension` | 本轮 adapter，经 `mcp` 分发通道；不要求领域工具使用网络 MCP |
| capability search/describe/read/prompt adapter | 接到宿主管理的 MCP 目录和调用 | [runtime.ts](../src/agent/runtime.ts) `extension` | 目录、授权、刷新与在途结果检查由产品 MCP 服务处理 |

## 3. Skill、MCP 与工具能力

| SDK 契约或入口 | 本产品接入 | 代码证据 | 限制与缺口 |
|---|---|---|---|
| `SkillRegistry`、`parseSkillMarkdown` | 独立发现、列表、loadFull、invoke、reload 与安装校验 | [skills.ts](../src/capabilities/skills.ts) | 只扫描产品目录；动态命令、hooks、fork 被宿主拒绝 |
| `SkillRegistry.invoke` | 参数化方法文本，`disableDynamicContext: true` | [skills.ts](../src/capabilities/skills.ts) `use` | 不自动执行包内脚本，不授予工具权限 |
| `createMcpManager`、能力 ID 解析 | 管理外部 MCP 目录、调用及连接生命周期 | [mcp.ts](../src/capabilities/mcp.ts) | UI 接受 HTTP/SSE；未接入 stdio 配置或 OAuth 授权流程 |
| 原生 `web_search/web_fetch` 工具 | 加入画布本轮原生工具 allowlist | [service.ts](../src/capabilities/service.ts)、[app.ts](../src/agent/app.ts) | 搜索事实需查证；网页证据转为基础本体仍待对应任务 |
| 原生 MCP search/describe/call/resource/prompt 工具 | 接宿主的发现与获准能力 | [service.ts](../src/capabilities/service.ts)、[runtime.ts](../src/agent/runtime.ts) | 通用工具调用不等于登记企业来源或允许对外消费 |
| `capability_search/skill_use/skill_read/sdk_call` | DataEngine 定义的领域工具，借 SDK 分发 | [service.ts](../src/capabilities/service.ts) | 名称不是 KodaX 通用 API；其行为由产品实现 |

Skill 的包目录、已安装方法与变更流程只在[内置 Skill](BUILTIN_SKILLS.md)维护。
本产品能力工具的 `mutates: false` 不证明任意外部 MCP 调用只读；具体能力仍受独立授权和执行检查约束。

## 4. 属于 DataEngine 的职责

| 产品能力 | 当前归属与证据 | 不应归给 SDK 的含义 |
|---|---|---|
| 目标、页面范围、上下文 | [app.ts](../src/agent/app.ts) 组装 RunRequest，[work-context.ts](../src/agent/work-context.ts) 解析消息固定引用；`context_read` 与前端复用读取服务 | SDK 不自动知道企业范围、选择或正确下一步 |
| 成果版本与运行写入资格 | [memory.ts](../src/agent/memory.ts) 的事务、revision、executionId | SDK session、abort 不替代业务并发和提交校验 |
| 本体与对象执行 | [workspace.ts](../src/agent/workspace.ts)、[domain-objects.ts](../src/agent/domain-objects.ts) | NOOA 式受限组合是产品实现；未集成完整 NOOA runtime |
| 来源、映射与在线读取 | [sources.ts](../src/live/sources.ts)、[memory.ts](../src/live/memory.ts) | MCP 工具目录不能自动产生语义映射、身份和证据 |
| 注册式业务 SDK | [sdk.ts](../src/capabilities/sdk.ts)，当前为 Octokit 公开仓库方法 | 不是 KodaX 的业务本体 SDK 生成器，也不支持任意包执行 |
| 对外 HTTP/MCP 消费 | [consumption.ts](../src/agent/consumption.ts)、[MCP bridge](../scripts/dataengine-mcp.ts) | 独立消费许可与数据执行，不经内部模型循环 |
| Web 宿主与用户交互 | [server.ts](../src/agent/server.ts)、[app.js](../web/agent/app.js) | 没有采用 Space 的 Electron、daemon、Partner 组件 |

在线 v2 目前为按需非原子跨源读取，未提供完整断言解释/证据回执；这些是领域交付缺口，不是换一个 SDK 模式即可解决。

## 5. 未接入或未验证的范围

| 范围 | 本次结论 |
|---|---|
| KodaX 其他运行模式、进程/远程隔离、多 Agent 调度 | 产品未接入；本次未审查完整 SDK 支持矩阵 |
| 通用 Hook、动态 Skill、脚本执行、Skill fork | 当前加载器拒绝动态命令/hooks/fork，不执行包内脚本；完整 SDK 契约未验证 |
| SDK 所有 provider、认证模式、凭据校验辅助 API | 本产品仅配置 deepseek/openai/anthropic；其他能力未验证 |
| SDK 事件持久恢复、跨主机会话、崩溃自动续跑 | 本次未验证；当前应用只清理中断运行身份并重新加载业务状态 |
| MCP OAuth、stdio UI、任意第三方连接器兼容 | 本产品未接入或未验证；不能由 SDK manager 的存在推断可用 |
| Space 专属桌面、daemon、专家及 Partner 功能 | 不属于本项目实现；参考文档组织不等于代码或能力复用 |

未验证项不自动进入本轮排期；实施范围继续由既有十八张任务及用户后续要求决定。

## 6. 维护与验收

1. 升级依赖前记录实际安装版本、对应官方契约与受影响 adapter；不使用浮动默认分支作为唯一依据。
2. 对照 session/run、extension、事件、权限和 Skill/MCP 的实际调用检查差异，先标出尚未验证的接点。
3. 更新实现后运行相关类型/行为检查，覆盖停止竞态、版本失效、权限撤销、未知工具和加载失败。
4. 需要证明模型使用新能力时，再做对应真实模型调用，分别保留 SDK 成功、工具结果与领域成果的证据。
5. 更新本台账、[Agent 契约](AGENT_DESIGN.md)或对应唯一文档；功能状态只在[台账](FEATURE_LIST.md)维护。

已有可读证据为[能力验收记录](experiment/AGENT_CAPABILITIES.md)、[在线运行记录](experiment/LIVE_MEMORY.md)和 [tests/agent](../tests/agent)。
历史通过次数按当时记录理解；T013-01 的新增能力与本轮验证另见[基础本体验收](experiment/COMPANY_FOUNDATION.md)。

## 基础本体方法接入（T013-01）

沿现有 SkillRegistry 和同一 KodaX 循环，按需加载 `company-foundation-ontology`；宿主记录本轮加载摘要后才允许 `foundation_propose`。`foundation_read` 与画布读取同一 `FoundationService`。真实原话、基础版本、名称纠正、冲突与采用在服务端检查；SDK 不负责判断企业语义真伪。字段及限制见[Skill 接口契约](COMPANY_FOUNDATION_SKILL.md#10-t013-01-实际接口)。未新增模型循环、执行环境或 SDK 版本。
