import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Artifact } from "../../src/agent/contracts.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { createServer } from "../../src/agent/server.ts";

const ref = (a: Artifact) => ({id: a.id, version: a.version});

test("program construction, Agent repair, explicit mapping adoption and publication preserve an existing consumer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ade-repair-chain-"));
  let stage: "repair" | "rebind" = "repair", calls = 0;
  let repaired: Artifact | undefined, rebound: Artifact | undefined;
  const driver: AgentDriver = {
    async run(request) {
      calls++;
      const input = JSON.parse(request.input);
      const foundation = (await request.onTool("foundation_read", {}) as any).current;
      if (stage === "repair") {
        await request.onTool("skill_use", {name: "company-foundation-ontology"});
        const message = input.recentMessages.at(-1);
        repaired = await request.onTool("foundation_propose", {
          baseVersion: foundation.version, enterprise: foundation.content.enterprise,
          concepts: [{id: foundation.content.concepts[0].id, name: "公司", description: "公司业务记录", evidenceRefs: ["repair"]}],
          relations: [], evidence: [{id: "repair", messageId: message.id, quote: message.content}], unknowns: [], conflicts: [],
        }) as unknown as Artifact;
      } else {
        assert.equal(foundation.status, "adopted");
        const model = (await request.onTool("live_overview", {}) as any).models.find((m: Artifact) => m.status === "adopted");
        const before = model.content.types[0], concept = foundation.content.concepts.find((c: any) => c.id === before.conceptId);
        const sample = await request.onTool("live_read", {sourceId: before.sourceId, capability: before.capability, limit: 1}) as any;
        assert.equal(sample.items[0].name, "Example");
        rebound = await request.onTool("live_propose", {
          foundationRef: ref(foundation), baseModelRef: ref(model), purpose: "采用修订后的公司定义", rationale: "沿用相同来源和字段，执行类型名称与含义同步已采用概念。",
          types: [{...before, name: concept.name, description: concept.description}], relations: model.content.relations,
        }) as unknown as Artifact;
      }
      return {text: "候选已保存，等待页面采用。", sessionId: "repair-chain", runId: `repair-chain-${calls}`};
    }, async stop() {}, async close() {},
  };
  const service = await createServer({directory, driver});
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(origin + path, {method: body ? "POST" : "GET", headers: {"x-dataengine-token": service.adminToken, "content-type": "application/json"}, ...(body ? {body: JSON.stringify(body)} : {})});
    const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
  };
  const external = async (key: string, path: string) => {
    const response = await fetch(origin + path, {headers: {authorization: `Bearer ${key}`}});
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  const publish = async (name: string) => {
    const overview = await api("/api/releases");
    const checked = await api("/api/releases/check", {inputHash: overview.working.inputHash});
    assert.equal(checked.status, "ready", JSON.stringify(checked.content));
    return (await api("/api/releases/publish", {operationId: name, name, checkRef: ref(checked)})).release;
  };
  try {
    await api("/api/canvas/upload", {page: "setup", name: "companies.csv", content: "id,name\nA,Example\n"});
    await service.app.idle();
    assert.equal(calls, 0, "program construction must not invoke the model");
    const initial = service.app.foundation.read().adopted!;
    const initialModel = service.app.live.overview().models.find(m => m.status === "adopted")!;
    const originalType = (initialModel.content.types as any[])[0], conceptId = originalType.conceptId;
    const first = await publish("v1");
    const old = await api("/api/releases/connect", {operationId: "old", name: "原消费者", releaseRef: ref(first), conceptIds: [conceptId], relationIds: [], business: {grants: [{type: originalType.name, fields: ["$id", "name"], relations: []}]}});
    const conceptPath = `/v4/concept?conceptId=${encodeURIComponent(conceptId)}`;
    const originalObjectPath = `/v4/objects?type=${encodeURIComponent(originalType.name)}`;
    assert.equal((await external(old.key, originalObjectPath)).items[0].properties.name.value, "Example");

    await api("/api/canvas/navigate", {page: "ontology"});
    await api("/api/canvas/message", {page: "ontology", text: "把这个概念叫公司，含义为公司业务记录。", messageId: "repair"});
    await service.app.idle();
    assert.equal(repaired?.status, "candidate");
    assert.equal(service.app.foundation.read().adopted!.version, initial.version);
    await api("/api/canvas/foundation/adopt", {page: "ontology", ...ref(repaired!)});
    await service.app.idle();
    assert.equal((service.app.foundation.read().adopted!.content.concepts as any[])[0].name, "公司");
    assert.equal((await external(old.key, conceptPath)).concept.name, originalType.name);
    assert.equal((await external(old.key, originalObjectPath)).items[0].properties.name.value, "Example");
    const blocked = await api("/api/releases/check", {inputHash: (await api("/api/releases")).working.inputHash});
    assert.equal(blocked.status, "blocked", "a semantic change needs a matching execution mapping before publication");

    stage = "rebind";
    await api("/api/canvas/message", {page: "ontology", text: "沿用来源和字段，把执行映射名称及含义同步到已采用的公司概念。", messageId: "rebind"});
    await service.app.idle();
    assert.equal(rebound?.status, "candidate");
    await api("/api/live/adopt", ref(rebound!));
    await service.app.idle();
    const active = service.app.live.overview().models.find(m => m.status === "adopted")!;
    const records = await api("/api/live/query", {modelId: active.id, type: "公司"});
    assert.equal(records.items[0].name, "Example");
    const second = await publish("v2");
    assert.equal(second.content.sequence, 2);
    assert.equal(second.content.definition.concepts[0].name, "公司");
    assert(second.content.diff.some((d: any) => d.path === `/concepts/${conceptId}/name` && d.before === originalType.name && d.after === "公司"));
    const newer = await api("/api/releases/connect", {operationId: "new", name: "新版消费者", releaseRef: ref(second), conceptIds: [conceptId], relationIds: [], business: {grants: [{type: "公司", fields: ["$id", "name"], relations: []}]}});
    assert.equal((await external(newer.key, conceptPath)).concept.description, "公司业务记录");
    assert.equal((await external(newer.key, `/v4/objects?type=${encodeURIComponent("公司")}`)).items[0].properties.name.value, "Example");
    assert.equal((await external(old.key, conceptPath)).concept.name, originalType.name);
    assert.equal((await external(old.key, originalObjectPath)).items[0].properties.name.value, "Example");
    assert.equal(calls, 2, "the same Agent only assists the repair and rebind");
  } finally {await service.close(); rmSync(directory, {recursive: true, force: true});}
});
