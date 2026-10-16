import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import type { AgentDriver } from "../../src/agent/runtime.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

test("onboarding saves selected industry naming references, waits for data and preserves existing definitions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-onboarding-"));
  const driver: AgentDriver = { async run() { return { text: "连接成功", sessionId: "test", runId: "test" }; }, async stop() {}, async close() {} };
  let service = await createServer({ directory, driver });
  let origin = "";
  const start = async () => { await new Promise<void>(resolve => service.server.listen(0,"127.0.0.1",resolve)); origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`; };
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(origin+path, { method: body ? "POST" : "GET", headers: { "x-dataengine-token": service.adminToken, "content-type":"application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  try {
    await start();
    assert.equal((await call("/api/onboarding")).data.active,true);
    // Legacy profile keys are migrated when the user saves canonical setup fields.
    service.app.memory.putArtifact({kind:"profile",title:"历史档案",status:"active",content:{statements:[{key:"business",text:"历史业务",origin:"user"}],conflicts:[]}});
    let state = (await call("/api/onboarding")).data;
    assert.equal(state.active, false);
    assert.equal(state.step, 1);
    assert.equal(state.packs.length, 20);
    assert(state.packs.filter((p: any) => p.group === "金融服务").length >= 10);
    const saved = await call("/api/onboarding/company", { expectedVersion: state.version, profileVersion: state.currentProfileVersion, name: "测试银行", industry: "banking", business: "企业银行业务", region: "上海", website: "", goal: "统一客户和账户" });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    state = saved.data.onboarding;
    assert.equal(state.step, 3);
    assert.equal(state.company.business,"企业银行业务");
    assert(!saved.data.profile.content.statements.some((s:any)=>s.key==="business"));
    const stale = await call("/api/onboarding/company", { expectedVersion: 0, name: "另一企业", industry: "insurance" });
    assert.equal(stale.status, 400);
    await service.close(); service = await createServer({ directory, driver }); await start();
    state = (await call("/api/onboarding")).data;
    assert.equal(state.company.name, "测试银行");
    assert.equal(state.step, 3);
    const pack = state.packs.find((p: any) => p.id === "banking");
    const body = { expectedVersion: state.version, baseVersion: 0, packId: "banking", concepts: pack.concepts.slice(0,2), operationId: "apply-banking" };
    const applied = await call("/api/onboarding/pack", body);
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.equal(applied.data.foundation.current, null);
    assert.equal(applied.data.foundation.adopted, null);
    assert.equal(applied.data.onboarding.foundationStatus, "waiting_data");
    assert.match(applied.data.onboarding.foundationMessage, /结构化数据/);
    const reference = applied.data.onboarding.reference;
    assert.equal(reference.kind, "industry_reference");
    assert.equal(reference.status, "reference");
    assert.deepEqual(reference.content.concepts, pack.concepts.slice(0, 2).map((item: any) => ({ templateId: item.id, name: item.name, description: item.description })));
    assert.equal(service.app.memory.listArtifacts("foundation").length, 0);
    assert.equal(service.app.memory.listTasks().length, 0, "saving reference vocabulary does not start an Agent task");
    assert.equal(applied.data.sources.length, 0);
    assert.equal(applied.data.live.connections.length, 0);
    const repeat = await call("/api/onboarding/pack", body);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.data.onboarding.reference.version, reference.version);
    assert.equal(repeat.data.onboarding.version, applied.data.onboarding.version);
    assert.equal((await call("/api/onboarding/pack", { ...body, concepts: [pack.concepts[0]] })).status, 400);
    state = applied.data.onboarding;
    assert.equal((await call("/api/onboarding/step", { expectedVersion: state.version, step: 5 })).status, 200);
    state = (await call("/api/onboarding")).data;
    const complete = await call("/api/onboarding/complete", { expectedVersion: state.version });
    assert.equal(complete.status, 200, JSON.stringify(complete.data));
    assert.equal(complete.data.onboarding.active, false);
    assert.equal(complete.data.currentPage, "setup");
    assert.equal(complete.data.foundation.adopted, null);
    await call("/api/profile",{id:complete.data.profile.id,expectedVersion:complete.data.profile.version,key:"company.business",text:"企业页的新业务"});
    const restarted = await call("/api/onboarding/start", { expectedVersion: complete.data.onboarding.version });
    assert.equal(restarted.status, 200);
    assert.equal(restarted.data.foundation.adopted, null);
    assert.deepEqual(restarted.data.onboarding.reference, reference);
    assert.equal(restarted.data.onboarding.company.name, "测试银行");
    assert.equal(restarted.data.onboarding.company.business,"企业页的新业务");
    state = restarted.data.onboarding;
    const edited = await call("/api/profile",{id:restarted.data.profile.id,expectedVersion:restarted.data.profile.version,key:"company.business",text:"并发编辑的新业务"});
    assert.equal(edited.status,200);
    const staleProfile = await call("/api/onboarding/company",{...state.company,expectedVersion:state.version,profileVersion:state.currentProfileVersion});
    assert.equal(staleProfile.status,400);
    state = (await call("/api/onboarding")).data;
    assert.equal(state.company.business,"并发编辑的新业务");
    const cleared = await call("/api/onboarding/company",{...state.company,business:"",expectedVersion:state.version,profileVersion:state.currentProfileVersion});
    assert.equal(cleared.status,200,JSON.stringify(cleared.data));
    assert(!cleared.data.profile.content.statements.some((s:any)=>s.key==="company.business"));
    state=cleared.data.onboarding;
    const original = seedFoundation(service.app.memory, service.app.foundation, {
      enterprise: "测试银行", concepts: [{ id: "banking_customer", name: "客户", description: "程序根据客户表构建的记录。" }],
    });
    const changed=await call("/api/onboarding/pack",{expectedVersion:state.version,baseVersion:original.version,packId:"banking",concepts:[{...pack.concepts[0],name:"机构客户"}],operationId:"renamed-banking"});
    assert.equal(changed.status,200,JSON.stringify(changed.data));
    const updated=changed.data.foundation.adopted.content.concepts;
    assert.equal(updated.length,1);
    assert.equal(updated.find((c:any)=>c.id==="banking_customer").name,"客户");
    assert.equal(changed.data.foundation.adopted.version, original.version);
    assert.equal(changed.data.onboarding.reference.id, reference.id);
    assert.equal(changed.data.onboarding.reference.version, reference.version + 1);
    assert.equal(changed.data.onboarding.reference.content.concepts[0].name, "机构客户");
    assert.equal(changed.data.onboarding.foundationStatus, "available");
    const denied = await fetch(origin+"/api/onboarding");
    assert.equal(denied.status, 403);
  } finally { await service.close(); rmSync(directory,{recursive:true,force:true}); }
});

test("an Agent reads industry vocabulary by reference and refines only a rule-built concept; saving references preserves a pending candidate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-onboarding-reference-"));
  let ran = false;
  const selected = { id: "banking_customer", name: "机构客户", description: "与银行开展业务的机构主体。" };
  const driver: AgentDriver = {
    async run(request) {
      const input = JSON.parse(request.input);
      assert.equal(input.enterprise.industryReferences.length, 1);
      const catalog = input.enterprise.industryReferences[0];
      assert.equal(catalog.purpose, "naming_reference");
      assert.equal(catalog.concepts, undefined, "the directory does not inline the vocabulary");
      const reference = await request.onTool("memory_read", { id: catalog.id, version: catalog.version }) as any;
      assert.deepEqual(reference.content.concepts, [{ templateId: selected.id, name: selected.name, description: selected.description }]);
      assert.match(reference.content.instructions, /不得据此新建/);
      const current = (await request.onTool("foundation_read", {}) as any).current;
      const message = input.recentMessages.filter((item: any) => item.role === "user").at(-1);
      await request.onTool("skill_use", { name: "company-foundation-ontology" });
      const proposal = {
        baseVersion: current.version, enterprise: current.content.enterprise,
        concepts: [{ id: "customer_table", name: selected.name, description: selected.description, evidenceRefs: ["meaning"] }],
        relations: [], evidence: [{ id: "meaning", messageId: message.id, quote: message.content }], unknowns: [], conflicts: [],
      };
      await assert.rejects(request.onTool("foundation_propose", {
        ...proposal, concepts: [{ ...proposal.concepts[0], id: selected.id }],
      }), /数据程序/);
      const candidate = await request.onTool("foundation_propose", proposal) as any;
      assert.deepEqual(candidate.content.concepts.map((item: any) => [item.id, item.name, item.origin]), [["customer_table", "机构客户", "program"]]);
      await request.onTool("task_ask", { question: "请核对客户定义修正", reason: "采用已有客户记录的业务名称", foundationId: candidate.id, version: candidate.version });
      ran = true;
      return { text: "已保存修正候选，等待采用。", sessionId: "reference", runId: "reference" };
    }, async stop() {}, async close() {},
  };
  let service = await createServer({ directory, driver });
  let origin = "";
  const start = async () => { await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`; };
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { "x-dataengine-token": service.adminToken, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    assert.equal(response.status, path === "/api/canvas/message" ? 202 : 200, result.error ?? path);
    return result;
  };
  try {
    await start();
    const initial = await call("/api/onboarding");
    let state = (await call("/api/onboarding/company", { expectedVersion: initial.version, profileVersion: initial.currentProfileVersion,
      name: "测试银行", industry: "banking", business: "", region: "", website: "", goal: "" })).onboarding;
    const saved = await call("/api/onboarding/pack", { expectedVersion: state.version, baseVersion: 0, packId: "banking", concepts: [selected], operationId: "save-reference" });
    const reference = saved.onboarding.reference;
    await service.close(); service = await createServer({ directory, driver }); await start();
    assert.deepEqual((await call("/api/onboarding")).reference, reference, "the selected vocabulary survives restart");
    const seeded = seedFoundation(service.app.memory, service.app.foundation, {
      enterprise: "测试银行", concepts: [{ id: "customer_table", name: "Customer", description: "客户表记录，名称和说明待核对。" }],
    });
    await call("/api/canvas/message", { page: "setup", messageId: "refine-from-vocabulary", text: "我们的客户表记录是与银行开展业务的机构主体。请称为机构客户。" });
    await service.app.idle();
    assert(ran, JSON.stringify(service.app.canvasState().messages));
    const before = await call("/api/canvas");
    assert.equal(before.foundation.current.status, "candidate");
    assert.equal(before.foundation.adopted.version, seeded.version);
    assert.equal(before.pending.foundationId, before.foundation.current.id);
    state = before.onboarding;
    const changed = await call("/api/onboarding/pack", { expectedVersion: state.version, baseVersion: before.foundation.current.version,
      packId: "banking", concepts: [{ ...selected, name: "企业客户" }], operationId: "change-reference-only" });
    assert.deepEqual(changed.foundation, before.foundation, "updating naming references neither replaces nor adopts an existing candidate");
    assert.deepEqual(changed.pending, before.pending);
    assert.equal(changed.onboarding.reference.content.concepts[0].name, "企业客户");
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});
