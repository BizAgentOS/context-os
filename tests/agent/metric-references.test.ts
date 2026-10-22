import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentApplication } from "../../src/agent/app.ts";
import { createMetricSource, metricCapability } from "./metrics-fixture.ts";
import { seedFoundation } from "./program-foundation-fixture.ts";
import type { Artifact } from "../../src/agent/contracts.ts";
import { Releases } from "../../src/engine/releases.ts";
import { OntologyDatasets } from "../../src/live/ontology-datasets.ts";
import { identityWorkspace } from "./identity-fixture.ts";
import { createServer } from "../../src/agent/server.ts";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Workspace } from "../../src/agent/workspace.ts";

const ref = (a: Artifact) => ({ id: a.id, version: a.version });

test("a heating metric is attached to stable entity properties only after reviewing its actual definition", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-metric-reference-")), source = await createMetricSource();
  const app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    seedFoundation(app.memory, app.foundation, { enterprise: "澄川热力", concepts: [{ id: "station", name: "供热站", description: "运营供热站" }] });
    const property = await app.changes.propose({ operationId: "property", origin: "human", type: "property", baseline: app.changes.currentBaseline(), subject: { action: "add", property: { id: "station-name", entityTypeId: "station", name: "站点名称", valueType: "string" } } });
    const checkedProperty = await app.changes.verify({ ...ref(property.change), operationId: "property-check" });
    await app.changes.adopt({ ...ref(checkedProperty), operationId: "property-adopt" });
    const connection = await app.live.sources.connect({ name: "供热 BI", protocol: "http", url: source.url, capabilities: [metricCapability] });
    const baseline = app.changes.currentBaseline(), versionCount = app.memory.listArtifacts("workspace_version").length;
    const proposal = await app.changes.propose({ operationId: "metric", origin: "human", type: "metric_reference", baseline,
      subject: { action: "add", metric: { id: "complaint-resolution", entityTypeId: "station", sourceId: connection.id, capability: "metrics", connectionVersion: connection.version,
        dimensions: [{ dimension: "station", propertyId: "station-name" }] } } });
    assert.deepEqual(app.changes.currentBaseline(), baseline);
    assert.equal(app.memory.listArtifacts("workspace_version").length, versionCount);
    const checked = await app.changes.verify({ ...ref(proposal.change), operationId: "check" });
    assert.equal(checked.status, "verified", JSON.stringify(checked.content.verification));
    assert.equal((checked.content.verification as any).result, "review");
    assert(source.state.calls > 0, "verification actually reads the authorized BI definition");
    const preview = await app.changes.preparePreview(ref(checked));
    assert.equal((preview.impact!.after as any).definition.revision, "r1");
    assert.equal((preview.impact!.after as any).definition.aggregation.timeAdditive, false);
    await assert.rejects(app.changes.adopt({ ...ref(checked), operationId: "unreviewed" }), /确认/);
    const adoptedMetric=await app.changes.adopt({ ...ref(checked), operationId: "adopt", acknowledgeReview: true });
    assert.equal((adoptedMetric.content.verification as any).inputs.reviewedMetric.after.definition.revision,'r1','an adopted change retains the actual reviewed definition');
    const qa = await app.questionAnswering.begin({ question: "供热站有哪些指标？" });
    const directoryRead = await qa.execute("ontology_describe", { entityTypeId: "station" }) as any;
    const metric = directoryRead.result.metrics[0];
    assert.equal(metric.id, "complaint-resolution");
    assert.equal(metric.definition.id, "resolution_rate");
    assert.equal(metric.definition.grain, "month");
    assert.equal(metric.definition.timeZone, "Asia/Shanghai");
    assert.equal(metric.definition.unit, "%");
    assert.deepEqual(metric.dimensions, [{ dimension: "station", propertyId: "station-name" }]);
    assert.equal(app.memory.listArtifacts("workspace_version").length, versionCount + 1);
    assert.equal(app.live.overview().models.length, 0, "BI references do not invent object row bindings");
    const definitionSource = await app.live.sources.connect({ name: "仅定义资料", protocol: "http", url: source.url, capabilities: [{ ...metricCapability, metricAccess: "definition_only" }] });
    const only = await app.changes.propose({ operationId: "definition-only", origin: "human", type: "metric_reference", baseline: app.changes.currentBaseline(),
      subject: { action: "add", metric: { id: "definition-only", entityTypeId: "station", sourceId: definitionSource.id, capability: "metrics", connectionVersion: definitionSource.version, dimensions: [{ dimension: "station", propertyId: "station-name" }] } } });
    const onlyChecked = await app.changes.verify({ ...ref(only.change), operationId: "definition-only-check" });
    await app.changes.adopt({ ...ref(onlyChecked), operationId: "definition-only-adopt", acknowledgeReview: true });
    const onlyCalls = source.state.calls;
    const unavailable = await app.questionAnswering.begin({ question: "没有观测能力" }).execute("metric_query", { metricReferenceId: "definition-only", start: "2026-01-01", end: "2026-02-01" }) as any;
    assert.equal(unavailable.reason, "definition_only");
    assert.deepEqual(unavailable.result.items, []);
    assert.equal(source.state.calls, onlyCalls, "definition-only capability never attempts a value query");
    const removal=await app.changes.propose({operationId:'remove-only',origin:'human',type:'metric_reference',baseline:app.changes.currentBaseline(),subject:{action:'remove',metric:{id:'definition-only'}}});
    const reviewed=await app.changes.verify({...ref(removal.change),operationId:'review-removal'});
    app.changes.reject({...ref(reviewed),operationId:'reject-removal',reason:'保留原指标定义'});source.state.revision='r2';
    const frozen=(app.changes.read(reviewed.id).content.verification as any).inputs.reviewedMetric;
    assert.equal(frozen.before.definition.revision,'r1');assert.equal(frozen.after,null);
    assert.equal(source.state.calls,onlyCalls,'reviewing closed history does not fetch a newer remote definition');
  } finally { await app.close(); await source.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("program reconstruction retains independently governed metrics and semantic dimension IDs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-metric-program-")), source = await createMetricSource();
  const app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    const workspace = new Workspace(app.memory);
    workspace.upload("供热站.csv", "id,name\nS1,清河站\nS2,育新站\n");
    const first = await app.programBuilds.build({ operationId: "first-build", autoAdopt: true });
    assert.equal(first.content.outcome, "adopted", JSON.stringify(first.content));
    const model = app.live.overview().models.find(item => item.status === "adopted")!, layered = app.live.readLayered(model.id);
    const entity = layered.semantic.entityTypes[0], property = layered.semantic.properties.find(item => item.entityTypeId === entity.id && item.name === "name")!;
    const connection = await app.live.sources.connect({ name: "供热 BI", protocol: "http", url: source.url, capabilities: [metricCapability] });
    const proposed = await app.changes.propose({ operationId: "metric", origin: "human", type: "metric_reference", baseline: app.changes.currentBaseline(), subject: { action: "add", metric: {
      id: "complaint-resolution", entityTypeId: entity.id, sourceId: connection.id, capability: "metrics", connectionVersion: connection.version, dimensions: [{ dimension: "station", propertyId: property.id }],
    } } });
    const checked = await app.changes.verify({ ...ref(proposed.change), operationId: "metric-check" });
    await app.changes.adopt({ ...ref(checked), operationId: "metric-adopt", acknowledgeReview: true });
    workspace.upload("供热站.csv", "id,name,area\nS1,清河站,城北\nS2,育新站,城南\n");
    const job = await app.programBuilds.build({ operationId: "second-build", autoAdopt: true });
    assert.equal(job.content.outcome, "adopted", JSON.stringify(job.content));
    const current = app.live.overview().models.find(item => item.status === "adopted")!;
    assert.equal((current.content.layered as any).semantic.metricReferences[0].dimensions[0].propertyId, property.id);
    assert.equal((app.foundation.read().adopted!.content.metricReferences as any[])[0].definition.revision, "r1");
  } finally { await app.close(); await source.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("independent MCP reads metric coverage while denied dimensions, stop and revocation prevent further reads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-metric-mcp-")), source = await createMetricSource();
  const service = await createServer({ directory, automaticApi: false }), app = service.app;
  const client = new Client({ name: "independent-heating-agent", version: "1" });
  let releaseRead = () => {};
  try {
    await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    seedFoundation(app.memory, app.foundation, { enterprise: "澄川热力", concepts: [{ id: "station", name: "供热站", description: "运营供热站" }] });
    const adopt = async (type: string, subject: unknown, operationId: string) => {
      const proposal = await app.changes.propose({ operationId, origin: "human", type, baseline: app.changes.currentBaseline(), subject });
      const checked = await app.changes.verify({ ...ref(proposal.change), operationId: operationId + ":check" });
      assert.equal(checked.status, "verified", JSON.stringify(checked.content.verification));
      return app.changes.adopt({ ...ref(checked), operationId: operationId + ":adopt", acknowledgeReview: true });
    };
    await adopt("property", { action: "add", property: { id: "station-name", entityTypeId: "station", name: "站点名称", valueType: "string" } }, "property");
    const connection = await app.live.sources.connect({ name: "供热 BI", protocol: "http", url: source.url, capabilities: [{ ...metricCapability, metricAccess: "historical_observations" }] });
    await adopt("metric_reference", { action: "add", metric: { id: "complaint-resolution", entityTypeId: "station", sourceId: connection.id, capability: "metrics", connectionVersion: connection.version,
      dimensions: [{ dimension: "station", propertyId: "station-name" }] } }, "metric");
    const releases = new Releases(app.memory, app.live), check = await releases.check({ inputHash: releases.overview().working.inputHash });
    const published = releases.publish({ operationId: "publish", checkRef: ref(check), name: "供热指标" }).release;
    const connected = releases.connect({ operationId: "connect", name: "统计助手", releaseRef: ref(published), conceptIds: ["station"], relationIds: [], metricIds: ["complaint-resolution"] });
    const configuration = new OntologyDatasets(app.memory, app.live).connection(ref(connected.dataset), origin);
    const config = Object.values(configuration.mcp.mcpServers)[0];
    await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: { ...config.env, CONTEXT_OS_CONSUMER_KEY: connected.key! }, stderr: "pipe" }));
    assert((await client.listTools()).tools.some(tool => tool.name === "query_metric"));
    const input = { metricReferenceId: "complaint-resolution", start: "2026-01-01", end: "2026-02-01" };
    const actual = await client.callTool({ name: "query_metric", arguments: input });
    assert.equal(actual.isError, undefined, JSON.stringify(actual));
    const data = actual.structuredContent as any;
    assert.deepEqual(data.items.map((item: any) => item.value), [80, null]);
    assert.equal(data.items[1].status, "missing");
    assert.equal(data.status, "partial");
    assert.equal(data.metricReference.access, "historical_observations");
    const before = source.state.calls;
    const denied = await fetch(origin + "/v4/metrics?" + new URLSearchParams({ query: JSON.stringify({ ...input, where: { hidden: "秘密" } }) }), { headers: { authorization: "Bearer " + connected.key } });
    assert.equal(denied.status, 403);
    assert.equal(source.state.calls, before);
    let running = true;
    const qa = app.questionAnswering.begin({ question: "可停止指标读取", assertActive: () => { if (!running) throw new Error("已停止"); } });
    source.state.delay = new Promise<void>(resolve => { releaseRead = resolve; });
    const pending = qa.execute("metric_query", input);
    const stopped = assert.rejects(pending, /停止/);
    while (source.state.calls === before) await new Promise(resolve => setImmediate(resolve));
    running = false; releaseRead(); await stopped;
    assert.equal(source.state.calls, before + 1, "stop after describe prevents the observation request");
    source.state.delay = undefined;
    app.live.sources.disable(connection.id, connection.version);
    assert.throws(() => app.questionAnswering.begin({ question: "权限已撤销" }), /变化|停用|来源/);
    assert.equal((await client.callTool({ name: "describe_dataset", arguments: {} })).isError, true, "revoked metric sources cannot continue exposing their catalog");
    assert.equal((await client.callTool({ name: "query_metric", arguments: input })).isError, true);
  } finally { releaseRead(); await client.close(); await service.close(); await source.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("metric references and their unbound dimensions survive model rebuilding and historical restore", async () => {
  const w = await identityWorkspace(), source = await createMetricSource();
  const app = w.service.app;
  try {
    await w.adopt("property", { action: "add", property: { id: "metric-station", entityTypeId: "person", name: "负责供热站", valueType: "string" } });
    const connection = await app.live.sources.connect({ name: "供热 BI", protocol: "http", url: source.url, capabilities: [metricCapability] });
    await w.adopt("metric_reference", { action: "add", metric: { id: "complaint-resolution", entityTypeId: "person", sourceId: connection.id, capability: "metrics", connectionVersion: connection.version,
      dimensions: [{ dimension: "station", propertyId: "metric-station" }] } });
    const historical = app.memory.listArtifacts("workspace_version")[0];
    const before = app.live.overview().models.find(item => item.status === "adopted")!;
    const candidate = await app.live.propose({ purpose: "等价重建", rationale: "只重建执行绑定，指标语义必须保留", foundationRef: before.content.foundationRef, baseModelRef: ref(before), types: before.content.types, relations: before.content.relations });
    const rebuilt = await app.live.adopt(candidate.id, candidate.version);
    assert.equal((rebuilt.content.layered as any).semantic.metricReferences[0].definition.revision, "r1");
    assert((rebuilt.content.layered as any).semantic.properties.some((item: any) => item.id === "metric-station"));
    const removal = await w.call("/api/changes/propose", { operationId: "remove-dimension", origin: "human", type: "property", baseline: app.changes.currentBaseline(), subject: { action: "remove", property: { id: "metric-station" } } });
    const rejected = await w.call("/api/changes/verify", { operationId: "remove-check", ...ref(removal.body.change) });
    assert.equal(rejected.body.change.status, "failed", "a referenced semantic dimension cannot silently disappear");
    await w.adopt("metric_reference", { action: "remove", metric: { id: "complaint-resolution" } });
    await w.adopt("restore", { workspaceVersionRef: ref(historical) });
    const restored = app.questionAnswering.begin({ question: "恢复后的指标" });
    const read = await restored.execute("ontology_describe", { entityTypeId: "person" }) as any;
    assert.equal(read.result.metrics[0].definition.revision, "r1");
    assert.equal(read.result.metrics[0].dimensions[0].propertyId, "metric-station");
  } finally { await w.close(); await source.close(); }
});

test("published metrics require an explicit grant and keep their definition when the source changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-metric-release-")), source = await createMetricSource();
  const app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    seedFoundation(app.memory, app.foundation, { enterprise: "澄川热力", concepts: [{ id: "station", name: "供热站", description: "运营供热站" }] });
    const adopt = async (type: string, subject: unknown, operationId: string) => {
      const proposed = await app.changes.propose({ operationId, origin: "human", type, baseline: app.changes.currentBaseline(), subject });
      const checked = await app.changes.verify({ ...ref(proposed.change), operationId: operationId + ":check" });
      assert.equal(checked.status, "verified", JSON.stringify(checked.content.verification));
      return app.changes.adopt({ ...ref(checked), operationId: operationId + ":adopt", acknowledgeReview: true });
    };
    await adopt("property", { action: "add", property: { id: "station-name", entityTypeId: "station", name: "站点名称", valueType: "string" } }, "property");
    const connection = await app.live.sources.connect({ name: "供热 BI", protocol: "http", url: source.url, capabilities: [metricCapability] });
    const metric = { id: "complaint-resolution", entityTypeId: "station", sourceId: connection.id, capability: "metrics", connectionVersion: connection.version,
      dimensions: [{ dimension: "station", propertyId: "station-name" }] };
    await adopt("metric_reference", { action: "add", metric }, "metric");
    const releases = new Releases(app.memory, app.live), datasets = new OntologyDatasets(app.memory, app.live);
    const check = await releases.check({ inputHash: releases.overview().working.inputHash });
    assert.equal(check.status, "ready", JSON.stringify(check.content.issues));
    const release = releases.publish({ operationId: "release", checkRef: ref(check), name: "一月口径" }).release;
    assert.equal((release.content.definition as any).metricReferences[0].definition.revision, "r1");
    const basic = { releaseRef: ref(release), conceptIds: ["station"], relationIds: [] };
    const old = releases.connect({ ...basic, operationId: "no-metrics", name: "仅概念" });
    const granted = releases.connect({ ...basic, operationId: "with-metrics", name: "供热统计", metricIds: ["complaint-resolution"] });
    const input = { metricReferenceId: "complaint-resolution", start: "2026-01-01", end: "2026-02-01", where: { "station-name": "清河站" } };
    const params = new URLSearchParams({ query: JSON.stringify(input) }), calls = source.state.calls;
    assert.equal((await datasets.handle("/v4/metrics", params, `Bearer ${old.key}`)).status, 403);
    assert.equal(source.state.calls, calls, "a missing metric grant is rejected before any BI read");
    const read = await datasets.handle("/v4/metrics", params, `Bearer ${granted.key}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal((read.body.items as any[])[0].value, 80);
    assert.equal(JSON.stringify(read.body).includes(connection.id), false);
    assert.equal((await datasets.handle("/v4/objects", new URLSearchParams({ type: "供热站" }), `Bearer ${granted.key}`)).status, 403, "metric access does not grant object rows");
    const qa = app.questionAnswering.begin({ question: "统计", dataView: { kind: "consumer", releaseRef: ref(release), connectionRef: ref(granted.connection) } });
    const described = await qa.execute("ontology_describe", { entityTypeId: "station" }) as any;
    assert.equal(described.result.metrics[0].definition.revision, "r1");
    assert.equal(described.result.entities[0].properties[0].id, "station-name");
    source.state.revision = "r2";
    const stale = await datasets.handle("/v4/metrics", params, `Bearer ${granted.key}`);
    assert.equal(stale.body.status, "unavailable");
    assert.equal((stale.body.definition as any).revision, "r1");
    const invalid = await releases.check({ inputHash: releases.overview().working.inputHash });
    assert.equal(invalid.status, "blocked", "a new release cannot endorse a definition the source has replaced");
    await adopt("metric_reference", { action: "update", metric }, "metric-update");
    assert(releases.overview().working.objectDiff.some(item => item.kind === "metric_reference" && item.id === metric.id));
    assert.equal((await qa.execute("metric_query", input) as any).result.definition.revision, "r1");
    const secondCheck = await releases.check({ inputHash: releases.overview().working.inputHash });
    const second = releases.publish({ operationId: "release-2", checkRef: ref(secondCheck), name: "二月口径" }).release;
    const upgraded = releases.upgrade({ operationId: "upgrade", connectionRef: ref(granted.connection), releaseRef: ref(second) });
    const updatedRead = await datasets.handle("/v4/metrics", params, `Bearer ${upgraded.key}`);
    assert.equal(updatedRead.status, 200, JSON.stringify(updatedRead.body));
    assert.equal((updatedRead.body.definition as any).revision, "r2");
    await adopt("property", { action: "add", property: { id: "station-code", entityTypeId: "station", name: "外部站点编号", valueType: "string" } }, "property-code");
    await adopt("metric_reference", { action: "update", metric: { ...metric, dimensions: [{ dimension: "station", propertyId: "station-code" }] } }, "dimension-update");
    const thirdCheck = await releases.check({ inputHash: releases.overview().working.inputHash });
    const third = releases.publish({ operationId: "release-3", checkRef: ref(thirdCheck), name: "新维度对应" }).release;
    assert.throws(() => releases.upgrade({ operationId: "upgrade-dimension", connectionRef: ref(upgraded.connection), releaseRef: ref(third) }), /维度|重新选择|指标/);
    assert.equal((await datasets.handle("/v4/metrics", params, `Bearer ${upgraded.key}`)).status, 200, "rejected scope expansion leaves the prior key intact");
  } finally { await app.close(); await source.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("heating QA reads actual metric observations by semantic dimension and cannot silently use a changed definition", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-os-metric-qa-")), source = await createMetricSource();
  const app = new AgentApplication(directory, undefined, new Set(), false);
  try {
    seedFoundation(app.memory, app.foundation, { enterprise: "澄川热力", concepts: [{ id: "station", name: "供热站", description: "运营供热站" }] });
    const adopt = async (type: string, subject: unknown, operationId: string) => {
      const proposed = await app.changes.propose({ operationId, origin: "human", type, baseline: app.changes.currentBaseline(), subject });
      const checked = await app.changes.verify({ ...ref(proposed.change), operationId: operationId + ":check" });
      assert.equal(checked.status, "verified", JSON.stringify(checked.content.verification));
      return app.changes.adopt({ ...ref(checked), operationId: operationId + ":adopt", acknowledgeReview: true });
    };
    await adopt("property", { action: "add", property: { id: "station-name", entityTypeId: "station", name: "站点名称", valueType: "string" } }, "property");
    const connection = await app.live.sources.connect({ name: "供热 BI", protocol: "http", url: source.url, capabilities: [metricCapability] });
    await adopt("metric_reference", { action: "add", metric: { id: "complaint-resolution", entityTypeId: "station", sourceId: connection.id, capability: "metrics", connectionVersion: connection.version,
      dimensions: [{ dimension: "station", propertyId: "station-name" }] } }, "metric");
    const run = app.questionAnswering.begin({ question: "清河站一月份投诉办结率是多少？" });
    const input = { metricReferenceId: "complaint-resolution", start: "2026-01-01", end: "2026-02-01", where: { "station-name": "清河站" } };
    const read = await run.execute("metric_query", input) as any;
    assert.equal(read.result.items[0].value, 80);
    assert.deepEqual(read.result.items[0].dimensions, { "station-name": "清河站" });
    assert.equal(read.result.definition.revision, "r1");
    assert.equal(read.result.definition.aggregation.kind, "ratio");
    assert.equal(read.result.definition.timeZone, "Asia/Shanghai");
    assert.equal(read.result.historicalRecalculation, false);
    const answer = run.answer("清河站一月份投诉办结率为80%，该比率不能直接加总。") as any;
    assert.equal(answer.evidence[0].readId, read.readId);
    assert.equal(answer.evidence[0].result.items[0].value, 80);
    assert.equal(answer.evidence[0].labels["station-name"], "站点名称");
    assert.equal(JSON.stringify(answer).includes(connection.id), false, "QA receipts do not disclose raw source identities");
    const calls = source.state.calls;
    await assert.rejects(run.execute("metric_query", { ...input, where: { hidden: "育新站" } }), /维度|属性|范围/);
    assert.equal(source.state.calls, calls);
    source.state.revision = "r2";
    const changed = await run.execute("metric_query", input) as any;
    assert.equal(changed.status, "unavailable");
    assert.match(changed.message, /口径|定义/);
    assert.equal(changed.result.items.length, 0);
    assert.equal(changed.result.definition.revision, "r1", "the frozen semantic definition does not follow the remote source");
  } finally { await app.close(); await source.close(); rmSync(directory, { recursive: true, force: true }); }
});
