import { z } from 'zod';
import type { Artifact, Data } from '../agent/contracts.ts';
import type { MemoryStore } from '../agent/memory.ts';
import type { FoundationService } from '../agent/foundation.ts';
import type { LiveMemory } from '../live/memory.ts';
import type { Snapshots } from '../data/snapshots.ts';
import type { ProgramBuilds } from './program-builds.ts';
import { ChangeConflict, type OntologyChanges, type PreparedChange } from './changes.ts';
import { prepareWordingEdits } from './wording-changes.ts';
import { fingerprint } from './release-diff.ts';
import { jsonData } from '../live/sources.ts';
import { FoundationDocuments, type FoundationEvidence } from '../agent/foundation-evidence.ts';
import { namingRelationIdentity } from './naming-relation-labels.ts';

const identifier = z.string().min(1).max(300), name = z.string().trim().min(1).max(200);
const reference = z.object({ id: identifier, version: z.number().int().positive() }).strict();
const wording = z.object({ key: identifier, name, aliases: z.array(name).max(100), description: z.string().trim().min(1).max(4000), evidence: z.string().trim().min(1).max(1500) }).strict();
export const namingProposal = z.object({ items: z.array(wording).max(50), finalize: z.boolean().default(false) }).strict();
export const namingPage = z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(30).default(10), pending: z.boolean().optional() }).strict();
const editInput = reference.extend({ items: z.array(wording.omit({ evidence: true }).partial().required({ key: true })).min(1).max(50) }).strict();
const ref = (item: Artifact) => ({ id: item.id, version: item.version });
const rows = (value: unknown): Data[] => Array.isArray(value) ? structuredClone(value) : [];
const phrase = (item: Data) => ({ name: String(item.name), aliases: (item.aliases ?? []) as string[], description: String(item.description ?? '') });

export class NamingProposalError extends Error {
  readonly recovery: Data;
  constructor(message: string, recovery: Data) { super(message); this.recovery = { status: 'needs_correction', error: message, ...recovery }; }
}

