/** Isolated FEATURE_040 migration acceptance. Reads real snapshots; never opens a real workspace database. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MemoryStore } from "../../src/agent/memory.ts";
import type { Artifact, Data } from "../../src/agent/contracts.ts";
import { Snapshots } from "../../src/data/snapshots.ts";
import { LiveMemory, pinKey, type SnapshotPins } from "../../src/live/memory.ts";
import { ConsumerViews } from "../../src/live/consumer-views.ts";
import { migrateLegacyModel, projectLegacyModel, type LegacyModel } from "../../src/semantic/model.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE = "f446b3b";
const temporary = mkdtempSync(join(tmpdir(), "ade-layered-migration-"));
const keep = process.argv.includes("--keep");
const selected = process.argv.find(argument => argument.startsWith("--workspace="))?.slice("--workspace=".length);
const targets = [
  { label: "starbridge", directory: "local-state/starbridge-video-2026-10-16" },
  { label: "heating", directory: "local-state/live-heating" },
  { label: "investment", directory: "local-state/investment-mock" },
].filter(target => !selected || target.label === selected);
if (!targets.length) throw new Error("未知验收工作区");
type Report = { label: string; models: Data[]; existingConsumers: Data[]; releases: number; limitation?: string };
type Contents = LegacyModel & { connections: Record<string, number> };
type Capture = { objects: Record<string, Data[]>; relations: Array<{ name: string; from: string; id: string; items?: Data[]; error?: string }>; total: number; relationTypes: number };

// Load the exact pre-FEATURE_040 execution service, with its old fusion implementation.
// Stable dependencies keep their real source paths; no source or credential text enters the report.
function historicalModule(relative: string) {
  const source = execFileSync("git", ["show", `${BASELINE}:${relative}`], { cwd: ROOT, encoding: "utf8" });
  const rewritten = source.replace(/from\s+(["'])([^"']+)\1/g, (match, quote: string, specifier: string) => {
    if (!specifier.startsWith(".")) return specifier.startsWith("node:") ? match : `from ${quote}${import.meta.resolve(specifier)}${quote}`;
    const target = relative === "src/live/memory.ts" && specifier === "./fusion.ts"
      ? join(temporary, "baseline-fusion.ts") : resolve(ROOT, dirname(relative), specifier);
    return `from ${quote}${pathToFileURL(target).href}${quote}`;
  });
  const output = join(temporary, relative.endsWith("fusion.ts") ? "baseline-fusion.ts" : "baseline-memory.ts");
  writeFileSync(output, rewritten);
  return output;
}
function fingerprintFiles(directory: string) {
  return ["memory.sqlite", "memory.sqlite-wal", "memory.sqlite-shm"].flatMap(file => {
    const path = join(directory, file);
    if (!existsSync(path)) return [];
    const value = statSync(path);
    return [{ file, size: value.size, mtimeMs: value.mtimeMs }];
  });
}
function pinsFor(model: Artifact, snapshots: Snapshots): SnapshotPins {
  const content = model.content as unknown as Contents;
  const bindings = content.types.flatMap(type => [type, ...(type.supplements ?? [])]);
  const pins: SnapshotPins = {};
  for (const binding of bindings) {
    const dataset = snapshots.bindingDataset(binding.sourceId, binding.capability);
    if (!dataset?.content.activeVersion) throw new Error("来源没有已采用快照；本验收不向真实来源发起请求");
    pins[pinKey(binding.sourceId, binding.capability)] = String(dataset.content.activeVersion);
  }
  return pins;
}
async function allPages(live: LiveMemory, model: Artifact, pins: SnapshotPins, input: Data): Promise<Data[]> {
  const result: Data[] = [], pageSize = 20;
  for (let offset = 0; offset < 10000; offset += pageSize) {
    const page = await live.query({ modelId: model.id, modelVersion: model.version, ...input, offset, limit: pageSize }, () => {}, true, undefined, true, pins);
    result.push(...page.items);
    if (page.coverage.complete || page.coverage.total !== null && offset + page.items.length >= page.coverage.total) return result;
    if (page.items.length < pageSize) throw new Error("快照读取覆盖不完整，不能验收为全部对象");
  }
  throw new Error("验收对象超过明确的10000行读取预算");
}
async function capture(live: LiveMemory, model: Artifact, pins: SnapshotPins): Promise<Capture> {
  const content = model.content as unknown as Contents;
  const objects: Record<string, Data[]> = {};
  for (const type of content.types) objects[type.name] = await allPages(live, model, pins, { type: type.name });
  const relations: Capture["relations"] = [];
  for (const relation of content.relations) for (const object of objects[relation.from]) {
    const id = String(object.$id);
    try {
      relations.push({ name: relation.name, from: relation.from, id, items: await allPages(live, model, pins, { type: relation.from, id, relation: relation.name }) });
    } catch (error) {
      // Missing keys already fail in the old service. Preserve and compare that outcome as well as successful reads.
      relations.push({ name: relation.name, from: relation.from, id, error: (error as Error).message });
    }
  }
  return { objects, relations, total: Object.values(objects).reduce((sum, values) => sum + values.length, 0), relationTypes: content.relations.length };
}
async function existingConsumers(memory: MemoryStore, live: LiveMemory): Promise<Array<{ id: string; version: number; status: number; body: Data }>> {
  const views = new ConsumerViews(memory, live), results = [];
  for (const view of memory.listArtifacts("consumer_view").filter(view => view.status === "active")) {
    const grants = view.content.grants as Array<{ type: string }>;
    if (!grants?.length) continue;
    const params = new URLSearchParams({ type: grants[0].type, limit: "20" });
    const read = await views.readLinkedView({ id: view.id, version: view.version }, "/v3/objects", params, () => {});
    // Ephemeral evidence references and access counters are excluded; values and permission outcomes are compared.
    results.push({ id: view.id, version: view.version, status: read.status, body: { items: read.body.items ?? [], error: read.body.error ?? null } });
  }
  return results;
}
function persistMigration(memory: MemoryStore, live: LiveMemory, model: Artifact) {
  const originalContent = structuredClone(model.content);
  const content = model.content as unknown as Contents;
  const options = { capability: (sourceId: string, capability: string) => live.sources.pinnedCapability(sourceId, capability, content.connections[sourceId]).cap };
  const layered = migrateLegacyModel(content, options);
  const wording = structuredClone(content);
  for (const type of wording.types) type.description += "（隔离措辞验收）";
  const reworded = migrateLegacyModel(wording, options);
  assert.deepEqual(reworded.bindings, layered.bindings, "措辞变化影响了绑定");
  assert.deepEqual(reworded.semantic.properties.map(property => property.id), layered.semantic.properties.map(property => property.id));
  // New canonical model identity leaves every original published model reference intact.
  const migrated = memory.putArtifact({ kind: "live_ontology", title: model.title, status: model.status,
    content: JSON.parse(JSON.stringify({ ...content, ...projectLegacyModel(layered, { allowTransforms: true }), layered, migratedFrom: { id: model.id, version: model.version } })) });
  assert.deepEqual(memory.getArtifact(model.id, model.version).content, originalContent, "原版本被改写");
  return { layered, migrated };
}

let failed = false;
const reports: Report[] = [];
try {
  historicalModule("src/live/fusion.ts");
  const historicalPath = historicalModule("src/live/memory.ts");
  const LegacyLiveMemory = (await import(pathToFileURL(historicalPath).href)).LiveMemory as typeof LiveMemory;
  for (const target of targets) {
    const original = resolve(ROOT, target.directory);
    const sourceFingerprint = fingerprintFiles(original);
    const copied = join(temporary, target.label);
    cpSync(original, copied, { recursive: true, filter: path => !["credentials", "runtime", "source-credentials.json", "admin-token"].includes(basename(path)) });
    const memory = new MemoryStore(copied);
    const oldLive = new LegacyLiveMemory(copied, memory);
    let oldSnapshots = new Snapshots(memory, oldLive, copied);
    const report: Report = { label: target.label, models: [], releases: memory.listArtifacts("data_release").length, existingConsumers: [] };
    try {
      const models = memory.listArtifacts("live_ontology");
      const baselines = new Map<string, { model: Artifact; pins: SnapshotPins; before: Capture }>();
      const priorConsumers = await existingConsumers(memory, oldLive);
      for (const model of models) {
        try {
          const pins = pinsFor(model, oldSnapshots);
          baselines.set(model.id, { model, pins, before: await capture(oldLive, model, pins) });
        } catch (error) {
          const { layered } = persistMigration(memory, oldLive, model);
          report.models.push({ version: model.version, status: "definition_migrated_queries_unavailable", reason: (error as Error).message,
            entityTypes: layered.semantic.entityTypes.length, properties: layered.semantic.properties.length, relationTypes: layered.semantic.relationTypes.length,
            stableIds: true, bindingsUnaffectedByWording: true, originalVersionUnchanged: true });
        }
      }
      await oldSnapshots.close();
      const live = new LiveMemory(copied, memory);
      oldSnapshots = new Snapshots(memory, live, copied);
      for (const { model, pins, before } of baselines.values()) {
        const { layered, migrated } = persistMigration(memory, oldLive, model);
        const after = await capture(live, migrated, pins);
        assert.deepEqual(after, before, "迁移前后业务对象或关系查询不同");
        const oldModelAfter = await capture(live, model, pins);
        assert.deepEqual(oldModelAfter, before, "迁移影响了原模型读取");
        report.models.push({ version: model.version, status: "passed", objects: after.total, entityTypes: layered.semantic.entityTypes.length,
          properties: layered.semantic.properties.length, relationTypes: after.relationTypes, relationQueries: after.relations.length,
          unchangedRelationErrors: after.relations.filter(relation => relation.error).length,
          stableIds: true, bindingsUnaffectedByWording: true, originalVersionUnchanged: true });
      }
      const afterConsumers = await existingConsumers(memory, live);
      assert.deepEqual(afterConsumers, priorConsumers, "迁移影响了已有消费视图读取");
      report.existingConsumers = afterConsumers.map(item => ({ status: item.status, unchanged: true }));
      if (!report.releases && !report.existingConsumers.length) report.limitation = "副本没有已发布版本或消费视图；历史接入合同由独立快照/发布回归验证，本记录未创造历史接入";
      if (!models.length) report.limitation = "该工作区没有执行模型";
    } finally {
      await oldSnapshots.close();
      memory.close();
      assert.deepEqual(fingerprintFiles(original), sourceFingerprint, "真实工作区数据库文件发生变化");
    }
    reports.push(report);
  }
  const starbridge = reports.find(report => report.label === "starbridge");
  if (starbridge) assert.ok(starbridge.models.some(model => model.status === "passed" && model.objects === 58 && model.relationTypes === 8), "星桥58对象/8关系验收未完成");
  const investment = reports.find(report => report.label === "investment");
  if (investment) assert.ok(investment.models.some(model => model.status === "passed"), "投研隔离迁移未完成");
  console.log(JSON.stringify({ status: "passed_with_reported_limits", baseline: BASELINE, isolated: true, realWorkspaceFilesUnchanged: true, reports, ...(keep ? { directory: temporary } : {}) }, null, 2));
} catch (error) {
  failed = true;
  console.error(JSON.stringify({ status: "failed", isolated: true, error: (error as Error).message, reports, ...(keep ? { directory: temporary } : {}) }, null, 2));
} finally {
  if (!keep) rmSync(temporary, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}
