# 第三页：消费接口与治理

2026-09-14。本文为三页产品的消费设计，归属 FEATURE_016；历史四页和 v1/v2 已交付范围单独保留。内容修订与采用由第二页负责，本页围绕同一变更处理消费、发布、权限和影响。

## 0.2.0 主入口：发布与接入

第三页按产品版本管理组织：工作版差异 → 有界发布检查 → 不可变发布版本 → 独立调用方接入。`data_release` 固定本体、映射、存取策略及对外契约；远端事实仍按需读取，CSV 使用上传快照。检查按每种映射类型读取样本，不证明全量质量或业务语义。

管理接口为 `/api/releases` 以及 `check/publish/connect/upgrade/revoke/connection`。检查绑定输入 hash，过期或未采用候选阻止发布；发布与接入操作带 operationId，重试不重复创建或返回密钥。每个 `release_connection` 绑定发布版本和明确范围。升级保留范围与证据许可，签发新密钥并原子撤销旧接入；不兼容升级失败时保留原接入。

外部查询继续用 v4 与 stdio MCP。可选 `agentEnabled` 默认关闭；开启后增加 `submit_ade_task`、`read_ade_task`、`cancel_ade_task`，对应 `POST /v4/agent/tasks`、`GET /v4/agent/tasks/:id`、`POST /v4/agent/tasks/:id/cancel`。使用同一个数据集密钥，任务固定调用方和数据集版本，只读获准数据。任务无法跨调用方读取，撤销或来源许可变化也会阻止历史任务结果交付；重启不会自动重放模型任务。

模型未配置时委托显示等待，不伪造结果。每轮最多24次读取、512 KiB工具结果和20个对象/次。旧消费接口与数据集仍保持兼容；以下章节保留它们的契约，当前新接入优先从发布版本创建。


## 当前主入口：本体 MCP 数据集（2026-09-17）

FEATURE_023 将在线第三页改为本体数据集工作台。管理员选择已采用本体的概念及两端都已开放的关系，形成独立 `ontology_dataset`。定义按发布时版本固定，标记为已采用解释，不冒充业务事实；未映射概念仍可作为本体知识读取。原文、证据引用、来源连接信息不随定义导出。

可选的业务字段复用 v3 许可视图，并固定对应本体、映射及视图版本。页面默认不授权任何业务类型，字段需明确勾选，属性依据另行许可；业务记录按需读取，保留冲突、缺失及读取覆盖，不提供原子快照。v1/v2/v3 原合同与存量管理保留。

管理接口为 `GET /api/datasets`、`GET /api/datasets/connection?id=…&version=…`、`POST /api/datasets/publish`、`/revoke`、`/test`。发布请求包括 operationId、name、foundationRef、conceptIds、relationIds，以及可选 business.modelRef / grants；发布原子保存并签发一次性 `de_dataset_` 密钥，同一操作重试不再返回明文。密钥仅存摘要，列表包含完整管理范围及成功读取次数/最后时间，配置说明只放密钥占位符。停用同时撤销关联业务视图，在途业务返回前再次检查数据集状态。

| MCP 只读工具 | v4 GET 接口 | 用途 |
|---|---|---|
| describe_dataset | /v4/dataset | 已开放概念、关系与业务类型目录 |
| read_concept | /v4/concept?conceptId=… | 一个已开放概念的固定定义 |
| query_relations | /v4/relations?conceptId=… | 该概念的已开放定义关系 |
| describe_type | /v4/types?type=… | 已许可业务类型、字段及依据范围 |
| query_objects | /v4/objects | 有界业务查询；type / id / relation / fields / offset / limit |
| read_evidence | /v4/evidence?ref=… | 对查询返回的获准依据引用逐项读取 |

外部 Agent 使用生成的本机 stdio 配置（实际 Node 路径、桥接脚本、服务 URL 和数据集密钥），DataEngine 服务需保持运行。当前不提供远程 MCP URL、公网托管、记录级或多租户权限。每次调用独立校验权限，数据集密钥不能用于管理或旧消费接口。页面“测试 MCP”执行真实握手、工具发现、目录及一个概念读取，不能代表外部 Agent 已配置，也不证明全部业务来源可用。验收见 [本体数据集](experiment/ONTOLOGY_DATASETS.md)。

## 消费视图

用户根据用途选择已采用且可执行的本体子集，明确调用方、类型、字段、关系与可开放证据。Agent 可以解释并提出范围；真实启用与撤销由已授权管理入口执行。基础本体中的未映射概念可以治理，不能提供假实例或被当作可执行数据源。

