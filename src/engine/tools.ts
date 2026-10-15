import type { DomainTool } from "../agent/contracts.ts";
import type { ProgramBuilds } from "./program-builds.ts";
import type { Data } from "../agent/contracts.ts";
import type { Releases } from "./releases.ts";
import type { MemoryStore } from "../agent/memory.ts";
import type { LiveMemory } from "../live/memory.ts";
import type { DatasetContent, Snapshots } from "../data/snapshots.ts";
import { quote } from "../data/executor/engine.ts";
import { validateDefinition } from "./validation.ts";
import type { SuggestedOntology } from "./helix-discovery.ts";
import { z } from "zod";

/** Agent discovery stays bounded; detailed definitions are read by artifact ref. */
export function engineOverviewForAgent(builds: ProgramBuilds) {
  const state = builds.overview();
  const candidate = state.candidate;
  const checks = candidate?.content.checks as Data | undefined;
  return {
    jobs: state.jobs.slice(0, 8).map(({ id, version, title, status, content }) => ({ id, version, title, status,
      content: { outcome: content.outcome, steps: content.steps, candidateRef: content.candidateRef, issues: (content.issues as unknown[]).slice(0, 12) } })),
    datasets: state.datasets.slice(0, 40).map(({ id, version, title, status, content }) => ({ id, version, title, status,
      content: { sourceId: content.sourceId, capability: content.capability, fieldCount: (content.fields as unknown[]).length,
        idField: content.idField, sampleCount: content.sampleCount, complete: content.complete, readAt: content.readAt, strategy: content.strategy } })),
    candidate: candidate ? { id: candidate.id, version: candidate.version, status: candidate.status,
      checks: checks ? { valid: checks.valid, checkedAt: checks.checkedAt, description: checks.description } : null,
      diff: candidate.content.diff, issues: (candidate.content.issues as unknown[]).slice(0, 12) } : null,
    coverage: { jobsShown: Math.min(state.jobs.length, 8), jobsTotal: state.jobs.length, datasetsShown: Math.min(state.datasets.length, 40), datasetsTotal: state.datasets.length },
    strategies: state.strategies,
    instructions: "按需要用 memory_read 读取指定成果引用；用 live_read 读取真实当前来源。目录不包含全部记录或历史任务。",
  };
}

export function releaseOverviewForAgent(releases: Releases) {
  const state = releases.overview();
  const summary = ({ id, version, title, status }: { id: string; version: number; title: string; status: string }) => ({ id, version, title, status });
  return {
    working: { inputHash: state.working.inputHash, foundationRef: state.working.foundationRef, modelRef: state.working.modelRef,
      summary: state.working.summary, pending: state.working.pending.slice(0, 20), issues: state.working.issues.slice(0, 20),
      diff: state.working.diff.slice(0, 40), diffTotal: state.working.diff.length },
    currentRelease: state.currentRelease ? summary(state.currentRelease) : null,
    latestCheck: state.latestCheck ? { ...summary(state.latestCheck), checkedAt: state.latestCheck.content.checkedAt,
      checkScope: state.latestCheck.content.checkScope, issues: (state.latestCheck.content.issues as unknown[]).slice(0, 20) } : null,
    releases: state.releases.slice(0, 20).map(summary),
    connections: state.connections.slice(0, 20).map(a => ({ ...summary(a), effectiveStatus: a.effectiveStatus, releaseRef: a.content.releaseRef })),
    coverage: { releasesTotal: state.releases.length, connectionsTotal: state.connections.length },
    instructions: "目录最多显示20个发布/接入与40项差异；按需要用 memory_read 读取具体发布成果，管理决定在发布页执行。",
  };
}

