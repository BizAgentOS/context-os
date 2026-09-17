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
      await admin("/api/live/propose", fusionDefinition(primary.id, extra.id))
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

    await assert.rejects(
      admin("/api/live/views/propose", {
        ...input,
        operationId: "bad",
        grants: [
          {
            type: "投诉",
            fields: ["$id", "状态"],
            relations: [],
            evidence: { fields: ["实际反馈"], relations: [] },
          },
        ],
      }),
      /证据/,
    );
    const draft = (await admin("/api/live/views/propose", input)).saved;
    const active = (
      await admin("/api/live/views/activate", {
        id: draft.id,
        version: draft.version,
      })
    ).saved;
    source.state.mode = "conflict";
    const objects = await read(
      "/v3/objects?type=" + encodeURIComponent("投诉"),
      active.key,
    );
    assert.equal(objects.status, 200);
    const cell = objects.body.items[0].properties.状态;
    assert.equal(typeof cell.evidenceRef, "string");
    assert.equal(
      objects.body.items[0].properties.实际反馈.evidenceRef,
      undefined,
    );
    const path = "/v3/evidence?ref=" + encodeURIComponent(cell.evidenceRef);
    source.state.mode = "normal";
    const evidence = await read(path, active.key);
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
        "/v3/objects?type=" + encodeURIComponent("投诉"),
        active.key,
      );
      const detail = await read(
        "/v3/evidence?ref=" + query.body.items[0].properties.状态.evidenceRef,
        active.key,
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
    const narrow = (
      await admin("/api/live/views/propose", {
        ...input,
        operationId: "narrow",
        grants: [{ type: "投诉", fields: ["$id", "状态"], relations: [] }],
      })
    ).saved;
    const b = (
      await admin("/api/live/views/activate", {
        id: narrow.id,
        version: narrow.version,
      })
    ).saved;
    assert.equal((await read(path, b.key)).status, 403);
    const client = new Client({
      name: "independent-v3-client",
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL("../../scripts/dataengine-mcp.ts", import.meta.url),
        ),
      ],
      env: {
        PATH: process.env.PATH!,
        DATAENGINE_URL: origin,
        DATAENGINE_CONSUMER_KEY: active.key,
      },
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((t) => t.name).sort(),
        [
          "describe_catalog",
          "describe_connection",
          "describe_type",
          "query_objects",
          "read_evidence",
        ].sort(),
      );
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
        "/v3/objects?type=" + encodeURIComponent("投诉"),
        active.key,
      );
      assert.equal(page.status, 200);
      newest = page.body.items[0].properties.状态.evidenceRef;
    }
    assert.equal(
      (await read(path, active.key)).status,
      403,
      "old references are evicted at the view budget",
    );
    assert.equal(
      (await read("/v3/evidence?ref=" + newest, active.key)).status,
      200,
    );
    const docs = await read("/v3/connection", active.key);
    assert.equal(docs.status, 200);
    assert.equal(docs.body.openapi.openapi, "3.1.0");
    assert.ok(docs.body.openapi.paths["/v3/evidence"]);
    assert.doesNotMatch(
      JSON.stringify(docs.body),
      new RegExp(active.key + "|phone|WO02|sourceId|上门次数"),
    );
    await admin("/api/live/views/revoke", {
      id: active.view.id,
      version: active.view.version,
    });
    assert.equal((await read(path, active.key)).status, 403);
  } finally {
    await service.close();
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
