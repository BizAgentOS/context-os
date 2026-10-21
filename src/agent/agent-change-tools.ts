import { z } from "zod";
import type { Artifact, Data, DomainTool, WriteContext } from "./contracts.ts";
import type { MemoryStore } from "./memory.ts";
import type { OntologyChanges } from "../engine/changes.ts";
import type { PendingCenter } from "../engine/pending.ts";
import { liveQuerySchema, type LiveMemory } from "../live/memory.ts";
import { assertAgentTool, type FrozenAgentTurn } from "./agent-modes.ts";
import { fingerprint } from "../engine/release-diff.ts";
import { jsonData } from "../live/sources.ts";
import { captureChangeEvidence } from "./change-evidence.ts";
import type { FoundationDocuments } from "./foundation-evidence.ts";
import type { Gaps } from "../engine/gaps.ts";

const name = z.string().trim().min(1).max(200), reference = z.object({ id: name, version: z.number().int().positive() }).strict();
const operation = z.string().trim().min(1).max(80), reason = z.string().trim().min(1).max(4000);
const baseline = z.object({ foundationRef: reference.nullable(), modelRef: reference.nullable() }).strict();
const proposal = z.object({ operationId: operation, type: z.enum(["entity", "property", "relation", "binding", "identity_rule", "identity_decision", "naming", "description", "local_correction", "deprecation", "data_issue"]), baseline, subject: z.record(z.string(), z.unknown()), evidence: reason }).strict();
const action = reference.extend({ operationId: operation }).strict();
const preview = reference.extend({ query: liveQuerySchema.omit({ modelId: true, modelVersion: true, readMode: true }).extend({ limit: z.number().int().min(1).max(20).default(20) }).strict().optional(),gapRef:reference.optional(),operationId:operation.optional(),relationResolutions:z.array(z.object({fromRelationId:name,toRelationId:name}).strict()).max(3).optional() }).strict().refine(value=>!!value.query!==!!value.gapRef,'提供一个对象查询，或引用原问题缺口重放').refine(value=>!value.gapRef||!!value.operationId,'缺口预览需要操作标识');
const pendingFilters = z.object({ category: z.enum(["structure", "naming", "adjudication", "gap", "data_issue"]).optional(), source: name.optional(), object: name.optional(), limit: z.number().int().min(1).max(40).default(20), offset: z.number().int().min(0).default(0) }).strict();
const tool = (name: string, description: string, schema: z.ZodType, mutates = false): DomainTool => ({ name, description, inputSchema: z.toJSONSchema(schema), mutates });
const ref = (artifact: Artifact) => ({ id: artifact.id, version: artifact.version });

