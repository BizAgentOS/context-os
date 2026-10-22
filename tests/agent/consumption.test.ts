import {publishedDefinition,publishWorking,connectPublished,ref} from "./published-consumers-fixture.ts";
import {Releases} from "../../src/engine/releases.ts";
import { historicalConsumers } from "./historical-consumers-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import { ConsumptionService } from "../../src/agent/consumption.ts";
import type { Artifact, Data } from "../../src/agent/contracts.ts";

async function model(repo: MemoryStore) {
  const workspace = new Workspace(repo);
  const tickets = workspace.upload(
    "投诉.csv",
    "id,status,phone\nC1,closed,13800000001\nC2,open,13800000002\n",
  );
  const callbacks = workspace.upload(
    "回访.csv",
    "id,complaint_id,result,phone\nF1,C1,improved,13800000003\n",
  );
  const draft = (await workspace.execute("ontology_propose", {
    title: "投诉与回访",
    purpose: "核查处理与回访",
    types: [
      {
        name: "Complaint",
        description: "投诉",
        sourceId: tickets.id,
        idField: "id",
        fields: { status: "status", phone: "phone" },
      },
      {
        name: "Callback",
        description: "回访",
        sourceId: callbacks.id,
        idField: "id",
        fields: {
          complaintId: "complaint_id",
          result: "result",
          phone: "phone",
        },
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
      { sourceId: tickets.id, version: 1 },
      { sourceId: callbacks.id, version: 1 },
    ],
  })) as unknown as Artifact;
  const preview = (await workspace.execute("ontology_preview", {
    id: draft.id,
    version: draft.version,
  })) as unknown as Artifact;
  return {
    model: workspace.adopt(preview.id, preview.version),
    tickets,
    callbacks,
    workspace,
  };
}

const read = (
  service: ConsumptionService,
  key: string,
  query: string,
  path = "/v1/objects",
  method = "GET",
) =>
  service.handle({
    method,
    path,
    query: new URLSearchParams(query),
    authorization: `Bearer ${key}`,
  });

test("a reviewed consumer receives only granted fields, keeps its exact source version and can be revoked after reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-consumption-"));
  let memory = new MemoryStore(directory);
  let service = new ConsumptionService(directory, memory);
  try {
    const fixture = await model(memory);
    const draft = historicalConsumers(service, memory, directory).propose({
      name: "客服助手",
      purpose: "查询投诉状态",
      modelId: fixture.model.id,
      modelVersion: fixture.model.version,
      grants: [{ type: "Complaint", fields: ["$id", "status"], relations: [] }],
    });
    assert.equal(draft.status, "draft");

    const { consumer, apiKey } = historicalConsumers(service, memory, directory).activate(draft.id, draft.version);
    assert.equal(consumer.status, "active");
    assert.match(apiKey, /^de_consumer_/);

    const result = read(service, apiKey, "type=Complaint");
    assert.equal(result.status, 200);
    assert.deepEqual((result.body as Data).items, [
      { type: "Complaint", id: "C1", fields: { status: "closed" } },
      { type: "Complaint", id: "C2", fields: { status: "open" } },
    ]);
    assert.equal(JSON.stringify(result).includes("13800000001"), false);
    assert.equal(
      read(service, apiKey, "type=Complaint&fields=phone").status,
      403,
    );
    assert.equal(read(service, apiKey, "type=Callback").status, 403);
    fixture.workspace.upload(
      "投诉.csv",
      "id,status,phone\nC1,updated,13899999999\n",
    );
    assert.equal(
      (
        (
          (read(service, apiKey, "type=Complaint&id=C1").body as Data)
            .items as Data[]
        )[0].fields as Data
      ).status,
      "closed",
    );
    service.close();
    memory.close();
    memory = new MemoryStore(directory);
    service = new ConsumptionService(directory, memory);
    assert.equal(read(service, apiKey, "type=Complaint").status, 200);
    const revoked = service.revoke(consumer.id, consumer.version);
    assert.equal(revoked.status, "revoked");
    assert.equal(read(service, apiKey, "type=Complaint").status, 401);
    assert.equal(
      service.logs(consumer.id).some((entry) => entry.result === "denied"),
      true,
    );
    assert.equal(
      JSON.stringify(memory.listArtifacts()).includes(apiKey),
      false,
    );
    assert.equal(JSON.stringify(service.logs()).includes(apiKey), false);
    assert.equal(JSON.stringify(service.list()).includes("keyHash"), false);
  } finally {
    service.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("relationships require both endpoint grants and never expose hidden fields or evidence; undeclared operations are denied", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-relations-"));
  const memory = new MemoryStore(directory);
  const service = new ConsumptionService(directory, memory);
  try {
    const fixture = await model(memory);
    const base = {
      name: "客服关系助手",
      purpose: "查看回访结果",
      modelId: fixture.model.id,
      modelVersion: fixture.model.version,
    };
    const grants = [
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
    ];


    const draft = historicalConsumers(service, memory, directory).propose({ ...base, grants });
    const { apiKey } = historicalConsumers(service, memory, directory).activate(draft.id, draft.version);
    const result = read(
      service,
      apiKey,
      "type=Complaint&id=C1&relation=callbacks&fields=result",
    );
    assert.equal(result.status, 200);
    assert.deepEqual((result.body as Data).items, [
      { type: "Callback", fields: { result: "improved" } },
    ]);
    assert.equal(JSON.stringify(result).includes("phone"), false);
    assert.equal(JSON.stringify(result).includes("evidence"), false);
    assert.equal(
      read(
        service,
        apiKey,
        "type=Complaint&id=C1&relation=callbacks&fields=phone",
      ).status,
      403,
    );
    for (const query of [
      "type=Complaint&fields=phone",
      "type=Complaint&fields=unknown",
      "type=Complaint&fields=*",
      "type=Complaint&fields=status&fields=phone",
      "type=Complaint&id=C1&relation=callbacks.secret",
      "type=Complaint&relation=callbacks",
      "type=Complaint&modelVersion=99",
      "type=Complaint&version=99",
      "type=Complaint&where.phone=13800000001",
      "type=Complaint&evidence=true",
      "type=Complaint&raw=true",
      "type=Complaint&method=recoveryEvidence",
      "type=Complaint&aggregate=phone",
    ])
      assert.equal(read(service, apiKey, query).status, 403, query);
    for (const path of [
      "/v1/evidence",
      "/v1/sources",
      "/v1/aggregate",
      "/v1/objects/C1/evidence",
    ])
      assert.equal(
        read(service, apiKey, "type=Complaint", path).status,
        404,
        path,
      );
    assert.equal(
      read(service, apiKey, "type=Complaint", "/v1/objects", "POST").status,
      405,
    );
    assert.equal(read(service, "invalid", "type=Complaint").status, 401);
    assert.equal(read(service, apiKey, "type=Complaint&offset=-1").status, 400);
    assert.equal(JSON.stringify(service.logs()).includes("13800000001"), false);
    const noIdentity = historicalConsumers(service, memory, directory).propose({
      ...base,
      name: "统计界面",
      grants: [{ type: "Complaint", fields: ["status"], relations: [] }],
    });
    const limited = historicalConsumers(service, memory, directory).activate(noIdentity.id, noIdentity.version);
    assert.deepEqual(
      (read(service, limited.apiKey, "type=Complaint").body as Data).items,
      [
        { type: "Complaint", fields: { status: "closed" } },
        { type: "Complaint", fields: { status: "open" } },
      ],
    );
    assert.equal(
      read(service, limited.apiKey, "type=Complaint&id=C1").status,
      403,
    );
    assert.equal(
      read(service, limited.apiKey, "type=Complaint&fields=$id").status,
      403,
    );
  } finally {
    service.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real HTTP separates admin capabilities from consumer keys, audits denied reads and survives restart", async () => {
  const { createServer } = await import("../../src/agent/server.ts");
  const directory = mkdtempSync(join(tmpdir(), "dataengine-consumer-http-"));
  const driver = {
    async run() {
      return { text: "", sessionId: "unused", runId: "unused" };
    },
    async stop() {},
    async close() {},
  };
  let service = await createServer({ directory, driver, automaticApi:false });
  const listen = async () => {
    await new Promise<void>((done) =>
      service.server.listen(0, "127.0.0.1", done),
    );
    const address = service.server.address() as import("node:net").AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  };
  let origin = await listen();
  try {
    assert.equal((await fetch(`${origin}/api/canvas/bootstrap`)).status, 403);
    const bootstrap = await fetch(`${origin}/api/canvas/bootstrap`, {
      headers: { "x-dataengine-token": service.adminToken },
    });
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/api/);
    assert.equal(
      (
        await fetch(`${origin}/api/canvas`, {
          headers: { cookie: cookie.split(";")[0] },
        })
      ).status,
      200,
    );
    const fixture = await model(service.app.memory);
    const primary=service.app.live.sources.connectUpload(fixture.tickets.id,fixture.tickets.version,"id");
    const related=service.app.live.sources.connectUpload(fixture.callbacks.id,fixture.callbacks.version,"id");
    await service.app.snapshots.sync({operationId:"current-consumer-snapshots"});
    const definition=publishedDefinition(service.app,{purpose:"当前发布消费",rationale:"明确的虚构投诉与回访映射",types:[
      {name:"Complaint",description:"投诉",sourceId:primary.id,capability:"records",fields:{status:"status",phone:"phone"}},
      {name:"Callback",description:"回访",sourceId:related.id,capability:"records",fields:{complaintId:"complaint_id",result:"result",phone:"phone"}},
    ],relations:[{name:"callbacks",from:"Complaint",to:"Callback",fromField:"$id",toField:"complaintId"}]});
    const candidate=await service.app.live.propose(definition);await service.app.live.adopt(candidate.id,candidate.version);
    const publication=await publishWorking(service.app);
    const connected=connectPublished(service.app,publication,{name:"外部客服",purpose:"获取投诉状态",grants:[{type:"Complaint",fields:["$id","status"],relations:[]}]});
    const consumer=connected.connection,apiKey=connected.key!;
    const authorization = `Bearer ${apiKey}`;
    for (const path of [
      "/api/bootstrap",
      "/api/canvas/bootstrap",
      "/api/state",
      "/api/canvas",
      "/api/objects",
      `/api/artifacts/${fixture.tickets.id}`,
      "/api/consumers",
    ])
      for (const headers of [
        {},
        { authorization },
        { authorization, cookie: cookie.split(";")[0] },
      ] as Record<string, string>[])
        assert.equal(
          (await fetch(`${origin}${path}`, { headers })).status,
          403,
          path,
        );
    const good = await fetch(`${origin}/v4/objects?type=Complaint`, {
      headers: { authorization },
    });
    assert.equal(good.status, 200);
    assert.deepEqual((await good.json()).items.map((item:any)=>[item.objectRef.id,item.properties.status.value]),[["C1","closed"],["C2","open"]]);
    assert.equal(
      (
        await fetch(`${origin}/v4/objects?type=Complaint`, {
          headers: {
            "x-dataengine-token": service.adminToken,
            cookie: cookie.split(";")[0],
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${origin}/v4/objects?type=Complaint&fields=phone`, {
          headers: { authorization },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${origin}/v4/evidence?type=Complaint`, {
          headers: { authorization },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${origin}/v4/objects?type=Complaint`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      405,
    );
    const forbiddenActivation = await fetch(
      `${origin}/api/consumers/activate`,
      {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ id: consumer.id, version: consumer.version }),
      },
    );
    assert.equal(forbiddenActivation.status, 403);
    const oldToken = service.adminToken;
    await service.close();
    service = await createServer({ directory, driver, automaticApi:false });
    origin = await listen();
    assert.equal(service.adminToken, oldToken);
    assert.equal(
      (
        await fetch(`${origin}/v4/objects?type=Complaint`, {
          headers: { authorization },
        })
      ).status,
      200,
    );
    new Releases(service.app.memory,service.app.live).revoke({operationId:"revoke-http-consumer",connectionRef:ref(consumer)});
    assert.equal(
      (
        await fetch(`${origin}/v4/objects?type=Complaint`, {
          headers: { authorization },
        })
      ).status,
      403,
    );
    const records=await fetch(`${origin}/api/releases/connection-detail?id=${consumer.id}&version=${consumer.version+1}`,{headers:{"x-dataengine-token":service.adminToken}});
    assert.equal(records.status,200);
    const audit=(await records.json()).usage;
    assert(audit.succeeded>0);assert(audit.failed>0);
    assert.equal(JSON.stringify(audit).includes(apiKey),false);
    assert.equal(JSON.stringify(audit).includes("13800000001"),false);
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a relation grant also requires the start object's identifier even when its join uses another field", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "dataengine-relation-identity-"),
  );
  const memory = new MemoryStore(directory);
  const service = new ConsumptionService(directory, memory);
  try {
    const fixture = await model(memory);
    const candidate = (await fixture.workspace.execute("ontology_propose", {
      ...fixture.model.content,
      title: "按联系电话关联",
      relations: [
        {
          name: "samePhone",
          from: "Complaint",
          to: "Callback",
          fromField: "phone",
          toField: "phone",
        },
      ],
    })) as unknown as Artifact;
    const preview = (await fixture.workspace.execute("ontology_preview", {
      id: candidate.id,
      version: candidate.version,
    })) as unknown as Artifact;
    const adopted = fixture.workspace.adopt(preview.id, preview.version);
    const scope = {
      name: "核对助手",
      purpose: "按已授权的电话关联回访",
      modelId: adopted.id,
      modelVersion: adopted.version,
      grants: [
        { type: "Complaint", fields: ["phone"], relations: ["samePhone"] },
        { type: "Callback", fields: ["phone", "result"], relations: [] },
      ],
    };

    assert.deepEqual(service.list(), []);
    const draft = historicalConsumers(service, memory, directory).propose({
      ...scope,
      grants: [
        { ...scope.grants[0], fields: ["$id", "phone"] },
        scope.grants[1],
      ],
    });
    const { apiKey } = historicalConsumers(service, memory, directory).activate(draft.id, draft.version);
    assert.equal(
      read(service, apiKey, "type=Complaint&id=C1&relation=samePhone").status,
      200,
    );
  } finally {
    service.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
