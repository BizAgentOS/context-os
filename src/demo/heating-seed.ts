import { readFileSync } from "node:fs";
import type { AgentApplication } from "../agent/app.ts";
import type { Artifact, CanvasPage, Data } from "../agent/contracts.ts";
import { Workspace } from "../agent/workspace.ts";
import { SourcePolicyService } from "../agent/source-policy.ts";
import { reviewVerification } from "../agent/maintenance.ts";

const artifact = (value: unknown) => value as Artifact;
const csv = (columns: string[], rows: (string | number)[][]) =>
  [columns, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
const reference = (source: Artifact) => ({ sourceId: source.id, version: source.version });

/** Deliberately fictional, local demonstration. Existing enterprise memory is never replaced. */
export function seedHeatingDemo(app: AgentApplication) {
  if (app.memory.listArtifacts().length) return { seeded: false };
  const workspace = new Workspace(app.memory);
  const policies = new SourcePolicyService(app.memory);
  const add = (name: string, raw: string, purpose: string, owner: string, sensitiveFields: string[] = []) => {
    const source = workspace.upload(name, raw);
    if (source.status !== "ready") throw new Error(`演示资料解析失败：${name}`);
    policies.update({ sourceId: source.id, purpose, owner, sensitiveFields });
    return source;
  };
  const company = add(
    "企业经营与分工.md",
    readFileSync(new URL("../../data/samples/chengchuan-heating/sources/company/company-brief.md", import.meta.url), "utf8"),
    "确认企业经营范围、组织分工和服务规模。所有企业与地址均为虚构。",
    "运行调度 · 运行主管",
  );
  const rules = add(
    "投诉处理与恢复证据.md",
    `# 投诉处理与恢复证据\n\n演示资料 · COMP-RULES-001 · 已审批业务口径的简化示例\n\n工单办结只表示设备维修完成了本次处理任务。投诉办结是客户服务流程状态，两者都不能独立证明供热恢复。\n\n投诉关联到实际楼栋，楼栋归属于小区，小区由换热站服务；工单与回访必须引用明确的投诉编号。\n\n居民回访的已改善或已恢复构成该条投诉的正向反馈；未改善或未恢复构成负向反馈。未接通、没有回访属于证据不足。不同时间出现相反反馈时保留冲突，不自动选择最终状态。\n\n单户反馈不能推广为整栋楼或整个小区已经恢复；物业反馈与站点状态不能替代居民回访或实际测温。\n\n本演示不提供因果诊断、热力法规判断或生产控制。投诉联系方式仅供内部客服使用，不对外开放 API。\n`,
    "区分处理状态与恢复证据，约束本体中的恢复依据方法。",
    "客户服务 · 客服负责人",
  );
  const stations = add("换热站台账.csv", csv(
    ["站点编号", "站点名称", "热源接入点", "负责部门", "服务户数", "建筑面积㎡"],
    [["Z01", "清河站", "北城热源接入点", "运行调度", 600, 60000], ["Z02", "育新站", "北城热源接入点", "运行调度", 600, 60000]],
  ), "识别供热设施与服务范围；台账不代表实时运行状态。", "运行调度");
  const communityRows = [
    ["C01", "柳岸小区", "Z01"], ["C02", "松园小区", "Z01"],
    ["C03", "文苑小区", "Z02"], ["C04", "新桥小区", "Z02"],
  ];
  const communities = add("服务小区.csv", csv(
    ["小区编号", "小区名称", "站点编号", "楼栋数", "服务户数", "建筑面积㎡"],
    communityRows.map(([id, name, station]) => [id, name, station, 3, 300, 30000]),
  ), "将地址对应到责任换热站，支持按小区复盘。", "运行调度");
  const buildings = add("楼栋台账.csv", csv(
    ["楼栋编号", "楼栋名称", "小区编号", "户数", "建筑面积㎡"],
    communityRows.flatMap(([id, name], index) => [1, 2, 3].map((number) => [
      `B${String(index * 3 + number).padStart(2, "0")}`, `${name}${number}号楼`, id, 100, 10000,
    ])),
  ), "统一投诉地址与楼栋身份；户数及面积属于企业台账口径。", "运行调度");
  const complaints = add("居民投诉.csv", csv(
    ["投诉编号", "楼栋编号", "受理时间", "诉求", "处理状态", "联系手机"],
    [
      ["TS001", "B01", "2026-01-05 08:35", "卧室暖气不热", "已办结", "演示手机号-001"],
      ["TS002", "B04", "2026-01-05 09:10", "连续两天室内偏冷", "已办结", "演示手机号-002"],
      ["TS003", "B07", "2026-01-06 10:20", "客厅散热器温度低", "已办结", "演示手机号-003"],
      ["TS004", "B10", "2026-01-06 14:45", "晚间供暖效果下降", "处理中", "演示手机号-004"],
      ["TS005", "B02", "2026-01-07 08:50", "入户支路有气堵声", "已办结", "演示手机号-005"],
      ["TS006", "B11", "2026-01-07 17:05", "次卧温度仍然偏低", "处理中", "演示手机号-006"],
    ],
  ), "记录居民原始诉求、地址和受理状态。联系方式仅供客服内部使用。", "客户服务", ["联系手机"]);
  const orders = add("维修工单.csv", csv(
    ["工单编号", "投诉编号", "负责部门", "处理动作", "工单状态", "完成时间"],
    [
      ["GD001", "TS001", "设备维修", "入户排气并检查阀门", "已办结", "2026-01-05 11:10"],
      ["GD002", "TS002", "设备维修", "清理入户过滤器", "已办结", "2026-01-05 13:20"],
      ["GD003", "TS003", "设备维修", "检查支路与阀门开度", "已办结", "2026-01-06 15:40"],
      ["GD004", "TS004", "设备维修", "安排晚间复测", "待复查", ""],
      ["GD005", "TS005", "设备维修", "支路排气", "已办结", "2026-01-07 11:25"],
      ["GD006", "TS006", "设备维修", "预约入户检查", "待上门", ""],
    ],
  ), "保留维修处理动作和办结时间，与恢复证据分别读取。", "设备维修");
  const callbacks = add("客服回访.csv", csv(
    ["回访编号", "投诉编号", "回访时间", "反馈结果", "居民反馈"],
    [
      ["HF001", "TS001", "2026-01-05 18:20", "已改善", "居民反馈卧室暖气已明显变热"],
      ["HF002", "TS002", "2026-01-05 18:45", "未改善", "居民反馈过滤器清理后室内仍偏冷"],
      ["HF004", "TS004", "2026-01-07 09:05", "未接通", "两次拨打均未接通，等待补充反馈"],
      ["HF005", "TS005", "2026-01-07 18:10", "已改善", "居民反馈气堵声消失，暖气改善"],
      ["HF006", "TS006", "2026-01-08 09:30", "未改善", "居民反馈次卧仍偏冷，等待上门"],
    ],
  ), "区分正向反馈、负向反馈与未知，不能将单户结论外推为楼栋恢复。", "客户服务");

  workspace.execute("profile_update", {
    statements: Object.entries({
      "company.name": "澄川热力有限公司",
      "company.business": "从外部采购热量，为澄川市北城区居民提供供热运行、设备维护与客户服务。",
      "company.scope": "2 座换热站 · 4 个小区 · 12 栋楼 · 1,200 户 · 12 万㎡",
      "company.departments": "运行调度、设备维修、客户服务",
      "company.goal": "找出已办结投诉中，哪些仍有未改善反馈，哪些还缺恢复依据。",
      "company.boundary": "不自营热源生产；工单办结、居民反馈和楼栋恢复分别判断。",
    }).map(([key, text]) => ({ key, text, origin: "source", evidence: [reference(company)] })),
  });

  // Save the document outline first so the later adopted mapping opens by default.
  const outline = artifact(workspace.execute("ontology_outline", {
    title: "处理完成与恢复证据",
    purpose: "先澄清业务含义，再将可以验证的含义映射到具体记录。",
    concepts: [
      { name: "工单办结", description: "本次维修任务的流程状态，只能证明已记录的处理动作完成。", evidence: [reference(rules)] },
      { name: "居民回访", description: "居民对本条投诉的明确改善、未改善或未知反馈。", evidence: [reference(rules)] },
      { name: "楼栋恢复", description: "楼栋范围的业务判断，需要相应范围和时间的实际依据；本演示资料尚不支持直接证明。", evidence: [reference(rules)] },
    ],
    relations: [
      { name: "之后核对", from: "工单办结", to: "居民回访", description: "办结之后另行检查居民反馈，保留证据缺口。", evidence: [reference(rules)] },
      { name: "不能单独证明", from: "居民回访", to: "楼栋恢复", description: "单户反馈不能自动外推为全楼恢复。", evidence: [reference(rules)] },
    ],
  }));
  const types = [
    { name: "换热站", description: "承担片区热量换热与分配的设施；以运行台账编号识别。", sourceId: stations.id, idField: "站点编号", fields: { 名称: "站点名称", 热源接入点: "热源接入点", 负责部门: "负责部门", 服务户数: "服务户数", 建筑面积: "建筑面积㎡" } },
    { name: "小区", description: "企业服务的居民小区，明确归属一个责任换热站。", sourceId: communities.id, idField: "小区编号", fields: { 名称: "小区名称", 站点编号: "站点编号", 楼栋数: "楼栋数", 服务户数: "服务户数", 建筑面积: "建筑面积㎡" } },
    { name: "楼栋", description: "投诉地址定位的最小公共设施范围；单户反馈不等于楼栋结论。", sourceId: buildings.id, idField: "楼栋编号", fields: { 名称: "楼栋名称", 小区编号: "小区编号", 户数: "户数", 建筑面积: "建筑面积㎡" } },
    { name: "投诉", description: "一次有独立编号的居民诉求，处理状态与恢复依据分别保存。", sourceId: complaints.id, idField: "投诉编号", fields: { 楼栋编号: "楼栋编号", 受理时间: "受理时间", 诉求: "诉求", 处理状态: "处理状态", 联系手机: "联系手机" } },
    { name: "工单", description: "为处理投诉而派发的维修任务，办结不直接表示供热恢复。", sourceId: orders.id, idField: "工单编号", fields: { 投诉编号: "投诉编号", 负责部门: "负责部门", 处理动作: "处理动作", 工单状态: "工单状态", 完成时间: "完成时间" } },
    { name: "回访", description: "带时间的居民反馈记录；没有反馈必须保留为未知。", sourceId: callbacks.id, idField: "回访编号", fields: { 投诉编号: "投诉编号", 回访时间: "回访时间", 反馈结果: "反馈结果", 居民反馈: "居民反馈" } },
  ];
  const relations = [
    { name: "服务小区", from: "换热站", to: "小区", fromField: "$id", toField: "站点编号" },
    { name: "责任换热站", from: "小区", to: "换热站", fromField: "站点编号", toField: "$id" },
    { name: "包含楼栋", from: "小区", to: "楼栋", fromField: "$id", toField: "小区编号" },
    { name: "所属小区", from: "楼栋", to: "小区", fromField: "小区编号", toField: "$id" },
    { name: "居民投诉", from: "楼栋", to: "投诉", fromField: "$id", toField: "楼栋编号" },
    { name: "所在楼栋", from: "投诉", to: "楼栋", fromField: "楼栋编号", toField: "$id" },
    { name: "处理工单", from: "投诉", to: "工单", fromField: "$id", toField: "投诉编号" },
    { name: "居民回访", from: "投诉", to: "回访", fromField: "$id", toField: "投诉编号" },
    { name: "关联投诉", from: "工单", to: "投诉", fromField: "投诉编号", toField: "$id" },
    { name: "关联投诉", from: "回访", to: "投诉", fromField: "投诉编号", toField: "$id" },
  ];
  const candidate = artifact(workspace.execute("ontology_propose", {
    title: "澄川热力 · 供热服务记忆",
    purpose: "沿换热站、小区、楼栋连接投诉、工单与回访，逐条检查办结后是否有恢复依据。",
    types, relations,
    functions: [{ name: "检查恢复依据", implementation: "recovery_evidence", type: "投诉", relation: "居民回访", field: "反馈结果", evidence: [reference(rules)] }],
    evidence: [company, rules, stations, communities, buildings, complaints, orders, callbacks].map(reference),
  }));
  const preview = artifact(workspace.execute("ontology_preview", { id: candidate.id, version: candidate.version }));
  const model = workspace.adopt(preview.id, preview.version);

  const verificationRecords = [artifact(workspace.execute("ontology_verify", {
    question: "哪些投诉还缺恢复依据？",
    operations: [
      { op: "query", type: "投诉", limit: 20, as: "complaints" },
      { op: "call", input: "$complaints", method: "检查恢复依据", as: "recovery" },
    ],
  })), ...[
    { id: "TS002", question: "松园小区 1 号楼的工单已办结，是否仍有未改善反馈？" },
    { id: "TS003", question: "文苑小区 1 号楼这条投诉，办结后还缺什么恢复依据？" },
  ].map(({ id, question }) => artifact(workspace.execute("ontology_verify", {
    question,
    operations: [
      { op: "get", type: "投诉", id, as: "complaint" },
      { op: "related", input: "$complaint", relation: "所在楼栋", as: "building" },
      { op: "related", input: "$complaint", relation: "处理工单", as: "orders" },
      { op: "related", input: "$complaint", relation: "居民回访", as: "callbacks" },
      { op: "call", input: "$complaint", method: "检查恢复依据", as: "recovery" },
    ],
  })))];
  reviewVerification(app.memory, {
    id: verificationRecords[0].id, version: verificationRecords[0].version, status: "matches_expectation",
  });

  const createConsumer = (name: string, purpose: string, grants: Data[]) => {
    const draft = app.consumption.propose({ name, purpose, modelId: model.id, modelVersion: model.version, grants });
    return app.consumption.activate(draft.id, draft.version);
  };
  const customerService = createConsumer("客服工作台", "查询投诉、维修动作和回访结果，识别仍需跟进的投诉。", [
    { type: "投诉", fields: ["$id", "楼栋编号", "诉求", "处理状态"], relations: ["处理工单", "居民回访"] },
    { type: "工单", fields: ["$id", "投诉编号", "处理动作", "工单状态", "完成时间"], relations: [] },
    { type: "回访", fields: ["$id", "投诉编号", "回访时间", "反馈结果", "居民反馈"], relations: [] },
  ]);
  const dispatch = createConsumer("运行调度看板", "读取供热片区与楼栋台账，核对各换热站服务范围。", [
    { type: "换热站", fields: ["$id", "名称", "服务户数", "建筑面积"], relations: ["服务小区"] },
    { type: "小区", fields: ["$id", "名称", "站点编号", "楼栋数", "服务户数"], relations: ["包含楼栋"] },
    { type: "楼栋", fields: ["$id", "名称", "小区编号", "户数"], relations: [] },
  ]);
  const retired = createConsumer("旧版物业查询", "停用的试点接入，保留历史授权和撤销后的拒绝记录。", [
    { type: "小区", fields: ["$id", "名称"], relations: [] },
  ]);
  const request = (apiKey: string, query: Record<string, string>, expectedStatus: number) => {
    const response = app.consumption.handle({ method: "GET", path: "/v1/objects", query: new URLSearchParams(query), authorization: `Bearer ${apiKey}` });
    if (response.status !== expectedStatus) throw new Error(`演示消费校验失败：预期 ${expectedStatus}，实际 ${response.status}`);
  };
  request(customerService.apiKey, { type: "投诉", id: "TS002" }, 200);
  request(customerService.apiKey, { type: "投诉", id: "TS002", relation: "居民回访" }, 200);
  request(dispatch.apiKey, { type: "换热站", id: "Z01", relation: "服务小区" }, 200);
  request(dispatch.apiKey, { type: "小区", id: "C03", relation: "包含楼栋" }, 200);
  request(customerService.apiKey, { type: "投诉", fields: "联系手机" }, 403);
  request(retired.apiKey, { type: "小区" }, 200);
  app.consumption.revoke(retired.consumer.id, retired.consumer.version);
  request(retired.apiKey, { type: "小区" }, 401);

  const taskIds: Partial<Record<CanvasPage, string>> = {};
  const prompts: Record<CanvasPage, string> = {
    setup: "澄川热力的企业信息和 8 份演示资料已接入。点开可查看或补充信息、原始记录与使用范围。",
    ontology: "6 类对象已经连接起来。可以从投诉查看处理工单和回访，或用一个业务问题验证定义。",
    consumption: "2 个应用正在按授权读取企业记忆，1 个旧接入已撤销。点开调用方可查看范围和记录。",
  };
  for (const page of Object.keys(prompts) as CanvasPage[]) {
    const task = app.memory.createTask(`热力公司演示 · ${page}`);
    taskIds[page] = task.id;
    app.memory.addMessage(task.id, "assistant", prompts[page]);
  }
  app.memory.saveCanvas({ layoutVersion: 2, setupSection: "company", currentPage: "setup", completed: ["setup", "ontology"], reached: ["setup", "ontology", "consumption"], taskIds });
  return { seeded: true, model: { id: model.id, version: model.version }, outline: { id: outline.id, version: outline.version }, sourceCount: 8, objectCount: 35 };
}