消费视图固定明确语义版本，所有读取仍核对当前权限和来源状态。消费者拥有独立凭据，不能调用管理预览、采用或来源配置接口。界面合并不改变这项边界。

## 实际接口与生成内容

共同服务提供有界许可目录、类型描述、对象查询、关系展开与获准证据/解释。新融合接口单独版本化，保留原 /v1、/v2 行为；T016-01/02 已实现下述 v3 HTTP、按需证据、本地 stdio MCP 与说明生成。

页面从实际已开放的许可契约生成 API 文档、OpenAPI 描述和 HTTP/MCP 调用样例。接口必须真实可调用，样例中的类型和字段必须获准；不把生成文件或复制按钮当作服务已实现。密钥用占位符，内部来源地址和受限字段不出现在说明中。

动态发现面向有限上下文的 Agent：先小目录，再展开定义、对象与证据。静态多语言 SDK 可后续从同一契约生成；首轮不要求全语言客户端。

## 结果与证据

对象结果保留业务身份、字段、关系、范围、版本和各来源读取时点。属性/关系可按需解释含义、出处及实际计算依据，证据内容同样受权限控制。空结果、未匹配、多匹配、来源失败和截断分别表达；只披露获准原因。

文档证据保留片段定位，BI 结果保留粒度/单位/期间，不能经解释接口暴露未授权原文或字段。计数、错误和生成 schema 同样检查。

## 采用、发布与迁移

第二页形成并处理内容 changeRef，本页读取相同候选/版本及检查结果，展示哪些消费者受影响。采用新本体不会自动切换全部消费者；按授权和兼容结果迁移指定视图，新字段不自动获得权限。

源记录变化遵循按需读取，通常不产生新语义版本。定义/映射变化、权限变化、源事实变化分别显示。旧消费者仍按约定旧契约工作，但撤销或旧源不兼容时明确失败，不能承诺历史永久可读。

当前在线读取没有跨源原子快照。重现旧值需要来源历史或获准证据保留；语义版本固定本身不提供数据快照。

## 治理与安全

所有读取/写入在共同领域服务校验；前端可见性、模型说明和对象方法隐藏不构成权限。身份、字段、关系端点、文档与指标、证据和实际返回均受约束。在途结果返回前复核撤销，旧语义版本不能保留旧权限。

展示真实访问和变更记录，保留必要依据及执行状态，不默认保存完整响应或凭据。首轮保留本地单企业、字段/关系许可；员工身份、记录级隔离、多租户、集中密钥管理及公网托管另行建设，不展示为已支持。

## 验收与历史

