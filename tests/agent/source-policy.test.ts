import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { SourcePolicyService } from "../../src/agent/source-policy.ts";
import { ConsumptionService } from "../../src/agent/consumption.ts";
import type { Artifact } from "../../src/agent/contracts.ts";

async function fixture(memory: MemoryStore) {
  const workspace = new Workspace(memory);
  const source = workspace.upload(
    "投诉.csv",
    "id,status,phone\nC1,closed,13800000001\n",
  );
  const callbacks = workspace.upload(
    "回访.csv",
    "id,complaint_id,result\nF1,C1,improved\n",
  );
  const candidate = (await workspace.execute("ontology_propose", {
    title: "投诉与回访",
    purpose: "复核投诉处理结果",
    types: [
      {
        name: "Complaint",
        description: "投诉",
        sourceId: source.id,
        idField: "id",
        fields: { status: "status", contact: "phone" },
      },
      {
        name: "Callback",
        description: "回访",
        sourceId: callbacks.id,
        idField: "id",
        fields: { complaintId: "complaint_id", result: "result" },
      },
    ],
    relations: [
      {
        name: "callbacks",
        from: "Complaint",
        to: "Callback",
        fromField: "$id",
        toField: "complaintId",
      },
    ],
    functions: [],
    evidence: [
      { sourceId: source.id, version: 1 },
      { sourceId: callbacks.id, version: 1 },
    ],
  })) as unknown as Artifact;
  const preview = (await workspace.execute("ontology_preview", {
    id: candidate.id,
    version: candidate.version,
  })) as unknown as Artifact;
  const model = workspace.adopt(preview.id, preview.version);
  return { source, callbacks, workspace, model };
}

const read = (service: ConsumptionService, key: string, query: string) =>
  service.handle({
    method: "GET",
    path: "/v1/objects",
    query: new URLSearchParams(query),
    authorization: `Bearer ${key}`,
  });

