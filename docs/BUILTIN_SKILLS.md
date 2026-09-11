# DataEngine 内置 Skill 目录与生命周期

更新：2026-09-11。本文维护产品运行 Skill 的职责、发现方式、内容变更与验证要求。
T013-01/02 已通过真实 KodaX 加载基础本体方法，对话与企业文档共用同一成果；方法与领域操作的验证见[验收记录](experiment/COMPANY_FOUNDATION.md)。
Skill 是内部 Agent 按需使用的方法说明，KodaX 保持唯一模型循环，领域服务决定实际权限、保存和完成状态。

## 1. 当前目录与规划

| name | 状态与方法 | 入口及限制 |
|---|---|---|
| `enterprise-research` | 已有运行包：查证企业公开信息并提出有出处的建议 | [SKILL.md](../config/skills/enterprise-research/SKILL.md)；明确名称/地区、核对官方网页，使用 `profile_update` 保存 suggestion，不伪造 user 陈述 |
| `ontology-modeling` | 已有运行包：围绕业务问题检查实际源契约与样本，提出在线本体候选 | [SKILL.md](../config/skills/ontology-modeling/SKILL.md)；使用 `live_overview/read/propose`，用户采用前保持候选，工具结果不等于正式来源 |
| `company-foundation-ontology` | 已实现对话与 Markdown/TXT 路径：实际依据、基础候选、未知与冲突，人工采用 | [SKILL.md](../config/skills/company-foundation-ontology/SKILL.md)、[接口规格](COMPANY_FOUNDATION_SKILL.md)；资料验收见[记录](experiment/FOUNDATION_DOCUMENTS.md)，公开研究由 T013-03 承接 |

“已有运行包”只说明文件和加载链路存在，不代表在当前这轮对话中已调用。
基础方法复用前两项的取证与建模原则，先在同一循环内加载方法，再调用基础领域服务；已接入 Markdown/TXT 文档证据，公开网页证据留给 T013-03。
基础定义获采用不表示业务数据已映射、API 已有对象或消费者已获授权。

## 2. 目录与职责

| 位置 | 用途 |
|---|---|
| `config/skills/<name>/SKILL.md` | 随产品代码维护的 bundled 方法 |
| `<运行目录>/capabilities/skills/<name>/SKILL.md` | 经产品安装入口保存的运行方法 |
| `.agents/skills/` | 开发本项目的工作技能；产品 Agent 不扫描此处 |
| `config/agent/canvas.md` 与 `system.md` | 宿主系统说明；不是可按需调用的 Skill 包 |

默认服务运行目录为 `local-state/agent`；具体启动可传入独立目录，不能把默认路径当作所有实例的唯一位置。
[AgentSkills](../src/capabilities/skills.ts) 使用独立 KodaX SkillRegistry，只设置上述产品 projectPaths，关闭 userPaths/pluginPaths 并使用独立空 builtin 路径。
外层调研文件、个人开发 Skill 和产品仓库指令不会因同机存在就成为产品方法。

## 3. 发现、加载与执行：当前实现

1. `capability_search` 列出匹配的 Skill 名称与说明；仅发现目录不代表已阅读方法正文。
2. `skill_use` 通过 `loadFull`、内容校验和 `invoke` 返回方法文本与参数，关闭动态上下文。
3. `skill_read` 读取已发现 Skill 包内的参考文本，经过 realpath 范围检查；方法不能引用包外任意文件。
4. Agent 在同一 KodaX 循环中依照方法选择当前已开放、已授权工具。
5. 领域服务返回实际候选、查询或保存结果，Agent 据此说明成果和未决项。

实现见 [skills.ts](../src/capabilities/skills.ts) 和 [service.ts](../src/capabilities/service.ts)。
加载器按字符串长度将单份方法限制为 100,000，单份参考文件限制为 100,000 字节。
当前拒绝动态命令标记、`hooks` 和 `context: fork`；不自动执行包内脚本，不提供方法自身的后台任务或模型循环。
Skill 不能改变页面工具范围、扩大 MCP 授权或把网页/资料中的指令提升为用户指令。
发现不等于加载，加载不等于调用业务工具，工具成功不等于已采用；这几个状态应分别报告。

## 4. 内容设计约定

每个 Skill 以稳定 name、简明 description 和明确触发条件说明它解决的业务问题。
正文交代必要输入、优先行动、来源/未知/冲突处理、可使用的现有工具、输出和完成条件。
提示文字不能声明尚未实现的方法已经可执行；出现新依赖时先核对[能力台账](KODAX_CAPABILITY_LEDGER.md)。
已有明确企业和任务直接继续；同名主体需要消歧，但不能把“确认企业”解释为机械重复询问名称。
公开搜索只用获准公开信息；私有记录与凭据不自动发送给公共搜索服务。
参考材料用于展开细节；它们的指令权威仍低于用户请求和宿主约束。
证据、版本、采用及消费边界引用[语义契约](SEMANTIC_CONTRACTS.md)，不在每个包中各造一套协议。

## 5. 安装、修改与版本记录

当前安装入口校验 frontmatter、name/description 和正文；拒绝禁用模型调用的方法及重名安装，写入单份 SKILL.md 后 reload。
安装入口不提供覆盖升级、删除、资源包上传或正式 Skill 发布迁移；不能把 registry 的 reload 说成已有完整升级产品。
修改 bundled 方法通过代码评审与 Git 版本记录；发现当前是惰性初始化，修改后应重新初始化或重启宿主再验证。
多文件参考随代码维护并检查包内引用；运行安装方法若需资源，应先落实支持方式，不能假定安装器会复制资源。
方法变更不自动修改已保存本体、重新执行旧任务或迁移消费者；有影响的领域变更走对应服务与业务决定。
后续若需更强的 Skill 版本绑定或回放能力，应明确实际存储与升级方案；当前不承诺按旧方法版本重现运行。

## 6. 修改后的验收

- 检查 frontmatter、唯一名称、目录发现、正文加载及包内参考读取；验证越界、超限和禁止内容明确失败。
- 核对所提到工具在目标页面真实可用，来源授权和业务执行边界没有因方法加载而扩大。
- 用适用业务输入验证一个可查看的真实成果，包含至少与改动相关的未知、冲突、错误或停止恢复情况。
- 对新基础本体方法按[规格](COMPANY_FOUNDATION_SKILL.md)验证身份、三条路径和未映射状态；按既有票分期交付。
- 需要证明真实模型行为时记录 Skill 实际加载、工具执行和领域结果；脚本读取成功或旧验收记录不能替代。

代码检查参考 [capabilities.test.ts](../tests/agent/capabilities.test.ts)；真实能力操作见[运行记录](experiment/AGENT_CAPABILITIES.md)。
T013-01 的测试与真实模型记录见基础本体验收；任务状态以[版本设计块](features/v0.1.0.md#feature-013)为准。
