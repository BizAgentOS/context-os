# 第一阶段补齐交付记录

日期：2026-11-02。范围依据 [第一阶段实施决定 §11](PHASE1_DECISION.md)。基线提交 `924e779`；继续使用 `feat/knowledge-platform-phase1`，没有修改 main 或创建产品 Release。

## 实际实现

| 能力 | 实现及使用方式 |
|---|---|
| 否定/计划/条件 | `claim.semantics` 保存 polarity、modality、condition；非普通实际肯定声明和 inferred 进入 pending，投影再次隔离。原文条件保留文本，不求值 |
| 比较口径 | 属性 `comparison` 定义 unit/currency/scope；声明保留自身口径；CSV `mapping.comparisons[propertyId]` 显式配置。参与采纳的口径不一致/缺失时返回 incomparable 和 null，不被人工优先级掩盖 |
| 身份纠错 | 管理员 Action `RematchIdentity`，要求本体启用；标识绑定历史 + 明确选中声明的迁移映射 + 同一系统时间边界；旧声明标 superseded，新声明保留证据。未选中的不动，旧系统时点可查，反向 Action 可恢复 |
| 修正依据 | CorrectProperty/CorrectValidity 的 `evidence` 接受 `{sourceVersionId,locator}`；实际定位验证。`GET /api/evidence/{assertionId}?revision=N` 返回原始依据及该修订的新增依据，role 区分 source_evidence/revision_basis |
| 策略溯源 | 投影 body.policy 和 fusion_policy_version 为 semantic-conflict-v2；历史查询仍按当前算法解释历史输入，不宣称任意旧算法重放 |
| 运行记录 | jobs.metrics 保存最近尝试；`GET /api/jobs/{id}/attempts` 保存逐次成功/失败/中断记录、耗时、输入规模、提供方数值 usage。费用未知为 null，字节不冒充 token |
| 可检查页面 | 声明语义/口径展示、修订级证据、人工修正依据输入、管理员标识纠错、任务尝试记录、全实例资料可读的边界提示 |
| 试点评测 | [评测与运行基线](PHASE1_PILOT_EVALUATION.md)：标注/裁决/冻结、分环节质量、召回、权限门槛、成本与负载记录模板 |

人工依据只验证位置，不能证明新值符合现实。人工判断无文档依据时也会保留理由和操作者审计，不冒充模型已核实。

## 初始化与配置

运行 `npm run knowledge:init` 显式应用 schema 002。初始化只补充新结构，不删除 schema 001 数据；启动要求版本 2，旧库未更新会明确拒绝启动。开发重置仍需原有显式确认。

已发布本体不可修改。要启用身份纠错，可复制草稿，将 RematchIdentity 加入 actions 后发布；工程示例已经加入。单值属性人工修正如有本体口径，调用者需显式提供 comparison。

身份 Action 示例（编号替换为实际回执；不是可直接执行的输入）：

```json
{
  "operationId": "unique-operation",
  "kind": "RematchIdentity",
  "targetId": "旧对象 UUID",
  "expectedRevision": 3,
  "identity": {"typeId": "Person", "namespace": "employee_no", "value": "E001"},
  "assertionIds": ["已审核来源声明 UUID"],
  "reason": "业务审核确认标识归属错误"
}
```

省略 newObjectId 时新建同类型对象；指定已有目标时必须带 expectedTargetRevision。返回 moves 的 old/newAssertionId 与 systemAt。反向纠错重新读取两个对象修订，以原对象为目标并选择返回的新声明。该动作仅迁移选中的当前来源声明/关系，不自动迁移人工覆盖、其他标识、未选择的关系，也不保证解决来源自身的错误编号。

## 验证证据

- TypeScript 类型检查通过；浏览器 JavaScript 语法检查和 Git 差异空白检查通过。
- 知识核心自动测试 21/21，无跳过：包括 2 条新增语义/口径用例及 3 条新增 PostgreSQL 场景，覆盖真假布尔、隔离、不同比较口径、修正证据回滚/旧历史、身份改绑/反向操作/再同步、统一时间边界及 schema 更新。
- 既有回归 680/680，通过约 397 秒。本轮没有修改旧 Agent 产品代码；最新小幅调整仅影响新知识模块，针对性复验通过。
- HTTP 集成覆盖实例权限、身份操作的管理员限制、修订证据查询、逐次任务 usage/费用未知、重试记录。
- 实际浏览器：连接本机合成实例，查看对象，提交标识改绑，提交带依据的人工修正，查看新值、旧值分歧及指定来源证据。没有把凭据或真实企业资料上传到第三方。
- 本轮没有重新调用 GLM 或其他付费模型；之前 GLM 输出回放通过不等于新提示的真实效果验证。新增语义漏标率仍需真实资料评测。

PostgreSQL 使用本轮独立本机测试集群 127.0.0.1:55440，工程数据与工作台合成数据分别使用独立数据库。测试日志与截图留在工作区，不提交运行数据、凭据或数据库文件。

## 代码评审

固定点为 `924e779`，审查该点之后本轮差异（含新文件）；需求依据为 PHASE1_DECISION §11。按两条独立遍历审查。

### Standards

已修正：身份纠错移入独立模块；修订证据引用用组合外键；历史标识用当前唯一索引；SQL 参数化；任务 usage 只保留数值，不保存提供方任意消息。未保留阻断性发现。

### Spec

已修正：身份迁移与绑定共用同一系统时间；回执时间可直接传入历史查询；重试保留逐次记录；证据不能附带于不支持的 Action 后被静默忽略。九项差距中的首期补齐及暂缓边界已分别落实；不把 pending 当完整否定推理或证明链，不把全实例角色当细粒度授权。未保留阻断性发现。

两轴未解决 Critical/High：0。剩余边界如下，不是生产验收结论。

## 仍未完成

真实业务场景、授权资料、阈值及冻结标注集仍需团队提供和确定；模板不是已完成评测。部门/字段/证据级权限、正式推导与支持组、模糊候选匹配和通用合并拆分、单位自动换算、条件求值、旧策略任意重放及生产容量未实现。

程序可以拦住被标注的否定/计划/条件声明，但不能保证模型没有误标为 actual。真实金额资料需配置属性口径；无口径工程样本保留兼容行为。当前页面仍是开发工作台，参数采用 JSON 输入，不是完整业务交互设计。
