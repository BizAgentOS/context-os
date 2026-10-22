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

test("permissioned evidence is bound to a view and reading, with explicit scope and revocation", async () => {
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
          evidence: { fields: ["状态"], relations: [] },
        },
      ],
    };


    const publication=await publishWorking(service.app);
    const active=connectPublished(service.app,publication,input);
    source.state.mode = "conflict";
    const objects = await read(
      "/v4/objects?type=" + encodeURIComponent("投诉"),
      active.key!,
    );
    assert.equal(objects.status, 200);
    const cell = objects.body.items[0].properties.状态;
    assert.equal(typeof cell.evidenceRef, "string");
    assert.equal(
      objects.body.items[0].properties.实际反馈.evidenceRef,
      undefined,
    );
    const path = "/v4/evidence?ref=" + encodeURIComponent(cell.evidenceRef);
    source.state.mode = "normal";
    const evidence = await read(path, active.key!);
    assert.equal(evidence.status, 200);
    assert.equal(evidence.body.evidence.status, "conflict");
    assert.equal(evidence.body.evidence.observations.length, 2);
    assert.doesNotMatch(
      JSON.stringify(evidence.body),
      /sourceId|recordId|WO02|ticket|phone|sourceTitle/,
    );
    assert.equal(evidence.body.reading, "saved_reading_not_current");
    for (const [mode, status, total] of [
      ["unknown", "unknown", null],
      ["short", "ambiguous", 2],
      ["failure", "unavailable", null],
    ]) {
      source.state.mode = mode as string;
      const query = await read(
        "/v4/objects?type=" + encodeURIComponent("投诉"),
        active.key!,
      );
      const detail = await read(
        "/v4/evidence?ref=" + query.body.items[0].properties.状态.evidenceRef,
        active.key!,
      );
      assert.equal(detail.body.evidence.matches[0].status, status);
      assert.equal(
        detail.body.evidence.matches[0].coverage?.total ?? null,
        total,
      );
      assert.doesNotMatch(
        JSON.stringify(detail.body),
        /sourceId|recordId|ticket|sourceTitle/,
      );
    }
    source.state.mode = "normal";
    const b=connectPublished(service.app,publication,{...input,operationId:"narrow",grants:[{type:"投诉",fields:["$id","状态"],relations:[]}]});
    assert.equal((await read(path, b.key!)).status, 403);
    const client = new Client({
      name: "independent-v4-client",
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL("../../scripts/context-os-mcp.ts", import.meta.url),
        ),
      ],
      env: {
        PATH: process.env.PATH!,
        CONTEXT_OS_URL: origin,
        CONTEXT_OS_CONSUMER_KEY: active.key!,
      },
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(tools.tools.some(tool=>tool.name==="describe_dataset"));
      assert.ok(tools.tools.some(tool=>tool.name==="read_evidence"));
      assert.ok(!tools.tools.some(tool=>tool.name==="describe_catalog"));
      const output = await client.callTool({
        name: "read_evidence",
        arguments: { ref: cell.evidenceRef },
      });
      assert.equal(output.isError, undefined);
      assert.equal(
        (output.structuredContent as any).evidence.status,
        "conflict",
      );
      const bad = await client.callTool({
        name: "query_objects",
        arguments: { type: "投诉", fields: ["$id", "phone"] },
      });
      assert.equal(bad.isError, true);
    } finally {
      await client.close();
    }
    for (let i = 0; i < 18; i++)
      source.primary.push({ ...source.primary[0], id: `TS-retention-${i}` });
    let newest = "";
    for (let i = 0; i < 26; i++) {
      const page = await read(
        "/v4/objects?type=" + encodeURIComponent("投诉"),
        active.key!,
      );
      assert.equal(page.status, 200);
      newest = page.body.items[0].properties.状态.evidenceRef;
    }
    assert.equal(
      (await read(path, active.key!)).status,
      403,
      "old references are evicted at the view budget",
    );
    assert.equal(
      (await read("/v4/evidence?ref=" + newest, active.key!)).status,
      200,
    );
    const docsResponse=await fetch(origin+"/api/releases/connection?"+new URLSearchParams({id:active.connection.id,version:String(active.connection.version)}),{headers:{"x-contextos-token":service.adminToken}});
    assert.equal(docsResponse.status,200);
    const docs=await docsResponse.json() as any;
    assert.ok(docs.http.endpoints.some((endpoint:any)=>endpoint.path==="/v4/objects"));
    assert.ok(docs.tools.includes("read_evidence"));
    assert.doesNotMatch(JSON.stringify({dataset:docs.dataset,http:docs.http,mcp:docs.mcp,tools:docs.tools}),new RegExp(active.key+"|phone|WO02|sourceId|上门次数"));
    assert.equal((await fetch(origin+"/api/releases/connection?id="+active.connection.id+"&version="+active.connection.version,{headers:{authorization:"Bearer "+active.key}})).status,403);
    await admin("/api/releases/revoke",{operationId:"revoke-evidence",connectionRef:ref(active.connection)});
    assert.equal((await read(path, active.key!)).status, 403);
  } finally {
    await service.close();
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("v4 release connections reject evidence fields outside the granted fields without publishing partial access", async () => {
  const { MemoryStore } = await import("../../src/agent/memory.ts");
  const { LiveMemory } = await import("../../src/live/memory.ts");
  const { Releases } = await import("../../src/engine/releases.ts");
  const { OntologyDatasets } = await import("../../src/live/ontology-datasets.ts");
  const directory = mkdtempSync(join(tmpdir(), "context-os-release-evidence-scope-"));
  const source = await createFusionSources();
  const memory = new MemoryStore(directory), live = new LiveMemory(directory, memory);
  const releases = new Releases(memory, live), datasets = new OntologyDatasets(memory, live);
  const ref = (artifact: { id: string; version: number }) => ({ id: artifact.id, version: artifact.version });
  try {
    const foundation = memory.putArtifact({ kind: "foundation", title: "投诉本体", status: "adopted", content: {
      enterprise: { name: "证据范围测试" }, concepts: [{ id: "complaint", name: "投诉", description: "居民投诉" }], relations: [], evidence: [], unknowns: [], conflicts: [],
    } });
    const primary = await live.sources.connect({ name: "primary", protocol: "http", url: source.url, capabilities: [primaryCapability] });
    const extra = await live.sources.connect({ name: "extra", protocol: "mcp", url: source.url + "/mcp", capabilities: [supplementCapability] });
    const definition = fusionDefinition(primary.id, extra.id);
    const candidate = await live.propose({ ...definition, foundationRef: ref(foundation), baseModelRef: null, types: definition.types.map(type => ({ ...type, conceptId: "complaint" })) });
    await live.adopt(candidate.id, candidate.version);
    const checked = await releases.check({ inputHash: releases.overview().working.inputHash });
    assert.equal(checked.status, "ready");
    const release = releases.publish({ operationId: "publish", checkRef: ref(checked), name: "发布一" }).release;
    const connection = { operationId: "evidence-boundary", name: "状态助手", releaseRef: ref(release), conceptIds: ["complaint"], relationIds: [], business: {
      grants: [{ type: "投诉", fields: ["$id", "状态"], relations: [], evidence: { fields: ["实际反馈"], relations: [] } }],
    } };
    assert.throws(() => releases.connect(connection), /证据范围必须属于已许可字段/);
    for (const kind of ["release_connection", "ontology_dataset", "consumer_view", "view_receipt"]) assert.equal(memory.listArtifacts(kind).length, 0, kind);
    const allowed = releases.connect({ ...connection, business: { grants: [{ ...connection.business.grants[0], evidence: { fields: ["状态"], relations: [] } }] } });
    const query = await datasets.handle("/v4/objects", new URLSearchParams({ type: "投诉" }), "Bearer " + allowed.key);
    assert.equal(query.status, 200);
    const properties = (query.body.items as any[])[0].properties;
    assert.equal(typeof properties.状态.evidenceRef, "string");
    assert.equal(properties.实际反馈, undefined);
    const evidence = await datasets.handle("/v4/evidence", new URLSearchParams({ ref: properties.状态.evidenceRef }), "Bearer " + allowed.key);
    assert.equal(evidence.status, 200);
    assert.equal((await datasets.handle("/v4/objects", new URLSearchParams({ type: "投诉", fields: "$id,实际反馈" }), "Bearer " + allowed.key)).status, 403);
  } finally { memory.close(); await source.close(); rmSync(directory, { recursive: true, force: true }); }
});