/** Agent authority is narrower than the administrator's change endpoints. */
export class AgentChangeTools {
  readonly tools: DomainTool[] = [
    tool("change_propose", "提出一项有业务依据的统一变更，baseline 从待处理目录读取。结构、身份与弃用只保存提议，由人采用；名称和说明经服务复验后可直接生效。文字变更可在subject.evidence引用本轮读取：[{id,kind:document|web|knowledge|api,readId,quote}]或[{id,messageId,quote}]；不得伪造readId或传evidenceRefs。外部资料与已确认含义不一致时保留原含义及双方依据，形成待裁决项。origin与决定身份由宿主设置。", proposal, true),
    tool("change_verify", "复验准确版本的已保存变更，读取真实来源与当前工作版；返回通过、需核对或失败以及实际指标。不会采用结构。", action, true),
    tool("change_preview_query", "对准确版本的变更重放同一个有界对象查询，返回工作版与假设采用后的结果、覆盖与差异。引用gapRef时不传query，提供operationId，宿主重放缺口原查询并关联修复，不会确认缺口；relationResolutions只用于把原缺失关系对应到本次新增关系。普通新增关系可用relation:$proposed。不采用，最多20条。", preview),
    tool("change_withdraw", "撤回本会话自己提出、尚未采用的变更，必须说明原因。不能撤回人类、程序或其他会话的变更；没有拒绝或采用工具。", action.extend({ reason }).strict(), true),
    tool("pending_list", "读取统一待处理目录与当前baseline；按类别、来源、对象分页。目录含程序发现、助手提议及待裁决事项。", pendingFilters),
    tool("pending_read", "读取一个准确版本的待处理事项、实际依据、影响与复验；决定卡引用这里返回的id/version。", reference),
    tool("ontology_outline", "有界读取当前已采用本体的实体与关系目录，不创建或修改定义。", z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) }).strict()),
  ];
  private memory: MemoryStore; private changes: OntologyChanges; private pending: PendingCenter; private live: LiveMemory; private gaps?:Gaps;
  constructor(memory: MemoryStore, changes: OntologyChanges, pending: PendingCenter, live: LiveMemory,gaps?:Gaps) { this.memory = memory; this.changes = changes; this.pending = pending; this.live = live; this.gaps=gaps; }
  async execute(name: string, value: unknown, context: WriteContext, turn: FrozenAgentTurn, documents?: FoundationDocuments): Promise<unknown> {
    const active = () => assertAgentTool(this.memory, context, turn, name); active();
    const scoped = (id: string) => `agent:${turn.executionId}:${id}`;
    if (name === "pending_list") return this.pending.list(pendingFilters.parse(value));
    if (name === "pending_read") {
      const args = reference.parse(value), item = this.pending.read(args.id);
      if (item.version !== args.version) throw new Error("待处理版本已变化，请重新读取目录");
      let change: Artifact | undefined; try { change = this.changes.read(item.id, item.version); } catch { /* Providers own non-change decision details. */ }
      return { item, ...(change ? { change } : {}), ...(item.category==='gap'?{gap:this.memory.getArtifact(item.id,item.version)}:{}), baseline: this.changes.currentBaseline() };
    }
    if (name === "ontology_outline") {
      const args = z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) }).strict().parse(value);
      const base = this.changes.currentBaseline(), foundation = base.foundationRef ? this.memory.getArtifact(base.foundationRef.id, base.foundationRef.version) : null;
      const concepts = (foundation?.content.concepts ?? []) as Data[], relations = (foundation?.content.relations ?? []) as Data[];
      const entities = concepts.slice(args.offset, args.offset + args.limit).map(({ id, name, description, aliases }) => ({ id, name, description, aliases: aliases ?? [] }));
      return { baseline: base, entities, relations: relations.slice(args.offset, args.offset + args.limit).map(({ id, name, from, to, description }) => ({ id, name, from, to, description })), coverage: { offset: args.offset, entities: concepts.length, relations: relations.length, complete: args.offset + args.limit >= Math.max(concepts.length, relations.length) } };
    }
    if (name === "change_propose") {
      const args = proposal.parse(value);
      const subject = ["naming", "description"].includes(args.type)
        ? captureChangeEvidence(this.memory, args.subject as Data, context, scoped(args.operationId), documents)
        : args.subject;
      const result = await this.changes.propose({ ...args, subject, operationId: scoped(args.operationId), origin: "agent" });
      const ownership = this.memory.listArtifacts("agent_change_owner").find(owner => owner.content.changeId === result.change.id);
      if (!ownership) this.memory.putArtifact({ kind: "agent_change_owner", title: "助手提议归属", status: "saved", content: { changeId: result.change.id, taskId: turn.taskId, sessionId: turn.sessionId } });
      let change = result.change;
      if (["naming", "description"].includes(args.type)) {
        active();
        change = await this.changes.verify({ ...ref(change), operationId: `${scoped(args.operationId)}:verify` }, active);
        if (change.status === "verified" && (change.content.verification as Data).result === "passed") change = await this.changes.adopt({ ...ref(change), operationId: `${scoped(args.operationId)}:wording` }, active);
      }
      return { ...result, change };
    }
    if (name === "change_verify") { const args = action.parse(value); return this.changes.verify({ ...args, operationId: scoped(args.operationId) }, active); }
    if (name === "change_withdraw") {
      const args = action.extend({ reason }).strict().parse(value), change = this.changes.read(args.id);
      const owner = this.memory.listArtifacts("agent_change_owner").find(owner => owner.content.changeId === change.id);
      if (change.content.origin !== "agent" || !owner || (turn.sessionId ? owner.content.sessionId !== turn.sessionId : owner.content.taskId !== turn.taskId)) throw new Error("只能撤回本会话自己提出的变更");
      active(); return this.changes.withdraw({ ...args, operationId: scoped(args.operationId) });
    }
    if (name === "change_preview_query") {
      const args = preview.parse(value), change = this.changes.read(args.id, args.version), base = this.changes.currentBaseline();
      if(args.gapRef){
        if(!this.gaps)throw new Error('缺口重放服务尚不可用');
        active();const result=await this.gaps.preview({...args.gapRef,operationId:scoped(args.operationId!),changeRef:ref(change),...(args.relationResolutions?{relationResolutions:args.relationResolutions}:{})},active);
        active();const linked=this.gaps.linkChange({...args.gapRef,operationId:scoped(args.operationId!)+':link',changeRef:ref(change),previewRef:ref(result.preview)},active);
        return {...result,linkedGap:linked.gap,changeRef:ref(change),adopted:false};
      }
      const expression=args.query!;
      if (!base.modelRef) throw new Error("当前没有可供预览的工作版映射");
      const prepared = await this.changes.preparePreview(ref(change), active);
      if (!prepared.definition) throw new Error("该变更尚未提供查询预览，请先查看复验和影响记录");
      let relation = expression.relation;
      if (relation === "$proposed") {
        const current = this.live.projectModel(this.memory.getArtifact(base.modelRef.id)).content.relations as Data[];
        const added = (prepared.definition.relations as Data[]).filter(item => !current.some(old => old.relationId === item.relationId));
        if (added.length !== 1) throw new Error("预览没有唯一新增关系，请使用明确关系名称");
        relation = String(added[0].name);
      }
      const query = { ...expression, ...(relation ? { relation } : {}), modelId: base.modelRef.id, modelVersion: base.modelRef.version, readMode: "active_snapshot" };
      const reading = this.live.capturePreviewReading(base.modelRef, prepared.definition);
      const run = async (definition?: Data) => { try { return { status: "available", result: jsonData(await this.live.query(query, active,
        definition && prepared.corrections?.relations ? { records: prepared.corrections.relations } : true,
        definition, false, undefined, reading, true, definition ? prepared.foundation : undefined,
        definition && prepared.corrections?.properties ? { records: prepared.corrections.properties } : true)) }; } catch (error) { active(); return { status: "unavailable", error: (error as Error).message }; } };
      const before = await run(), after = await run(prepared.definition); active();
      const checked = await this.changes.preparePreview(ref(change), active);
      if (fingerprint(prepared.verification.inputs) !== fingerprint(checked.verification.inputs) || fingerprint(base) !== fingerprint(this.changes.currentBaseline())) throw new Error("预览期间来源或工作版变化，请重新预览");
      const comparable = (value: typeof before) => ({ status: value.status, error: value.error ?? null, items: value.result?.items ?? null, coverage: value.result?.coverage ?? null });
      return { changeRef: ref(change), view: "工作版视角", query: expression, before, after, changed: fingerprint(comparable(before)) !== fingerprint(comparable(after)), verification: prepared.verification, adopted: false };
    }
    throw new Error("未知的构建模式工具");
  }
}
