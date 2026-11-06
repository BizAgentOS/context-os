import {crossTableReferences,referenceDataScope,referenceMatchStatus,REFERENCE_ROW_LIMIT} from './structured-references.ts';
import type {DiscoverySource} from './discovery.ts';
import type {z} from 'zod';
import type {compactCoordinationSchema} from './compact-coordination-schema.ts';
import {fingerprint} from './sources.ts';
type Selection=z.infer<typeof compactCoordinationSchema>['relationshipBindings'][number];
type Binding={sourceVersionId?:string;column:string};
type Raw={types:Array<{id:string;sourceColumns?:Binding[];properties?:Array<{sourceColumns?:Binding[]}>}>;links:Array<{id:string;from:string;to:string;sourceColumns?:Binding[]}>};
const bindings=(type:Raw['types'][number]|undefined)=>[...(type?.sourceColumns??[]),...(type?.properties??[]).flatMap(p=>p.sourceColumns??[])];
const values=(source:DiscoverySource,row:Record<string,string>,columns:string[])=>columns.map(c=>{const native=source.nativeValues?.[row[source.keyColumn!]];return native&&Object.hasOwn(native,c)?native[c]:row[c];});
/** Check the binding actually selected by coordination, preserving semantic
 * reasons separately. Zero data match never mutates/removes a link definition. */
export function relationshipValidation(raw:Raw,sources:DiscoverySource[],audit:Array<{memberId:string;reason:string}>=[],selections:Selection[]=[],evidence:Array<{memberId:string;sourceVersionId:string}>=[]){
 const references=crossTableReferences(sources,[raw]);
 const alternatives=references.flatMap(r=>r.alternatives.map(a=>({...a,sourceVersionId:r.sourceVersionId})));
 const selected=new Map<string,Selection>();
 for(const item of selections){if(selected.has(item.linkId))throw new Error('关系绑定决定重复');if(!raw.links.some(l=>l.id===item.linkId))throw new Error('关系绑定引用不存在的关系');selected.set(item.linkId,item);}
 return raw.links.map(link=>{
  const decision=selected.get(link.id),from=raw.types.find(t=>t.id===link.from),to=raw.types.find(t=>t.id===link.to);
  const result={memberId:link.id,businessMeaning:{status:'model_proposal_not_independently_confirmed',reasons:audit.filter(a=>a.memberId===link.id).map(a=>a.reason),evidence:evidence.filter(e=>e.memberId===link.id)},
   sourceBinding:{status:decision?'selected_and_validated':'not_selected',reason:decision?.reason??null,bindings:[] as unknown[]},dataMatch:{status:'not_checked',scope:'no_explicit_complete_binding_selection'} as Record<string,unknown>};
  if(!decision)return result;
  const choices=decision.bindings.map(choice=>{
   const candidate=alternatives.find(a=>a.ref===choice.candidateRef);if(!candidate||!candidate.sourceColumns.length||candidate.bindingValidity!=='declared_columns_exist')throw new Error('关系绑定候选不存在或复合映射未验证');
   const endpoint=choice.endpoint==='from'?from:to;
   if(!endpoint||!candidate.targetCandidateTypes.includes(endpoint.id))throw new Error('关系绑定候选不支持所选端点类型，不能按名称自动映射');
   const required=[...candidate.sourceColumns.map(column=>({sourceVersionId:candidate.sourceVersionId,column})),...candidate.targetColumns.map(column=>({sourceVersionId:candidate.targetSourceVersionId,column}))];
   if(required.some(b=>!link.sourceColumns?.some(c=>c.sourceVersionId===b.sourceVersionId&&c.column===b.column)))throw new Error('关系显式绑定未完整包含源/目标列组，不能缩成单列重叠');
   return {...candidate,endpoint:choice.endpoint};
  });
  if(new Set(choices.map(c=>c.endpoint)).size!==choices.length)throw new Error('同一关系端点存在多个已选择路径，必须显式区分业务角色');
  if(choices.some(c=>!bindings(c.endpoint==='to'?from:to).some(b=>b.sourceVersionId===c.sourceVersionId))&&(!choices.some(c=>c.endpoint==='from')||!choices.some(c=>c.endpoint==='to')||new Set(choices.map(c=>c.sourceVersionId)).size!==1))throw new Error('中间表关系须提供同一来源的两个端点路径');
  if(new Set(choices.map(c=>c.sourceVersionId)).size!==1)throw new Error('同一关系检查必须使用同一驱动来源，不能混读不同来源的端点列');
  const source=sources.find(s=>s.id===choices[0].sourceVersionId)!;
  let checked=0,matched=0;
  const targets=choices.map(c=>{const target=sources.find(s=>s.id===c.targetSourceVersionId)!;return new Set((target.rows??[]).slice(0,REFERENCE_ROW_LIMIT).map(row=>JSON.stringify(values(target,row,c.targetColumns))));});
  if(choices.every(c=>c.dataMatch.status!=='not_checked'))for(const row of (source.rows??[]).slice(0,REFERENCE_ROW_LIMIT)){
   const tuples=choices.map(c=>values(source,row,c.sourceColumns));if(tuples.some(tuple=>tuple.some(v=>v===null||v===undefined||v==='')))continue;
   checked++;if(tuples.every((tuple,i)=>targets[i].has(JSON.stringify(tuple))))matched++;
  }
  result.sourceBinding.bindings=choices.map(c=>({candidateRef:c.ref,endpoint:c.endpoint,sourceVersionId:c.sourceVersionId,sourceColumns:c.sourceColumns,targetSourceVersionId:c.targetSourceVersionId,targetColumns:c.targetColumns,role:c.role}));
  const sourceScope=referenceDataScope(source),targetScopes=choices.map(c=>({sourceVersionId:c.targetSourceVersionId,...referenceDataScope(sources.find(s=>s.id===c.targetSourceVersionId)!)}));
  result.dataMatch={status:referenceMatchStatus(checked,matched,sourceScope.complete&&targetScopes.every(s=>s.complete)),checked,matched,rowLimit:REFERENCE_ROW_LIMIT,sourceScope,targetScopes,scope:'frozen_loaded_records',sourceVersionIds:[source.id,...choices.map(c=>c.targetSourceVersionId)],checks:choices.map(c=>({candidateRef:c.ref,...c.dataMatch})),checkHash:fingerprint(choices.map(c=>({ref:c.ref,dataMatch:c.dataMatch}))),note:'数据匹配不证明业务含义；抽样未匹配不能推断全量无关联，零匹配保留业务关系定义'};
  return result;
 });
}
