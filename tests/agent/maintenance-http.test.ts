import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Artifact } from "../../src/agent/contracts.ts";
import { createServer } from "../../src/agent/server.ts";
import { Workspace } from "../../src/agent/workspace.ts";

test("management records business review and source policy without changing data; stale and unauthenticated edits fail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dataengine-maintenance-http-"));
  let service = await createServer({ directory });
  const start = async () => {
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    return `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  };
  let base = await start();
  const post = (path: string, body: unknown, authorized = true) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorized ? { "X-DataEngine-Token": service.adminToken } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const workspace = new Workspace(service.app.memory);
    const source = workspace.upload(
      "tickets.csv",
      "id,status,phone\nT1,closed,13800000000\n",
    );
    let model = workspace.execute("ontology_propose", {
      title: "投诉定义",
      purpose: "查询办结记录",
      types: [
        {
          name: "投诉",
          description: "客户投诉记录，办结不代表恢复",
          sourceId: source.id,
          idField: "id",
          fields: { 状态: "status", 电话: "phone" },
        },
      ],
      relations: [],
      functions: [],
      evidence: [{ sourceId: source.id, version: source.version }],
    }) as unknown as Artifact;
    model = workspace.execute("ontology_preview", {
      id: model.id,
      version: model.version,
    }) as unknown as Artifact;
    const verification = workspace.execute("ontology_verify", {
      question: "T1 的状态是什么？",
      candidateId: model.id,
      candidateVersion: model.version,
      operations: [{ op: "get", type: "投诉", id: "T1", as: "ticket" }],
    }) as unknown as Artifact;
    const reviewBody = {
      id: verification.id,
      version: verification.version,
      status: "matches_expectation",
    };
    assert.equal(
      (await post("/api/verifications/review", reviewBody, false)).status,
      403,
    );
    const response = await post("/api/verifications/review", reviewBody);
    assert.equal(response.status, 200, await response.clone().text());
    const reviewed = (await response.json()).verification;
    assert.equal(reviewed.status, "matches_expectation");
    assert.equal(reviewed.content.review.origin, "user");
    assert.deepEqual(reviewed.content.result, verification.content.result);
    assert.equal(
      (await post("/api/verifications/review", reviewBody)).status,
      400,
    );
    assert.equal(
      (
        await post("/api/verifications/review", {
          ...reviewBody,
          id: source.id,
        })
      ).status,
      400,
    );
    const policyResponse = await post("/api/sources/policy", {
      sourceId: source.id,
      version: 0,
      purpose: "联络客户并查投诉进度",
      owner: "客服",
      sensitiveFields: ["phone"],
    });
    assert.equal(
      policyResponse.status,
      200,
      await policyResponse.clone().text(),
    );
    const policy = (await policyResponse.json()).policy;
    assert.equal(policy.content.owner, "客服");
    assert.equal(service.app.memory.getArtifact(source.id).version, 1);
    await service.close();
    service = await createServer({ directory });
    base = await start();
    const state = await fetch(base + "/api/canvas?page=ontology", {
      headers: { "X-DataEngine-Token": service.adminToken },
    }).then((r) => r.json());
    assert.equal(state.verifications[0].status, "matches_expectation");
    assert.deepEqual(state.sourcePolicies[0].content.sensitiveFields, [
      "phone",
    ]);
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
