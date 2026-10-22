import { randomUUID } from "node:crypto";
import type { AgentDriver, RunRequest } from "../agent/runtime.ts";
import type { Artifact, Data } from "../agent/contracts.ts";

const statusLabels: Record<string, string> = {
  positive_callback_evidence: "回访显示已改善",
  negative_callback_evidence: "回访显示未改善",
  conflicting_callback_evidence: "回访证据有冲突",
  unknown_callback_evidence: "回访结果不明确",
  no_evidence: "缺少回访依据",
};

/** The current QA host exposes only semantic reads; demo answers follow those same receipts. */
async function qaExample(request: RunRequest, question: string) {
  const directory = await request.onTool('ontology_describe', {}) as any;
  const entities = directory.result.entities as Data[], relations = directory.result.relations as Data[];
  if (question === '谁可以调用这些记忆？') return `本地脚本示例：当前视图可读 ${entities.length} 类对象、${relations.length} 条关系。本轮未读取接入授权，不能据此判断谁可调用；请在发布与接入页查看实际接入方和授权范围。演示写操作不会签发真实密钥。`;
  if (question !== '哪些投诉还缺恢复依据？') return '本地脚本示例：已读取当前本体目录。可试问“哪些投诉还缺恢复依据？”；自定义分析需要接入真实模型。';
  const complaint = entities.find(item => item.name === '投诉'), callback = entities.find(item => item.name === '回访');
  const relation = relations.find(item => item.name === '居民回访' && item.from === complaint?.id && item.to === callback?.id);
  const feedback = (callback?.properties as Data[] | undefined)?.find(item => item.name === '反馈结果');
  if (!complaint || !relation || !feedback) return '当前本体缺少投诉到回访的可读定义，不能判断恢复依据。';
  const read = await request.onTool('objects_query', {target: {entityTypeId: complaint.id}}) as any;
  if (read.status !== 'available' || !read.result.coverage?.complete) return '当前投诉读取不完整，不能给出完整恢复依据统计。请查看本轮实际读取回执。';
  const counts = new Map<string, number>();
  for (const item of read.result.items as Data[]) {
    const result = await request.onTool('relations_traverse', {target: {entityTypeId: complaint.id, id: item.$id}, traverse: [{relationTypeId: relation.id}], fields: [feedback.id]}) as any;
    const items = (result.result.items ?? []) as Data[];
    if (!result.result.coverage?.complete || result.status !== 'available')
      return '部分回访读取不足，不能给出完整恢复依据统计。请查看本轮实际读取回执。';
    const values = items.map(value => String((value.values as Data)[String(feedback.id)]));
    const positive = values.some(value => ['已改善', '已恢复'].includes(value)), negative = values.some(value => ['未改善', '未恢复'].includes(value));
    const status = !items.length ? 'no_evidence' : positive && negative ? 'conflicting_callback_evidence' : negative ? 'negative_callback_evidence' : positive ? 'positive_callback_evidence' : 'unknown_callback_evidence';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return `本地脚本示例，已实际读取 ${read.result.items.length} 条投诉及其回访：${[...counts].map(([status, count]) => `${count} 条${statusLabels[status]}`).join('，')}。办结不能代表供热恢复，单户回访不能代表整栋楼。原始结果与覆盖范围见本轮读取回执。`;
}

/** Explicitly scripted preview interactions. Only object results come from execution. */
export function heatingDemoDriver(): AgentDriver {
  return {
    async run(request: RunRequest) {
      const context = JSON.parse(request.input);
      const question = String(context.question ?? context.recentMessages?.findLast((item: {role: string}) => item.role === "user")?.content ?? "");
      if (context.mode === 'qa') {
        const text = await qaExample(request, question);
        request.onEvent('assistant.delta', {text});
        return {text, sessionId: `demo-${randomUUID()}`, runId: randomUUID()};
      }
      const enterprise = await request.onTool("workspace_overview", {}) as any;
      const verificationPrefix = "请用已保存的本体与真实对象验证这个业务问题：";
      const isVerification = context.page === "ontology" && question.startsWith(verificationPrefix);
      const requestedQuestion = isVerification
        ? question.slice(verificationPrefix.length).split("。请保存实际查询结果和依据；")[0]
        : question;
      let text = "这是本地演示问答。可以点击输入框里的示例问题，或直接打开背景中的企业信息、资料和对象；编辑与发布操作仅作模拟，不保存实际变更。";
      if (context.page === "setup" && question === "这家企业是什么样的？") {
        const facts = enterprise.profile?.content.statements ?? [];
        const value = (key: string) => facts.find((item: {key: string}) => item.key === key)?.text;
        text = [value("company.name"), value("company.business"), value("company.scope"), value("company.goal")].filter(Boolean).join("\n");
      } else if (context.page === "setup" && question === "这些资料如何连起来？") {
        text = `这里已保存 ${enterprise.sources.length} 份资料。设施台账通过编号连接站、小区和楼栋；投诉关联楼栋，工单和回访再关联投诉。业务文档说明各类记录的含义。可以打开任一资料查看原文、负责人及敏感字段。`;
      } else if (context.page === "ontology" && (isVerification || question === "哪些投诉还缺恢复依据？")) {
        const ref = enterprise.models.find((item: Artifact) => item.status === "adopted");
        if (ref) {
          const model = await request.onTool("memory_read", {id: ref.id, version: ref.version}) as unknown as Artifact;
          const methods = model.content.functions as Data[];
          const method = methods.find((item) => item.implementation === "recovery_evidence");
          if (method) {
            let operations: Data[] | undefined;
            if (requestedQuestion === "哪些投诉还缺恢复依据？") {
              operations = [
                {op: "query", type: method.type, limit: 100, as: "complaints"},
                {op: "call", input: "$complaints", method: method.name, as: "recovery"},
              ];
            } else {
              for (const saved of enterprise.verifications) {
                const record = await request.onTool("memory_read", {id: saved.id, version: saved.version}) as unknown as Artifact;
                if (record.content.question === requestedQuestion) {
                  operations = record.content.operations as Data[];
                  break;
                }
              }
            }
            if (!operations) return {
              text: "演示问答支持重新执行已保存的问题。可以试问“哪些投诉还缺恢复依据？”，或打开已有验证再执行；自定义问题需要接入真实模型。",
              sessionId: `demo-${randomUUID()}`, runId: randomUUID(),
            };
            const result = await request.onTool("object_execute", {operations}) as unknown as Data;
            const values = (result.results as Data).recovery as Data | undefined;
            const items = values?.items as Data[] | undefined;
            const counts = new Map<string, number>();
            for (const item of items ?? []) {
              const status = String(item.status);
              counts.set(status, (counts.get(status) ?? 0) + 1);
            }
            text = items
              ? `已查证 ${items.length} 条投诉：${[...counts].map(([status, count]) => `${count} 条${statusLabels[status] || status}`).join("，")}。\n办结不能代表供热恢复，单户回访也不能代表整栋楼。本轮查询表与读取过程可在助手面板查看，原始验证记录继续保留。`
              : "已使用当前资料重新执行示例问题。请在助手面板查看本轮结果，并判断是否符合预期。";
          }
        }
      } else if (context.page === "consumption" && question === "谁可以调用这些记忆？") {
        const consumers = context.consumption?.consumers ?? [];
        const active = consumers.filter((item: Artifact) => item.status === "active");
        const inactive = consumers.filter((item: Artifact) => item.status !== "active");
        text = `当前启用：${active.map((item: Artifact) => item.title).join("、") || "无"}。${inactive.length ? `其他调用方：${inactive.map((item: Artifact) => item.title).join("、")}。` : ""}\n每个调用方只能读取列明的对象与字段，居民联系方式受限制。点击调用方可查看具体范围、访问记录，也可以停用。`;
      } else if (/^我上传了 /.test(question)) {
        text = "资料已保存在演示空间，可以在数据页查看。演示问答不会自动为新资料创建定义；这里的本体是预先准备的热力业务示例。";
      }
      request.onEvent("assistant.delta", {text});
      return {text, sessionId: `demo-${randomUUID()}`, runId: randomUUID()};
    },
    async stop() {},
    async close() {},
  };
}
