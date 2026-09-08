import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { ConsumptionService } from "../../src/agent/consumption.ts";
import { SourcePolicyService } from "../../src/agent/source-policy.ts";
import type { Artifact, Data } from "../../src/agent/contracts.ts";

async function fixture(memory: MemoryStore, service: ConsumptionService) {
  const workspace = new Workspace(memory);
  const source = workspace.upload(
    "投诉.csv",
    "id,status,private\nC1,closed,secret\n",
  );
  const callbacks = workspace.upload(
    "回访.csv",
    "id,complaint_id,result\nF1,C1,unknown\n",
  );
  const policy = workspace.upload(
    "口径.md",
    "工单办结不等于居民已经确认恢复。",
  );
  const draft = (await workspace.execute("ontology_propose", {
    title: "供热服务",
    purpose: "查询恢复依据",
    types: [
      {
        name: "Complaint",
        description: "投诉",
        sourceId: source.id,
        idField: "id",
        fields: { status: "status", private: "private" },
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
    evidence: [source, callbacks, policy].map(({ id, version }) => ({
      sourceId: id,
      version,
    })),
  })) as unknown as Artifact;
  const preview = (await workspace.execute("ontology_preview", {
    id: draft.id,
    version: draft.version,
  })) as unknown as Artifact;
  const model = workspace.adopt(preview.id, preview.version);
  const consumerDraft = service.propose({
    name: "客服 Agent",
    purpose: "按授权检查处理与回访",
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
  return {
    workspace,
    source,
    callbacks,
    policy,
    model,
    ...service.activate(consumerDraft.id, consumerDraft.version),
  };
}

const read = (
  service: ConsumptionService,
  key: string,
  query = "type=Complaint",
  path = "/v1/objects",
) =>
  service.handle({
    method: "GET",
    path,
    query: new URLSearchParams(query),
    authorization: `Bearer ${key}`,
  });
const statuses = (service: ConsumptionService, key: string) =>
  (read(service, key).body.items as Data[]).map(
    (item) => (item.fields as Data).status,
  );

test("publishing records retains the same key, fixed ontology and grants; pinned reads detect a new publication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-data-publish-"));
  let memory = new MemoryStore(directory);
  let service = new ConsumptionService(directory, memory);
  try {
    const f = await fixture(memory, service);
    const otherDraft = service.propose({
      name: "另一个助手",
      purpose: "保留此前发布的数据",
      modelId: f.model.id,
      modelVersion: f.model.version,
      grants: [{ type: "Complaint", fields: ["status"], relations: [] }],
    });
    const other = service.activate(otherDraft.id, otherDraft.version);
    const schema = read(service, f.apiKey, "", "/v1/schema");
    assert.equal(schema.status, 200);
    assert.equal(schema.body.dataVersion, f.consumer.version);
    assert.deepEqual((schema.body.types as Data[])[0], {
      name: "Complaint",
      description: "投诉",
      fields: [{ name: "$id" }, { name: "status" }],
      relations: [{ name: "callbacks", to: "Callback" }],
    });
    for (const hidden of [
      "private",
      "sourceId",
      "idField",
      "evidence",
      "sourceVersions",
      "mapping",
    ])
      assert.equal(JSON.stringify(schema.body).includes(hidden), false, hidden);
    f.workspace.upload(
      "投诉.csv",
      "id,status,private\nC1,recovered,changed-secret\nC2,open,other-secret\n",
    );
    f.workspace.upload("口径.md", "另一套尚未采用的恢复口径。");
    assert.deepEqual(statuses(service, f.apiKey), ["closed"]);
    const update = service.previewDataUpdate(f.consumer.id, f.consumer.version);
    assert.equal(update.valid, true);
    assert.deepEqual(
      update.changedSources.map((source) => source.sourceId),
      [f.source.id],
    );
    assert.equal(update.nextSourceVersions[f.policy.id], 1);
    assert.equal(update.currentSourceVersions[f.source.id], 1);
    assert.equal(update.nextSourceVersions[f.source.id], 2);
    const published = service.publishDataUpdate(
      f.consumer.id,
      f.consumer.version,
      update.nextSourceVersions,
    );
    assert.equal(published.version, f.consumer.version + 1);
    assert.deepEqual(published.content.grants, f.consumer.content.grants);
    assert.equal(published.content.modelId, f.model.id);
    assert.equal(published.content.modelVersion, f.model.version);
    assert.deepEqual(memory.getArtifact(f.model.id, f.model.version), f.model);
    assert.deepEqual(statuses(service, f.apiKey), ["recovered", "open"]);
    assert.deepEqual(statuses(service, other.apiKey), ["closed"]);
    assert.equal(
      read(
        service,
        f.apiKey,
        `type=Complaint&dataVersion=${f.consumer.version}`,
      ).status,
      409,
    );
    assert.equal(
      read(service, f.apiKey, `type=Complaint&dataVersion=${published.version}`)
        .status,
      200,
    );
    assert.equal(
      read(service, f.apiKey, `dataVersion=${f.consumer.version}`, "/v1/schema")
        .status,
      409,
    );
    assert.equal(
      read(service, f.apiKey, "type=Complaint&dataVersion=oops").status,
      400,
    );
    const relation = read(
      service,
      f.apiKey,
      `type=Complaint&id=C1&relation=callbacks&dataVersion=${published.version}`,
    );
    assert.equal(relation.status, 200);
    assert.equal((relation.body.items as Data[])[0].id, "F1");
    assert.throws(
      () =>
        service.publishDataUpdate(
          published.id,
          published.version,
          update.nextSourceVersions,
        ),
      /无需发布/,
    );
    f.workspace.upload("投诉.csv", "id,status,private\nC1,verified,secret\n");
    const next = service.previewDataUpdate(published.id, published.version);
    const second = service.publishDataUpdate(
      published.id,
      published.version,
      next.nextSourceVersions,
    );
    assert.deepEqual(statuses(service, f.apiKey), ["verified"]);
    service.close();
    memory.close();
    memory = new MemoryStore(directory);
    service = new ConsumptionService(directory, memory);
    assert.deepEqual(statuses(service, f.apiKey), ["verified"]);
    service.revoke(second.id, second.version);
    service.close();
    memory.close();
    memory = new MemoryStore(directory);
    service = new ConsumptionService(directory, memory);
    assert.equal(read(service, f.apiKey).status, 401);
    assert.equal(read(service, f.apiKey, "", "/v1/schema").status, 401);
    assert.equal(
      JSON.stringify(memory.listArtifacts()).includes(f.apiKey),
      false,
    );
    assert.equal(JSON.stringify(service.logs()).includes(f.apiKey), false);
  } finally {
    service.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stale preview and broken source rows cannot replace the active published data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-data-conflict-"));
  const memory = new MemoryStore(directory);
  const service = new ConsumptionService(directory, memory);
  try {
    const f = await fixture(memory, service);
    f.workspace.upload("投诉.csv", "id,status,private\nC1,recovered,secret\n");
    const preview = service.previewDataUpdate(
      f.consumer.id,
      f.consumer.version,
    );
    f.workspace.upload("投诉.csv", "id,status,private\nC1,newer,secret\n");
    assert.throws(
      () =>
        service.publishDataUpdate(
          f.consumer.id,
          f.consumer.version,
          preview.nextSourceVersions,
        ),
      /来源版本已变化/,
    );
    assert.throws(
      () => service.previewDataUpdate(f.consumer.id, f.consumer.version + 1),
      /授权版本/,
    );
    for (const csv of [
      "id,renamed,private\nC1,closed,secret\n",
      "id,status,private\nC1,closed,secret\nC1,open,secret\n",
      "id,status,private\n,closed,secret\n",
    ]) {
      f.workspace.upload("投诉.csv", csv);
      const invalid = service.previewDataUpdate(
        f.consumer.id,
        f.consumer.version,
      );
      assert.equal(invalid.valid, false, csv);
      assert.throws(
        () =>
          service.publishDataUpdate(
            f.consumer.id,
            f.consumer.version,
            invalid.nextSourceVersions,
          ),
        /未通过检查/,
      );
      assert.deepEqual(statuses(service, f.apiKey), ["closed"]);
      assert.equal(
        memory.getArtifact(f.consumer.id).version,
        f.consumer.version,
      );
    }
    const latest = memory.getArtifact(f.source.id);
    memory.putArtifact({
      id: latest.id,
      expectedVersion: latest.version,
      kind: "source",
      title: latest.title,
      status: "ready",
      content: { ...latest.content, rows: [{ id: "C1", private: "secret" }] },
    });
    const malformed = service.previewDataUpdate(
      f.consumer.id,
      f.consumer.version,
    );
    assert.equal(malformed.valid, false);
    assert.match(malformed.errors.join(" "), /缺少映射字段/);
    assert.deepEqual(statuses(service, f.apiKey), ["closed"]);
  } finally {
    service.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed publication leaves the old data and credential usable", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "dataengine-data-write-failure-"),
  );
  const memory = new MemoryStore(directory);
  let fail = false;
  const service = new ConsumptionService(directory, {
    getArtifact: memory.getArtifact.bind(memory),
    listArtifacts: memory.listArtifacts.bind(memory),
    putArtifact: (...args: Parameters<MemoryStore["putArtifact"]>) => {
      if (fail && args[0].kind === "consumer")
        throw new Error("injected publication failure");
      return memory.putArtifact(...args);
    },
  });
  try {
    const f = await fixture(memory, service);
    f.workspace.upload("投诉.csv", "id,status,private\nC1,recovered,secret\n");
    const update = service.previewDataUpdate(f.consumer.id, f.consumer.version);
    fail = true;
    assert.throws(
      () =>
        service.publishDataUpdate(
          f.consumer.id,
          f.consumer.version,
          update.nextSourceVersions,
        ),
      /injected publication failure/,
    );
    assert.deepEqual(memory.getArtifact(f.consumer.id), f.consumer);
    assert.deepEqual(statuses(service, f.apiKey), ["closed"]);
    fail = false;
    service.publishDataUpdate(
      f.consumer.id,
      f.consumer.version,
      update.nextSourceVersions,
    );
    assert.deepEqual(statuses(service, f.apiKey), ["recovered"]);
  } finally {
    service.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("latest sensitivity rules still block old keys, schema disclosure and data publication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-data-policy-"));
  const memory = new MemoryStore(directory);
  const service = new ConsumptionService(directory, memory);
  try {
    const f = await fixture(memory, service);
    f.workspace.upload("投诉.csv", "id,status,private\nC1,recovered,secret\n");
    const update = service.previewDataUpdate(f.consumer.id, f.consumer.version);
    new SourcePolicyService(memory).update({
      sourceId: f.source.id,
      purpose: "内部使用",
      owner: "客服",
      version: 0,
      sensitiveFields: ["status"],
    });
    assert.equal(read(service, f.apiKey).status, 403);
    const schema = read(service, f.apiKey, "", "/v1/schema");
    assert.equal(schema.status, 403);
    assert.equal(JSON.stringify(schema.body).includes("status"), false);
    const preview = service.previewDataUpdate(
      f.consumer.id,
      f.consumer.version,
    );
    assert.equal(preview.valid, false);
    assert.throws(
      () =>
        service.publishDataUpdate(
          f.consumer.id,
          f.consumer.version,
          update.nextSourceVersions,
        ),
      /未通过检查/,
    );
    assert.deepEqual(memory.getArtifact(f.consumer.id), f.consumer);
    assert.ok(
      service
        .logs(f.consumer.id)
        .some((entry) => entry.reason === "scope_unavailable"),
    );
  } finally {
    service.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema discovery is scoped and audited; carrying a credential anchor cannot widen its grants", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-schema-scope-"));
  const memory = new MemoryStore(directory);
  const service = new ConsumptionService(directory, memory);
  try {
    const f = await fixture(memory, service);
    const draft = service.propose({
      name: "状态助手",
      purpose: "只读取状态",
      modelId: f.model.id,
      modelVersion: f.model.version,
      grants: [{ type: "Complaint", fields: ["status"], relations: [] }],
    });
    const limited = service.activate(draft.id, draft.version);
    const schema = read(service, limited.apiKey, "", "/v1/schema");
    assert.equal(schema.status, 200);
    assert.deepEqual(schema.body.types, [
      {
        name: "Complaint",
        description: "投诉",
        fields: [{ name: "status" }],
        relations: [],
      },
    ]);
    assert.equal(read(service, "invalid", "", "/v1/schema").status, 401);
    assert.equal(
      read(service, limited.apiKey, "type=Callback", "/v1/schema").status,
      403,
    );
    assert.equal(
      service
        .logs(limited.consumer.id)
        .filter((entry) => entry.result === "allowed").length,
      1,
    );
    f.workspace.upload("投诉.csv", "id,status,private\nC1,recovered,secret\n");
    const preview = service.previewDataUpdate(
      limited.consumer.id,
      limited.consumer.version,
    );
    const published = service.publishDataUpdate(
      limited.consumer.id,
      limited.consumer.version,
      preview.nextSourceVersions,
    );
    memory.putArtifact({
      id: published.id,
      expectedVersion: published.version,
      kind: "consumer",
      title: published.title,
      status: "active",
      content: {
        ...published.content,
        grants: [
          { type: "Complaint", fields: ["status", "private"], relations: [] },
        ],
      },
    });
    assert.equal(read(service, limited.apiKey).status, 401);
    assert.equal(read(service, limited.apiKey, "", "/v1/schema").status, 401);
  } finally {
    service.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
