import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { ResolvedWorkContext } from "../../src/agent/work-context.ts";
import type { Data } from "../../src/agent/contracts.ts";
import type { RunRequest } from "../../src/agent/runtime.ts";
import { createServer } from "../../src/agent/server.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";
import {
  createHeatingSources,
  connectHeatingSources,
  heatingDefinition,
} from "../../src/live/heating-sources.ts";

test("a selected live relation binds the same validated target to the browser and Agent message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-work-context-"));
  const upstream = await createHeatingSources();
  let runs = 0;
  let seen: ResolvedWorkContext | undefined;
  const service = await createServer({ automaticApi: false,
    directory,
    driver: {
      async run(request) {
        runs++;
        seen = JSON.parse(request.input).workContext;
        const result = await request.onTool("context_read", {});
        assert.deepEqual((result as Data).target, seen!.target);
        return {
          text: "已核对选中的回访关系。",
          sessionId: "bound",
          runId: "bound",
        };
      },
      async stop() {},
      async close() {},
    },
  });
  try {
    const { api, mcp } = await connectHeatingSources(
      service.app.live.sources,
      upstream,
    );
    const model = await service.app.live.propose(
      heatingDefinition(api.id, mcp.id),
    );
    await service.app.canvasNavigate({ page: "ontology" });
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const headers = {
      "x-dataengine-token": service.adminToken,
      "content-type": "application/json",
    };
    const post = async (path: string, body: unknown) =>
      fetch(base + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const state = await (await fetch(base + "/api/canvas", { headers })).json();
    const context = {
      view: "ontology.definitions",
      revision: 3,
      selection: [
        {
          spaceId: state.workspaceId,
          kind: "relation",
          id: model.id,
          version: model.version,
          type: "投诉",
          member: "回访记录",
        },
      ],
      scope: { where: {}, offset: 0, limit: 20 },
      draftRef: { id: "browser-draft-1", revision: 2 },
    };
    // The fixture uses the actual declared relation, while the identity is bound
    // to its source type rather than a mutable graph-edge array index.
    context.selection[0].member = heatingDefinition(
      api.id,
      mcp.id,
    ).relations[0].name;
    const resolved = await post("/api/canvas/context", {
      page: "ontology",
      context,
    });
    assert.equal(resolved.status, 200);
    const preview = await resolved.json();
    assert.equal(preview.target.ref.id, model.id);
    assert.equal(preview.target.ref.member, context.selection[0].member);
    const body = {
      page: "ontology",
      text: "请核对这条关系",
      messageId: "selected-relation",
      workContext: context,
    };
    assert.equal((await post("/api/canvas/message", body)).status, 202);
    await service.app.idle();
    assert.ok(seen);
    assert.deepEqual(seen.context, context);
    assert.deepEqual(seen.target, preview.target);
    assert.equal((await post("/api/canvas/message", body)).status, 202);
    assert.equal(runs, 1);
    const switched = structuredClone(body);
    switched.workContext.selection[0].member = "另一条关系";
    assert.equal((await post("/api/canvas/message", switched)).status, 400);
    assert.equal(runs, 1);
  } finally {
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("object relation context reads current source facts in its fixed range and rejects stale references", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-context-read-"));
  const upstream = await createHeatingSources();
  const service = await createServer({ automaticApi: false, directory });
  try {
    const { api, mcp } = await connectHeatingSources(
      service.app.live.sources,
      upstream,
    );
    const model = await service.app.live.propose(
      heatingDefinition(api.id, mcp.id),
    );
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    const headers = {
      "x-dataengine-token": service.adminToken,
      "content-type": "application/json",
    };
    const post = async (context: unknown) =>
      fetch(base + "/api/canvas/context/read", {
        method: "POST",
        headers,
        body: JSON.stringify({ page: "ontology", context }),
      });
    const state = await (await fetch(base + "/api/canvas", { headers })).json();
    const context = {
      view: "ontology.objects",
      revision: 1,
      selection: [
        {
          spaceId: state.workspaceId,
          kind: "relation",
          id: model.id,
          version: model.version,
          type: "投诉",
          member: "回访记录",
          objectId: "TS002",
        },
      ],
      scope: { where: { $id: "TS002" }, offset: 0, limit: 1 },
      draftRef: { id: "object-relation-draft", revision: 1 },
    };
    const read = await post(context);
    assert.equal(read.status, 200);
    const first = await read.json();
    assert.equal(first.result.items[0].$id, "HF002");
    assert.equal(first.result.items[0].结果, "未改善");
    assert.equal(first.result.coverage.shown, 1);
    assert.equal(first.result.reads.length, 2);
    upstream.setOutcome("已经改善");
    const second = await (await post(context)).json();
    assert.equal(second.result.items[0].结果, "已经改善");
    assert.deepEqual(second.target, first.target);
    const conflict = structuredClone(context);
    conflict.scope.where.$id = "TS999";
    assert.equal((await post(conflict)).status, 400);
    const otherSpace = structuredClone(context);
    otherSpace.selection[0].spaceId = "another-enterprise";
    assert.equal((await post(otherSpace)).status, 400);
    assert.equal((await post({ ...context, approved: true })).status, 400);
    const pageTwo = structuredClone(context);
    pageTwo.scope.offset = 1;
    assert.equal((await (await post(pageTwo)).json()).result.coverage.shown, 0);
    const property = {
      ...context,
      view: "ontology.definitions",
      scope: { where: {}, offset: 0, limit: 20 },
      selection: [
        {
          spaceId: state.workspaceId,
          kind: "property",
          id: model.id,
          version: model.version,
          type: "投诉",
          member: "$id",
        },
      ],
    };
    const propertyRead = await (await post(property)).json();
    assert.equal(propertyRead.target.definition.sourceField, "id");
    await service.app.live.adopt(model.id, model.version);
    assert.equal((await post(context)).status, 400);
  } finally {
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stopping a bound run rejects its late write and reopening never replays that message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-context-stop-"));
  const upstream = await createHeatingSources();
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runs = 0;
  let definition: ReturnType<typeof heatingDefinition>;
  const driver = {
    async run(request: RunRequest) {
      runs++;
      await request.onTool("context_read", {});
      started();
      await held;
      await assert.rejects(request.onTool("live_propose", definition));
      return {
        text: "迟到结果不应显示",
        sessionId: "cancelled",
        runId: "cancelled",
      };
    },
    async stop() {
      release();
    },
    async close() {},
  };
  let service = await createServer({ automaticApi: false, directory, driver });
  try {
    const { api, mcp } = await connectHeatingSources(
      service.app.live.sources,
      upstream,
    );
    definition = heatingDefinition(api.id, mcp.id);
    const model = await service.app.live.propose(definition);
    await service.app.canvasNavigate({ page: "ontology" });
    const context = {
      view: "ontology.definitions",
      revision: 7,
      selection: [
        {
          spaceId: service.app.canvasState().workspaceId,
          kind: "property",
          id: model.id,
          version: model.version,
          type: "投诉",
          member: "状态",
        },
      ],
      scope: { where: {}, offset: 0, limit: 20 },
      draftRef: { id: "cancel-draft", revision: 4 },
    };
    const body = {
      page: "ontology",
      text: "修改这个属性",
      messageId: "cancel-and-retry",
      workContext: context,
    };
    await service.app.canvasMessage(body);
    await entered;
    await service.app.canvasStop({ page: "ontology" });
    await service.app.idle();
    const state = service.app.canvasState();
    assert.equal(state.live.models.length, 1);
    assert.doesNotMatch(JSON.stringify(state.messages), /迟到结果/);
    await service.close();
    service = await createServer({ automaticApi: false, directory, driver });
    const restored = await service.app.canvasMessage(body);
    assert.equal(runs, 1);
    assert.deepEqual(
      restored.messages.find((m) => m.id === body.messageId)?.workContext
        ?.context,
      context,
    );
    const changed = structuredClone(body);
    changed.workContext.draftRef.revision++;
    await assert.rejects(service.app.canvasMessage(changed), /消息标识/);
    service.app.live.sources.disable(api.id, api.version);
    await assert.rejects(
      service.app.canvasMessage({ ...body, messageId: "revoked-source" }),
      /来源/,
    );
    assert.equal(runs, 1);
  } finally {
    release();
    await service.close();
    await upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a bound semantic edit can retry its own saved operation and ask a follow-up", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-context-own-write-"));
  let finished = false;
  const service = await createServer({ automaticApi: false,
    directory,
    driver: {
      async run(request) {
        const input = JSON.parse(request.input);
        const user = input.recentMessages.at(-1);
        const args = { operationId: "business-wording", type: "description", baseline: (await request.onTool("pending_list", {}) as any).baseline,
          subject: { target: "concept", id: "service", description: "居民供热", evidence: [{ id: "user-business", messageId: user.id, quote: "居民供热" }] }, evidence: "用户原话" };
        const result = await request.onTool("change_propose", args);
        assert.deepEqual(await request.onTool("change_propose", args), result);
        await request.onTool("decision_request", { question: "主要服务哪些区域？", reason: "需要补充业务范围" });
        finished = true;
        return {
          text: "主要服务哪些区域？",
          sessionId: "self-write",
          runId: "self-write",
        };
      },
      async stop() {},
      async close() {},
    },
  });
  try {
    const profile = seedFoundation(service.app.memory, service.app.foundation, { enterprise: "澄川热力", concepts: [{ id: "service", name: "供热业务", description: "待明确服务范围" }] });
    const context = {
      view: "ontology.definitions",
      revision: 1,
      selection: [
        {
          spaceId: service.app.canvasState().workspaceId,
          kind: "foundation_concept",
          id: profile.id,
          version: profile.version,
          member: "service",
        },
      ],
      scope: { where: {}, offset: 0, limit: 20 },
      draftRef: { id: "company-edit", revision: 1 },
    };
    await service.app.canvasMessage({
      page: "ontology",
      text: "业务是居民供热",
      messageId: "company-edit",
      workContext: context,
    });
    await service.app.idle();
    assert.equal(finished, true);
    const state = service.app.canvasState();
    assert.match(JSON.stringify(state.foundation.adopted), /居民供热/);
    assert.equal(state.foundation.adopted!.version, profile.version + 1);
    assert.deepEqual(state.messages.at(-1)?.workContext?.context, context);
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy pending requests can check their original receipt without launching another run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-context-legacy-"));
  let runs = 0;
  const service = await createServer({ automaticApi: false,
    directory,
    driver: {
      async run() {
        runs++;
        return { text: "收到", sessionId: "legacy", runId: "legacy" };
      },
      async stop() {},
      async close() {},
    },
  });
  try {
    const message = {
      page: "setup",
      text: "旧版尚待核对的请求",
      messageId: "legacy-receipt",
    };
    await service.app.canvasMessage(message);
    await service.app.idle();
    const result = service.app.canvasMessageReceipt(message);
    assert.equal(result.messageReceipt.received, true);
    assert.equal(
      service.app.canvasMessageReceipt({
        ...message,
        messageId: "never-received",
      }).messageReceipt.received,
      false,
    );
    assert.throws(
      () => service.app.canvasMessageReceipt({ ...message, page: "ontology" }),
      /消息标识/,
    );
    // An old browser may send to an upgraded server. Receipt-only lookup works
    // for both old text-only and new context-bound fingerprints.
    await service.app.canvasMessage({
      ...message,
      messageId: "mixed-client",
      workContext: {
        view: "setup.company",
        revision: 0,
        selection: [],
        scope: { where: {}, offset: 0, limit: 20 },
        draftRef: { id: "mixed-client-draft", revision: 0 },
      },
    });
    await service.app.idle();
    assert.equal(
      service.app.canvasMessageReceipt({
        page: "setup",
        messageId: "mixed-client",
      }).messageReceipt.received,
      true,
    );
    assert.equal(runs, 2);
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
