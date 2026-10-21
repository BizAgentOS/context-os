import { z } from "zod";
import type { Artifact, Data, Repository } from "../agent/contracts.ts";
import type { LiveMemory, SnapshotPins } from "./memory.ts";
import type { ReadMode } from "./reading-contract.ts";
import { identityRuleSchema, parseLayeredModel, type IdentityRule, type LayeredModel } from "../semantic/model.ts";
import { identityFilter, identityValue, objectIdLimit, scopedFilter, transformValue } from "../semantic/values.ts";
import { fingerprint } from "../engine/release-diff.ts";
import { jsonData } from "./sources.ts";

export type IdentityDecisionPins = true | false | ReadonlySet<string>;
export interface IdentityReading { readMode?: ReadMode; pins?: SnapshotPins; fixedSemantic?: boolean; modelDefinition?: Data }
const name = z.string().trim().min(1).max(200);
const record = z.object({ bindingId: name, recordId: z.string().trim().min(1).max(objectIdLimit) }).strict();
export const identityRuleSubject = identityRuleSchema.omit({ id: true, legacy: true }).extend({ id: name.optional(), relationName: name.optional() });
export const identityDecisionSubject = z.object({ ruleId: name, left: record, right: record.nullable(), decision: z.enum(["match", "no_match"]),
  reason: z.string().trim().min(1).max(2000), evidence: z.string().trim().min(1).max(4000) }).strict().refine(value => value.decision !== "match" || value.right !== null, "明确对应需要右侧记录");
export type IdentityDecision = z.infer<typeof identityDecisionSubject>;
export const identityDecisionKey = (content: Data) => fingerprint({ ruleId: content.ruleId, left: content.left, right: content.right });
export function identityDecisionsForModel(repo: Repository, model: Artifact, pins: IdentityDecisionPins = true): Artifact[] {
  if (!pins) return [];
  const records = pins === true ? repo.listArtifacts("identity_decision") : [...pins].map(pin => {
    const split = pin.lastIndexOf("@"), version = Number(pin.slice(split + 1));
    if (split < 1 || !Number.isSafeInteger(version)) throw new Error("身份决定固定版本无效");
    return repo.getArtifact(pin.slice(0, split), version);
  });
  return records.filter(item => {
    if (item.kind !== "identity_decision" || item.status !== "adopted") return false;
    const target = item.content.modelRef as Data | undefined;
    return target?.id === model.id && target.version === model.version;
  }).sort((a,b)=>a.id.localeCompare(b.id));
}
export function identityRuleScope(layered: LayeredModel, rule: IdentityRule) {
  const binding = (id: string) => {
    const item = layered.bindings.entities.find(binding => binding.id === id);
    if (!item) throw new Error("身份规则绑定不存在");
    return { id: item.id, entityTypeId: item.entityTypeId, dataset: item.dataset, role: item.role, keyColumns: item.keyColumns, rowFilter: item.rowFilter ?? null };
  };
  return fingerprint({ id: rule.id, kind: rule.kind, left: rule.left, right: rule.right, transform: rule.transform, relationTypeId: rule.relationTypeId ?? null,
    leftBinding: binding(rule.left.bindingId), rightBinding: binding(rule.right.bindingId) });
}
export const identityRuleOf = (layered: LayeredModel, id: string) => {
  const rule = layered.bindings.identityRules.find(rule => rule.id === id);
  if (!rule) throw new Error("身份规则不存在或已变化");
  return rule;
};
type Reader = ReturnType<LiveMemory["identityReader"]>;
type Binding = LayeredModel["bindings"]["entities"][number];
function keyFor(reader: Reader, binding: Binding) {
  const {cap} = reader.sources.capability(binding.dataset.sourceId, binding.dataset.capability);
  return {cap, columns: binding.role === "primary" && binding.keyColumns.length ? binding.keyColumns : [cap.idField]};
}
export function identityRecordId(reader: Reader, binding: Binding, row: Data): string {
  const {cap,columns}=keyFor(reader,binding);
  return String(identityValue(row,columns,cap.idField));
}
async function readRecord(reader: Reader, binding: Binding, recordId: string) {
  const {cap,columns}=keyFor(reader,binding);
  const page=await reader.sources.readRecords(binding.dataset.sourceId,binding.dataset.capability,scopedFilter(binding.rowFilter,identityFilter(recordId,columns,cap.idType,cap.idField)),0,2);
  reader.assertValid();
  if(page.items.length!==1 || page.coverage.total!==1)throw new Error("身份决定的记录不存在、不唯一或读取不完整");
  return page;
}
export async function captureIdentityDecision(live: LiveMemory, model: Artifact, content: Data, options: IdentityReading = {}) {
  const subject=identityDecisionSubject.parse(Object.fromEntries(["ruleId","left","right","decision","reason","evidence"].map(key=>[key,content[key]])));
  const reader=live.identityReader(model,options),layered=reader.layered,rule=identityRuleOf(layered,subject.ruleId);
  if(subject.left.bindingId!==rule.left.bindingId || subject.right && subject.right.bindingId!==rule.right.bindingId)throw new Error("身份决定记录不属于规则两端");
  const left=layered.bindings.entities.find(binding=>binding.id===rule.left.bindingId)!,right=layered.bindings.entities.find(binding=>binding.id===rule.right.bindingId)!;
  const a=await readRecord(reader,left,subject.left.recordId),b=subject.right?await readRecord(reader,right,subject.right.recordId):null;
  const scopeFingerprint=identityRuleScope(layered,rule);
  const facts={left:a.items[0],right:b?.items[0]??null};
  const inputs=jsonData({scopeFingerprint, factsFingerprint:fingerprint(facts),sources:[a.provenance,b?.provenance].filter(Boolean).map(item=>{const {readAt,...stable}=item!;return stable;}),pins:reader.pins});
  return {scopeFingerprint,fingerprint:fingerprint({scopeFingerprint,facts}),inputs};
}
export async function identityRows(reader: Reader,binding: Binding,maximum=10000) {
  const items:Data[]=[],reads=[];
  let complete=false,total:number|null=null;
  for(let offset=0;offset<maximum;offset+=100){
    const page=await reader.sources.readRecords(binding.dataset.sourceId,binding.dataset.capability,binding.rowFilter??{},offset,Math.min(100,maximum-offset));
    reader.assertValid();items.push(...page.items);reads.push(page.provenance);total=page.coverage.total;
    if(page.coverage.complete || total!==null&&offset+page.items.length>=total){complete=true;break;}
    if(page.items.length<100)break;
  }
  return {items,reads,complete,total};
}
export function identityTuple(row:Data,columns:string[],rule:IdentityRule):string|null {
  const values=columns.map(column=>row[column]);
  if(values.some(value=>value===null||value===undefined||typeof value==='string'&&!value.trim()))return null;
  return fingerprint(values.map(value=>transformValue(value,rule.transform)));
}

