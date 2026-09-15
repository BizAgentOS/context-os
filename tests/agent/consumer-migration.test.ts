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

test("a checked migration switches only its selected view, keeps permissions and pins subsequent requests", async () => {
  const source = await createFusionSources(),
    directory = mkdtempSync(join(tmpdir(), "de-view-"));
  const service = await createServer({
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
          evidence: { fields: ["实际反馈"], relations: [] },
        },
      ],
    };

    const view = (await admin("/api/live/views/propose", input)).saved;
    const active = (
      await admin("/api/live/views/activate", {
        id: view.id,
        version: view.version,
      })
    ).saved;
    const other = (
      await admin("/api/live/views/propose", {
        ...input,
        operationId: "other",
        name: "other",
      })
    ).saved;
    const otherActive = (
      await admin("/api/live/views/activate", {
        id: other.id,
        version: other.version,
      })
    ).saved;
    const path = "/v3/objects?type=" + encodeURIComponent("投诉");
    const before = await read(path, active.key);
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
    const changeRef = { id: change.id, version: change.version };
    const impact = await admin("/api/live/migrations/impact", { changeRef });
    assert.equal(impact.items.length, 2);
    assert(impact.items.every((x: any) => x.affected));
    const proposal = {
      operationId: "preview",
      viewRef: { id: active.view.id, version: active.view.version },
      changeRef,
      dropContextEvidence: false,
    };
    const preview = (await admin("/api/live/migrations/preview", proposal))
      .saved;
    assert.equal(preview.content.report.compatible, true);
    assert.equal(
      (await read(path, active.key)).body.items[0].properties.实际反馈.value,
      "未改善",
    );
    const commit = {
      operationId: "commit",
      id: preview.id,
      version: preview.version,
    };
    const competitor = (
      await admin("/api/live/migrations/preview", {
        ...proposal,
        operationId: "competing-preview",
      })
    ).saved;
    const calls = source.state.calls;
    source.state.delay = new Promise((r) => (release = r));
    const inFlight = read(path, active.key);
    for (let i = 0; i < 100 && source.state.calls === calls; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert(source.state.calls > calls);
    const responseState = await admin("/api/live/migrations/commit", commit);
    const done = responseState.saved;
    assert.equal(
      responseState.live.views.find((v: any) => v.id === active.view.id)
        .version,
      done.content.resultRef.version,
    );
    release!();
    source.state.delay = undefined;
    assert.equal((await inFlight).status, 409);
    await assert.rejects(
      admin("/api/live/migrations/commit", {
        operationId: "competing",
        id: competitor.id,
        version: competitor.version,
      }),
      /版本/,
    );
    assert.equal(done.status, "committed");
    const version = done.content.resultRef.version;
    assert.equal((await read(path, active.key)).status, 409);
    assert.equal(
      (await read(path + "&viewVersion=" + active.view.version, active.key))
        .status,
      409,
    );
    const current = await read(path + "&viewVersion=" + version, active.key);
    assert.equal(current.status, 200);
    assert.equal(current.body.items[0].properties.实际反馈.value, "已办结");
    assert.deepEqual(current.body.modelRef, change.content.resultModel);
    assert.equal(
      (
        await read(
          "/v3/evidence?ref=" + oldEvidence + "&viewVersion=" + version,
          active.key,
        )
      ).status,
      403,
    );
    const client = new Client({ name: "migration-client", version: "1.0" });
    try {
      await client.connect(
        new StdioClientTransport({
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
        }),
      );
      const denied = await client.callTool({
        name: "query_objects",
        arguments: { type: "投诉" },
      });
      assert.equal(denied.isError, true);
      assert.equal((denied.structuredContent as any).status, 409);
      const response = await client.callTool({
        name: "query_objects",
        arguments: { type: "投诉", viewVersion: version },
      });
      assert.equal(response.isError, undefined);
      assert.equal(
        (response.structuredContent as any).items[0].properties.实际反馈.value,
        "已办结",
      );
      const docs = await read("/v3/connection", active.key);
      for (const path of ["/v3/types", "/v3/objects", "/v3/evidence"])
        assert.equal(
          docs.body.openapi.paths[path].get.parameters.find(
            (p: any) => p.name === "viewVersion",
          ).required,
          true,
        );
      assert.match(
        docs.body.http.example,
        new RegExp("viewVersion=" + version),
      );
    } finally {
      await client.close();
    }
    assert.equal(
      (await read(path, otherActive.key)).body.items[0].properties.实际反馈
        .value,
      "未改善",
    );
    assert.equal(
      (await admin("/api/live/migrations/commit", commit)).saved.id,
      done.id,
    );
    await assert.rejects(
      admin("/api/live/migrations/commit", { ...commit, version: 999 }),
      /幂等/,
    );
    await assert.rejects(
      admin("/api/live/migrations/preview", {
        ...proposal,
        operationId: "stale",
      }),
      /版本|基线/,
    );
    await admin("/api/live/views/revoke", { id: active.view.id, version });
    assert.equal((await read("/v3/catalog", active.key)).status, 403);
  } finally {
    release?.();
    await service.close();
    await source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
