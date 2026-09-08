import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact, CanvasPage, Data, Json } from "../agent/contracts.ts";
import { createHeatingDemo } from "./server.ts";

export interface HeatingShareSnapshot {
  formatVersion: 1;
  pages: Record<CanvasPage, Data>;
  routes: Record<string, Json>;
  answers: Record<CanvasPage, { question: string; answer: string }>;
}

const pages: CanvasPage[] = ["company", "sources", "ontology", "consumption"];
const json = (value: unknown): Data => JSON.parse(JSON.stringify(value));

/** Object collections are stored in full; the offline reader applies pagination. */
export function shareRouteKey(path: string) {
  const url = new URL(path, "https://share.invalid");
  if (url.pathname === "/api/objects") {
    url.searchParams.delete("offset");
    url.searchParams.delete("limit");
  }
  url.searchParams.sort();
  return url.pathname + (url.searchParams.size ? `?${url.searchParams}` : "");
}

function assertShareable(value: Json): void {
  if (typeof value === "string") {
    if (
      /de_(?:admin|consumer)_[A-Za-z0-9_-]+|\/Users\/|\/private\/var\/|\/tmp\//.test(
        value,
      )
    )
      throw new Error("分享快照包含本机路径或凭据，已停止导出");
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (
      /^(?:apiKey|token|adminToken|authorization|password|secret|credentialVersion)$/i.test(
        key,
      )
    )
      throw new Error("分享快照包含凭据字段，已停止导出");
    assertShareable(item);
  }
}

/**
 * Only fixed, fictional seed data enters a share. Never open the live demo's
 * directory, a user's workspace, saved model settings or credential database.
 */
export async function createHeatingShareSnapshot(): Promise<HeatingShareSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), "dataengine-share-"));
  let service: Awaited<ReturnType<typeof createHeatingDemo>> | undefined;
  try {
    service = await createHeatingDemo(directory);
    const app = service.app;
    const snapshotPages = {} as Record<CanvasPage, Data>;
    const routes: Record<string, Json> = {};
    const save = (path: string, value: unknown) => {
      routes[shareRouteKey(path)] = json(value);
    };

    for (const page of pages) {
      snapshotPages[page] = json({
        ...app.canvasState(page),
        currentPage: page,
        // No service/model settings are needed for a read-only offline replay.
        model: { configured: true, provider: "offline", model: "预置演示" },
        demo: { name: "澄川热力" },
      });
      save(`/api/canvas?page=${page}`, snapshotPages[page]);
    }
    save("/api/canvas/bootstrap", snapshotPages.company);
    save("/api/canvas", snapshotPages.company);

    const artifacts: Artifact[] = [];
    for (const latest of app.memory.listArtifacts()) {
      save(`/api/artifacts/${encodeURIComponent(latest.id)}`, latest);
      for (let version = 1; version <= latest.version; version++) {
        const artifact = app.memory.getArtifact(latest.id, version);
        artifacts.push(artifact);
        save(
          `/api/artifacts/${encodeURIComponent(artifact.id)}?version=${version}`,
          artifact,
        );
      }
    }

    // Capture the exact object/query API used by definition, neighborhood and
    // verification views, including historical versions referenced by evidence.
    for (const artifact of artifacts) {
      const canRead =
        artifact.kind === "verification" ||
        (artifact.kind === "ontology" &&
          artifact.content.preview &&
          (artifact.content.validation as Data | undefined)?.valid === true);
      if (!canRead) continue;
      const query = (extra: Record<string, string> = {}) => {
        const params = new URLSearchParams({
          artifactId: artifact.id,
          version: String(artifact.version),
          ...extra,
        });
        const result = app.objectDetails(params);
        save(`/api/objects?${params}`, result);
        return result;
      };
      const definition = query();
      for (const type of definition.types) {
        const list = query({ type: type.name, limit: "100" });
        const collection = list.result as Data;
        const items = collection.items as Data[];
        if (collection.total !== items.length)
          throw new Error("分享演示对象超过完整导出的范围");
        for (const entity of items) {
          const id = String(entity.id);
          query({ type: type.name, id });
          for (const relation of type.relations)
            query({ type: type.name, id, relation: relation.name });
        }
      }
    }

    const consumers = app.consumption.list();
    save("/api/consumers", { consumers, audit: app.consumption.logs() });
    for (const consumer of consumers)
      save(`/api/consumers?consumerId=${encodeURIComponent(consumer.id)}`, {
        consumers,
        audit: app.consumption.logs(consumer.id),
      });

    const facts = snapshotPages.company.profile as Data;
    const statements = facts.content as Data;
    const statement = (key: string) =>
      (statements.statements as Data[]).find((item) => item.key === key)?.text;
    const broadCheck = app.memory
      .listArtifacts("verification")
      .find((item) => item.content.question === "哪些投诉还缺恢复依据？")!;
    const results = (broadCheck.content.result as Data).results as Data;
    const recovery = (results.recovery as Data).items as Data[];
    const count = (status: string) =>
      recovery.filter((item) => item.status === status).length;
    const active = consumers.filter((item) => item.status === "active");
    const snapshot: HeatingShareSnapshot = {
      formatVersion: 1,
      pages: snapshotPages,
      routes,
      answers: {
        company: {
          question: "这家企业是什么样的？",
          answer: [
            "company.name",
            "company.business",
            "company.scope",
            "company.goal",
          ]
            .map(statement)
            .join("\n"),
        },
        sources: {
          question: "这些资料如何连起来？",
          answer:
            "8 份虚构资料通过编号相连：换热站连接小区与楼栋，投诉关联楼栋，工单和回访关联投诉。业务文档定义处理状态与恢复依据的区别。点开资料可以查看原文、负责人及限制字段。",
        },
        ontology: {
          question: "哪些投诉还缺恢复依据？",
          answer: `预存验证共查证 ${recovery.length} 条投诉：${count("positive_callback_evidence")} 条回访显示已改善，${count("negative_callback_evidence")} 条显示未改善，${count("no_evidence")} 条缺少回访，${count("unknown_callback_evidence")} 条反馈不明确。\n工单办结不能代表供热恢复，单户回访也不能证明整栋楼恢复。可在“验证”中查看结果与原始依据。`,
        },
        consumption: {
          question: "谁可以调用这些记忆？",
          answer: `预置演示中启用的调用方是${active.map((item) => item.title).join("、")}；旧版物业查询已停用。各调用方只能读取授权对象、字段和关系，居民联系方式不对外开放。此 HTML 展示已有范围和记录，不提供真实 API 接入。`,
        },
      },
    };
    assertShareable(json(snapshot));
    return snapshot;
  } finally {
    try {
      await service?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
