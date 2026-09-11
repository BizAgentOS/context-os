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

/** Explicitly scripted preview interactions. Only object results come from execution. */
export function heatingDemoDriver(): AgentDriver {
  return {
    async run(request: RunRequest) {
      const context = JSON.parse(request.input);
      const question = String(context.recentMessages?.findLast((item: {role: string}) => item.role === "user")?.content ?? "");
      const enterprise = context.enterprise;
      const verificationPrefix = "请用已保存的本体与真实对象验证这个业务问题：";
      const isVerification = context.page === "ontology" && question.startsWith(verificationPrefix);
      const requestedQuestion = isVerification
        ? question.slice(verificationPrefix.length).split("。请保存实际查询结果和依据；")[0]
        : question;
      let text = "这是本地演示问答。可以点击输入框里的示例问题，或直接打开背景中的企业信息、资料和对象；企业信息与资料用途也可以直接编辑。";
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
            const verification = await request.onTool("ontology_verify", {
              question: requestedQuestion,
              operations,
            }) as unknown as Artifact;
            const result = verification.content.result as Data;
            const values = (result.results as Data).recovery as Data | undefined;
            const items = values?.items as Data[] | undefined;
            const counts = new Map<string, number>();
            for (const item of items ?? []) {
              const status = String(item.status);
              counts.set(status, (counts.get(status) ?? 0) + 1);
            }
            text = items
              ? `已查证 ${items.length} 条投诉：${[...counts].map(([status, count]) => `${count} 条${statusLabels[status] || status}`).join("，")}。\n办结不能代表供热恢复，单户回访也不能代表整栋楼。结果与原始记录已保存在“验证”中。`
              : "已使用当前资料重新执行示例问题。请在“验证”中查看结果和原始依据，并判断是否符合预期。";
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