/** Datasets, versions, pending schema changes and recent syncs, without row content. */
export function dataOverviewForAgent(snapshots: Snapshots) {
  const state = snapshots.overview();
  return {
    datasets: state.datasets.slice(0, 40).map(d => {
      const c = d.content as unknown as DatasetContent;
      return { id: d.id, version: d.version, name: c.name, table: snapshots.table(d.id), sourceId: c.sourceId, capability: c.capability, materialization: c.materialization,
        activeVersion: c.activeVersion, pendingVersion: c.pendingVersion, versions: c.versions.length, coverage: c.coverage, lastSync: c.lastSync,
        columns: (c.profile?.columns ?? []).slice(0, 60).map(col => ({ name: col.name, type: col.type, nulls: col.nulls, distinct: col.distinct, primaryKey: col.primaryKey })) };
    }),
    jobs: state.jobs.slice(0, 5).map(j => ({ id: j.id, status: j.status, outcome: j.content.outcome, issues: (j.content.issues as unknown[]).slice(0, 12) })),
    coverage: { datasetsShown: Math.min(state.datasets.length, 40), datasetsTotal: state.datasets.length },
    instructions: "快照是同步时的不可变数据版本。用 snapshot_query 在表名 table 上做只读统计核对；结构变化待用户在数据页确认。",
  };
}

const queryInput = z.object({ datasetIds: z.array(z.string()).min(1).max(8), sql: z.string().min(1).max(8000), limit: z.number().int().min(1).max(200).default(50) }).strict();
/** One read-only SELECT over active snapshots; the executor rejects writes, multiple statements and file access. */
export async function snapshotQueryForAgent(snapshots: Snapshots, args: unknown) {
  const input = queryInput.parse(args);
  const result = await snapshots.query(input.datasetIds, input.sql, { limit: input.limit });
  return { rows: result.rows, totalRows: result.profile.rows, columns: result.profile.columns.map(c => ({ name: c.name, type: c.type })), inputs: result.inputs,
    truncated: result.profile.rows > result.rows.length };
}

const explainInput = z.object({ entityId: z.string().optional(), linkId: z.string().optional() }).strict().refine(v => !!v.entityId !== !!v.linkId, "请指定 entityId 或 linkId 之一");
/** Why the current program candidate merged or linked something, with up to five unmatched rows. */
export async function discoveryExplainForAgent(builds: ProgramBuilds, snapshots: Snapshots, args: unknown) {
  const input = explainInput.parse(args), candidate = builds.overview().candidate;
  const discovery = candidate?.content.discovery as unknown as SuggestedOntology | undefined;
  if (!discovery) throw new Error("当前没有基于快照的程序候选；请先构建");
  if (input.entityId) {
    const entity = discovery.entities.find(e => e.id === input.entityId);
    if (!entity) throw new Error("候选中没有该实体");
    return { entity, notes: discovery.notes.filter(n => n.entities?.includes(entity.id)) };
  }
  const link = discovery.links.find(l => l.id === input.linkId);
  if (!link) throw new Error("候选中没有该关联");
  const from = snapshots.table(link.fromDatasetId), to = snapshots.table(link.toDatasetId), cast = (a: string, c: string) => `CAST(${a}.${quote(c)} AS VARCHAR)`;
  const unmatched = link.matchedRows < link.totalRows ? (await snapshots.query([link.fromDatasetId, link.toDatasetId],
    `SELECT a.* FROM ${from} a WHERE a.${quote(link.fromColumn)} IS NOT NULL AND ${cast("a", link.fromColumn)} NOT IN (SELECT ${cast("b", link.toColumn)} FROM ${to} b WHERE b.${quote(link.toColumn)} IS NOT NULL)`, { limit: 5 })).rows : [];
  return { link, notes: discovery.notes.filter(n => n.links?.includes(link.id)), unmatchedSample: unmatched };
}

