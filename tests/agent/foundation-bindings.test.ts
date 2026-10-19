import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createServer as httpServer } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/agent/server.ts";
import type { AddressInfo } from "node:net";
import {
  createHeatingSources,
  connectHeatingSources,
} from "../../src/live/heating-sources.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";

test("adopted foundation concepts bind a checked execution subset, retain unbound concepts and reject stale dependencies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "de-binding-"));
  const upstream = await createHeatingSources();
  let unavailable = false;
  const proxy = httpServer(async (req, res) => {
    if (unavailable) {
      res.writeHead(503).end();
      return;
    }
    const response = await fetch(upstream.apiUrl + req.url);
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(await response.text());
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const sourceUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  let inspected: any;
  let phase = "foundation",
    mapping: any,
    proposed: any;
  const driver = {
    async run(request: any) {
      if (phase === "inspect") {
        inspected = await request.onTool("context_read", {});
      } else if (phase === "foundation") {
        const message = JSON.parse(request.input).recentMessages.at(-1);
        await request.onTool("skill_use", {
          name: "company-foundation-ontology",
        });
        const previous = await request.onTool("foundation_read", {});
        await request.onTool("foundation_propose", {
          baseVersion: previous.current?.version ?? 0,
          enterprise: { name: "澄川热力", evidenceRefs: [message.id] },
          concepts: [
            {
              id: "callback",
              name: "回访",
              description: "对投诉处理后的居民反馈",
              evidenceRefs: [message.id],
            },
            {
              id: "complaint",
              name: "投诉",
              description: "居民反映的供热问题",
              evidenceRefs: [message.id],
            },
            {
              id: "resident",
              name: "居民",
              description: "供热服务对象",
              evidenceRefs: [message.id],
            },
          ],
          relations: [
            {
              id: "has_callback",
              name: "回访记录",
              from: "complaint",
              to: "callback",
              description: "投诉处理后的回访",
              evidenceRefs: [message.id],
            },
          ],
          evidence: [
            { id: message.id, messageId: message.id, quote: message.content },
          ],
          unknowns: [],
          conflicts: [],
        });
      } else {
        assert(request.tools.some((tool: any) => tool.name === "live_propose"));
        assert(request.tools.some((tool: any) => tool.name === "live_query"));
        proposed = await request.onTool("live_propose", mapping);
        const preview = await request.onTool("live_query", {
          modelId: proposed.id,
          modelVersion: proposed.version,
          conceptId: "complaint",
          limit: 2,
        });
        assert.equal(preview.conceptRef.conceptId, "complaint");
        assert.equal(preview.items.length, 1);
        await request.onTool("task_ask", {
          question: "请核对并采用此执行子集",
          reason: "核对业务映射",
          candidateId: proposed.id,
          version: proposed.version,
        });
      }
      return {
        text: "候选已保存，请核对后采用",
        sessionId: "binding",
        runId: "binding",
      };
    },
    async stop() {},
    async close() {},
  };
  let service = await createServer({ directory, driver, automaticApi: false });
  seedFoundation(service.app.memory, service.app.foundation, {
    enterprise: "澄川热力",
    concepts: [
      { id: "callback", name: "回访", description: "来自回访表的记录，业务含义待核对。" },
      { id: "complaint", name: "投诉", description: "来自投诉表的记录，业务含义待核对。" },
      { id: "resident", name: "居民", description: "来自居民表的记录，业务含义待核对。" },
    ],
    relations: [
      { id: "has_callback", name: "回访记录", from: "complaint", to: "callback", description: "结构化数据中的回访记录关联。" },
    ],
  });
  const start = async () => {
    await new Promise<void>((r) => service.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    return async (path = "/api/canvas", body?: unknown): Promise<any> => {
      const res = await fetch(url + path, {
        method: body ? "POST" : "GET",
        headers: {
          "x-dataengine-token": service.adminToken,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value = (await res.json()) as any;
      if (!res.ok) throw new Error(value.error);
      return value;
    };
  };
  try {
    let api = await start();
    await connectHeatingSources(service.app.live.sources, {
      ...upstream,
      apiUrl: sourceUrl,
    });
    await api("/api/canvas/message", {
      page: "setup",
      text: "澄川热力向居民供热，投诉是居民反映的供热问题，处理后通过回访了解居民反馈。",
      messageId: "binding-user",
    });
    await service.app.idle();
    const current = (await api()).foundation.current;
    assert(current, JSON.stringify((await api()).messages));
    assert.deepEqual(current.content.concepts.map((item: any) => [item.id, item.origin]), [["callback", "program"], ["complaint", "program"], ["resident", "program"]]);
    assert.deepEqual(current.content.relations.map((item: any) => [item.id, item.from, item.to, item.origin]), [["has_callback", "complaint", "callback", "program"]]);
    await api("/api/canvas/foundation/adopt", {
      page: "setup",
      id: current.id,
      version: current.version,
    });
    const adopted = (await api()).foundation.adopted;
    const context = {
      view: "ontology.definitions",
      revision: 1,
      selection: [
        {
          spaceId: (await api()).workspaceId,
          kind: "foundation_concept",
          id: adopted.id,
          version: adopted.version,
          member: "resident",
        },
      ],
      scope: { where: {}, offset: 0, limit: 20 },
      draftRef: { id: "definition-draft", revision: 1 },
    };
    await api("/api/canvas/navigate", { page: "ontology" });
    const selected = await api("/api/canvas/context/read", {
      page: "ontology",
      context,
    });
    assert.equal(selected.target.label, "居民");
    assert.equal(selected.target.definition.mappingStatus, "unbound");
    assert.deepEqual(selected.target.definition.bindings, []);
    phase = "inspect";
    await api("/api/canvas/message", {
      page: "ontology",
      text: "解释选中的定义，不创建实例",
      messageId: "definition-context",
      workContext: context,
    });
    await service.app.idle();
    assert.deepEqual(inspected.target, selected.target);
    const relationContext = structuredClone(context);
    relationContext.selection[0].kind = "foundation_relation";
    relationContext.selection[0].member = "has_callback";
    const relationSelected = await api("/api/canvas/context/read", {
      page: "ontology",
      context: relationContext,
    });
    assert.equal(relationSelected.target.label, "投诉 → 回访记录 → 回访");
    assert.equal(relationSelected.target.definition.from, "complaint");
    await assert.rejects(
      api("/api/canvas/context", { page: "setup", context }),
    );
    const invalid = structuredClone(context);
    invalid.selection[0].member = "absent";
    await assert.rejects(
      api("/api/canvas/context", { page: "ontology", context: invalid }),
    );
    invalid.selection[0].member = "resident";
    Object.assign(invalid.scope.where, { $id: "fictional" });
    await assert.rejects(
      api("/api/canvas/context", { page: "ontology", context: invalid }),
    );
    const source = (await api()).live.connections.find(
      (s: any) => s.content.protocol === "http",
    );
    const cap = source.content.capabilities.find(
      (c: any) => c.name === "complaints",
    );
    assert(cap);
    mapping = {
      foundationRef: { id: adopted.id, version: adopted.version },
      baseModelRef: null,
      purpose: "投诉实例",
      types: [
        {
          name: "投诉",
          description: "居民反映的供热问题",
          conceptId: "complaint",
          sourceId: source.id,
          capability: cap.name,
          fields: { 描述: "content" },
        },
      ],
      relations: [],
      rationale: "已采用的投诉概念对应受理系统投诉记录；居民尚未绑定。",
    };
    // Use the source's approved field name, without assuming similarly named business fields.
    mapping.types[0].fields = { 状态: "status" };
    const callbackSource = (await api()).live.connections.find(
      (s: any) => s.content.protocol === "mcp",
    );
    mapping.types.push({
      name: "回访",
      description: "对投诉处理后的居民反馈",
      conceptId: "callback",
      sourceId: callbackSource.id,
      capability: "list_callbacks",
      fields: { 投诉编号: "complaintId", 结果: "outcome" },
    });
    mapping.relations = [
      {
        relationId: "has_callback",
        name: "回访记录",
        from: "投诉",
        to: "回访",
        fromField: "$id",
        toField: "投诉编号",
      },
    ];
    phase = "mapping";
    await api("/api/canvas/navigate", { page: "setup" });
    await api("/api/canvas/message", {
      page: "setup",
      text: "把投诉绑定受理系统，居民暂不映射",
      messageId: "bind-records",
    });
    await service.app.idle();
    assert(proposed, JSON.stringify((await api()).messages));
    assert.equal(proposed.content.foundationRef.id, adopted.id);
    const before = (await api()).foundation.current;
    assert.equal(
      before.content.concepts.find((c: any) => c.id === "complaint").bindings[0]
        .status,
      "candidate",
    );
    assert.equal((await api()).pending.candidateId, proposed.id);
    unavailable = true;
    await assert.rejects(
      api("/api/canvas/decision", {
        page: "setup", candidateId: proposed.id, version: proposed.version, decision: "adopt",
        messageId: "binding-adopt",
      }),
    );
    assert(
      !(await api()).messages.some((m: any) => m.id === "binding-adopt"),
      "failed adoption must not consume the message receipt",
    );
    unavailable = false;
    const fault = new DatabaseSync(join(directory, "memory.sqlite"));
    try {
      fault.exec(`CREATE TRIGGER reject_binding_decision BEFORE INSERT ON messages
        WHEN NEW.id='binding-adopt' BEGIN SELECT RAISE(ABORT, 'decision save failed'); END;`);
      await assert.rejects(
        api("/api/canvas/decision", {
          page: "setup", candidateId: proposed.id, version: proposed.version, decision: "adopt",
          messageId: "binding-adopt",
        }),
        /decision save failed/,
      );
      const failed = await api();
      assert.equal(
        failed.live.models.find((m: any) => m.id === proposed.id).status,
        "candidate",
      );
      assert(!failed.messages.some((m: any) => m.id === "binding-adopt"));
      assert.equal(failed.pending.candidateId, proposed.id);
      fault.exec("DROP TRIGGER reject_binding_decision");
    } finally {
      fault.close();
    }
    const adoption = await api("/api/canvas/decision", {
      page: "setup", candidateId: proposed.id, version: proposed.version, decision: "adopt",
      messageId: "binding-adopt",
    });
    const saved = adoption.live.models.find((m: any) => m.id === proposed.id);
    assert.equal(adoption.pending, null);
    mapping.baseModelRef = { id: saved.id, version: saved.version };
    const query = {
      modelId: saved.id,
      modelVersion: saved.version,
      conceptId: "complaint",
      limit: 2,
    };
    const records = await api("/api/live/query", query);
    assert.equal(records.conceptRef.foundationId, adopted.id);
    assert.equal(records.conceptRef.foundationVersion, adopted.version);
    assert.equal(records.items[0].$id, "TS002");
    const related = await api("/api/live/query", {
      ...query,
      id: "TS002",
      relation: "回访记录",
    });
    assert.equal(related.conceptRef.conceptId, "callback");
    assert.equal(related.items[0].结果, "未改善");
    upstream.setOutcome("已改善");
    assert.equal(
      (
        await api("/api/live/query", {
          ...query,
          id: "TS002",
          relation: "回访记录",
        })
      ).items[0].结果,
      "已改善",
    );
    const boundRelation = await api("/api/canvas/context/read", {
      page: "ontology",
      context: relationContext,
    });
    assert.equal(boundRelation.target.definition.mappingStatus, "bound");
    assert.equal(
      boundRelation.target.definition.bindings[0].mappings[0].fromField,
      "$id",
    );
    assert.equal(
      boundRelation.target.definition.bindings[0].mappings[0].toField,
      "投诉编号",
    );
    const view = (await api()).foundation.current;
    assert.equal(view.content.relations[0].mappingStatus, "bound");
    assert.equal(
      view.content.concepts.find((c: any) => c.id === "complaint")
        .mappingStatus,
      "bound",
    );
    assert.equal(
      view.content.concepts.find((c: any) => c.id === "resident").mappingStatus,
      "unbound",
    );
    await assert.rejects(
      api("/api/live/query", { ...query, conceptId: "resident" }),
      /绑定|类型/,
    );
    await assert.rejects(
      api("/api/live/propose", {
        ...mapping,
        types: [{ ...mapping.types[0], conceptId: "invented" }],
      }),
      /概念/,
    );
    await assert.rejects(
      api("/api/live/propose", {
        ...mapping,
        types: [{ ...mapping.types[0], name: "已恢复供热" }],
      }),
      /概念|含义/,
    );
    await assert.rejects(
      api("/api/live/propose", { ...mapping, baseModelRef: null }),
      /执行子集/,
    );
    const smaller = (
      await api("/api/live/propose", {
        ...mapping,
        types: [mapping.types[0]],
        relations: [],
      })
    ).saved;
    const smallerAdopted = (
      await api("/api/live/adopt", { id: smaller.id, version: smaller.version })
    ).saved;
    await assert.rejects(api("/api/live/propose", mapping), /执行子集/);
    const projection = (await api()).foundation.current.content;
    assert.equal(
      projection.concepts.find((c: any) => c.id === "callback").mappingStatus,
      "unbound",
    );
    assert.equal(projection.relations[0].mappingStatus, "unbound");
    assert.equal(
      projection.concepts
        .find((c: any) => c.id === "complaint")
        .bindings.filter((b: any) => b.status === "adopted").length,
      1,
    );
    mapping.baseModelRef = {
      id: smallerAdopted.id,
      version: smallerAdopted.version,
    };
    const pending = (await api("/api/live/propose", mapping)).saved;
    phase = "foundation";
    await api("/api/canvas/navigate", { page: "setup" });
    await api("/api/canvas/message", {
      page: "setup",
      text: "澄川热力向居民供热，投诉是居民反映的供热问题，处理后通过回访了解居民反馈。",
      messageId: "binding-revision",
    });
    await service.app.idle();
    // A new draft does not invalidate the still adopted semantic version.
    assert.equal((await api("/api/live/query", query)).items[0].$id, "TS002");
    const retained = await api("/api/canvas/context/read", {
      page: "ontology",
      context,
    });
    assert.equal(retained.target.ref.version, adopted.version);
    const revised = (await api()).foundation.current;
    await api("/api/canvas/foundation/adopt", {
      page: "setup",
      id: revised.id,
      version: revised.version,
    });
    await assert.rejects(
      api("/api/canvas/context/read", { page: "ontology", context }),
      /版本/,
    );
    await assert.rejects(
      api("/api/live/adopt", { id: pending.id, version: pending.version }),
      /基础|版本/,
    );
    await assert.rejects(api("/api/live/query", query), /基础|版本/);
    await service.close();
    service = await createServer({ directory, driver, automaticApi: false });
    api = await start();
    const reopened = await api();
    assert.equal(reopened.foundation.current.content.concepts.length, 3);
    await assert.rejects(api("/api/live/query", query), /基础|版本/);
  } finally {
    await service.close();
    await upstream.close();
    proxy.closeAllConnections();
    await new Promise<void>((r) => proxy.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
});
