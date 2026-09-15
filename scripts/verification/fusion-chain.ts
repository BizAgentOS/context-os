/** Manual, paid real-model acceptance; never part of the automatic test suite. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createServer } from "../../src/agent/server.ts";
import {
  createFusionSources,
  primaryCapability,
  supplementCapability,
} from "../../tests/agent/fusion-fixture.ts";
import {
  createKnowledgeSource,
  knowledgeCapability,
} from "../../tests/agent/knowledge-fixture.ts";
import {
  createMetricSource,
  metricCapability,
} from "../../tests/agent/metrics-fixture.ts";

if (!process.argv.includes("--real"))
  throw new Error(
    "使用 --real 明确启动已配置的真实模型；此验收会产生模型调用费用。",
  );
const keepOpen = process.argv.includes("--keep-open");
const directory = mkdtempSync(join(tmpdir(), "dataengine-chain-"));
const report: any = {
  startedAt: new Date().toISOString(),
  scenario: "fictional-heating",
  scope:
    "public HTTP/MCP and real-model flow; browser and legacy/offline acceptance are separate",
  realModel: true,
  runs: [],
  checks: [],
  status: "running",
};
const reportPath = join(directory, "acceptance.json");
const authPath = join(directory, "browser-auth.json");
const secretsPath = join(directory, "consumer-keys.json");
const credentials = new Set<string>();
let records: Awaited<ReturnType<typeof createFusionSources>> | undefined;
let knowledge: Awaited<ReturnType<typeof createKnowledgeSource>> | undefined;
let metrics: Awaited<ReturnType<typeof createMetricSource>> | undefined;
let service: Awaited<ReturnType<typeof createServer>> | undefined;
let origin = "";
let stage = "start";
const save = () =>
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
const checkpoint = (name: string, facts: any = {}) => {
  report.checks.push({ name, ...facts });
  save();
  console.log(JSON.stringify({ stage: name, ...facts }));
};
const api = async (path: string, body?: unknown): Promise<any> => {
  const r = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-dataengine-token": service!.adminToken,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90000),
  });
  const result = await r.json();
  if (!r.ok)
    throw new Error(`${path}: HTTP ${r.status}: ${JSON.stringify(result)}`);
  return result;
};
const external = async (path: string, key: string) => {
  const r = await fetch(origin + path, {
    headers: { authorization: "Bearer " + key },
    signal: AbortSignal.timeout(30000),
  });
  return { status: r.status, body: (await r.json()) as any };
};
const agent = async (page: string, text: string) => {
  console.log(JSON.stringify({ stage: "agent", page, task: stage }));
  await api("/api/canvas/navigate", { page });
  await api("/api/canvas/message", { page, text, messageId: randomUUID() });
  await service!.app.idle();
  return recordRun();
};
const recordRun = async () => {
  const canvas = await api("/api/canvas");
  const state = await api("/api/state");
  const events = state.events as any[];
  const start = events.findLastIndex((e) => e.kind === "run.started");
  const run = events.slice(start);
  const names = run
    .filter((e) => e.kind === "operation.completed")
    .map((e) => e.data.name);
  const failure = run.find(
    (e) => ["run.ended", "run.result"].includes(e.kind) && e.data?.error,
  )?.data.error;
  report.runs.push({
    stage,
    runId: run.find((e) => e.kind === "run.started")?.data.runId,
    error: failure ?? null,
    toolErrors: run
      .filter((e) => e.kind === "operation.failed")
      .map((e) => e.data),
    tools: names,
    message: canvas.messages.filter((m: any) => m.role === "assistant").at(-1)
      ?.content,
  });
  save();
  assert(!canvas.busy, "Agent must finish");
  assert(
    start >= 0 && run.some((e) => e.kind === "run.result") && !failure,
    "Agent run must finish successfully; inspect saved run record",
  );
  return canvas;
};
const ref = (a: any) => ({ id: a.id, version: a.version });
async function close() {
  const failures: string[] = [];
  const results = await Promise.allSettled(
    [service, records, knowledge, metrics].map((resource) =>
      Promise.resolve().then(() => resource?.close()),
    ),
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") failures.push("resource-" + i);
  });
  for (const path of [authPath, secretsPath]) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        failures.push("credential-cleanup");
    }
  }
  if (failures.length) {
    report.status = "failed";
    report.cleanupFailures = failures;
    save();
    process.exitCode = 1;
  }
}
function verifyBundle(
  bundle: any,
  base: any,
  knowledgeId: string,
  metricId: string,
) {
  const c = bundle.content,
    q = c.request.objects;
  assert.equal(q.modelId, base.id);
  assert.equal(q.modelVersion, base.version);
  assert(
    q.type === "投诉" ||
      q.conceptId ===
        base.content.types.find((t: any) => t.name === "投诉").conceptId,
    "expected complaint type or its concept identity",
  );
  assert.equal(q.id, "TS002");
  for (const field of ["$id", "状态", "实际反馈", "上门次数", "所属站"])
    assert(q.fields.includes(field), "missing requested field: " + field);
  assert.equal(c.objects.status, "read");
  assert.deepEqual(
    c.objects.result.items.map((i: any) => i.$id),
    ["TS002"],
  );
  assert.equal(c.objects.result.items[0].实际反馈, "未改善");
  assert.equal(c.objects.result.items[0].上门次数, 0);
  assert.equal(c.objects.result.evidence[0].properties.状态.status, "conflict");
  assert.equal(c.documents.length, 1);
  assert.equal(c.metrics.length, 1);
  const doc = c.documents[0],
    metric = c.metrics[0];
  assert.equal(doc.status, "read");
  assert.equal(doc.request.sourceId, knowledgeId);
  assert.equal(doc.request.segmentId, "guide-1");
  assert.equal(doc.request.revision, "r1");
  assert(doc.request.limit <= 100);
  assert(doc.result.text.length <= 100);
  assert.match(doc.result.text, /居民投诉由客服部门登记/);
  assert.equal(doc.association, "declared_context");
  assert.equal(metric.status, "read");
  assert.equal(metric.request.sourceId, metricId);
  assert.equal(metric.result.definition.id, "resolution_rate");
  assert.equal(metric.result.query.start, "2026-01-01");
  assert.equal(metric.result.query.end, "2026-02-01");
  assert.deepEqual(metric.result.query.where, { station: "清河站" });
  assert(metric.result.query.limit <= 1);
  assert.equal(metric.result.items.length, 1);
  assert.equal(metric.result.items[0].value, 80);
  assert.equal(metric.result.items[0].dimensions.station, "清河站");
  assert.equal(metric.association.status, "context_only");
}

try {
  records = await createFusionSources();
  knowledge = await createKnowledgeSource();
  metrics = await createMetricSource();
  records.state.mode = "conflict";
  records.primary.forEach((r, i) =>
    Object.assign(r, { station: i === 0 ? "清河站" : "育新站" }),
  );
  service = await createServer({ directory });
  credentials.add(service.adminToken);
  await new Promise<void>((resolve) =>
    service!.server.listen(0, "127.0.0.1", resolve),
  );
  origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  console.log(JSON.stringify({ origin, directory, reportPath }));
  stage = "foundation_document";
  await api("/api/canvas/upload", {
    page: "setup",
    name: "澄川热力基础资料.md",
    content:
      "# 澄川热力\n这是虚构实验企业。澄川热力为居民提供供热服务。客服登记居民投诉，投诉通过工单安排处理。投诉是居民反映的供热问题；工单是处理该投诉的执行记录。每个投诉具有跨系统一致的业务编号，工单保留对应投诉的业务编号。工单的实际反馈用于描述用户反馈，不能由是否办结推断。供热站负责处理投诉。投诉办理后安排回访。\n基础概念为居民、投诉、工单和供热站。关系“处理工单”从投诉指向工单，表示投诉对应的执行记录。企业规模未知。",
  });
  await service.app.idle();
  let canvas = await recordRun();
  if (!canvas.foundation.current)
    canvas = await agent(
      "setup",
      "请按基础本体Skill读取刚上传的企业资料，基于原文引文保存基础本体候选，保留明确概念和关系，不自动采用。",
    );
  const foundation = canvas.foundation.current;
  assert(
    foundation?.content.evidence.some((e: any) => e.kind === "document"),
    "foundation must cite uploaded text",
  );
  for (const name of ["居民", "投诉", "工单", "供热站"])
    assert(
      foundation.content.concepts.some((c: any) => c.name === name),
      "foundation missing " + name,
    );
  assert(foundation.content.relations.some((r: any) => r.name === "处理工单"));
  canvas = await api("/api/canvas/foundation/adopt", {
    page: "setup",
    ...ref(foundation),
  });
  const adoptedFoundation = canvas.foundation.adopted;
  checkpoint(stage, { foundationRef: ref(adoptedFoundation) });

  stage = "source_connections";
  const p = (
    await api("/api/live/connect", {
      name: "投诉业务系统",
      protocol: "http",
      url: records.url,
      capabilities: [
        {
          ...primaryCapability,
          fields: [...primaryCapability.fields, "station"],
        },
      ],
    })
  ).saved;
  const s = (
    await api("/api/live/connect", {
      name: "工单执行系统",
      protocol: "mcp",
      url: records.url + "/mcp",
      capabilities: [supplementCapability],
    })
  ).saved;
  const k = (
    await api("/api/live/connect", {
      name: "服务知识库",
      protocol: "http",
      url: knowledge.url,
      capabilities: [knowledgeCapability],
    })
  ).saved;
  const bi = (
    await api("/api/live/connect", {
      name: "经营BI",
      protocol: "mcp",
      url: metrics.mcpUrl,
      capabilities: [metricCapability],
    })
  ).saved;
  checkpoint(stage, { count: 4, protocols: ["http", "mcp"] });

  stage = "fusion_mapping";
  canvas = await agent(
    "ontology",
    `基于已采用的基础本体和获准来源建立执行映射候选，实际读取两端样本，不自动采用。类型名称使用“投诉”和“工单”。投诉主源是“投诉业务系统” complaints，字段“业务编号”=ticket、“状态”=status、“所属站”=station；以业务编号匹配“工单执行系统” workorders 的 ticket，作为同实体附源“工单”，补充“状态”=status、“实际反馈”=outcome、“上门次数”=visits，保留冲突。独立工单类型使用 workorders，字段“投诉编号”=ticket、“反馈”=outcome。类型及关系绑定基础本体中相应概念。关系名称“处理工单”，方向投诉到工单。历史遗留规则使用投诉.$id匹配工单.投诉编号，请在候选里保留这个现行规则供后续专门核查，不自动修正；不要把它声明为业务真实。不要映射 phone/private。请保存候选。`,
  );
  const candidate = canvas.live.models.find(
    (m: any) => m.status === "proposed" || m.status === "candidate",
  );
  assert(candidate, "real Agent must save mapping candidate");
  const base = (await api("/api/live/adopt", ref(candidate))).saved;
  assert.deepEqual(base.content.foundationRef, ref(adoptedFoundation));
  const retained = (await api("/api/canvas")).foundation.adopted;
  assert.deepEqual(
    retained.content.concepts.map(
      ({ id, name, description, evidenceRefs }: any) => ({
        id,
        name,
        description,
        evidenceRefs,
      }),
    ),
    adoptedFoundation.content.concepts.map(
      ({ id, name, description, evidenceRefs }: any) => ({
        id,
        name,
        description,
        evidenceRefs,
      }),
    ),
    "unmapped concepts remain available",
  );
  const type = base.content.types.find((t: any) => t.name === "投诉");
  assert(type.supplements.length === 1);
  assert.equal(
    base.content.relations.find((r: any) => r.name === "处理工单").fromField,
    "$id",
  );
  const query = {
    modelId: base.id,
    modelVersion: base.version,
    type: "投诉",
    limit: 20,
  };
  const fused = await api("/api/live/query", query);
  const ts = fused.items.find((i: any) => i.$id === "TS002");
  assert.equal(ts.实际反馈, "未改善");
  assert.equal(ts.上门次数, 0);
  assert.equal(
    fused.evidence.find((e: any) => e.objectId === "TS002").properties.状态
      .status,
    "conflict",
  );
  const related = { ...query, id: "TS002", relation: "处理工单" };
  assert.equal((await api("/api/live/query", related)).items.length, 0);
  checkpoint(stage, {
    modelRef: ref(base),
    conflict: true,
    zeroPreserved: true,
    legacyRelationCount: 0,
  });

  stage = "shared_evidence";
  // Explicit investigation scope is supplied as a user request, never expected test answers.
  canvas = await agent(
    "ontology",
    `对当前映射下投诉TS002做一次共同取证：实际查询投诉状态、实际反馈、上门次数、所属站，并查询服务知识库实际片段及经营BI中2026-01-01到2026-02-01的办结率。先查目录/指标定义，用真实引用保存一份 evidence_collect 记录；文档读取最多100字符，指标只读清河站最多1条，维度仅作背景，不把办结率或办结状态推断为用户恢复。若来源有冲突和覆盖限制如实保留。`,
  );
  const state = await api("/api/state");
  const bundleMeta = state.artifacts.find(
    (a: any) => a.kind === "evidence_bundle",
  );
  assert(bundleMeta, "real Agent must save shared evidence");
  const bundle = await api("/api/artifacts/" + bundleMeta.id);
  verifyBundle(bundle, base, k.id, bi.id);
  checkpoint(stage, {
    bundleRef: ref(bundle),
    objectId: "TS002",
    station: "清河站",
    period: ["2026-01-01", "2026-02-01"],
    contextOnly: true,
  });

  stage = "consumer_views";
  const grants = [
    {
      type: "投诉",
      fields: ["$id", "业务编号", "状态", "实际反馈", "上门次数"],
      relations: ["处理工单"],
      evidence: { fields: ["状态", "实际反馈"], relations: ["处理工单"] },
    },
    {
      type: "工单",
      fields: ["$id", "投诉编号", "反馈"],
      relations: [],
      evidence: { fields: ["反馈"], relations: [] },
    },
  ];
  const proposeView = async (name: string, withContext: boolean) => {
    const draft = (
      await api("/api/live/views/propose", {
        operationId: randomUUID(),
        name,
        purpose: "按许可读取投诉融合对象及工单",
        modelRef: ref(base),
        grants,
        contextEvidence: withContext
          ? [
              { bundleRef: ref(bundle), kind: "document", index: 0 },
              { bundleRef: ref(bundle), kind: "metric", index: 0 },
            ]
          : [],
      })
    ).saved;
    const active = (await api("/api/live/views/activate", ref(draft))).saved;
    credentials.add(active.key);
    return active;
  };
  const a = await proposeView("服务Agent", true),
    b = await proposeView("审计Agent", false);
  const objectPath =
    "/v3/objects?type=" + encodeURIComponent("投诉") + "&id=TS002";
  const relationPath =
    objectPath + "&relation=" + encodeURIComponent("处理工单");
  const initial = await external(objectPath, a.key);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.items[0].properties.状态.status, "conflict");
  assert.equal(
    (
      await external(
        objectPath + "&fields=" + encodeURIComponent("$id,phone"),
        a.key,
      )
    ).status,
    403,
  );
  assert.equal((await external(relationPath, b.key)).body.items.length, 0);
  const catalog = await external("/v3/catalog", a.key);
  assert.equal(catalog.body.contextEvidence.length, 2);
  for (const e of catalog.body.contextEvidence) {
    const evidencePath = "/v3/evidence?ref=" + encodeURIComponent(e.ref);
    const reading = await external(evidencePath, a.key);
    assert.equal(reading.status, 200);
    assert.equal((await external(evidencePath, b.key)).status, 403);
    if (e.kind === "document")
      assert.equal(
        reading.body.evidence.text,
        bundle.content.documents[0].result.text,
      );
    else {
      assert.deepEqual(
        reading.body.evidence.query,
        Object.fromEntries(
          ["start", "end", "where", "offset", "limit"].map((key) => [
            key,
            bundle.content.metrics[0].result.query[key],
          ]),
        ),
      );
      assert.equal(reading.body.evidence.items[0].value, 80);
    }
  }
  checkpoint(stage, { independentViews: 2, permissionDenied: 403 });

  stage = "global_rule_change";
  canvas = await agent(
    "ontology",
    `当前投诉TS002有业务编号，但“处理工单”关系为空。请实际查询投诉与工单，解释现行连接字段的问题。业务确认跨系统应以投诉.业务编号与工单.投诉编号相等建立关系。针对当前基础映射保存这一项全局关系规则修订并完成检查，保留源记录、样本和共同changeRef；不自动采用，不改属性权限。`,
  );
  let change = (await api("/api/live/changes/list", {})).items.find(
    (c: any) => c.status === "checked",
  );
  assert(change, "real Agent must save and check a mapping change");
  change = (
    await api("/api/live/changes/adopt", {
      ...ref(change),
      operationId: randomUUID(),
    })
  ).saved;
  const target = change.content.resultModel;
  assert.equal(
    (
      await api("/api/live/query", {
        ...related,
        modelId: target.id,
        modelVersion: target.version,
      })
    ).items[0].$id,
    "WO02",
  );
  assert.equal((await external(relationPath, a.key)).body.items.length, 0);
  checkpoint(stage, {
    changeRef: ref(change),
    targetRef: target,
    oldViewRelationCount: 0,
  });

  stage = "migration_preview";
  canvas = await agent(
    "consumption",
    `基于刚采用的“处理工单”关系变更，只为“服务Agent”生成迁移预览。我明确同意移除服务Agent绑定旧模型的全部两份文档/BI背景依据；保持原有字段、关系与证据许可。“审计Agent”保持旧版，不生成它的迁移。不提交，仅保存并解释具体预览。`,
  );
  const previews = (await api("/api/live/migrations/list", {})).items;
  assert.equal(
    previews.length,
    1,
    "only the requested consumer may receive a preview",
  );
  const preview = await api("/api/live/migrations/read", ref(previews[0]));
  assert.equal(preview.content.viewRef.id, a.view.id);
  assert(preview.content.report.compatible);
  const receipt = (
    await api("/api/live/migrations/commit", {
      ...ref(preview),
      operationId: randomUUID(),
    })
  ).saved;
  const version = receipt.content.resultRef.version;
  assert.equal((await external(relationPath, a.key)).status, 409);
  assert.equal(
    (await external(relationPath + "&viewVersion=" + version, a.key)).body
      .items[0].objectRef.id,
    "WO02",
  );
  assert.equal((await external(relationPath, b.key)).body.items.length, 0);
  assert.equal(
    (
      await external(
        "/v3/evidence?ref=" +
          initial.body.items[0].properties.实际反馈.evidenceRef +
          "&viewVersion=" +
          version,
        a.key,
      )
    ).status,
    403,
  );
  checkpoint(stage, {
    migrationRef: ref(receipt),
    viewVersion: version,
    newRelationCount: 1,
    otherRelationCount: 0,
  });

  stage = "source_change_and_mcp";
  records.state.outcome = "已改善";
  records.state.visits = 2;
  const client = new Client({ name: "chain-independent", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("../dataengine-mcp.ts", import.meta.url))],
        env: {
          PATH: process.env.PATH!,
          DATAENGINE_URL: origin,
          DATAENGINE_CONSUMER_KEY: a.key,
        },
      }),
    );
    const result = await client.callTool({
      name: "query_objects",
      arguments: { type: "投诉", id: "TS002", viewVersion: version },
    });
    assert.equal(
      (result.structuredContent as any).items[0].properties.实际反馈.value,
      "已改善",
    );
  } finally {
    await client.close();
  }
  assert.equal(
    (await external(objectPath, b.key)).body.items[0].properties.实际反馈.value,
    "已改善",
  );
  records.state.mode = "failure";
  const unavailable = await external(
    objectPath + "&viewVersion=" + version,
    a.key,
  );
  const failedProperty = unavailable.body.items[0].properties.实际反馈;
  assert.equal(unavailable.status, 200);
  assert.equal(failedProperty.status, "uncertain");
  assert.equal(failedProperty.value, null);
  const failedEvidence = await external(
    "/v3/evidence?ref=" +
      failedProperty.evidenceRef +
      "&viewVersion=" +
      version,
    a.key,
  );
  assert.equal(failedEvidence.status, 200);
  assert(
    failedEvidence.body.evidence.matches.some(
      (m: any) => m.status === "unavailable",
    ),
  );
  records.state.mode = "conflict";
  checkpoint(stage, {
    newOutcome: "已改善",
    oldModelReadsCurrentSource: true,
    failedSource: { value: null, status: "uncertain", match: "unavailable" },
  });

  stage = "restart";
  await service.close();
  service = await createServer({ directory });
  await new Promise<void>((resolve) =>
    service!.server.listen(0, "127.0.0.1", resolve),
  );
  origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  assert.equal(
    (await external(relationPath + "&viewVersion=" + version, a.key)).body
      .items[0].objectRef.id,
    "WO02",
  );
  assert.equal((await external(relationPath, b.key)).body.items.length, 0);
  checkpoint(stage, { sameCredentials: true, origin });
  report.status = "passed";
  report.completedAt = new Date().toISOString();
  save();
  if (keepOpen) {
    writeFileSync(
      authPath,
      JSON.stringify({
        cookies: [
          {
            name:
              "dataengine_admin_" +
              createHash("sha256")
                .update(service.adminToken)
                .digest("hex")
                .slice(0, 16),
            value: service.adminToken,
            domain: "127.0.0.1",
            path: "/api",
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: "Strict",
          },
        ],
        origins: [],
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      secretsPath,
      JSON.stringify({
        a: a.key,
        b: b.key,
        viewVersion: version,
        baseRef: ref(base),
        targetRef: target,
      }),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({ preview: origin, authPath, secretsPath, reportPath }),
    );
  }
} catch (error) {
  report.status = "failed";
  report.failedStage = stage;
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of credentials)
    message = message.replaceAll(secret, "[redacted]");
  report.error = message;
  save();
  console.error(JSON.stringify({ stage, error: message, reportPath }));
  process.exitCode = 1;
} finally {
  if (keepOpen && report.status === "passed") {
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, async () => {
        await close();
        process.exit(process.exitCode ? Number(process.exitCode) : 0);
      });
  } else await close();
}