/** One bounded resolver serves both supplementary attributes and belongs-to relations. */
export async function resolveIdentity(live:LiveMemory,model:Artifact,rule:IdentityRule,from:"left"|"right",row:Data,decisions:Artifact[],options:IdentityReading={}) {
  const reader=live.identityReader(model,options),layered=reader.layered;
  const origin=layered.bindings.entities.find(binding=>binding.id===rule[from].bindingId)!;
  const target=layered.bindings.entities.find(binding=>binding.id===rule[from==='left'?'right':'left'].bindingId)!;
  const originId=identityRecordId(reader,origin,row),active=decisions.filter(item=>item.content.ruleId===rule.id);
  for(const decision of active){
    const fresh=await captureIdentityDecision(live,model,decision.content,options);
    if(fresh.fingerprint!==decision.content.fingerprint || fresh.scopeFingerprint!==decision.content.scopeFingerprint)throw new Error("身份决定依赖的事实或规则已变化，请重新复验");
  }
  const pages=await identityRows(reader,target,2000),originKey=identityTuple(row,rule[from].columns,rule);
  const matches=pages.items.filter(item=>originKey!==null&&originKey===identityTuple(item,rule[from==='left'?'right':'left'].columns,rule));
  const relevant=active.filter(item=>from==='left'?(item.content.left as Data).recordId===originId:(item.content.right as Data|null)?.recordId===originId);
  const explicit=relevant.filter(item=>item.content.decision==='match');
  let candidates=matches;
  if(explicit.length){
    candidates=[];
    for(const decision of explicit){const endpoint=decision.content[from==='left'?'right':'left'] as Data;const page=await readRecord(reader,target,String(endpoint.recordId));candidates.push(...page.items);pages.reads.push(page.provenance);}
  }
  candidates=candidates.filter(item=>{
    const targetId=identityRecordId(reader,target,item),leftId=from==='left'?originId:targetId,rightId=from==='left'?targetId:originId;
    if(active.some(d=>d.content.decision==='no_match'&&(d.content.left as Data).recordId===leftId&&(!(d.content.right as Data|null)||(d.content.right as Data).recordId===rightId)))return false;
    if(from==='right'&&active.some(d=>d.content.decision==='match'&&(d.content.left as Data).recordId===leftId&&(d.content.right as Data).recordId!==rightId))return false;
    return true;
  });
  candidates=[...new Map(candidates.map(item=>[identityRecordId(reader,target,item),item])).values()];
  const excluded=from==='left'&&active.some(d=>d.content.decision==='no_match'&&(d.content.left as Data).recordId===originId&&!d.content.right);
  const complete=excluded||explicit.length>0||pages.complete;
  const status: "missing"|"unknown"|"ambiguous"|"unique"=excluded?'missing':!complete?'unknown':candidates.length>1?'ambiguous':candidates.length?'unique':'missing';
  return {items:excluded?[]:candidates,reads:pages.reads,status,complete,total:complete?candidates.length:null,
    reason:excluded?'明确排除此记录的身份对应':status==='unique'?'身份规则与记录决定得到唯一对应':status==='ambiguous'?'身份对应不唯一，未选择任何记录':status==='unknown'?'身份读取覆盖不完整':'没有对应记录'};
}
