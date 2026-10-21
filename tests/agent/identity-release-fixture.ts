import type { AgentDriver } from "../../src/agent/runtime.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

export const ref = (a: { id: string; version: number }) => ({ id: a.id, version: a.version });

/** Separate people and account datasets: a shared mailbox is not proof that a bot is a person. */
export async function identityWorkspace(driver?: AgentDriver) {
  const directory = mkdtempSync(join(tmpdir(), "ade-identity-release-"));
  const service = await createServer({ directory, driver, automaticApi: false });
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-DataEngine-Token": service.adminToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const manage = async (path: string, body?: unknown) => {
    const result = await request(path, body);
    assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.body));
    return result.body;
  };
  try {
    const foundation = seedFoundation(service.app.memory, service.app.foundation, { enterprise: "星桥",
      concepts: [{ id: "person", name: "人员", description: "实际工作人员" }, { id: "account", name: "账号", description: "系统登录账号" }],
      relations: [{ id: "account_owner", name: "所属人员", from: "account", to: "person", description: "账号对应的实际人员" }] });
    const upload = (name: string, text: string) => {
      const source = new Workspace(service.app.memory).upload(name, text);
      return service.app.live.sources.connectUpload(source.id, source.version, "id");
    };
    const people = upload("people.csv", "id,email,name\nP1,new@example.test,林\nP2,shared@example.test,周\n");
    const accounts = upload("accounts.csv", "id,email,name\na-old,old@example.test,旧邮箱账号\na-bot,shared@example.test,ci-bot\na-user,new@example.test,工作账号\n");
    await service.app.snapshots.sync({ operationId: "identity-source-data" });
    const candidate = await service.app.live.propose({ foundationRef: ref(foundation), baseModelRef: null, purpose: "人员与账号的业务对应", rationale: "人员与账号分别建模，邮箱仅作为待核对的对应依据",
      types: [
        { conceptId: "person", name: "人员", description: "实际工作人员", sourceId: people.id, capability: "records", fields: { 邮箱: "email", 姓名: "name" } },
        { conceptId: "account", name: "账号", description: "系统登录账号", sourceId: accounts.id, capability: "records", fields: { 邮箱: "email", 名称: "name" } },
      ], relations: [{ relationId: "account_owner", name: "所属人员", from: "账号", to: "人员", fromField: "邮箱", toField: "邮箱" }] });
    const initialModel = await service.app.live.adopt(candidate.id, candidate.version);
    const govern = async (type: string, subject: unknown, tag: string) => {
      const change = (await manage("/api/changes/propose", { operationId: `propose-${tag}`, origin: "human", type,
        baseline: (await manage("/api/changes")).baseline, subject })).change;
      const checked = (await manage("/api/changes/verify", { operationId: `verify-${tag}`, ...ref(change) })).change;
      assert.equal(checked.status, "verified", JSON.stringify(checked.content.verification));
      return (await manage("/api/changes/adopt", { operationId: `adopt-${tag}`, ...ref(checked), acknowledgeReview: true })).change;
    };
    const layered = service.app.live.readLayered(initialModel.id, initialModel.version);
    const left = layered.bindings.entities.find(binding => binding.dataset.sourceId === accounts.id)!;
    const right = layered.bindings.entities.find(binding => binding.dataset.sourceId === people.id)!;
    const ruleChange = await govern("identity_rule", { kind: "belongs_to", left: { bindingId: left.id, columns: ["email"] }, right: { bindingId: right.id, columns: ["email"] },
      relationTypeId: "account_owner", reason: "相同邮箱可提示账号所属人员，不合并对象", evidence: "账号目录与人员名册" }, "rule");
    const ruleId = String(ruleChange.content.effect.ruleId);
    const currentModel = () => service.app.memory.listArtifacts("live_ontology").find(model => model.status === "adopted")!;
    const decide = (account: string, decision: "match" | "no_match", person: string | null, tag: string) => govern("identity_decision", {
      ruleId, left: { bindingId: left.id, recordId: account }, right: person ? { bindingId: right.id, recordId: person } : null,
      decision, reason: decision === "no_match" ? "此账号是机器人，不对应人员" : "已核对账号持有人", evidence: "管理员核对账号登记和人员档案",
    }, tag);
    const publish = async (name: string) => {
      const working = (await manage("/api/releases")).working;
      const check = await manage("/api/releases/check", { inputHash: working.inputHash });
      assert.equal(check.status, "ready", JSON.stringify(check.content.issues));
      return (await manage("/api/releases/publish", { operationId: `publish-${name}`, checkRef: ref(check), name })).release;
    };
    const connect = (release: any, name: string) => manage("/api/releases/connect", { operationId: `connect-${name}`, name, releaseRef: ref(release),
      conceptIds: ["account", "person"], relationIds: ["account_owner"], business: { grants: [
        { type: "账号", fields: ["$id", "邮箱", "名称"], relations: ["所属人员"] },
        { type: "人员", fields: ["$id", "邮箱", "姓名"], relations: [] },
      ] } });
    const external = async (key: string, id: string) => {
      const response = await fetch(origin + "/v4/objects?" + new URLSearchParams({ type: "账号", id, relation: "所属人员" }), { headers: { authorization: `Bearer ${key}` } });
      return { status: response.status, body: await response.json() as any };
    };
    return { service, origin, manage, request, govern, decide, publish, connect, external, currentModel, ruleId, people, accounts, left, right, upload,
      async close() { await service.close(); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    await service.close(); rmSync(directory, { recursive: true, force: true }); throw error;
  }
}
