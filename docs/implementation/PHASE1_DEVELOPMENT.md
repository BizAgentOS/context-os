# 第一阶段开发交接

当前状态：首轮按用户要求仅编写实现；用户审阅并授权后，已执行运行测试、修复和 GLM 5.3 小样本验证。实际结果与边界见 [运行验证记录](PHASE1_VERIFICATION.md)。下文保留配置与操作说明，历史“尚未执行”表述仅指最初开发交接时点。

## 入口与范围

新默认 `npm start` 指向 `src/knowledge/server.ts`，独立于旧 AgentApplication / SQLite 状态。旧开发入口仅保留为 `npm run legacy:start`，方便查阅既有实现，不属于新核心依赖。

新核心复用 DocumentFiles 的子进程解析器、文档定位和 KodaX 提供方运行时；不加载旧项目的行业规则、主源/补充源约束、发布快照或旧本体治理流程。

目录：

- `src/knowledge/contracts.ts`：本体、声明、时间、映射、Action 与权限契约。
- `src/knowledge/sql/001-core.sql`、`database.ts`：PostgreSQL schema、异步事务及显式初始化。
- `sources.ts`：CSV / PDF 接入，字段和引文定位，确定性映射。
- `service.ts`：本体、身份、声明、证据、双时间对象查询、Action 与审计。
- `projection.ts`：冲突、未知时间、人工覆盖及多值投影策略。
- `model.ts`：受限结构化提交，复用提供方接口，无原生工具权限。
- `jobs.ts`：持久化队列、租约、失败及显式重试。
- `server.ts`、`web/knowledge/`：最小工作台及带身份的 HTTP API。
- `tests/knowledge/`：已编写但未运行的纯规则和 PostgreSQL 集成测试。

## 与实施任务对应

| 任务 | 本轮写入内容 | 尚需验证 |
|---|---|---|
| F1 | OO 元模型、声明与 Action schema，CSV/文本样本、PDF 生成脚本 | 编译、样本与真实评测集审阅 |
| F2 | PostgreSQL DDL、版本初始化、事务、幂等与修订控制 | 专用空库初始化和事务测试 |
| F3 | CSV 与文本层 PDF，版本/哈希、字段/页码/偏移证据 | 真实文件解析及上传 |
| F4 | 候选本体生成、依据验证、发布、CSV 映射及 PDF 模型任务 | 真实模型本体与声明效果分别评测 |
| F5 | 对象独立 ID、来源身份映射、冲突与双时间查询 | 历史边界、迟到信息及多源链路 |
| F6 | 四类 Action、人工覆盖持续方式、修订审计及源更新失效 | 并发、重试、再同步及撤销 |
| F7 | 资料/任务、本体、对象/证据/时间/修正/审计界面 | 浏览器、HTTP、键盘及窄屏检查 |

## 授权后再执行的环境准备

本轮只通过 `npm install --package-lock-only --ignore-scripts` 写入 pg 依赖锁文件，没有安装或执行新驱动。授权验证后先安装依赖。PostgreSQL 需由开发者提供数据库与账号；程序不创建数据库、不启动容器、不隐式建 schema。

必要配置：

```sh
# 替换占位值；真实凭据不要提交到 Git。
export CONTEXT_OS_KNOWLEDGE_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/context_os_dev'
export CONTEXT_OS_KNOWLEDGE_PRINCIPALS='[{"id":"developer","role":"admin","token":"REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS"}]'
# 可选，默认 local-state/knowledge 和 3211。
export CONTEXT_OS_KNOWLEDGE_DIRECTORY='local-state/knowledge'
export CONTEXT_OS_KNOWLEDGE_PORT='3211'
```

principals 是受信任的部署配置，不能由请求选择角色。令牌放在 Authorization Bearer；页面连接后仅在内存中使用，不写 localStorage。admin 可发布，editor 可构建及修正，viewer 只读。第一阶段所有授权用户可读实例资料，不提供部门/属性级 ACL；若试点要求精细权限，必须补齐后接入敏感资料。默认只绑定 127.0.0.1，不将此入口直接暴露公网。

启用模型（可选，CSV 显式映射无需模型）：

```sh
export CONTEXT_OS_KNOWLEDGE_MODEL_PROVIDER='custom'
export CONTEXT_OS_KNOWLEDGE_MODEL='YOUR_MODEL_ID'
export CONTEXT_OS_KNOWLEDGE_MODEL_BASE_URL='https://YOUR_PROVIDER/v1'
export CONTEXT_OS_KNOWLEDGE_MODEL_PROTOCOL='openai'
export CONTEXT_OS_KNOWLEDGE_MODEL_API_KEY='YOUR_SECRET'
```