/** A single durable candidate owns the complete naming review; it never adopts structure. */
export class NamingBatches {
  onQueued?: () => void;
  private memory: MemoryStore; private foundation: FoundationService; private live: LiveMemory; private snapshots: Snapshots; private changes: OntologyChanges;
  constructor(memory: MemoryStore, foundation: FoundationService, live: LiveMemory, snapshots: Snapshots, changes: OntologyChanges) {
    this.memory = memory; this.foundation = foundation; this.live = live; this.snapshots = snapshots; this.changes = changes;
    changes.registerOwnerHandler('naming_batch', { subject: z.object({ ownerRef: reference }).strict(), prepare: (change, active) => this.prepare(change, active) });
    memory.atomic(() => { for (const candidate of memory.listArtifacts('naming_batch')) changes.trackOwner(candidate); });
  }
  jobs() { return this.memory.listArtifacts('naming_job'); }
  updateJob(id: string, status: string, content: Data = {}) {
    const job = this.job(id);
    return this.memory.putArtifact({ ...job, expectedVersion: job.version, status, content: { ...job.content, ...content } });
  }
  private job(id: string) {
    const job = this.memory.getArtifact(id);
    if (job.kind !== 'naming_job') throw new Error('命名任务不存在');
    return job;
  }
  private confirmed() {
    const confirmed = new Set<string>();
    for (const change of this.memory.listArtifacts('ontology_change').filter(item => item.status === 'adopted' && item.content.type === 'naming')) {
      const subject = change.content.subject as Data;
      if (typeof subject.name === 'string') confirmed.add(`${subject.target}:${subject.id}`);
      const owner = change.content.owner as Data | undefined;
      if (owner?.kind === 'naming_batch') for (const item of rows(this.memory.getArtifact(String(owner.id), Number(owner.version)).content.items)) confirmed.add(String(item.key));
    }
    return confirmed;
  }
  private capture() {
    const baseline = this.changes.currentBaseline();
    if (!baseline.foundationRef || !baseline.modelRef) return null;
    const base = this.memory.getArtifact(baseline.foundationRef.id), layered = this.live.readLayered(baseline.modelRef.id), confirmed = this.confirmed();
    const owners = [...rows(base.content.concepts), ...rows(base.content.relations), ...rows(base.content.properties)];
    const items: Data[] = [];
    for (const [target, definitions] of [['concept', layered.semantic.entityTypes], ['property', layered.semantic.properties], ['relation', layered.semantic.relationTypes]] as const) {
      for (const definition of definitions) {
        const item = jsonData(definition), key = `${target}:${item.id}`, owner = owners.find(owner => owner.id === item.id);
        const parent = target === 'property' ? owners.find(owner => owner.id === item.entityTypeId) : undefined;
        const protectedName = confirmed.has(key) || !!owner && owner.origin !== 'program' && !owner.governed || !owner && !!parent && parent.origin !== 'program';
        const bindings = target === 'property' ? layered.bindings.properties.filter(binding => binding.propertyId === item.id).map(binding => binding.entityBindingId)
          : layered.bindings.entities.filter(binding => [item.id, item.from, item.to].includes(binding.entityTypeId)).map(binding => binding.id);
        const sourceColumns = target === 'property' ? layered.bindings.properties.filter(binding => binding.propertyId === item.id).map(binding => binding.column) : [];
        items.push({ key, target, id: item.id, ...phrase(item), before: phrase(item), protected: protectedName, bindingIds: bindings, sourceColumns, ...(parent ? { ownerLabel: parent.name } : {}),
          ...(target === 'relation' ? { from: item.from, to: item.to, fromLabel: layered.semantic.entityTypes.find(entity => entity.id === item.from)?.name ?? '', toLabel: layered.semantic.entityTypes.find(entity => entity.id === item.to)?.name ?? '' } : {}) });
      }
    }
    const dependencies = layered.bindings.entities.map(binding => {
      const connection = this.live.sources.capability(binding.dataset.sourceId, binding.dataset.capability).artifact;
      const dataset = this.snapshots.bindingDataset(binding.dataset.sourceId, binding.dataset.capability);
      if (!dataset?.content.activeVersion) throw new Error('命名需要已采用的数据快照');
      return { bindingId: binding.id, sourceId: connection.id, sourceVersion: connection.version, capability: binding.dataset.capability, datasetId: dataset.id, snapshotId: dataset.content.activeVersion };
    });
    for (const change of this.memory.listArtifacts('ontology_change').filter(change => change.content.type === 'relation' && !change.content.owner && ['proposed', 'verified', 'failed'].includes(change.status))) {
      const subject = change.content.subject as Data;
      if (!subject.from || !subject.to) continue;
      const ends = [subject.from, subject.to] as Data[], bindings = ends.map(end => dependencies.find(dependency => dependency.datasetId === end.datasetId));
      if (bindings.some(binding => !binding)) continue;
      const entities = bindings.map(binding => layered.bindings.entities.find(entity => entity.id === binding!.bindingId)!.entityTypeId);
      const labels = entities.map(id => layered.semantic.entityTypes.find(entity => entity.id === id)!.name), identity = namingRelationIdentity(subject), key = `pending_relation:${identity}`;
      if (items.some(item => item.key === key)) continue;
      const before = { name: `${String(ends[0].column)} → ${labels[1]}`, aliases: [], description: String(change.content.evidence ?? '尚待核对的关系') };
      items.push({ key, target: 'pending_relation', id: change.id, ...before, before, protected: false, deferred: true, relationSubject: subject, identity,
        from: entities[0], to: entities[1], fromLabel: labels[0], toLabel: labels[1], bindingIds: bindings.map(binding => binding!.bindingId) });
    }
    return jsonData({ baseline, items, dependencies });
  }
  /** Called after discovery has registered the first build's pending relations. Replays reuse this job. */
  ensure(): Artifact | undefined {
    const existing = this.jobs()[0];
    if (existing) return existing;
    const captured = this.capture();
    if (!captured || !(captured.items as Data[]).length) return;
    const job = this.memory.putArtifact({ kind: 'naming_job', title: '首次构建业务命名', status: 'queued', content: { ...captured, readKeys: [], draft: [] } });
    queueMicrotask(() => this.onQueued?.());
    return job;
  }
  connectBuilds(engine: ProgramBuilds) {
    let enabled = this.memory.listArtifacts('naming_initialization').length > 0;
    if (!enabled && !this.changes.currentBaseline().modelRef) {
      this.memory.putArtifact({ kind: 'naming_initialization', title: '首次构建命名已启用', status: 'ready', content: {} });
      enabled = true;
    }
    const previous = engine.onDiscovery;
    engine.onDiscovery = async () => {
      await previous?.();
      if (!enabled) return;
      const first = this.memory.listArtifacts('engine_candidate').find(candidate => candidate.status === 'adopted' && candidate.content.baseModelRef === null && candidate.content.adoption);
      if (!first || this.memory.getArtifact(String(first.content.jobId)).kind !== 'engine_build') return;
      try { this.ensure(); }
      catch (error) {
        if (!this.jobs().length) this.memory.putArtifact({ kind: 'naming_job', title: '首次构建业务命名', status: 'failed', content: { error: (error as Error).message } });
      }
    };
    if (enabled) queueMicrotask(() => { void engine.onDiscovery?.(); });
  }
  start(id: string, taskId: string) {
    const job = this.job(id);
    if (job.status !== 'queued' || job.content.candidateRef) throw new Error('命名任务已经提交或正在运行');
    const captured = this.capture();
    if (!captured) throw new Error('请先完成首次结构化构建');
    let resume = fingerprint(job.content.baseline) === fingerprint(captured.baseline) && fingerprint(job.content.dependencies) === fingerprint(captured.dependencies);
    try { this.assertInputs(job.content); } catch { resume = false; }
    const items = rows(captured.items), previous = rows(job.content.items);
    resume &&= items.length === previous.length && items.every((item, index) =>
      item.key === previous[index].key && fingerprint(item.before) === fingerprint(previous[index].before) && item.protected === previous[index].protected);
    const draft = resume ? rows(job.content.draft).map(item => ({ ...items.find(current => current.key === item.key)!, proposed: item.proposed })) : [];
    return this.updateJob(id, 'running', { ...captured, taskId, readKeys: resume ? job.content.readKeys ?? [] : [], draft, documents: resume ? job.content.documents ?? [] : [], error: null });
  }
  private assertInputs(content: Data) {
    if (fingerprint(content.baseline) !== fingerprint(this.changes.currentBaseline())) throw new ChangeConflict('stale_baseline', '命名依据的工作版已变化，请重新读取后重试命名');
    for (const dependency of rows(content.dependencies)) {
      this.live.sources.capability(String(dependency.sourceId), String(dependency.capability), Number(dependency.sourceVersion));
      if (this.snapshots.dataset(String(dependency.datasetId)).content.activeVersion !== dependency.snapshotId) throw new ChangeConflict('verification_changed', '命名依据的数据快照已变化，请重新读取');
    }
    for (const document of rows(content.documents)) {
      const source = this.memory.getArtifact(String(document.sourceId));
      if (source.status !== 'ready' || source.version !== document.sourceVersion) throw new ChangeConflict('verification_changed', '命名引用的文档已变化或停用，请重新读取');
    }
  }
  async readContext(id: string, input: unknown = {}, assertActive: () => void = () => {}) {
    const args = namingPage.parse(input), job = this.job(id);
    if (!['queued', 'running'].includes(job.status)) throw new Error('命名任务当前不可读取');
    assertActive(); this.assertInputs(job.content);
    const all = rows(job.content.items), submitted = new Set(rows(job.content.draft).map(item => item.key));
    const selectedItems = all.map((item, index) => ({ item, index })).filter(({ item, index }) => index >= args.offset && (!args.pending || !submitted.has(item.key)));
    const selectedPage = selectedItems.slice(0, args.limit), items = selectedPage.map(entry => entry.item), sources: Data[] = [];
    const selected = new Set(items.flatMap(item => item.bindingIds as string[]));
    for (const dependency of rows(job.content.dependencies).filter(dependency => selected.has(String(dependency.bindingId)))) {
      if (sources.some(source => source.datasetId === dependency.datasetId)) continue;
      const { cap } = this.live.sources.capability(String(dependency.sourceId), String(dependency.capability), Number(dependency.sourceVersion));
      const page = await this.snapshots.readPinned(String(dependency.snapshotId), cap, { sourceId: String(dependency.sourceId), connectionVersion: Number(dependency.sourceVersion) }, {}, 0, 3);
      assertActive(); this.assertInputs(job.content);
      const dataset = this.snapshots.dataset(String(dependency.datasetId));
      const profile = this.memory.getArtifact(String(dependency.snapshotId)).content.profile as Data;
      const requested = new Set(items.flatMap(item => item.sourceColumns as string[] ?? []));
      const allColumns = rows(profile.columns), columns = [...allColumns.filter(column => requested.has(String(column.name))), ...allColumns.filter(column => !requested.has(String(column.name)))].slice(0, 30)
        .map(column => ({ name: column.name, type: column.type, nulls: column.nulls, distinct: column.distinct, primaryKey: column.primaryKey }));
      const fields = columns.map(column => String(column.name));
      const sample = page.items.map(row => Object.fromEntries(fields.map(field => [field, typeof row[field] === 'string' ? row[field].slice(0, 200) : row[field] ?? null])));
      sources.push({ ...dependency, name: dataset.content.name, profile: { rows: profile.rows, columns, columnsTotal: allColumns.length, columnsTruncated: allColumns.length > columns.length }, sample,
        sampleTruncated: page.items.some(row => fields.some(field => typeof row[field] === 'string' && row[field].length > 200)), coverage: jsonData(page.coverage) });
    }
    const baseline = job.content.baseline as Data, base = this.memory.getArtifact(String((baseline.foundationRef as Data).id)), documents: Data[] = [];
    for (const entry of rows(base.content.evidence).filter(entry => entry.kind === 'document').slice(0, 6)) {
      const source = this.memory.getArtifact(String(entry.sourceId));
      if (source.status !== 'ready' || source.version !== entry.sourceVersion) continue;
      new FoundationDocuments(this.memory).locate(entry as unknown as FoundationEvidence);
      documents.push({ id: entry.id, sourceId: source.id, sourceVersion: source.version, title: source.title, quote: String(entry.quote).slice(0, 1500), quoteTruncated: String(entry.quote).length > 1500 });
    }
    assertActive(); this.assertInputs(job.content);
    const current = this.job(id);
    this.updateJob(id, current.status, { readKeys: [...new Set([...(current.content.readKeys as string[]), ...items.map(item => String(item.key))])], documents });
    return { items, sources, documents, total: all.length, remaining: all.length - submitted.size, nextOffset: selectedItems[args.limit]?.index ?? null };
  }
  /** The model sees job-local handles and business context; durable drafts retain canonical references. */
  async readAgentContext(id: string, input: unknown = {}, assertActive: () => void = () => {}) {
    const args = namingPage.parse(input), page = await this.readContext(id, { ...args, pending: args.pending ?? true }, assertActive);
    const job = this.job(id), all = rows(job.content.items), dependencies = rows(job.content.dependencies);
    const sourceKey = (bindingId: unknown) => {
      const dependency = dependencies.find(entry => entry.bindingId === bindingId)!;
      return `s${dependencies.findIndex(entry => entry.datasetId === dependency.datasetId) + 1}`;
    };
    return { ...page,
      items: page.items.map(item => ({ key: `n${all.findIndex(entry => entry.key === item.key) + 1}`, target: item.target, ...phrase(item), protected: item.protected,
        ...(item.ownerLabel ? { ownerLabel: item.ownerLabel } : {}), ...(item.fromLabel ? { fromLabel: item.fromLabel, toLabel: item.toLabel } : {}),
        columns: item.sourceColumns ?? [], sources: (item.bindingIds as string[]).map(sourceKey) })),
      sources: page.sources.map(source => ({ key: sourceKey(source.bindingId), name: source.name, profile: source.profile, sample: source.sample, sampleTruncated: source.sampleTruncated,
        coverage: Object.fromEntries(Object.entries(source.coverage as Data).filter(([key]) => ['mode', 'complete', 'returned', 'total', 'limited', 'reason'].includes(key))) })),
      documents: page.documents.map((document, index) => ({ key: `d${index + 1}`, title: document.title, quote: document.quote, quoteTruncated: document.quoteTruncated })) };
  }
  private progress(content: Data, additions: Data = {}) {
    const submitted = new Set(rows(content.draft).map(item => item.key)), missing = rows(content.items).map((item, index) => ({ item, index })).filter(({ item }) => !submitted.has(item.key));
    return { remaining: missing.length, nextOffset: missing[0]?.index ?? null, missingKeys: missing.slice(0, 30).map(({ index }) => `n${index + 1}`), missingTruncated: missing.length > 30, ...additions };
  }
  propose(id: string, input: unknown, assertActive: () => void = () => {}, responsible = 'agent:background-naming') {
    const args = namingProposal.parse(input), job = this.job(id);
    assertActive();
    if (!args.items.length && !args.finalize) throw new NamingProposalError('请先读取并提供本页命名；只有全部暂存后才能用空 items 完成提交。', this.progress(job.content));
    const items = rows(job.content.items), invalidKeys: string[] = [], duplicateKeys: string[] = [], unreadKeys: string[] = [], seen = new Set<string>();
    const read = new Set(job.content.readKeys as string[]);
    args.items = args.items.map(proposed => {
      const match = /^n([1-9]\d*)$/.exec(proposed.key), index = match ? Number(match[1]) - 1 : items.findIndex(item => item.key === proposed.key), item = items[index];
      if (!item) { invalidKeys.push(proposed.key); return proposed; }
      const key = String(item.key), handle = `n${index + 1}`;
      if (seen.has(key)) duplicateKeys.push(handle);
      if (!read.has(key)) unreadKeys.push(handle);
      seen.add(key); return { ...proposed, key };
    });
    if (invalidKeys.length || duplicateKeys.length || unreadKeys.length) throw new NamingProposalError('命名对象键无效、重复或尚未读取；请按返回的短 key 更正，先读取缺失页。', this.progress(job.content, { invalidKeys, duplicateKeys, unreadKeys }));
    if (job.content.candidateRef) {
      if (job.content.submissionHash !== fingerprint(args)) throw new Error('命名任务已提交，不能用同一任务提交不同结果');
      const candidateRef = job.content.candidateRef as Data, changeRef = job.content.changeRef as Data;
      return { candidate: this.memory.getArtifact(String(candidateRef.id), Number(candidateRef.version)), change: this.changes.read(String(changeRef.id), Number(changeRef.version)), remaining: 0 };
    }
    this.assertInputs(job.content);
    if (!['queued', 'running'].includes(job.status)) throw new Error('命名任务已经提交或关闭');
    const draft = new Map(rows(job.content.draft).map(item => [item.key, item]));
    for (const proposed of args.items) {
      const item = items.find(item => item.key === proposed.key)!;
      if (item.protected && proposed.name !== item.name) throw new Error('人工已确认名称不可覆盖');
      draft.set(proposed.key, { ...item, proposed: jsonData(proposed) });
    }
    if (args.finalize && draft.size !== items.length) throw new NamingProposalError('请先为全部对象提供名称、别名、说明和依据；本次不完整提交尚未保存，请先分批暂存。', this.progress(job.content));
    return this.memory.atomic(() => {
      assertActive(); this.assertInputs(job.content);
      if (!args.finalize) { const saved = this.updateJob(id, job.status, { draft: [...draft.values()] }); return { candidate: null, change: null, ...this.progress(saved.content) }; }
      const candidate = this.memory.putArtifact({ kind: 'naming_batch', title: `业务命名 · ${items.length} 项`, status: 'candidate', content: { jobId: id, baseline: job.content.baseline,
        dependencies: job.content.dependencies, documents: job.content.documents ?? [], items: [...draft.values()], responsible, rationale: '根据表名、字段画像、实际样本与已读文档提出，需人工整批确认。' } });
      const change = this.changes.trackOwner(candidate)!;
      this.updateJob(id, 'completed', { candidateRef: ref(candidate), changeRef: ref(change), submissionHash: fingerprint(args), draft: [], error: null });
      return { candidate, change, remaining: 0 };
    });
  }
  read(id: string, version?: number) {
    const candidate = this.memory.getArtifact(id, version);
    if (candidate.kind !== 'naming_batch') throw new Error('命名批次不存在');
    const change = this.memory.listArtifacts('ontology_change').find(change => (change.content.owner as Data)?.id === id);
    return { candidate, change, items: rows(candidate.content.items) };
  }
  edit(input: unknown) {
    const args = editInput.parse(input), { candidate, change } = this.read(args.id);
    if (candidate.version !== args.version) throw new ChangeConflict('version_conflict', '命名版本已变化，请重新读取');
    if (candidate.status !== 'candidate' || !change || !['proposed', 'verified', 'failed'].includes(change.status)) throw new Error('已处理的命名批次不可编辑');
    this.assertInputs(candidate.content);
    const items = rows(candidate.content.items), seen = new Set<string>();
    for (const patch of args.items) {
      const item = items.find(item => item.key === patch.key);
      if (!item || seen.has(patch.key)) throw new Error('命名项不存在或重复');
      if (item.protected && patch.name !== undefined && patch.name !== item.name) throw new Error('人工已确认名称不可覆盖');
      seen.add(patch.key); item.proposed = { ...item.proposed as Data, ...patch };
    }
    return this.memory.atomic(() => {
      this.assertInputs(candidate.content);
      const saved = this.memory.putArtifact({ ...candidate, expectedVersion: candidate.version, content: { ...candidate.content, items } });
      return { candidate: saved, change: this.changes.trackOwner(saved)! };
    });
  }
  private async prepare(change: Artifact, assertActive: () => void = () => {}): Promise<PreparedChange> {
    const owner = (change.content.subject as Data).ownerRef as Data;
    const candidate = this.read(String(owner.id)).candidate;
    if (candidate.version !== owner.version || candidate.status !== 'candidate') throw new ChangeConflict('version_conflict', '命名候选版本已变化');
    assertActive(); this.assertInputs(candidate.content);
    const patches: Artifact[] = [];
    const items = rows(candidate.content.items), labels: Data[] = [];
    const entityName = (id: Data[string]) => {
      const item = items.find(item => item.target === 'concept' && item.id === id);
      return String((item?.proposed as Data | undefined)?.name ?? item?.name ?? id);
    };
    for (const item of items) {
      const proposed = wording.parse(item.proposed), before = item.before as Data;
      if (item.protected && proposed.name !== before.name) throw new Error('人工已确认名称不可覆盖');
      proposed.aliases = [...new Set([...(before.aliases as string[]), ...proposed.aliases, ...(proposed.name !== before.name ? [String(before.name)] : [])])];
      if (item.target === 'relation' || item.target === 'pending_relation') proposed.description = `${entityName(item.from)} → ${proposed.name} → ${entityName(item.to)}。${proposed.description}`;
      if (item.target === 'pending_relation') {
        labels.push({ identity: item.identity, subject: item.relationSubject, wording: jsonData(proposed) });
        continue;
      }
      for (const [type, subject] of [['naming', { name: proposed.name, aliases: proposed.aliases }], ['description', { description: proposed.description }]] as const) {
        if (Object.entries(subject).every(([key, value]) => fingerprint(before[key] ?? []) === fingerprint(value))) continue;
        patches.push({ ...change, id: `${change.id}:${item.key}:${type}`, content: { ...change.content, type, subject: { target: item.target, id: item.id, ...subject } } });
      }
    }
    let prepared;
    try {
      prepared = patches.length ? await prepareWordingEdits(this.memory, this.foundation, this.live, this.changes, patches)
        : { verification: { result: 'passed' as const, metrics: {}, notes: [], inputs: {} }, apply: () => [this.changes.currentBaseline() as Data] };
    } catch (error) {
      if (!(error instanceof ChangeConflict) || error.code !== 'batch_conflict') throw error;
      return { verification: { result: 'failed' as const, metrics: { namesUnique: false }, notes: [error.message], inputs: { candidateRef: ref(candidate), dependencies: candidate.content.dependencies } }, apply: (): Data => { throw error; } };
    }
    const current = () => { assertActive(); this.assertInputs(candidate.content); if (this.memory.getArtifact(candidate.id).version !== candidate.version) throw new ChangeConflict('version_conflict', '命名候选版本已变化'); };
    current();
    return { ...prepared, verification: { ...prepared.verification, result: prepared.verification.result === 'failed' ? 'failed' as const : 'review' as const, notes: [...prepared.verification.notes, '整批业务命名需要人工核对；不会采用尚未确认的结构。'],
      metrics: { ...prepared.verification.metrics, items: (candidate.content.items as Data[]).length }, inputs: { ...prepared.verification.inputs, candidateRef: ref(candidate), dependencies: candidate.content.dependencies } },
      apply: () => {
        current(); const effect = prepared.apply()[0];
        const adopted = this.memory.putArtifact({ ...candidate, expectedVersion: candidate.version, status: 'adopted' });
        for (const label of labels) this.memory.putArtifact({ kind: 'naming_relation_label', title: String((label.wording as Data).name), status: 'adopted', content: { ...label, namingRef: ref(adopted) } });
        return { ...effect, ownerRef: ref(adopted) };
      } };
  }
}
