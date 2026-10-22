import {publishedDefinition,publishWorking,connectPublished,ref} from "./published-consumers-fixture.ts";
import { restoreHistoricalAccess } from "./historical-consumers-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/agent/server.ts";
import {
  createFusionSources,
  primaryCapability,
  supplementCapability,
  fusionDefinition,
} from "./fusion-fixture.ts";

test("published v4 views expose only allowed fusion values and status, isolate credentials, and stop an in-flight revoked response", async () => {
  const source = await createFusionSources(),
    directory = mkdtempSync(join(tmpdir(), "de-view-"));
  const service = await createServer({ automaticApi: false,
    directory,
    driver: {
      async run() {
        return { text: "idle", sessionId: "s", runId: "r" };
      },
      async stop() {},
      async close() {},
    },
  });
  await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const admin = async (path: string, body: any) => {
    const r = await fetch(origin + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dataengine-token": service.adminToken,
      },
      body: JSON.stringify(body),
    });
    const value = (await r.json()) as any;
    if (!r.ok) throw new Error(value.error);
    return value;
  };
  const read = async (path: string, key: string) => {
    const response = await fetch(origin + path, {
      headers: { authorization: "Bearer " + key },
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  let release: (() => void) | undefined;
  try {
    const primary = (
      await admin("/api/live/connect", {
        name: "primary",
        protocol: "http",
        url: source.url,
        capabilities: [primaryCapability],
      })
    ).saved;
    const extra = (
      await admin("/api/live/connect", {
        name: "workorders",
        protocol: "mcp",
        url: source.url + "/mcp",
        capabilities: [supplementCapability],
      })
    ).saved;
    const model = (
      await admin("/api/live/propose", publishedDefinition(service.app,fusionDefinition(primary.id, extra.id)))
    ).saved;
    const adopted = (
      await admin("/api/live/adopt", { id: model.id, version: model.version })
    ).saved;
    const input = {
      operationId: "create",
      name: "agent A",
      purpose: "only feedback",
      modelRef: { id: adopted.id, version: adopted.version },
      grants: [
        { type: "投诉", fields: ["$id", "实际反馈", "状态"], relations: [] },
      ],
    };
    const publication=await publishWorking(service.app);
    const activation=connectPublished(service.app,publication,input);
    const replay=connectPublished(service.app,publication,input);
    assert.equal(replay.connection.id,activation.connection.id);
    assert.equal(replay.key,null);
    const key=activation.key!;
    const catalog = await read("/v4/dataset", key);
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.body.businessTypes, [{ name: "投诉" }]);
    const description = await read(
      "/v4/types?type=" + encodeURIComponent("投诉"),
      key,
    );
    assert.equal(description.status, 200);
    assert.doesNotMatch(
      JSON.stringify(description.body),
      /sourceId|ticket|WO02|phone|上门次数/,
    );
    source.state.mode = "conflict";
    const objects = await read(
      "/v4/objects?type=" + encodeURIComponent("投诉"),
      key,
    );
    assert.equal(objects.status, 200);
    assert.equal(objects.body.items[0].objectRef.id, "TS002");
    assert.equal(objects.body.items[0].properties.状态.value, null);
    assert.equal(objects.body.items[0].properties.状态.status, "conflict");
    assert.equal(objects.body.items[0].properties.实际反馈.value, "未改善");
    assert.equal(objects.body.items[1].properties.实际反馈.status, "missing");
    assert.doesNotMatch(
      JSON.stringify(objects.body),
      /sourceId|recordId|private|WO02|ticket/,
    );
    assert.equal(
      (
        await read(
          "/v4/objects?type=" +
            encodeURIComponent("投诉") +
            "&fields=$id,phone",
          key,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await read(
          "/v4/objects?type=" + encodeURIComponent("投诉") + "&limit=21",
          key,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await read(
          "/v4/objects?type=" + encodeURIComponent("投诉") + "&type=secret",
          key,
        )
      ).status,
      400,
    );
    assert.equal((await read("/v2/schema", key)).status, 410);
    const legacy = (
      await restoreHistoricalAccess(service.app, "/api/live/prepare", {
        name: "old",
        purpose: "feedback",
        modelId: adopted.id,
        grants: input.grants,
      })
    ).saved;
    const legacyActivation = (
      await restoreHistoricalAccess(service.app, "/api/live/activate", {
        id: legacy.id,
        version: legacy.version,
      })
    ).saved;
    assert.equal((await read("/v2/schema", legacyActivation.key)).status, 410);
    assert.equal((await read("/v4/dataset", legacyActivation.key)).status, 403);
    await assert.rejects(admin("/api/live/views/activate", { id: activation.connection.id, version: activation.connection.version }), /已冻结/);
    const calls = source.state.calls;
    source.state.delay = new Promise((r) => (release = r));
    const pending = read("/v4/objects?type=" + encodeURIComponent("投诉"), key);
    const deadline=Date.now()+5000;
    while (source.state.calls === calls && Date.now()<deadline) await new Promise((r) => setTimeout(r, 5));
    assert(source.state.calls>calls);
    await admin("/api/releases/revoke", {operationId:"revoke",connectionRef:ref(activation.connection)});
    release!();
    const denied = await pending;
    assert.equal(denied.status, 403);
    assert(!JSON.stringify(denied.body).includes("未改善"));
    assert.equal((await read("/v4/dataset", key)).status, 403);
  } finally {
    release?.();
    await service.close();
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("relation permits require both endpoints, survive restart, and expose no data to a narrower independent client", async () => {
  const { createHeatingSources, connectHeatingSources, heatingDefinition } =
    await import("../../src/live/heating-sources.ts");
  const source = await createHeatingSources(),
    directory = mkdtempSync(join(tmpdir(), "de-view-related-"));
  let proposal: any, agentView: any;
  const driver = {
    async run(request: any) {
      assert(
        !request.tools.some((t: any) => t.name === "consumer_view_activate"),
      );
      agentView = await request.onTool("consumer_view_propose", proposal);
      return { text: "消费范围已保存，未启用", sessionId: "s", runId: "r" };
    },
    async stop() {},
    async close() {},
  };
  let service = await createServer({ automaticApi: false, directory, driver });
  const listen = async () => {
    await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
  };
  await listen();
  const origin = () =>
    `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const admin = async (path: string, body: any) => {
    const r = await fetch(origin() + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dataengine-token": service.adminToken,
      },
      body: JSON.stringify(body),
    });
    const data = (await r.json()) as any;
    if (!r.ok) throw new Error(data.error);
    return data;
  };
  const read = async (path: string, key: string) => {
    const r = await fetch(origin() + path, {
      headers: { authorization: "Bearer " + key },
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    const connections = await connectHeatingSources(
        service.app.live.sources,
        source,
      ),
      c = await service.app.live.propose(
        publishedDefinition(service.app,heatingDefinition(connections.api.id, connections.mcp.id)),
      ),
      m = await service.app.live.adopt(c.id, c.version);
    const input = {
      operationId: "related",
      name: "relation client",
      purpose: "follow complaint callbacks",
      modelRef: { id: m.id, version: m.version },
      grants: [
        { type: "投诉", fields: ["$id"], relations: ["回访记录"], evidence:{fields:[],relations:["回访记录"]} },
        { type: "回访", fields: ["$id", "投诉编号", "结果"], relations: [], evidence:{fields:["结果"],relations:[]} },
      ],
    };

    const publication=await publishWorking(service.app);
    assert.throws(()=>connectPublished(service.app,publication,{...input,operationId:"missing-endpoint",grants:[input.grants[0]]}),/两端|目标|许可|范围/);
    const narrow=connectPublished(service.app,publication,{...input,operationId:"narrow",grants:[{type:"投诉",fields:["$id"],relations:[]}]});
    const narrowKey=narrow.key!;
    const active=connectPublished(service.app,publication,input);
    const path =
      "/v4/objects?type=" +
      encodeURIComponent("投诉") +
      "&id=TS002&relation=" +
      encodeURIComponent("回访记录");
    const related = await read(path, active.key!);
    assert.equal(related.status, 200);
    assert.equal(related.body.items[0].objectRef.id, "HF002");
    assert.equal(related.body.items[0].properties.结果.value, "未改善");
    const evidencePath='/v4/evidence?ref='+related.body.relationEvidenceRef;
    const relationEvidence=await read(evidencePath,active.key!);
    assert.deepEqual(relationEvidence.body.evidence.from,{type:'投诉',id:'TS002'});
    assert.deepEqual(relationEvidence.body.evidence.targetIds,['HF002']);
    const propertyEvidencePath='/v4/evidence?ref='+related.body.items[0].properties.结果.evidenceRef;
    assert.equal((await read(propertyEvidencePath,active.key!)).body.evidence.value,'未改善');
    assert.equal((await read(evidencePath,narrowKey)).status,403);
    assert.equal((await read(path, narrowKey)).status, 403);
    assert.equal(
      (await read("/v4/types?type=" + encodeURIComponent("回访"), narrowKey))
        .status,
      403,
    );
    await service.close();
    service = await createServer({ automaticApi: false, directory, driver });
    await listen();
    source.setOutcome("已改善");
    const fresh = await read(path, active.key!);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.items[0].properties.结果.value, "已改善");
    assert.equal((await read(propertyEvidencePath,active.key!)).body.evidence.value,'未改善');
    assert.equal((await read(evidencePath,active.key!)).status,200);
    let incompatible = (await admin("/api/live/changes/propose", {
      operationId: "ungranted-join", baseRef: {id:m.id,version:m.version},
      patch: {kind:"relation",type:"投诉",relation:"回访记录",fromField:"小区",toField:"投诉编号"},
      reason:"测试目标关系要求未获许可的连接字段", evidence:"保留原消费者权限",
    })).saved;
    for (const action of ["check", "adopt"])
      incompatible = (await admin("/api/live/changes/"+action, {operationId:action+"-ungranted",id:incompatible.id,version:incompatible.version})).saved;
    await assert.rejects(admin("/api/live/migrations/preview", {
      operationId: "blocked-join-preview", viewRef: ref(active.connection),
      changeRef: { id: incompatible.id, version: incompatible.version }, dropContextEvidence: false,
    }), /已冻结/);
    assert.equal(service.app.memory.getArtifact(active.connection.id).version, active.connection.version);
    assert.equal((await read(path, active.key!)).body.items[0].objectRef.id, "HF002");
    assert.equal((await read("/v4/dataset", active.key!)).body.datasetRef.version, active.dataset.version);
    await admin("/api/live/disable", { id: connections.mcp.id, version: connections.mcp.version });
    const disabled = await read(path, active.key!);
    assert.equal(disabled.status, 502);
    assert.doesNotMatch(JSON.stringify(disabled.body), /已改善|HF002/);

  } finally {
    await service.close();
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
