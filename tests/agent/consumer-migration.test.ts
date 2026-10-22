import {publishedDefinition,publishWorking,connectPublished,ref} from "./published-consumers-fixture.ts";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
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

test("published connection upgrades preserve exact scope, rotate keys and reject in-flight old readings while historical migration writes stay frozen", async () => {
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
        "x-contextos-token": service.adminToken,
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
        {
          type: "投诉",
          fields: ["$id", "实际反馈", "状态"],
          relations: [],
          evidence: { fields: ["实际反馈"], relations: [] },
        },
      ],
    };

    const publication=await publishWorking(service.app,"原口径");
    const active=connectPublished(service.app,publication,input);
    const otherActive=connectPublished(service.app,publication,{...input,operationId:"other",name:"other"});
    const path="/v4/objects?type="+encodeURIComponent("投诉");
    const before = await read(path, active.key!);
    assert.equal(before.body.items[0].properties.实际反馈.value, "未改善");
    const oldEvidence = before.body.items[0].properties.实际反馈.evidenceRef;
    const changes = async (method: string, body: any) =>
      (await admin("/api/live/changes/" + method, body)).saved;
    let change = await changes("propose", {
      operationId: "change",
      baseRef: input.modelRef,
      patch: {
        kind: "property",
        type: "投诉",
        property: "实际反馈",
        supplement: "工单",
        sourceField: "status",
      },
      reason: "采用工单状态新口径",
      evidence: "业务人员明确修订",
    });
    change = await changes("check", {
      operationId: "check",
      id: change.id,
      version: change.version,
    });
    change = await changes("adopt", {
      operationId: "adopt",
      id: change.id,
      version: change.version,
    });
    const changeRef=ref(change);
    const target=await publishWorking(service.app,"新口径");
    const previewResponse=await fetch(origin+"/api/releases/upgrade-preview?"+new URLSearchParams({connectionId:active.connection.id,connectionVersion:String(active.connection.version),releaseId:target.id,releaseVersion:String(target.version)}),{headers:{"x-contextos-token":service.adminToken}});
    assert.equal(previewResponse.status,200);const preview=await previewResponse.json() as any;
    assert.equal(preview.compatible,true);
    assert.ok(preview.affected.length>0);
    const historicalProposal={operationId:"legacy-preview",viewRef:ref(active.connection),changeRef,dropContextEvidence:false};
    await assert.rejects(admin("/api/live/migrations/preview",historicalProposal),/已冻结/);
    const calls=source.state.calls;
    source.state.delay=new Promise(r=>release=r);
    const inFlight=read(path,active.key!);
    const deadline=Date.now()+5000;
    while(source.state.calls===calls&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
    assert(source.state.calls>calls);
    const upgrade={operationId:"upgrade",connectionRef:ref(active.connection),releaseRef:ref(target)};
    const migrated=await admin("/api/releases/upgrade",upgrade);
    assert.deepEqual(migrated.connection.content.business,active.connection.content.business);
    release!();source.state.delay=undefined;
    assert.equal((await inFlight).status,403);
    assert.equal((await read(path,active.key!)).status,403);
    const current=await read(path,migrated.key);
    assert.equal(current.status,200);
    assert.equal(current.body.items[0].properties.实际反馈.value,"已办结");
    assert.deepEqual(current.body.modelRef,change.content.resultModel);
    assert.equal((await read("/v4/evidence?ref="+oldEvidence,migrated.key)).status,403);
    const client=new Client({name:"migration-client",version:"1.0"});
    try{
      await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL("../../scripts/context-os-mcp.ts",import.meta.url))],env:{PATH:process.env.PATH!,CONTEXT_OS_URL:origin,CONTEXT_OS_CONSUMER_KEY:migrated.key}}));
      const response=await client.callTool({name:"query_objects",arguments:{type:"投诉"}});
      assert.equal(response.isError,undefined);
      assert.equal((response.structuredContent as any).items[0].properties.实际反馈.value,"已办结");
      const forbidden=await client.callTool({name:"query_objects",arguments:{type:"投诉",fields:["$id","上门次数"]}});
      assert.equal(forbidden.isError,true);
    }finally{await client.close();}
    assert.equal((await read(path,otherActive.key!)).body.items[0].properties.实际反馈.value,"未改善");
    const replay=await admin("/api/releases/upgrade",upgrade);
    assert.equal(replay.connection.version,migrated.connection.version);
    assert.equal(replay.key,null);
    await assert.rejects(admin("/api/releases/upgrade",{...upgrade,operationId:"stale"}),/版本|变化/);
    await assert.rejects(admin("/api/live/migrations/commit",{operationId:"legacy-commit",id:change.id,version:change.version}),/已冻结/);
    await admin("/api/releases/revoke",{operationId:"revoke-migrated",connectionRef:ref(migrated.connection)});
    assert.equal((await read("/v4/dataset",migrated.key)).status,403);
    assert.equal((await read("/v4/dataset",otherActive.key!)).status,200);
    for(const retired of ["/v1/schema","/v2/schema","/v3/catalog"])assert.equal((await read(retired,active.key!)).status,410);
  } finally {
    release?.();
    await service.close();
    await source.close();
    rmSync(directory,{recursive:true,force:true});
  }
});