两个独立 HTTP/MCP 客户端读取不同许可范围，浏览器关闭后仍可消费；生成说明与实际接口一致。验证证据绕权、未知/截断、撤销与重启、源变化、新旧语义迁移和旧接口兼容。任务见[FEATURE_016](features/v0.1.0.md#feature-016)。

原文件 /v1 发布与固定 dataVersion 见[接入与发布验收](experiment/AGENT_CONNECTION.md)；在线 /v2 按需 readAt 见[在线来源说明](experiment/LIVE_MEMORY.md)。原[消费验收](experiment/CONSUMPTION.md)与[维护验收](experiment/MAINTENANCE.md)只证明当时四页范围，不证明新增证据/融合/迁移能力完成。

## T016-01 交付基线（2026-09-14）

`consumer_view` 固定 `modelRef {id,version}`、可选 `semanticRef`、用途和 `grants[{type,fields,relations}]`。每个获准类型须含 `$id`；关系须同时许可两端类型、身份及关联字段。主来源和附来源字段共用许可检查，不自动开放新增字段。内部 Agent 使用 `consumer_view_propose`、`consumer_view_list`；启用不开放为模型工具。

管理员使用 `POST /api/live/views/propose`（operationId、name、purpose、modelRef、grants）、`activate` / `revoke`（id、version）。草稿保存按主体与 operationId 幂等，同键不同内容拒绝；启用仅首次返回明文密钥，重试返回 keyAvailable=false，不生成替代密钥。丢失密钥需停用后重建。服务器仅存摘要；前端多份首次密钥排队展示，关闭后清除，不进入浏览器持久存储。视图列表最多40条。

外部使用独立 `de_view_` Bearer 密钥，不具有管理权限，也不与 v1/v2 密钥混用：

| GET 接口 | 参数和结果 |
|---|---|
| `/v3/catalog` | 无参数；返回获准类型目录，最多20种 |
| `/v3/types?type=…` | 指定获准类型；仅返回许可字段和关系端点描述 |
| `/v3/objects?type=…` | 可选 id、relation、fields（逗号分隔）、offset、limit；最多20条，fields 必须含 $id；省略 fields 则返回该类型全部获准字段 |

关系查询须提供起点 id；结果按目标类型许可裁剪。对象返回 objectRef 和 properties[field]={value,status}，保留冲突、缺失与不确定性；不返回原始冲突值、源记录标识、源配置或内部映射。读取覆盖与 readAt/historicalReplay 随结果返回，按需读取非跨源原子快照。

共同元数据包括 contractVersion=v3、viewRef、modelRef、semanticRef、methodVersion=fusion-objects-v3.1、relationPolicy=source_mapping_only、evidenceAvailability=not_exposed。T016-01 当时未提供证据引用/正文、OpenAPI生成及新MCP接口；现由下节 T016-02 接入。局部关系纠正尚未对外发布；消费者迁移现由下节 T016-03 接入。

每次读取及返回前复核视图撤销、固定模型和来源可用性；无权/撤销403，非法参数400，固定映射/来源失效502。无内部错误细节。访问记录只记视图、路径、状态和时点。重启保留许可，源数据变化仍读取当前值；固定语义版本不构成历史数据快照。当前是本地单企业管理身份，不含员工级、记录级或多租户授权。

## T016-02 当前证据与接入契约（2026-09-14）

旧视图不自动增加权限。`grants[].evidence={fields:[],relations:[]}` 显式授权字段或关系依据，必须是同一 grant 已许可的子集；每类型最多20个证据属性。状态依据可包含该属性冲突双方的观测值，不能只把“读字段”当成已同意开放这些值。

`GET /v3/objects` 只对获准属性生成 `properties[field].evidenceRef`，关系展开可带 `relationEvidenceRef`；`GET /v3/evidence?ref=…` 按需读取。同一引用绑定视图版本及一次真实读取，返回 `reading=saved_reading_not_current`、到期时点、对象/属性/关系与安全裁剪的依据。属性保留观测值、eligible、读取时间和不透明 originRef，`objectCoverage` 与该属性相关的 `matches` 分开；匹配状态/覆盖区分缺失、多匹配、未知及来源失败，不返回内部源标识、原始列名或记录身份。关系使用本次源读取的规范起点 ID、目标 ID、精确匹配规则和实际覆盖，不包含内部局部纠正。

动态证据是可淘汰缓存，不是永久知识：最多可访问24小时，每批最多401份及512KiB、单视图500份、全局2000份及8MiB。超过批预算整批拒绝；容量满时先淘汰旧引用，已淘汰/过期/无权引用统一403。缓存与本体 artifacts 分表，启动和读写时清理过期项，撤销立即删除该视图动态证据；没有后台定时删除承诺。

文档/BI 使用独立 `contextEvidence:[{bundleRef:{id,version},kind:"document"|"metric",index}]`，最多6份。它明确选取同一固定映射下已保存共同取证中成功读取的一份文档片段或一组指标观测，不开放整个 bundle。界面从最近20份记录列出当前可用候选，完整展示将开放的内容后逐份勾选；默认不选择。提交、草稿恢复与幂等签名包含这些选择。

目录 `contextEvidence[{ref,kind,label}]` 返回本视图不透明引用，再由同一 `/v3/evidence` 读取。文档保留已授权文本、片段引用、版本、字符位置及覆盖；BI 保留单位、粒度、时区、聚合限制、期间、where筛选、offset/limit、观测及覆盖。不返回 bundle 内其他对象、关联对象身份、来源配置或内部关联理由。它们只是显式授权的历史背景，不能直接证明个体状态。此类引用依赖已保存 bundle，不受动态缓存24小时期限限制，但读取仍检查固定模型、当前来源许可及视图撤销。

`GET /v3/connection` 返回该视图 OpenAPI 3.1、HTTP 示例、本地 MCP 配置及许可范围。管理端用 `/api/live/views/connection?id=…&version=…` 获取同份说明；`/api/live/views/evidence-options` 使用相同模型引用列出可授权历史读取。密钥始终是占位符；源服务地址、未授权字段和内部 bundle 引用不进入对外说明。本地桥接脚本的实际文件路径用于本机配置，不是远程托管地址。

`node scripts/dataengine-mcp.ts` 接受 `DATAENGINE_URL` 与本视图 `DATAENGINE_CONSUMER_KEY`，通过实际 HTTP 服务读取，不依赖浏览器或内部模型。v3 工具为 `describe_catalog`、`describe_type`、`query_objects`、`read_evidence`、`describe_connection`；目录/查询/证据流程与 HTTP 相同。原 v1/v2 桥接不变。仍未提供远程托管 MCP 或记录级企业 IAM；迁移契约见 T016-03。

内部 Agent 在消费页已能只读 `evidence_list/read` 以确认真实引用，再通过 `consumer_view_propose` 保存显式许可；模型可能漏填证据范围，界面与实际草稿回执是核查依据，宿主不推断或补授用户未提交的权限。


## T016-03 当前迁移契约（2026-09-15）

第三页按第二页同一 `mapping_change {id,version}` 查询当前消费者影响，打开同一规则差异与历史样本。影响按20份分页；最近变更/迁移各40条，旧变更可按引用读取。`affected` 指许可字段、关系或其依赖涉及修订；`compatible` 表示当前版本、来源许可和既有字段/关系范围允许迁移，不证明业务正确、全量数据兼容或上游此刻可达。样本沿用原变更的有界读取，不冒充新一轮全量检查。

`consumer_migration` 保存当前 viewRef、changeRef、目标、原许可、条件指纹和移除旧背景的明确决定。Agent 可以调用 `consumer_migration_impact/preview/list/read`，消费页也可只读映射变更；不注册迁移提交工具。管理员通过 `POST /api/live/migrations/preview`（operationId、viewRef、changeRef、可选 dropContextEvidence）保存预览，`commit`（operationId、预览 id/version）确认指定视图。页面与 Agent 使用同一服务和同一预览记录。

提交在事务中重新检查预览、视图、变更、目标和当前来源许可，成功后保留视图 ID、密钥摘要及原 grants，增加视图版本并切换 modelRef。关联字段不在既有许可内则阻止；绝不自动增加字段、关系或证据权限。竞争提交和过期预览失败，按主体与 operationId 重试返回历史回执，同键不同请求拒绝。回执不代表视图此刻仍启用；当前状态须重新读取。

固定文档/BI 背景绑定旧模型，默认阻止迁移；仅明确 `dropContextEvidence:true` 才移除该视图全部旧背景引用。当前没有自动重绑或新背景补授入口。迁移立即删除该视图旧动态证据，原背景引用也失效。其他视图、旧 v1/v2 合同和原模型局部纠正保持原状，局部纠正不进入外部查询。

外部客户端先读 `/v3/catalog` 获得当前 `viewRef.version`；`/v3/catalog`、`/v3/connection` 可不带版本以重新发现。迁移后 `/v3/types`、`/v3/objects`、`/v3/evidence` 必须携带 `viewVersion`，生成 OpenAPI 同步标为必填，HTTP 示例带实际版本，MCP 三个读取工具接受相同参数。未迁移视图保持参数可选；任何显式旧版本都拒绝。迁移中的在途响应也拒绝，返回409及 `code=view_version_changed`，提示重新发现并开始查询；撤销返回403。一次客户端调查应始终使用同一版本，不能遇到409便拼接旧结果与新结果。

版本固定仅约束消费语义与许可，源值仍按需读取，没有跨源原子数据快照。首轮没有批量迁移、回滚协议、自动扩大授权、企业 IAM 或公网托管承诺。完整验证见[迁移验收](experiment/CONSUMER_MIGRATIONS.md)。

## 2026-09-15 整链验证补充

同一企业双消费者的许可差异、定向迁移、旧引用失效、内部局部纠正隔离及来源变化已在公共 HTTP/MCP 完成整链验证。映射版本固定不代表来源事实冻结。详见[整链验收](experiment/FUSION_CHAIN.md)，范围仍为本地单企业实验。

## 2026-10-15 快照发布与覆盖补充

v0.2.1 的发布定义固定各结构化来源的快照版本（见 [ADR-004](ADR/ADR-004-managed-snapshots-and-pinned-releases.md)），设为实时读取的来源仍沿用按需读取。以上早期记录对“固定语义不冻结来源”的说明适用于实时路径；锁定快照的消费者读取对应已保存版本。CSV 重新上传后，新建或升级到旧发布也使用该发布的来源契约；来源停用仍即时阻止读取和新增接入。

本次未发布修复补齐覆盖合同：发布清单记录快照的 `coverage`，覆盖不完整时发布检查给出警告，允许发布已保存范围。消费响应保留 `offset/shown/total/complete`，锁定快照另外提供 `sourceComplete`（同步时是否覆盖全来源）及 `snapshotTotal`（保存快照中满足当前过滤的记录总数）。不完整快照的 `total` 始终为 null、`complete` 始终为 false；空结果不能证明来源中不存在记录。完整快照则按当前过滤和分页计算 `total/complete`。后续同步即使内容相同而覆盖改变，也生成独立版本，不改写旧发布的覆盖信息。

发布补记（2026-10-15）：上述覆盖合同修复已随 v0.2.2 在本地 Git 发布。
