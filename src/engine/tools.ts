import type { DomainTool } from "../agent/contracts.ts";
import type { ProgramBuilds } from "./program-builds.ts";
import type { Data } from "../agent/contracts.ts";
import type { Releases } from "./releases.ts";

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

const empty = { type: "object", properties: {}, additionalProperties: false };
export const engineTools: DomainTool[] = [
  { name: "engine_overview", description: "查看程序构建任务、来源字段、候选、问题与实际存取策略。先检查现有结果，不重复用模型推导已有结构。", mutates: false, inputSchema: empty },
  { name: "engine_build", description: "按用户要求重新读取已授权结构化来源并生成本体候选；不调用模型构建、不自动采用或发布。保留已存在的人工修订。operationId 在相同操作重试时保持不变。", mutates: true,
    inputSchema: { type: "object", properties: { operationId: { type: "string" }, sourceIds: { type: "array", items: { type: "string" } }, expectedFoundationVersion: { type: "integer", minimum: 0 } }, required: ["operationId"], additionalProperties: false } },
  { name: "engine_check", description: "重新检查指定程序候选及当前来源，返回真实问题；检查通过不表示业务含义已核实。用户在本体页采用。", mutates: true,
    inputSchema: { type: "object", properties: { id: { type: "string" }, version: { type: "integer", minimum: 1 } }, required: ["id", "version"], additionalProperties: false } },
  { name: "release_overview", description: "查看工作版本差异、发布检查、历史发布与接入状态。不签发密钥，不发布、不升级接入；这些操作由第三页明确操作。", mutates: false, inputSchema: empty },
];
