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
    const draft = service.propose({
      name: "客服助手",
      purpose: "查询投诉状态",
      modelId: fixture.model.id,
      modelVersion: fixture.model.version,
      grants: [{ type: "Complaint", fields: ["$id", "status"], relations: [] }],
    });
    assert.equal(draft.status, "draft");
    assert.throws(() => service.activate(draft.id, draft.version + 1), /版本/);
    const { consumer, apiKey } = service.activate(draft.id, draft.version);
    assert.equal(consumer.status, "active");
    assert.match(apiKey, /^de_consumer_/);
    assert.throws(() => service.activate(draft.id, draft.version), /版本|草稿/);
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
    assert.throws(
      () => service.propose({ ...base, grants: [grants[0]] }),
      /目标类型/,
    );
    assert.throws(
      () =>
        service.propose({
          ...base,
          grants: [grants[0], { ...grants[1], fields: ["result"] }],
        }),
      /连接字段/,
    );
    const draft = service.propose({ ...base, grants });
    const { apiKey } = service.activate(draft.id, draft.version);
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
    const noIdentity = service.propose({
      ...base,
      name: "统计界面",
      grants: [{ type: "Complaint", fields: ["status"], relations: [] }],
    });
    const limited = service.activate(noIdentity.id, noIdentity.version);
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
  let service = await createServer({ directory, driver });
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
    const draft = service.app.consumption.propose({
      name: "外部客服",
      purpose: "获取投诉状态",
      modelId: fixture.model.id,
      modelVersion: fixture.model.version,
      grants: [{ type: "Complaint", fields: ["$id", "status"], relations: [] }],
    });
    const { consumer, apiKey } = service.app.consumption.activate(
      draft.id,
      draft.version,
    );
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
    const good = await fetch(`${origin}/v1/objects?type=Complaint`, {
      headers: { authorization },
    });
    assert.equal(good.status, 200);
    assert.deepEqual((await good.json()).items, [
      { type: "Complaint", id: "C1", fields: { status: "closed" } },
      { type: "Complaint", id: "C2", fields: { status: "open" } },
    ]);
    assert.equal(
      (
        await fetch(`${origin}/v1/objects?type=Complaint`, {
          headers: {
            "x-dataengine-token": service.adminToken,
            cookie: cookie.split(";")[0],
          },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${origin}/v1/objects?type=Complaint&fields=phone`, {
          headers: { authorization },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${origin}/v1/evidence?type=Complaint`, {
          headers: { authorization },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${origin}/v1/objects?type=Complaint`, {
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
    service = await createServer({ directory, driver });
    origin = await listen();
    assert.equal(service.adminToken, oldToken);
    assert.equal(
      (
        await fetch(`${origin}/v1/objects?type=Complaint`, {
          headers: { authorization },
        })
      ).status,
      200,
    );
    service.app.consumption.revoke(consumer.id, consumer.version);
    assert.equal(
      (
        await fetch(`${origin}/v1/objects?type=Complaint`, {
          headers: { authorization },
        })
      ).status,
      401,
    );
    const records = await fetch(`${origin}/api/consumers`, {
      headers: { "x-dataengine-token": service.adminToken },
    });
    assert.equal(records.status, 200);
    const audit = (await records.json()).audit;
    assert.equal(
      audit.some((log: { result: string }) => log.result === "allowed"),
      true,
    );
    assert.equal(
      audit.some((log: { result: string }) => log.result === "denied"),
      true,
    );
    assert.equal(JSON.stringify(audit).includes(apiKey), false);
    assert.equal(JSON.stringify(audit).includes("13800000001"), false);
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
    assert.throws(() => service.propose(scope), /起始对象.*\$id/);
    assert.deepEqual(service.list(), []);
    const draft = service.propose({
      ...scope,
      grants: [
        { ...scope.grants[0], fields: ["$id", "phone"] },
        scope.grants[1],
      ],
    });
    const { apiKey } = service.activate(draft.id, draft.version);
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

test("a credential commit failure keeps the authorization draft retryable", async (context) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = mkdtempSync(
    join(tmpdir(), "dataengine-activation-failure-"),
  );
  const memory = new MemoryStore(directory);
  const service = new ConsumptionService(directory, memory);
  try {
    const fixture = await model(memory);
    const draft = service.propose({
      name: "客服助手",
      purpose: "读取状态",
      modelId: fixture.model.id,
      modelVersion: fixture.model.version,
      grants: [{ type: "Complaint", fields: ["status"], relations: [] }],
    });
    const exec = DatabaseSync.prototype.exec;
    let failed = false;
    context.mock.method(
      DatabaseSync.prototype,
      "exec",
      function (this: InstanceType<typeof DatabaseSync>, sql: string) {
        // Inject one storage failure, while assertions below stay on the consumer's public lifecycle.
        if (
          !failed &&
          sql === "COMMIT" &&
          this.prepare(
            "SELECT name FROM sqlite_master WHERE name='credentials'",
          ).get()
        ) {
          failed = true;
          throw new Error("injected credential commit failure");
        }
        return exec.call(this, sql);
      },
    );
    assert.throws(
      () => service.activate(draft.id, draft.version),
      /injected credential commit failure/,
    );
    context.mock.restoreAll();
    assert.equal(failed, true);
    assert.equal(service.list()[0].status, "draft");
    assert.equal(service.list()[0].version, draft.version);
    const { apiKey } = service.activate(draft.id, draft.version);
    assert.equal(read(service, apiKey, "type=Complaint").status, 200);
  } finally {
    context.mock.restoreAll();
    service.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed memory activation never publishes its key and retry invalidates the discarded key", async (context) => {
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const crypto = createRequire(import.meta.url)(
    "node:crypto",
  ) as typeof import("node:crypto");
  const directory = mkdtempSync(
    join(tmpdir(), "dataengine-memory-activation-failure-"),
  );
  const memory = new MemoryStore(directory);
  let failMemory = false;
  const repository = {
    getArtifact: memory.getArtifact.bind(memory),
    listArtifacts: memory.listArtifacts.bind(memory),
    putArtifact: (...args: Parameters<MemoryStore["putArtifact"]>) => {
      if (
        failMemory &&
        args[0].kind === "consumer" &&
        args[0].status === "active"
      ) {
        failMemory = false;
        throw new Error("injected enterprise memory failure");
      }
      return memory.putArtifact(...args);
    },
  };
  const service = new ConsumptionService(directory, repository);
  try {
    const fixture = await model(memory);
    const draft = service.propose({
      name: "客服助手",
      purpose: "读取状态",
      modelId: fixture.model.id,
      modelVersion: fixture.model.version,
      grants: [{ type: "Complaint", fields: ["status"], relations: [] }],
    });
    // A deterministic test key lets the public consumption API prove that a failed delivery cannot later become valid.
    context.mock.method(crypto, "randomBytes", (size: number) =>
      Buffer.alloc(size, 17),
    );
    syncBuiltinESMExports();
    const discardedKey = `de_consumer_${Buffer.alloc(32, 17).toString("base64url")}`;
    failMemory = true;
    assert.throws(
      () => service.activate(draft.id, draft.version),
      /injected enterprise memory failure/,
    );
    assert.equal(service.list()[0].status, "draft");
    assert.equal(read(service, discardedKey, "type=Complaint").status, 401);
    context.mock.restoreAll();
    syncBuiltinESMExports();
    const { apiKey } = service.activate(draft.id, draft.version);
    assert.notEqual(apiKey, discardedKey);
    assert.equal(read(service, apiKey, "type=Complaint").status, 200);
    assert.equal(read(service, discardedKey, "type=Complaint").status, 401);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    service.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unavailable ontology reference is rejected with exact adopted choices and saves no consumer", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "dataengine-consumer-model-reference-"),
  );
  const memory = new MemoryStore(directory);
  const service = new ConsumptionService(directory, memory);
  try {
    const fixture = await model(memory);
    const scope = {
      name: "客服助手",
      purpose: "读取投诉状态",
      modelId: `${fixture.model.id}-copied-wrong`,
      modelVersion: fixture.model.version,
      grants: [{ type: "Complaint", fields: ["status"], relations: [] }],
    };
    for (const args of [
      scope,
      { ...scope, modelId: fixture.model.id, modelVersion: 999 },
    ]) {
      assert.throws(
        () => service.propose(args),
        (error: Error) => {
          assert.match(error.message, /本体标识.*版本不可用/);
          assert.equal(
            error.message.includes(
              JSON.stringify({
                id: fixture.model.id,
                version: fixture.model.version,
                title: fixture.model.title,
              }),
            ),
            true,
          );
          assert.match(error.message, /原样复制/);
          return true;
        },
      );
      assert.deepEqual(service.list(), []);
    }
    const validScope = { ...scope, modelId: fixture.model.id };
    assert.throws(
      () =>
        service.propose({
          ...validScope,
          id: "invented-consumer-id",
          expectedVersion: 1,
        }),
      /该授权草稿不存在.*新建时省略 id 和 expectedVersion.*系统生成/,
    );
    assert.deepEqual(service.list(), []);
    assert.throws(
      () => service.propose({ ...validScope, expectedVersion: 1 }),
      /新建时省略 id 和 expectedVersion/,
    );
    assert.deepEqual(service.list(), []);
    const draft = service.propose(validScope);
    assert.throws(
      () => service.propose({ ...validScope, id: draft.id }),
      /修改.*expectedVersion/,
    );
    assert.equal(service.list()[0].version, draft.version);
    const changed = service.propose({
      ...validScope,
      id: draft.id,
      expectedVersion: draft.version,
      purpose: "读取已确认的投诉状态",
    });
    assert.equal(changed.id, draft.id);
    assert.equal(changed.version, draft.version + 1);
  } finally {
    service.close();
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
