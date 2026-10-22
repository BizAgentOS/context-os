import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import type { Artifact, Data } from "../../src/agent/contracts.ts";

test("empty typed collections retain valid interfaces and reject undefined operations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-os-empty-interfaces-"));
  const repo = new MemoryStore(dir);
  try {
    const workspace = new Workspace(repo);
    const complaints = workspace.upload("投诉.csv", "id,status\n");
    const callbacks = workspace.upload("回访.csv", "id,complaint_id,result\n");
    const rules = workspace.upload("口径.md", "回访改善不等于整个楼栋恢复。");
    const candidate = (await workspace.execute("ontology_propose", {
      title: "投诉回访",
      purpose: "检查暂无投诉时的调查结果",
      types: [
        {
          name: "Complaint",
          description: "居民投诉",
          sourceId: complaints.id,
          idField: "id",
          fields: { status: "status" },
        },
        {
          name: "Callback",
          description: "投诉回访",
          sourceId: callbacks.id,
          idField: "id",
          fields: { complaintId: "complaint_id", result: "result" },
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
      functions: [
        {
          name: "recoveryEvidence",
          implementation: "recovery_evidence",
          type: "Complaint",
          relation: "callbacks",
          field: "result",
          evidence: [{ sourceId: rules.id, version: 1 }],
        },
      ],
      evidence: [{ sourceId: rules.id, version: 1 }],
    })) as unknown as Artifact;
    const checked = (await workspace.execute("ontology_preview", {
      id: candidate.id,
      version: candidate.version,
    })) as unknown as Artifact;
    workspace.adopt(checked.id, checked.version);
    await workspace.execute("object_execute", {
      operations: [{ op: "query", type: "Complaint", as: "empty" }],
    });
    assert.throws(
      () =>
        workspace.execute("object_execute", {
          operations: [
            { op: "related", input: "$empty", relation: "invented" },
          ],
        }),
      /没有关系/,
    );
    assert.throws(
      () =>
        workspace.execute("object_execute", {
          operations: [{ op: "call", input: "$empty", method: "invented" }],
        }),
      /没有.*方法/,
    );
    assert.throws(
      () =>
        workspace.execute("object_execute", {
          operations: [{ op: "aggregate", input: "$empty", field: "invented" }],
        }),
      /没有字段/,
    );
    const composed = (await workspace.execute("object_execute", {
      operations: [
        {
          op: "related",
          input: "$empty",
          relation: "callbacks",
          as: "callbacks",
        },
        { op: "aggregate", input: "$callbacks", field: "result", as: "count" },
        {
          op: "call",
          input: "$empty",
          method: "recoveryEvidence",
          as: "recovery",
        },
      ],
    })) as Data;
    const results = composed.results as Data;
    assert.equal((results.callbacks as Data).type, "Callback");
    assert.equal((results.count as Data).count, 0);
    assert.deepEqual((results.count as Data).groups, {});
    assert.equal((results.count as Data).partial, false);
    assert.deepEqual((results.recovery as Data).items, []);
    assert.throws(
      () =>
        workspace.execute("object_execute", {
          operations: [
            { op: "call", input: "$callbacks", method: "recoveryEvidence" },
          ],
        }),
      /没有.*方法/,
    );
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reopened investigation keeps its model and data scope when another task adopts newer memory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-os-investigation-"));
  let repo = new MemoryStore(dir);
  try {
    const host = new Workspace(repo);
    const source = host.upload(
      "设备.csv",
      "id,name,alias\nE1,旧设备名称,旧别名\n",
    );
    const definition = {
      title: "设备名称",
      purpose: "核查设备名称",
      types: [
        {
          name: "Equipment",
          description: "设备",
          sourceId: source.id,
          idField: "id",
          fields: { name: "name" },
        },
      ],
      relations: [],
      functions: [],
      evidence: [{ sourceId: source.id, version: 1, row: 1 }],
    };
    const proposed = (await host.execute(
      "ontology_propose",
      definition,
    )) as unknown as Artifact;
    const preview = (await host.execute("ontology_preview", {
      id: proposed.id,
      version: proposed.version,
    })) as unknown as Artifact;
    host.adopt(preview.id, preview.version);
    const task = repo.createTask("核查原快照设备");
    const execution = repo.beginExecution(task.id);
    const first = (await new Workspace(repo, execution).execute(
      "object_execute",
      { operations: [{ op: "get", type: "Equipment", id: "E1", as: "e" }] },
    )) as Data;
    repo.endExecution(execution);
    const otherTask = repo.createTask("更新企业资料");
    const otherExecution = repo.beginExecution(otherTask.id);
    const other = new Workspace(repo, otherExecution);
    other.upload("设备.csv", "id,name,alias\nE1,新设备名称,新业务别名\n");
    const revision = (await other.execute("ontology_propose", {
      ...definition,
      types: [{ ...definition.types[0], fields: { name: "alias" } }],
      evidence: [{ sourceId: source.id, version: 2, row: 1 }],
    })) as unknown as Artifact;
    const revisionPreview = (await other.execute("ontology_preview", {
      id: revision.id,
      version: revision.version,
    })) as unknown as Artifact;
    other.adopt(revisionPreview.id, revisionPreview.version);
    const current = (await other.execute("object_execute", {
      operations: [{ op: "get", type: "Equipment", id: "E1", as: "e" }],
    })) as Data;
    assert.equal(
      (((current.results as Data).e as Data).fields as Data).name,
      "新业务别名",
    );
    repo.endExecution(otherExecution);
    repo.close();
    repo = new MemoryStore(dir);
    const resumed = (await new Workspace(
      repo,
      repo.beginExecution(task.id),
    ).execute("object_execute", {
      operations: [{ op: "get", type: "Equipment", id: "E1", as: "e" }],
    })) as Data;
    assert.equal(resumed.snapshot, first.snapshot);
    assert.deepEqual(resumed.model, first.model);
    assert.equal(
      (((resumed.results as Data).e as Data).fields as Data).name,
      "旧设备名称",
    );
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid CSV remains inspectable as a failed source and a corrected upload creates a new usable version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-os-invalid-csv-"));
  const repo = new MemoryStore(dir);
  try {
    const workspace = new Workspace(repo);
    const raw = 'id,name\nA1,"引号未闭合';
    const failed = workspace.upload("设施.csv", raw);
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.content.rows, []);
    assert.deepEqual(failed.content.columns, []);
    assert.match(String(failed.content.parseError), /引号/);
    const read = (await workspace.execute("memory_read", {
      id: failed.id,
    })) as unknown as Artifact;
    assert.equal(read.content.raw, raw);
    assert.equal(read.content.hash, failed.content.hash);
    const args = {
      title: "设施模型",
      purpose: "查看设施",
      types: [
        {
          name: "Asset",
          description: "设施",
          sourceId: failed.id,
          idField: "id",
          fields: { name: "name" },
        },
      ],
      relations: [],
      functions: [],
      evidence: [{ sourceId: failed.id, version: 1 }],
    };
    const proposed = (await workspace.execute(
      "ontology_propose",
      args,
    )) as unknown as Artifact;
    const checked = (await workspace.execute("ontology_preview", {
      id: proposed.id,
      version: proposed.version,
    })) as unknown as Artifact;
    assert.equal((checked.content.validation as Data).valid, false);
    assert.match(
      String(((checked.content.validation as Data).errors as string[])[0]),
      /解析失败/,
    );
    const corrected = workspace.upload("设施.csv", "id,name\nA1,一号站\n");
    assert.equal(corrected.id, failed.id);
    assert.equal(corrected.version, 2);
    assert.equal(corrected.status, "ready");
    assert.equal(corrected.content.parseError, undefined);
    const revised = (await workspace.execute("ontology_propose", {
      ...args,
      evidence: [{ sourceId: failed.id, version: 2, row: 1 }],
    })) as unknown as Artifact;
    const valid = (await workspace.execute("ontology_preview", {
      id: revised.id,
      version: revised.version,
    })) as unknown as Artifact;
    assert.equal((valid.content.validation as Data).valid, true);
    const historical = (await workspace.execute("memory_read", {
      id: failed.id,
      version: 1,
    })) as unknown as Artifact;
    assert.equal(historical.status, "failed");
    assert.equal(historical.content.raw, raw);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collection references preserve their exact scope across object calls and reject fabricated totals or subsets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-os-collections-"));
  const repo = new MemoryStore(dir);
  try {
    const workspace = new Workspace(repo);
    const source = workspace.upload(
      "设备.csv",
      "id,name\nE1,一号泵\nE2,二号泵\nE3,三号泵\n",
    );
    const model = (await workspace.execute("ontology_propose", {
      title: "设备",
      purpose: "统计设备",
      types: [
        {
          name: "Equipment",
          description: "设备",
          sourceId: source.id,
          idField: "id",
          fields: { name: "name" },
        },
      ],
      relations: [],
      functions: [],
      evidence: [{ sourceId: source.id, version: 1 }],
    })) as unknown as Artifact;
    const checked = (await workspace.execute("ontology_preview", {
      id: model.id,
      version: model.version,
    })) as unknown as Artifact;
    workspace.adopt(checked.id, checked.version);
    const read = (await workspace.execute("object_execute", {
      operations: [
        { op: "query", type: "Equipment", as: "all" },
        { op: "query", type: "Equipment", limit: 1, as: "page" },
      ],
    })) as Data;
    const all = (read.results as Data).all as Data;
    const page = (read.results as Data).page as Data;
    assert.throws(
      () =>
        workspace.execute("object_execute", {
          operations: [
            { op: "aggregate", input: { ...page, truncated: false, total: 1 } },
          ],
        }),
      /集合|篡改/,
    );
    assert.throws(
      () =>
        workspace.execute("object_execute", {
          operations: [
            {
              op: "aggregate",
              input: {
                ...all,
                items: (all.items as Data[]).slice(0, 1),
                total: 1,
              },
            },
          ],
        }),
      /集合|篡改/,
    );
    assert.throws(
      () =>
        workspace.execute("object_execute", {
          operations: [
            {
              op: "aggregate",
              input: {
                snapshot: all.snapshot,
                type: "Equipment",
                items: (all.items as Data[]).slice(0, 1),
                total: 1,
                truncated: false,
              },
            },
          ],
        }),
      /集合|引用/,
    );
    assert.equal(typeof all.collectionId, "string");
    const aggregate = (await workspace.execute("object_execute", {
      operations: [
        {
          op: "aggregate",
          input: { snapshot: all.snapshot, collectionId: all.collectionId },
          as: "count",
        },
        { op: "aggregate", input: all, as: "roundtrip" },
        { op: "evidence", input: (all.items as Data[])[0], as: "entity" },
      ],
    })) as Data;
    assert.equal(((aggregate.results as Data).count as Data).count, 3);
    assert.equal(((aggregate.results as Data).roundtrip as Data).count, 3);
    assert.equal(((aggregate.results as Data).entity as Data).total, 1);
    const pageCount = (await workspace.execute("object_execute", {
      operations: [
        {
          op: "aggregate",
          input: { snapshot: page.snapshot, collectionId: page.collectionId },
          as: "count",
        },
      ],
    })) as Data;
    const partial = (pageCount.results as Data).count as Data;
    assert.equal(partial.count, 1);
    assert.equal(partial.partial, true);
    assert.equal(partial.scope, "current_page");
    assert.deepEqual(partial.coverage, {
      complete: false,
      total: 3,
      offset: 0,
      shown: 1,
    });
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uploaded sources and statement provenance reopen; model suggestions cannot overwrite user edits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-os-workspace-"));
  let repo = new MemoryStore(dir);
  try {
    let workspace = new Workspace(repo);
    const source = workspace.upload(
      "企业简介.md",
      "澄川热力为北城区居民供热。",
    );
    await workspace.execute("profile_update", {
      statements: [
        {
          key: "business",
          text: "居民供热",
          origin: "source",
          evidence: [{ sourceId: source.id, version: 1 }],
        },
      ],
    });
    workspace.editProfile("business", "为北城区居民供热");
    const updated = (await workspace.execute("profile_update", {
      statements: [{ key: "business", text: "工业供热", origin: "suggestion" }],
    })) as unknown as Artifact;
    assert.equal(
      (updated.content.statements as Data[])[0].text,
      "为北城区居民供热",
    );
    assert.equal((updated.content.conflicts as Data[]).length, 1);
    const newer = workspace.upload("企业简介.md", "澄川热力供热与服务。");
    assert.equal(newer.id, source.id);
    assert.equal(newer.version, 2);
    repo.close();
    repo = new MemoryStore(dir);
    workspace = new Workspace(repo);
    const original = (await workspace.execute("memory_read", {
      id: source.id,
      version: 1,
    })) as unknown as Artifact;
    assert.equal(original.content.raw, "澄川热力为北城区居民供热。");
    assert.equal((workspace.overview() as Data).sources instanceof Array, true);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retrying a successful candidate check returns the same saved version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-os-retry-"));
  const repo = new MemoryStore(dir);
  try {
    const workspace = new Workspace(repo);
    const source = workspace.upload("设备.csv", "id,name\nE1,循环泵\n");
    const model = (await workspace.execute("ontology_propose", {
      title: "设备",
      purpose: "查看设备",
      types: [
        {
          name: "Equipment",
          description: "设备实体",
          sourceId: source.id,
          idField: "id",
          fields: { name: "name" },
        },
      ],
      relations: [],
      functions: [],
      evidence: [{ sourceId: source.id, version: 1 }],
    })) as unknown as Artifact;
    const first = await workspace.execute(
      "ontology_preview",
      { id: model.id, version: model.version },
      "check-one",
    );
    const retry = await workspace.execute(
      "ontology_preview",
      { id: model.id, version: model.version },
      "check-one",
    );
    assert.deepEqual(retry, first);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("candidate reports remain previews; changed dependencies and nonunique identities cannot be adopted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-os-preview-"));
  const repo = new MemoryStore(dir);
  try {
    const workspace = new Workspace(repo);
    const source = workspace.upload(
      "设施.csv",
      "id,name\nA1,一号站\nA2,二号站\n",
    );
    const modelArgs = {
      title: "设施身份",
      purpose: "识别设施",
      types: [
        {
          name: "Asset",
          description: "设施",
          sourceId: source.id,
          idField: "id",
          fields: { name: "name" },
        },
      ],
      relations: [],
      functions: [],
      evidence: [{ sourceId: source.id, version: 1, row: 1 }],
    };
    const proposed = (await workspace.execute(
      "ontology_propose",
      modelArgs,
    )) as unknown as Artifact;
    const checked = (await workspace.execute("ontology_preview", {
      id: proposed.id,
      version: 1,
    })) as unknown as Artifact;
    const investigation = (await workspace.execute("object_execute", {
      candidateId: checked.id,
      candidateVersion: checked.version,
      operations: [{ op: "get", type: "Asset", id: "A1", as: "a" }],
    })) as Data;
    const report = (await workspace.execute("report_save", {
      title: "候选中的设施",
      question: "设施名称",
      snapshot: investigation.snapshot,
      findings: [
        {
          kind: "fact",
          text: "A1 是一号站",
          evidence: [{ sourceId: source.id, version: 1, row: 1 }],
        },
      ],
    })) as unknown as Artifact;
    assert.equal(report.status, "preview");
    workspace.upload("设施.csv", "id,name\nA1,一号站\nA1,另一个设施\n");
    assert.throws(
      () => workspace.adopt(checked.id, checked.version),
      /来源版本/,
    );
    const revised = (await workspace.execute("ontology_propose", {
      ...modelArgs,
      evidence: [{ sourceId: source.id, version: 2, row: 1 }],
    })) as unknown as Artifact;
    const invalid = (await workspace.execute("ontology_preview", {
      id: revised.id,
      version: revised.version,
    })) as unknown as Artifact;
    assert.equal((invalid.content.validation as Data).valid, false);
    assert.throws(() => workspace.adopt(invalid.id, invalid.version), /检查/);
    assert.throws(
      () =>
        workspace.execute(
          "ontology_preview",
          { id: revised.id, version: revised.version },
          "repeat-preview",
        ),
      /版本/,
    );
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("user statements need an exact quote from the current task and keep that provenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-os-quotes-"));
  const repo = new MemoryStore(dir);
  try {
    const task = repo.createTask("定义企业");
    const context = repo.beginExecution(task.id);
    const workspace = new Workspace(repo, context);
    const message = repo.addMessage(
      task.id,
      "user",
      "我们是热力公司，我负责客服。",
    );
    const source = {
      key: "role",
      text: "我负责客服",
      origin: "user",
      messageId: message.id,
      quote: "我负责客服",
    };
    const profile = (await workspace.execute("profile_update", {
      statements: [source],
    })) as unknown as Artifact;
    assert.equal((profile.content.statements as Data[])[0].origin, "user");
    assert.equal(
      ((profile.content.statements as Data[])[0].userEvidence as Data)
        .messageId,
      message.id,
    );
    assert.throws(
      () =>
        workspace.execute("profile_update", {
          statements: [{ ...source, text: "我是总经理" }],
        }),
      /引用|原话/,
    );
    const other = repo.createTask("另一任务");
    const unrelated = repo.addMessage(other.id, "user", "我负责客服");
    assert.throws(
      () =>
        workspace.execute("profile_update", {
          statements: [{ ...source, messageId: unrelated.id }],
        }),
      /当前任务|用户消息/,
    );
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports preserve checked evidence and object snapshots across source refresh and reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-os-report-"));
  let repo = new MemoryStore(dir);
  try {
    const workspace = new Workspace(repo);
    const source = workspace.upload(
      "工单.csv",
      "id,state\nW1,open\nW2,closed\n",
    );
    const unrelated = workspace.upload("无关.txt", "不能用此文档伪造工单证据");
    const proposed = (await workspace.execute("ontology_propose", {
      title: "工单模型",
      purpose: "核查处理状态",
      types: [
        {
          name: "WorkOrder",
          description: "一项维修工作",
          sourceId: source.id,
          idField: "id",
          fields: { state: "state" },
        },
      ],
      relations: [],
      functions: [],
      evidence: [{ sourceId: source.id, version: 1, row: 1 }],
    })) as unknown as Artifact;
    const checked = (await workspace.execute("ontology_preview", {
      id: proposed.id,
      version: proposed.version,
    })) as unknown as Artifact;
    workspace.adopt(checked.id, checked.version);
    const investigation = (await workspace.execute("object_execute", {
      operations: [{ op: "get", type: "WorkOrder", id: "W1", as: "work" }],
    })) as Data;
    const oldObject = (investigation.results as Data).work as Data;
    const evidence = oldObject.evidence as Data[];
    const report = (await workspace.execute("report_save", {
      title: "未闭环工单",
      question: "W1 是否办结",
      snapshot: investigation.snapshot,
      findings: [{ kind: "fact", text: "W1 尚处于 open 状态。", evidence }],
      limitations: ["仅依据导入快照，不推断供热恢复。"],
    })) as unknown as Artifact;
    assert.equal(report.status, "draft");
    assert.throws(
      () =>
        workspace.execute("report_save", {
          title: "伪造报告",
          question: "状态",
          snapshot: investigation.snapshot,
          findings: [
            {
              kind: "fact",
              text: "全部完成",
              evidence: [{ sourceId: source.id, version: 1, row: 99 }],
            },
          ],
        }),
      /行号/,
    );
    assert.throws(
      () =>
        workspace.execute("report_save", {
          title: "无关证据",
          question: "状态",
          snapshot: investigation.snapshot,
          findings: [
            {
              kind: "fact",
              text: "全部完成",
              evidence: [{ sourceId: unrelated.id, version: 1 }],
            },
          ],
        }),
      /快照|范围/,
    );
    workspace.upload("工单.csv", "id,state\nW1,closed\nW2,closed\n");
    const fresh = new Workspace(repo);
    assert.throws(
      () =>
        fresh.execute("object_execute", {
          operations: [{ op: "evidence", input: oldObject }],
        }),
      /快照/,
    );
    const freshResult = (await fresh.execute("object_execute", {
      operations: [{ op: "get", type: "WorkOrder", id: "W1", as: "newWork" }],
    })) as Data;
    assert.throws(
      () =>
        fresh.execute("object_execute", {
          operations: [
            {
              op: "evidence",
              input: {
                snapshot: freshResult.snapshot,
                type: "WorkOrder",
                items: [oldObject],
                total: 1,
                truncated: false,
              },
            },
          ],
        }),
      /快照/,
    );
    const before = (await workspace.execute("object_execute", {
      operations: [{ op: "get", type: "WorkOrder", id: "W1", as: "stillOld" }],
    })) as Data;
    assert.equal(
      (((before.results as Data).stillOld as Data).fields as Data).state,
      "open",
    );
    repo.close();
    repo = new MemoryStore(dir);
    const reopened = new Workspace(repo);
    const saved = (await reopened.execute("memory_read", {
      id: report.id,
    })) as unknown as Artifact;
    assert.equal(saved.content.snapshot, investigation.snapshot);
    const historical = (await reopened.execute("memory_read", {
      id: source.id,
      version: 1,
      offset: 0,
      limit: 1,
    })) as unknown as Artifact;
    assert.equal((historical.content.rows as Data[])[0].state, "open");
    assert.equal(historical.content.total, 2);
    assert.equal(historical.content.truncated, true);
    assert.equal(historical.content.raw, undefined);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a checked candidate stays a preview until host adoption; typed objects traverse sources and keep unknown recovery evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "context-os-model-"));
  const repo = new MemoryStore(dir);
  try {
    const workspace = new Workspace(repo);
    const tickets = workspace.upload(
      "投诉.csv",
      "ticket_id,building_id,status\nC1,B1,closed\nC2,B9,closed\nC3,B1,closed\n",
    );
    const buildings = workspace.upload(
      "楼栋.csv",
      "building_id,name\nB1,清河一号楼\n",
    );
    const callbacks = workspace.upload(
      "回访.csv",
      "callback_id,ticket_id,result\nF1,C1,improved\nF3,C3,not_improved\n",
    );
    const rules = workspace.upload(
      "口径.md",
      "投诉办结不代表供热恢复。improved 仅表示住户回访改善，not_improved 表示未改善。",
    );
    const proposed = (await workspace.execute("ontology_propose", {
      title: "投诉恢复证据模型",
      purpose: "查找办结投诉中的恢复证据缺口",
      types: [
        {
          name: "Complaint",
          description: "居民一次投诉",
          sourceId: tickets.id,
          idField: "ticket_id",
          fields: { status: "status", buildingId: "building_id" },
        },
        {
          name: "Building",
          description: "楼栋",
          sourceId: buildings.id,
          idField: "building_id",
          fields: { name: "name" },
        },
        {
          name: "Callback",
          description: "一次回访",
          sourceId: callbacks.id,
          idField: "callback_id",
          fields: { complaintId: "ticket_id", result: "result" },
        },
      ],
      relations: [
        {
          name: "building",
          from: "Complaint",
          to: "Building",
          fromField: "buildingId",
          toField: "$id",
        },
        {
          name: "callbacks",
          from: "Complaint",
          to: "Callback",
          fromField: "$id",
          toField: "complaintId",
        },
      ],
      functions: [
        {
          name: "recoveryEvidence",
          implementation: "recovery_evidence",
          type: "Complaint",
          relation: "callbacks",
          field: "result",
          evidence: [{ sourceId: rules.id, version: 1 }],
        },
      ],
      evidence: [{ sourceId: rules.id, version: 1 }],
    })) as unknown as Artifact;
    assert.equal(proposed.status, "candidate");
    assert.throws(
      () => workspace.adopt(proposed.id, proposed.version),
      /预览|检查/,
    );
    const checked = (await workspace.execute("ontology_preview", {
      id: proposed.id,
      version: proposed.version,
    })) as unknown as Artifact;
    assert.equal((checked.content.validation as Data).valid, true);
    assert.equal(checked.status, "candidate");
    assert.throws(
      () =>
        workspace.execute("object_execute", {
          operations: [{ op: "query", type: "Complaint" }],
        }),
      /采用/,
    );
    const adopted = workspace.adopt(checked.id, checked.version);
    assert.equal(adopted.status, "adopted");
    const result = (await workspace.execute("object_execute", {
      operations: [
        { op: "get", type: "Complaint", id: "C1", as: "complaint" },
        {
          op: "related",
          input: "$complaint",
          relation: "building",
          as: "building",
        },
        {
          op: "call",
          input: "$complaint",
          method: "recoveryEvidence",
          as: "recovery",
        },
        { op: "get", type: "Complaint", id: "C2", as: "missing" },
        {
          op: "related",
          input: "$missing",
          relation: "building",
          as: "unresolved",
        },
        {
          op: "call",
          input: "$missing",
          method: "recoveryEvidence",
          as: "unknown",
        },
      ],
    })) as Data;
    const results = result.results as Data;
    assert.equal(((results.building as Data).items as Data[])[0].id, "B1");
    assert.equal(
      (results.recovery as Data).status,
      "positive_callback_evidence",
    );
    assert.equal((results.unknown as Data).status, "no_evidence");
    assert.equal((results.unresolved as Data).unresolved, true);
    assert.equal(
      ((results.recovery as Data).evidence as Data[]).some(
        (e) => e.sourceId === callbacks.id && e.row === 1,
      ),
      true,
    );
    const paged = (await workspace.execute("object_execute", {
      operations: [
        { op: "query", type: "Complaint", offset: 1, limit: 1, as: "page" },
        {
          op: "related",
          input: "$page",
          relation: "callbacks",
          as: "pageCallbacks",
        },
        { op: "evidence", input: "$page", as: "pageEvidence" },
        {
          op: "call",
          input: "$page",
          method: "recoveryEvidence",
          as: "pageRecovery",
        },
        { op: "aggregate", input: "$page", as: "pageCount" },
        { op: "aggregate", input: "$pageCallbacks", as: "callbackCount" },
      ],
    })) as Data;
    const pageResults = paged.results as Data;
    const expectedCoverage = { complete: false, total: 3, offset: 1, shown: 1 };
    assert.deepEqual((pageResults.page as Data).coverage, expectedCoverage);
    assert.deepEqual(
      (pageResults.pageEvidence as Data).coverage,
      expectedCoverage,
    );
    assert.deepEqual(
      (pageResults.pageRecovery as Data).coverage,
      expectedCoverage,
    );
    assert.equal(
      ((pageResults.pageRecovery as Data).items as Data[])[0].status,
      "no_evidence",
    );
    assert.deepEqual((pageResults.pageCallbacks as Data).coverage, {
      complete: false,
      total: null,
      offset: 0,
      shown: 0,
      input: expectedCoverage,
    });
    assert.equal((pageResults.pageCount as Data).count, 1);
    assert.equal((pageResults.pageCount as Data).partial, true);
    assert.equal((pageResults.callbackCount as Data).count, 0);
    assert.equal((pageResults.callbackCount as Data).partial, true);
    assert.throws(
      () =>
        workspace.execute("ontology_propose", {
          ...proposed.content,
          title: "假实现",
          functions: [
            {
              name: "recovery",
              implementation: "arbitrary_code",
              type: "Complaint",
            },
          ],
        }),
      /实现|方法/,
    );
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