const checkInput = z.object({ id: z.string(), version: z.number().int().positive() }).strict();
/** Full-snapshot checks of a saved mapping (a program candidate or a proposed live_ontology). */
export async function ontologySnapshotCheckForAgent(memory: MemoryStore, live: LiveMemory, snapshots: Snapshots, args: unknown) {
  const input = checkInput.parse(args), artifact = memory.getArtifact(input.id, input.version);
  if (!["engine_candidate", "live_ontology"].includes(artifact.kind)) throw new Error("只能检查程序候选或执行映射成果");
  const c = artifact.content;
  const report = await validateDefinition(snapshots, live, { types: c.types as Data[], relations: (artifact.kind === "engine_candidate" ? c.modelRelations : c.relations) as Data[] },
    (artifact.kind === "engine_candidate" ? (c.bundle as Data | undefined)?.pipelines ?? [] : []) as never);
  return { ref: { id: artifact.id, version: artifact.version }, ...report, instructions: "检查只读取快照，不保存或采用成果；未通过项需修订后再由用户采用。" };
}

const empty = { type: "object", properties: {}, additionalProperties: false };
export const engineTools: DomainTool[] = [
  { name: "engine_overview", description: "查看程序构建任务、来源字段、候选、问题与实际存取策略。先检查现有结果，不重复用模型推导已有结构。", mutates: false, inputSchema: empty },
  { name: "engine_build", description: "按用户要求重新读取已授权结构化来源并生成本体候选；不调用模型构建、不自动采用或发布。保留已存在的人工修订。operationId 在相同操作重试时保持不变。", mutates: true,
    inputSchema: { type: "object", properties: { operationId: { type: "string" }, sourceIds: { type: "array", items: { type: "string" } }, expectedFoundationVersion: { type: "integer", minimum: 0 } }, required: ["operationId"], additionalProperties: false } },
  { name: "engine_check", description: "重新检查指定程序候选及当前来源，返回真实问题；检查通过不表示业务含义已核实。用户在本体页采用。", mutates: true,
    inputSchema: { type: "object", properties: { id: { type: "string" }, version: { type: "integer", minimum: 1 } }, required: ["id", "version"], additionalProperties: false } },
  { name: "data_overview", description: "查看已同步的数据集、快照版本、字段画像、待确认结构变化与最近同步。不含记录内容。", mutates: false, inputSchema: empty },
  { name: "data_sync", description: "按用户要求把已授权结构化来源同步为新快照；内容不变不新增版本，结构变化待用户确认。不构建或采用本体。operationId 在相同操作重试时保持不变。", mutates: true,
    inputSchema: { type: "object", properties: { operationId: { type: "string" }, sourceIds: { type: "array", items: { type: "string" } } }, required: ["operationId"], additionalProperties: false } },
  { name: "snapshot_query", description: "在快照上执行一条只读 SELECT 做统计核对（重复、空值、匹配率等）。表名用 data_overview 返回的 table，或带引号的数据集名称；最多返回 200 行。", mutates: false,
    inputSchema: { type: "object", properties: { datasetIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 }, sql: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, required: ["datasetIds", "sql"], additionalProperties: false } },
  { name: "discovery_explain", description: "解释当前程序候选为何合并某实体（entityId）或建立某关联（linkId），返回匹配数、依据类型、说明与最多 5 条未匹配记录。", mutates: false,
    inputSchema: { type: "object", properties: { entityId: { type: "string" }, linkId: { type: "string" } }, additionalProperties: false } },
  { name: "ontology_snapshot_check", description: "在全量快照上检查指定程序候选或执行映射（id/version）：身份唯一、字段存在、附来源与关系匹配率、合并结果每对象一行。修订后用它复验；不保存、不采用。", mutates: false,
    inputSchema: { type: "object", properties: { id: { type: "string" }, version: { type: "integer", minimum: 1 } }, required: ["id", "version"], additionalProperties: false } },
  { name: "release_overview", description: "查看工作版本差异、发布检查、历史发布与接入状态。不签发密钥，不发布、不升级接入；这些操作由第三页明确操作。", mutates: false, inputSchema: empty },
];
