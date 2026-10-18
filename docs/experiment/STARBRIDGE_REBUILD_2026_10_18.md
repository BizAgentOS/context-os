# 星桥原始数据清空重建验收（2026-10-18）

## 范围与环境

用户要求清空旧 mock 工作区，使用原星桥软件数据检验 v0.2.3 后的本体构建修复。使用当前本地代码和正式领域服务/API；没有新增 StarPlan 数据，没有人工预置标准本体，没有导入私有答案或 9 月 3 日更新批次。

旧运行工作区整体移动到 `local-state/backups/before-starbridge-rebuild-2026-10-18-2ffd2eb4/`，包含旧数据、快照、本体、对话及消费配置。活动目录仍为 `local-state/starbridge-video-2026-10-16/`，只保留模型设置、凭据文件与本地管理会话，重新创建业务库。源数据包和其他工作区未删除。

服务地址：`http://127.0.0.1:8798/`。模型凭据没有输出到日志或报告；没有发布新消费版本、创建 MCP 凭据或修改 Git Tag。

## 原始输入与程序结果

| 来源文件 | 记录数 | 程序对象 |
|---|---:|---|
| hr/people.csv | 13 | Person |
| hr/teams.csv | 8 | Team |
| tracker/users.csv | 14 | User |
| tracker/products.csv | 3 | Product |
| tracker/projects.csv | 2 | Project |
| tracker/releases.csv | 3 | Release |
| tracker/requirements.csv | 5 | Requirement |
| tracker/tasks.csv | 10 | Task |
| wiki/*.md | 5 份文档 | 补充已有定义与依据 |

合计 13 个来源文件、58 条结构化记录。上传前后 SHA-256 一致。初始程序构建自动采用，8 类概念全部保留 `origin=program`，8 类对象各有执行映射；未发生同实体附来源合并。

旧工作区基础版本 v28 有 25 个概念、17 条关系，包含文档标题、范围变更及中英文重复概念。新结构为 8 类业务对象、8 条关系，旧结果保留在备份，未移植进本次活动库。

## 已执行查询验收

通过 `/api/live/query` 查询 8 类全部对象，每类覆盖完整，共 58 条，身份无重复。生成的 8 条关系逐条以实际起点查询，目标字段匹配。

| 起点 | 关系字段 | 目标 |
|---|---|---|
| Person | team_id | Team |
| Team | lead_employee_no | Person |
| Product | owner_username | User |
| Release | product_key | Product |
| Requirement | owner_username | User |
| Requirement | target_release | Release |
| Requirement | project_key | Project |
| Task | requirement_key | Requirement |

另外实际查通：`FP-TASK-3203 → FP-REQ-3201 → FP-3.2 → FLOWPILOT`；需求负责人为账号 `cx_pm`；人员 `SB005` 所属团队为 `TEAM-FLOWPILOT`。

确认原值保留：`SB013.status=left`、`zhangwei_pm.account_status=active`；`ci-bot` 仍是账号；FlowPilot 的 `former_name=WorkflowX`；`FP-TASK-3203.blocked_by=FP-TASK-3204`；`FP-REQ-3204.target_release=FP-3.3`；`FP-3.2.forecast_date=2026-10-15`。同名项目 FP32 与版本 FP-3.2 的概念和实例身份分别保留。

## 本次暴露的缺口

1. **企业身份衔接**：档案已保存“星桥软件”，程序基础仍用“未设置企业”。第一份交付纪要不含企业名称，自动文档补充沿用占位名，被人工档案一致性检查拒绝并反复重试。发现后通过停止接口终止；修复及恢复结果见下节。
2. **唯一外键漏发现**：`Project.product_key → Product`、`Release.project_key → Project` 未生成。当前小样本中字段恰好唯一，被备用身份键规则跳过；后者空字符串还参与唯一值统计。
3. **普通责任字段**：`Task.assignee → User.username` 全部 10 条匹配，但只形成待核对提示；项目经理、研发负责人、发布经理字段也未形成可执行关系。
4. **自引用关系**：任务阻塞、人员汇报线、团队层级没有生成关系，当前发现算法排除同表/同实体连接。原始字段仍可读取。
5. **人员身份**：人员邮箱与账号邮箱 12/13 重合，仅作待核对提示；没有凭邮箱自动融合或建立归属关系。王晨旧邮箱需要有依据的身份对应；这与用户所需的跨系统同一对象归一仍有差距。
6. **文档更新后的映射跟随**：文档补充采用到 v20 后，现有执行映射仍引用 v18，所有概念显示未绑定。自动队列虽然设置 `rebindOnly`，执行时却仍调用完整结构发现；真实业务冲突触发完整构建保护，导致 8 个来源任务逐个失败。旧映射仍可按原版本查询，但不能当作当前基础版本的绑定。修复及恢复结果见下节。

以上第 2–4 项属于规则覆盖缺口；8 条已生成关系查询通过不代表业务关系已经完整。第 5 项保守处理符合身份约束，不能通过放宽邮箱合并来掩盖缺口。

## 企业身份修复与恢复

两条程序构建路径在企业身份缺失或明确未知时，读取人工确认的 `company.name`，生成固定档案 ID、版本、字段及摘要的依据。已有真实企业身份不自动改名。档案依据能定位原历史版本，在界面显示为企业档案而非用户对话。向导允许补齐未知企业；确认同文本的来源/建议名称也会记录真实人工确认，不连带确认其他建议字段。

通过正式领域服务离线重建，企业身份已恢复为“星桥软件”，基础采用 v18，仍为 8 个程序概念、8 条关系。恢复后首批 4 份文档成功补充至 v20，保留负责人、版本日期口径冲突，未增加结构。后续映射重绑问题另行修复，不删除冲突来绕过检查。

新增 5 个公开边界回归覆盖档案先行、快照/旧采样未知身份恢复、source/suggestion 同名确认、文档补充与旧依据定位。该阶段 `npm run check` 263/263 通过，类型检查、快照整链与前端 JS 语法检查通过。

### Standards

以本轮工作区 diff 对照项目开发约定，企业身份修复未发现必须修改的规范问题。复用领域服务、版本化成果和现有依据定位协议，未修改源数据或加入秘密。

### Spec

独立审查发现同名建议未升级为人工确认的 P2，已补公开服务回归并修复，复核关闭。企业隔离、历史版本、不可伪造档案依据和 UI 定位符合本轮范围。该阶段 Standards 0 项、Spec 0 项未解决发现。

## 映射重绑修复

自动队列现在使用独立重绑路径，只跟随已经采用且身份、结构稳定的基础版本。保留完整执行模型的字段、附来源、身份与关联键，对齐已采用名称/说明，经现有 `LiveMemory.propose/adopt` 及快照校验后生效。基础版本与冲突原样保留，完整 `ProgramBuilds` 冲突保护未放宽。

失败按基础/模型基线去重，不再换其他已完成来源反复尝试；显式重试可恢复仍被覆盖的持久化失败。保护待审基础与可采用映射候选。来源失效、版本变化、结构变化、停止均拒绝迟到采用；本次自动候选失败后仅在自身版本未变时归档，不清理用户候选。未覆盖来源不会留在 running 并报告成功。

新增 7 个公开边界回归覆盖正常语义跟随、真实业务冲突保留、失败去重与恢复、旧持久失败恢复、候选保护、采用阶段来源失败、结构变化及缩减模型覆盖。全量检查 269/269 通过（此后追加一条缩减模型回归），最终 `automatic-api.test.ts` 15/15 通过，覆盖该新增回归；`npm run verify:snapshots`、前端 JS 语法与 `git diff --check` 通过。真实库状态见下节。

### Standards

对照项目规范复核 `AutomaticApi` 与回归测试，复用共同服务与正常采用检查，未发现必须修改的规范问题。

### Spec

独立复核收口了协调来源未覆盖、过时来源占用重试名额、自身失败候选阻碍恢复三个边界；最终 0 项未解决必修发现。没有扩大到关系发现、跨系统身份自动合并或发布。该阶段 Standards 0 项、Spec 0 项未解决发现。

## 实际恢复状态

11:06 重启后按正式重试接口恢复，但任务随后收到暂停操作，当前基础 v20、4/5 文档已完成，重绑尚未采用。数据已保存，等待用户确认继续，未将旧映射可查询声称为当前版本绑定成功。

## 本地证据

下列文件均保存在忽略的 `local-state/`，不含密钥输出：

- `starbridge-rebuild-reset.json`：备份与重置记录。
- `starbridge-rebuild-import.json`：13 个源文件及哈希。
- `starbridge-rebuild-structured.json`：文档补充前的程序构建回执。
- `starbridge-rebuild-verification.json`：58 个对象与已生成关系的实际查询结果。
- `starbridge-rebuild-chain.json`：指定业务对象的关联链查询结果。
- `starbridge-rebuild-after-fix.json`：企业身份恢复的程序构建回执。
- `starbridge-rebuild-before-rebind-fix.json`：文档已补充但映射尚未跟随的真实状态。
- `starbridge-rebuild-all-check.log`、`starbridge-rebind-final.log`、`starbridge-rebuild-snapshots-final.log`：最终检查日志。

最终验证脚本另要求 5 份文档、8 个结构化来源全部完成，所有概念与关系映射绑定当前已采用基础版本；当前仍在未绑定断言失败，未覆盖之前通过的 v18 对象查询回执。

浏览器旧标签为已停止服务的错误页；Computer Use 读取该标签被浏览器协议策略拒绝。本轮先以正式管理接口和领域查询验收，未将其声称为浏览器验收通过。