test("source use and sensitive columns persist independently of raw data, with explicit version checks", () => {
  const directory = mkdtempSync(join(tmpdir(), "de-source-policy-"));
  let memory = new MemoryStore(directory);
  try {
    const workspace = new Workspace(memory);
    const source = workspace.upload(
      "投诉.csv",
      "id,status,phone\nC1,closed,13800000001\n",
    );
    let policies = new SourcePolicyService(memory);
    assert.equal(policies.read(source.id), null);
    const args = {
      sourceId: source.id,
      version: 0,
      purpose: "查看投诉处理情况",
      owner: "客服部",
      sensitiveFields: ["phone"],
    };
    const first = policies.update(args);
    assert.equal(first.kind, "source_policy");
    assert.equal(first.version, 1);
    assert.throws(() => policies.update(args), /版本/);
    const updated = policies.update({
      ...args,
      version: first.version,
      purpose: "复核投诉处理情况",
    });
    assert.equal(updated.version, 2);
    assert.deepEqual(memory.getArtifact(source.id), source);
    memory.close();
    memory = new MemoryStore(directory);
    policies = new SourcePolicyService(memory);
    assert.equal(policies.list().length, 1);
    assert.deepEqual(policies.read(source.id), updated);
    assert.deepEqual(memory.getArtifact(source.id), source);
    assert.throws(
      () =>
        policies.update({ ...args, version: 2, sensitiveFields: ["invented"] }),
      /列/,
    );
    assert.throws(
      () =>
        policies.update({
          ...args,
          version: 2,
          sensitiveFields: ["phone", "phone"],
        }),
      /重复/,
    );
    assert.throws(
      () => policies.update({ ...args, version: 2, purpose: "x".repeat(1001) }),
      /用途/,
    );
    assert.throws(
      () => policies.update({ ...args, version: 2, owner: "x".repeat(201) }),
      /负责人/,
    );
    assert.throws(
      () => policies.update({ ...args, sourceId: first.id }),
      /来源/,
    );
    const document = new Workspace(memory).upload(
      "说明.md",
      "投诉办结不等于恢复。",
    );
    assert.throws(
      () => policies.update({ ...args, sourceId: document.id }),
      /CSV/,
    );
  } finally {
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("classifying a source column blocks its mapped field immediately for an existing consumer and after reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-sensitive-consumer-"));
  let memory = new MemoryStore(directory);
  let service = new ConsumptionService(directory, memory);
  try {
    const { source, model } = await fixture(memory);
    const grant = {
      name: "客服助手",
      purpose: "查询处理状态",
      modelId: model.id,
      modelVersion: model.version,
      grants: [
        {
          type: "Complaint",
          fields: ["$id", "status", "contact"],
          relations: [],
        },
      ],
    };
    const draft = service.propose(grant);
    const { consumer, apiKey } = service.activate(draft.id, draft.version);
    assert.equal(
      read(service, apiKey, "type=Complaint&fields=contact").status,
      200,
    );
    const pending = service.propose(grant);
    new SourcePolicyService(memory).update({
      sourceId: source.id,
      version: 0,
      purpose: "服务核查",
      owner: "客服部",
      sensitiveFields: ["phone"],
    });
    const denied = read(service, apiKey, "type=Complaint&fields=contact");
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "sensitive_field");
    assert.equal(service.logs(consumer.id)[0].reason, "sensitive_field");
    assert.equal(JSON.stringify(service.logs()).includes("13800000001"), false);
    assert.equal(read(service, apiKey, "type=Complaint").status, 403);
    assert.deepEqual(
      read(service, apiKey, "type=Complaint&fields=status").body.items,
      [{ type: "Complaint", fields: { status: "closed" } }],
    );
    assert.throws(() => service.propose(grant), /敏感/);
    assert.throws(() => service.activate(pending.id, pending.version), /敏感/);
    service.close();
    memory.close();
    memory = new MemoryStore(directory);
    service = new ConsumptionService(directory, memory);
    assert.equal(
      read(service, apiKey, "type=Complaint&fields=contact").body.code,
      "sensitive_field",
    );
    assert.equal(
      read(service, apiKey, "type=Complaint&fields=status").status,
      200,
    );
    assert.equal(memory.getArtifact(source.id).version, 1);
    new Workspace(memory).upload("投诉.csv", "id,status\nC1,open\n");
    const policies = new SourcePolicyService(memory);
    policies.update({
      sourceId: source.id,
      version: policies.read(source.id)!.version,
      purpose: "更新用途仍保留历史列分类",
      owner: "客服部",
      sensitiveFields: ["phone"],
    });
    assert.equal(
      read(service, apiKey, "type=Complaint&fields=contact").body.code,
      "sensitive_field",
    );
    assert.deepEqual(
      read(service, apiKey, "type=Complaint&fields=status").body.items,
      [{ type: "Complaint", fields: { status: "closed" } }],
    );
    assert.equal(memory.getArtifact(source.id).version, 2);
  } finally {
    service.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sensitive identities and relationship join columns cannot be used indirectly through a public projection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-sensitive-relations-"));
  const memory = new MemoryStore(directory);
  const service = new ConsumptionService(directory, memory);
  try {
    const { source, callbacks, model } = await fixture(memory);
    const policies = new SourcePolicyService(memory);
    const draft = service.propose({
      name: "回访助手",
      purpose: "复核回访",
      modelId: model.id,
      modelVersion: model.version,
      grants: [
        {
          type: "Complaint",
          fields: ["$id", "status"],
          relations: ["callbacks"],
        },
        {
          type: "Callback",
          fields: ["$id", "complaintId", "result"],
          relations: [],
        },
      ],
    });
    const { apiKey } = service.activate(draft.id, draft.version);
    const relation = "type=Complaint&id=C1&relation=callbacks&fields=result";
    assert.equal(read(service, apiKey, relation).status, 200);
    const originPolicy = policies.update({
      sourceId: source.id,
      purpose: "身份受限",
      owner: "客服部",
      sensitiveFields: ["id"],
    });
    assert.equal(
      read(service, apiKey, "type=Complaint&id=C1&fields=status").body.code,
      "sensitive_field",
    );
    assert.equal(read(service, apiKey, relation).body.code, "sensitive_field");
    assert.equal(
      read(service, apiKey, "type=Complaint&fields=status").status,
      200,
    );
    policies.update({
      sourceId: source.id,
      version: originPolicy.version,
      purpose: "身份可用",
      owner: "客服部",
      sensitiveFields: [],
    });
    const targetPolicy = policies.update({
      sourceId: callbacks.id,
      purpose: "关联受限",
      owner: "客服部",
      sensitiveFields: ["complaint_id"],
    });
    assert.equal(read(service, apiKey, relation).body.code, "sensitive_field");
    assert.equal(
      read(service, apiKey, "type=Callback&fields=result").status,
      200,
    );
    policies.update({
      sourceId: callbacks.id,
      version: targetPolicy.version,
      purpose: "回访编号受限",
      owner: "客服部",
      sensitiveFields: ["id"],
    });
    assert.equal(
      read(service, apiKey, "type=Callback&id=F1&fields=result").body.code,
      "sensitive_field",
    );
    assert.equal(
      read(
        service,
        apiKey,
        "type=Complaint&id=C1&relation=callbacks&fields=$id",
      ).body.code,
      "sensitive_field",
    );
    assert.equal(
      read(service, apiKey, "type=Complaint&fields=contact").body.code,
      "field_denied",
    );
  } finally {
    service.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a retired unclassified column can still be restricted for consumers using its historical data version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-retired-sensitive-column-"));
  const memory = new MemoryStore(directory);
  const service = new ConsumptionService(directory, memory);
  try {
    const { source, model, workspace } = await fixture(memory);
    const draft = service.propose({
      name: "历史资料助手",
      purpose: "读取当时的联络资料",
      modelId: model.id,
      modelVersion: model.version,
      grants: [{ type: "Complaint", fields: ["contact"], relations: [] }],
    });
    const { apiKey } = service.activate(draft.id, draft.version);
    workspace.upload("投诉.csv", "id,status\nC1,open\n");
    assert.equal(read(service, apiKey, "type=Complaint").status, 200);
    const policies = new SourcePolicyService(memory);
    assert.deepEqual(policies.availableFields(source.id), [
      "id",
      "status",
      "phone",
    ]);
    policies.update({
      sourceId: source.id,
      purpose: "限制历史联系方式",
      owner: "客服部",
      sensitiveFields: ["phone"],
    });
    assert.equal(
      read(service, apiKey, "type=Complaint").body.code,
      "sensitive_field",
    );
    assert.equal(memory.getArtifact(source.id).version, 2);
    workspace.upload("投诉.csv", 'id,status\nC1,"未闭合');
    assert.deepEqual(policies.availableFields(source.id), [
      "id",
      "status",
      "phone",
    ]);
  } finally {
    service.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
