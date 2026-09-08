import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/agent/memory.ts";
import { Workspace } from "../../src/agent/workspace.ts";
import type { Artifact, Data } from "../../src/agent/contracts.ts";

test("documents can ground a revisable conceptual outline without inventing adopted objects", () => {
  const dir = mkdtempSync(join(tmpdir(), "dataengine-outline-"));
  let repo = new MemoryStore(dir);
  try {
    const workspace = new Workspace(repo);
    const rules = workspace.upload(
      "业务口径.md",
      "工单办结只说明处理流程完成；供暖恢复需要回访证据。投诉可以关联多个回访。",
    );
    const evidence = [{ sourceId: rules.id, version: rules.version }];
    const definition = {
      title: "投诉与恢复的概念初稿",
      purpose: "核查工单办结后是否有供暖恢复依据",
      concepts: [
        {
          name: "投诉",
          description: "居民反馈的供暖问题，处理办结不代表供暖恢复。",
          evidence,
        },
        { name: "回访", description: "居民对处理后供暖情况的反馈。", evidence },
      ],
      relations: [
        {
          name: "后续回访",
          from: "投诉",
          to: "回访",
          description: "通过回访核查投诉处理后的供暖情况。",
          evidence,
        },
      ],
    };
    const outline = workspace.execute(
      "ontology_outline",
      definition,
    ) as unknown as Artifact;
    assert.equal(outline.kind, "ontology_outline");
    assert.equal(outline.status, "draft");
    assert.equal((outline.content.concepts as Data[])[0].name, "投诉");
    assert.deepEqual(outline.content.sourceVersions, { [rules.id]: 1 });
    assert.deepEqual(outline.content.evidence, [
      { ...evidence[0], hash: rules.content.hash },
    ]);
    assert.throws(() => workspace.adopt(outline.id, outline.version), /候选/);
    assert.throws(
      () =>
        workspace.execute("ontology_preview", {
          id: outline.id,
          version: outline.version,
        }),
      /候选/,
    );
    assert.throws(
      () =>
        workspace.execute("object_execute", {
          operations: [{ op: "query", type: "投诉" }],
        }),
      /尚无已采用本体/,
    );
    assert.deepEqual((workspace.overview() as Data).models, []);
    assert.equal(
      ((workspace.overview() as Data).outlines as Data[])[0].id,
      outline.id,
    );

    assert.throws(() =>
      workspace.execute("ontology_outline", {
        ...definition,
        concepts: [
          {
            ...definition.concepts[0],
            evidence: [{ sourceId: "invented", version: 1 }],
          },
        ],
      }),
    );
    const failed = workspace.upload("坏表.csv", 'id,status\nC1,"未关闭');
    assert.throws(
      () =>
        workspace.execute("ontology_outline", {
          ...definition,
          concepts: [
            {
              ...definition.concepts[0],
              evidence: [{ sourceId: failed.id, version: 1 }],
            },
          ],
          relations: [],
        }),
      /失败/,
    );
    assert.throws(
      () =>
        workspace.execute("ontology_outline", {
          ...definition,
          relations: [{ ...definition.relations[0], to: "不存在的概念" }],
        }),
      /关系.*概念/,
    );
    assert.throws(
      () =>
        workspace.execute("ontology_outline", {
          ...definition,
          concepts: [definition.concepts[0], definition.concepts[0]],
        }),
      /唯一|重复/,
    );

    const revision = workspace.execute("ontology_outline", {
      ...definition,
      id: outline.id,
      version: outline.version,
      purpose: "仅核查关联回访的恢复反馈，不推断整栋楼供暖恢复",
    }) as unknown as Artifact;
    assert.equal(revision.id, outline.id);
    assert.equal(revision.version, 2);
    repo.close();
    repo = new MemoryStore(dir);
    const reopened = new Workspace(repo);
    assert.equal(
      (
        reopened.execute("memory_read", {
          id: outline.id,
        }) as unknown as Artifact
      ).content.purpose,
      revision.content.purpose,
    );
    assert.equal(
      (
        reopened.execute("memory_read", {
          id: outline.id,
          version: 1,
        }) as unknown as Artifact
      ).content.purpose,
      definition.purpose,
    );
    assert.deepEqual((reopened.overview() as Data).models, []);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("business verification saves actual callback evidence and keeps old source snapshots after a source update", () => {
  const dir = mkdtempSync(join(tmpdir(), "dataengine-verification-"));
  let repo = new MemoryStore(dir);
  try {
    const host = new Workspace(repo);
    const complaints = host.upload(
      "投诉.csv",
      "id,area,status\nC1,滨河小区,closed\nC2,滨河小区,closed\n",
    );
    const callbacks = host.upload(
      "回访.csv",
      "id,complaint_id,result\nF1,C1,not_recovered\nF2,C2,recovered\n",
    );
    const rules = host.upload(
      "恢复口径.md",
      "办结不是供暖恢复。回访结果才作为关联投诉的恢复反馈依据，单户反馈不证明整栋楼恢复。",
    );
    const proposed = host.execute("ontology_propose", {
      title: "投诉恢复证据",
      purpose: "滨河小区办结投诉是否已有恢复反馈",
      types: [
        {
          name: "Complaint",
          description: "居民投诉",
          sourceId: complaints.id,
          idField: "id",
          fields: { area: "area", status: "status" },
        },
        {
          name: "Callback",
          description: "居民回访",
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
    }) as unknown as Artifact;
    const checked = host.execute("ontology_preview", {
      id: proposed.id,
      version: proposed.version,
    }) as unknown as Artifact;
    const adopted = host.adopt(checked.id, checked.version);
    const task = repo.createTask("核查 C1 办结后的恢复反馈");
    const context = repo.beginExecution(task.id);
    const workspace = new Workspace(repo, context);
    const params = {
      question: "C1 已办结，是否有回访支持供暖恢复？",
      operations: [
        { op: "get", type: "Complaint", id: "C1", as: "complaint" },
        {
          op: "call",
          input: "$complaint",
          method: "recoveryEvidence",
          as: "recovery",
        },
      ],
    };
    const verification = workspace.execute(
      "ontology_verify",
      params,
      "verify-c1",
    ) as unknown as Artifact;
    assert.equal(verification.kind, "verification");
    assert.equal(verification.status, "unreviewed");
    assert.equal(verification.content.modelId, adopted.id);
    assert.equal(verification.content.modelVersion, adopted.version);
    assert.equal(verification.content.modelStatus, "adopted");
    assert.equal(verification.content.question, params.question);
    assert.equal(verification.content.runNumber, 1);
    assert.deepEqual(verification.content.operations, params.operations);
    const result = verification.content.result as Data;
    const results = result.results as Data;
    assert.equal(((results.complaint as Data).fields as Data).status, "closed");
    assert.equal(
      (results.recovery as Data).status,
      "negative_callback_evidence",
    );
    assert.deepEqual((results.recovery as Data).outcomes, ["not_recovered"]);
    assert.equal(verification.content.snapshot, result.snapshot);
    assert.deepEqual(
      verification.content.sourceVersions,
      result.sourceVersions,
    );
    assert.ok(
      (verification.content.evidence as Data[]).some(
        (ref) =>
          ref.sourceId === callbacks.id && ref.version === 1 && ref.row === 1,
      ),
    );
    assert.equal(verification.content.answer, undefined);
    assert.equal(verification.content.passed, undefined);
    const replay = workspace.execute(
      "ontology_verify",
      params,
      "verify-c1",
    ) as unknown as Artifact;
    assert.equal(replay.id, verification.id);
    assert.equal(replay.content.runNumber, 1);
    assert.throws(
      () =>
        workspace.execute("ontology_verify", {
          ...params,
          operations: [{ op: "get", type: "Complaint", id: "missing" }],
        }),
      /不存在/,
    );
    assert.throws(
      () =>
        workspace.execute("ontology_verify", {
          ...params,
          operations: [{ op: "delete", type: "Complaint", id: "C1" }],
        }),
      /不支持对象操作/,
    );
    assert.equal(repo.listArtifacts("verification").length, 1);

    const partial = workspace.execute("ontology_verify", {
      question: "只检查第一页的投诉办结数量",
      operations: [
        { op: "query", type: "Complaint", limit: 1, as: "page" },
        { op: "aggregate", input: "$page", field: "status", as: "count" },
      ],
    }) as unknown as Artifact;
    const count = ((partial.content.result as Data).results as Data)
      .count as Data;
    assert.equal(count.count, 1);
    assert.equal(count.partial, true);
    assert.equal(count.scope, "current_page");
    assert.equal((count.coverage as Data).total, 2);
    repo.endExecution(context);
    host.upload(
      "回访.csv",
      "id,complaint_id,result\nF1,C1,recovered\nF2,C2,recovered\n",
    );
    repo.close();
    repo = new MemoryStore(dir);
    const resumedContext = repo.beginExecution(task.id);
    const resumed = new Workspace(repo, resumedContext);
    const saved = resumed.execute("memory_read", {
      id: verification.id,
    }) as unknown as Artifact;
    assert.deepEqual(saved.content, verification.content);
    const sameTask = resumed.execute(
      "ontology_verify",
      params,
    ) as unknown as Artifact;
    assert.equal(sameTask.content.runNumber, 2);
    assert.equal(sameTask.content.snapshot, verification.content.snapshot);
    assert.equal(
      (((sameTask.content.result as Data).results as Data).recovery as Data)
        .status,
      "negative_callback_evidence",
    );
    repo.endExecution(resumedContext);
    const newTask = repo.createTask("核查新回访");
    const updated = new Workspace(
      repo,
      repo.beginExecution(newTask.id),
    ).execute("ontology_verify", params) as unknown as Artifact;
    assert.notEqual(updated.id, verification.id);
    assert.notEqual(updated.content.snapshot, verification.content.snapshot);
    assert.equal((updated.content.sourceVersions as Data)[callbacks.id], 2);
    assert.equal(updated.content.modelVersion, adopted.version);
    assert.equal(
      (((updated.content.result as Data).results as Data).recovery as Data)
        .status,
      "positive_callback_evidence",
    );
    assert.equal(updated.status, "unreviewed");
    assert.equal(updated.content.runNumber, 3);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("candidate verification stays a preview and an empty query retains its checked source scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "dataengine-preview-verification-"));
  const repo = new MemoryStore(dir);
  try {
    const workspace = new Workspace(repo);
    const source = workspace.upload("工单.csv", "id,status\nW1,open\n");
    const candidate = workspace.execute("ontology_propose", {
      title: "工单处理状态",
      purpose: "检查是否存在办结的工单",
      types: [
        {
          name: "WorkOrder",
          description: "处理投诉的工单，其状态仅代表流程状态。",
          sourceId: source.id,
          idField: "id",
          fields: { status: "status" },
        },
      ],
      relations: [],
      functions: [],
      evidence: [{ sourceId: source.id, version: source.version }],
    }) as unknown as Artifact;
    const params = {
      question: "是否存在已经办结的工单？",
      candidateId: candidate.id,
      candidateVersion: candidate.version,
      operations: [
        {
          op: "query",
          type: "WorkOrder",
          where: { status: "closed" },
          as: "closed",
        },
      ],
    };
    assert.throws(() => workspace.execute("ontology_verify", params), /已检查/);
    const checked = workspace.execute("ontology_preview", {
      id: candidate.id,
      version: candidate.version,
    }) as unknown as Artifact;
    const verification = workspace.execute("ontology_verify", {
      ...params,
      candidateVersion: checked.version,
    }) as unknown as Artifact;
    assert.equal(verification.status, "unreviewed");
    assert.equal(verification.content.modelStatus, "candidate");
    assert.equal(verification.content.modelVersion, checked.version);
    const closed = ((verification.content.result as Data).results as Data)
      .closed as Data;
    assert.deepEqual(closed.items, []);
    assert.equal(closed.total, 0);
    assert.equal((closed.coverage as Data).complete, true);
    assert.deepEqual(verification.content.evidence, [
      {
        sourceId: source.id,
        version: source.version,
        hash: source.content.hash,
      },
    ]);
    assert.equal(repo.getArtifact(candidate.id).status, "candidate");
    assert.throws(
      () =>
        workspace.execute("ontology_verify", {
          question: params.question,
          operations: params.operations,
        }),
      /尚无已采用/,
    );
    assert.throws(
      () =>
        workspace.execute("ontology_verify", {
          ...params,
          candidateVersion: undefined,
        }),
      /准确/,
    );
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty documents and header-only tables cannot serve as conceptual evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "dataengine-empty-outline-evidence-"));
  const repo = new MemoryStore(dir);
  try {
    const workspace = new Workspace(repo);
    const sources = [
      workspace.upload("空白说明.md", " \n\t "),
      workspace.upload("空白规则.txt", ""),
      workspace.upload("空投诉.csv", "id,status\n"),
    ];
    for (const source of sources)
      assert.throws(
        () =>
          workspace.execute("ontology_outline", {
            title: "没有依据的定义",
            purpose: "不从空资料推断业务规则",
            concepts: [
              {
                name: "投诉",
                description: "测试概念",
                evidence: [{ sourceId: source.id, version: source.version }],
              },
            ],
            relations: [],
          }),
        /内容|记录/,
      );
    assert.deepEqual((workspace.overview() as Data).outlines, []);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