也可使用既有运行时支持的非 custom 提供方及其标准环境变量。本轮没有选择或调用付费模型，没有读取旧凭据。未配置模型时，自动本体生成和 PDF 知识抽取明确失败，不能回退为假模型；仍可手动建立本体并进行 CSV 映射。

授权后启动顺序：

```sh
npm ci --ignore-scripts
npm run knowledge:init
npm run knowledge:sample-pdf
npm start
```

这些命令尚未执行。PDF 生成脚本使用 wx，文件已存在时拒绝覆盖。开发重建需要显式命令 `npm run knowledge:reset -- --confirm-delete-knowledge-schema`，仅删除目标数据库的 knowledge schema 和本阶段版本标记；会丢弃该 schema 数据，不会自动删除文件目录。不要对真实企业数据库使用开发重建。

## 人工检查路径

1. 连接令牌，上传 contracts.csv，记录键为 contract_no，来源编号 contracts。
2. 载入工程示例或在配置模型后生成候选本体，检查后保存并发布。identityNamespaces 是操作者批准的跨源身份命名空间，不仅按名称匹配。
3. 选择 CSV 与发布本体，检查示例映射后提交任务，手动刷新任务状态。
4. 打开对象，查看金额、负责人、声明及字段证据；业务时点使用 2026 年 4 月内的日期。
5. 授权真实模型后上传生成的 PDF，使用同一本体提取。验证不同金额并存为冲突、证据定位准确。
6. CorrectProperty 选择对象及其修订号，金额输入 JSON 字符串，例如 `"1300000.00"`；指定业务时间、覆盖持续方式和理由。
7. 使用相同来源编号上传 contracts-updated.csv 并重新映射，检查人工值、分歧提示、旧证据和历史查询。
8. 对人工声明执行 RejectAssertion 可撤销其影响；CorrectValidity 修正声明时间；所有修改查看审计。

## 语义边界与实现取舍

- 来源新版本激活即将旧版本声明的当前修订标为 superseded，保留旧系统历史，不推断业务结束日期。新构建完成前，受影响知识可能暂缺；这属于显式过渡状态，不使用旧内容冒充新内容。
- 对象查询在事务内直接读取声明并重算，不读取未经校验的缓存；投影表记录结果及依赖，后续可优化。当前采用单实例领域事务锁，优先正确性，吞吐量待真实规模验证。
- 未知业务时间返回 uncertain；有已知时间结果时同时返回未知时间候选，不能将后者当作已排除。
- 自动候选本体中每个类型和关系需要来源定位依据；这验证“引用存在”，不等于语义正确。真实模型需要单独评测。
- 来源命名空间创建来源内对象；批准的业务命名空间可跨源对应。可信 ID 必须在引用证据中出现，但仍不能保证模型理解正确。通用模糊合并与拆分暂缓。
- 同一 operationId 的输入变化被拒绝；相同来源版本及抽取配置的重复声明去重。新的抽取配置不会自动删除旧配置产出的声明，需显式否决不再采用的结果；通用重处理替换策略待后续完善。
- 文档抽取最多 40000 UTF-16 字符，超限拒绝而非截断；本体发现按有覆盖说明的字段和样本进行。第一阶段不是长文档批处理完成态。
- 本阶段仅实现来源→声明→对象视图的依赖，无任意多跳推导或问答缓存；文件原文保留本地。文件保留/物理删除策略另行实现。
- 部分错误会令整批任务失败且不写入半批声明，待处理状态用于推断声明；尚未实现逐项错误修复界面。

## 后续验证建议（本轮未执行）

先做短检查，再由用户选择是否扩大范围：

1. `npm run typecheck`：包含新源码、测试和脚本。
2. `node --test tests/knowledge/contracts.test.ts`：纯规则，不启动模型或数据库。
3. PostgreSQL 集成：设置 `CONTEXT_OS_KNOWLEDGE_TEST_DATABASE_URL` 指向专用空库后运行 `node --test tests/knowledge/postgres.test.ts`。测试拒绝已存在 knowledge schema 的库；测试结束仅清理自身创建的 schema。测试不调用真实模型，包含预解析文档夹具，不能替代 PDF 实际端到端验证。
4. 浏览器与真实模型效果分别执行，先限制样本和调用量，再考虑旧功能回归与规模测试。

只有实际执行并记录结果后，才能标记验收完成。当前项目版本仍为 0.3.1，没有提交、推送或发布。
