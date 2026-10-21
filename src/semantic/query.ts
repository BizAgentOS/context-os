import type {Artifact,Data,Json,Repository} from '../agent/contracts.ts';
import type {Snapshots} from '../data/snapshots.ts';
import {captureRelation,correctionRecords,type CorrectionTarget} from '../live/relation-corrections.ts';
import {identityDecisionsForModel,captureIdentityDecision} from '../live/identity.ts';
import {propertyCorrectionsForModel,validatePropertyCorrections} from '../live/property-corrections.ts';
import {pinKey,type LiveMemory} from '../live/memory.ts';
import {multipleSourceTimes,readingConsistency,type SourceReading} from '../live/reading-contract.ts';
import {semanticQuerySchema,type SemanticQueryOptions} from './query-contract.ts';
import {QuerySql,validateQuery,type QueryBinding} from './query-sql.ts';
export {semanticQuerySchema,type SemanticQueryOptions} from './query-contract.ts';

/** The host supplies reading credentials. Queries only contain semantic IDs and bounded operations. */
export class SemanticQuery {
  private memory:Repository;private live:LiveMemory;private snapshots:Pick<Snapshots,'read'|'bindingDataset'>;
  constructor(memory:Repository,live:LiveMemory,snapshots:Pick<Snapshots,'read'|'bindingDataset'>){this.memory=memory;this.live=live;this.snapshots=snapshots;}
  async execute(input:unknown,options:SemanticQueryOptions={}){
    const query=semanticQuerySchema.parse(input),assertActive=()=>{options.assertActive?.();if(options.signal?.aborted)throw new Error('数据读取已取消');};
    assertActive();
    const prepared=options.preparedModel?this.live.preparedReader(options.preparedModel.definition,options.preparedModel.foundation,options.preparedModel.assertUnchanged,options.pins):undefined;
    const stored=prepared?.model??(options.modelRef?this.memory.getArtifact(options.modelRef.id,options.modelRef.version):this.memory.listArtifacts('live_ontology').find(a=>a.status==='adopted'));
    if(!stored||stored.kind!=='live_ontology'||stored.status!=='adopted')throw new Error('查询需要已采用本体');
    const reader=prepared??this.live.identityReader(stored,options),{model,layered}=reader;
    const {target,fields}=validateQuery(layered,query,options);
    const usedTypes=new Set([query.target.entityTypeId,target.id]);
    for(const step of query.traverse){const relation=layered.semantic.relationTypes.find(r=>r.id===step.relationTypeId)!;usedTypes.add(relation.from);usedTypes.add(relation.to);}
    const datasets=new Map<string,QueryBinding>(),sources:SourceReading[]=[];
    const selectedBindings=[...layered.bindings.entities.filter(b=>usedTypes.has(b.entityTypeId)),...layered.bindings.relations.flatMap(binding=>binding.kind==='link_table'&&query.traverse.some(step=>step.relationTypeId===binding.relationTypeId)?[{id:'link:'+binding.id,dataset:binding.dataset}]:[])];
    for(const binding of selectedBindings){
      const {cap}=reader.sources.capability(binding.dataset.sourceId,binding.dataset.capability);
      const version=reader.pins[pinKey(binding.dataset.sourceId,binding.dataset.capability)];
      if(!version)throw new Error('扩展查询需要已同步的固定快照；当前来源为实时或尚未同步');
      const snapshot=this.memory.getArtifact(version);if(snapshot.kind!=='data_snapshot')throw new Error('锁定的数据快照不存在');
      const dataset=this.snapshots.bindingDataset(binding.dataset.sourceId,binding.dataset.capability);
      datasets.set(binding.id,{table:'',version,cap,coverage:snapshot.content.coverage as Data});
      if(!sources.some(s=>s.snapshotId===version))sources.push({id:binding.dataset.sourceId,name:this.memory.getArtifact(binding.dataset.sourceId).title,capability:binding.dataset.capability,
        readMode:'snapshot',datasetId:dataset?.id??null,snapshotId:version,dataAsOf:String(snapshot.content.syncedAt),coverage:snapshot.content.coverage as Data,status:'read'});
    }
    const decisions=identityDecisionsForModel(this.memory,stored,options.identityDecisionPins??true).filter(d=>layered.bindings.identityRules.some(r=>r.id===d.content.ruleId&&datasets.has(r.left.bindingId)&&datasets.has(r.right.bindingId)));
    for(const decision of decisions){const captured=await captureIdentityDecision(this.live,stored,decision.content,{...options,pins:reader.pins,readMode:reader.readMode,assertActive});assertActive();reader.assertValid();if(captured.fingerprint!==decision.content.fingerprint||captured.scopeFingerprint!==decision.content.scopeFingerprint)throw new Error('身份决定依赖的事实或规则已变化，请重新复验');}
    const corrections:Artifact[]=[];
    if(options.correctionPins!==false&&query.traverse.length){
      const records=correctionRecords(this.memory,options.correctionPins&&options.correctionPins!==true?options.correctionPins:undefined);
      for(const record of records){
        const saved=record.content.target as unknown as CorrectionTarget,relation=(record.content.snapshot as Data)?.relation as Data;
        if(!['adopted',...(options.correctionPins&&options.correctionPins!==true?['superseded']:[])].includes(record.status)||saved.modelId!==stored.id||saved.modelVersion!==stored.version||!query.traverse.some(t=>t.relationTypeId===relation?.relationId))continue;
        const checked=await captureRelation(this.live,saved,record.content.targetIds as string[],assertActive,{readMode:reader.readMode,pins:reader.pins,fixedSemantic:options.fixedSemantic??false,modelDefinition:model.content,identityDecisionPins:options.identityDecisionPins});
        if(checked.fingerprint!==(record.content.snapshot as Data).fingerprint)throw new Error('局部纠正依赖的事实已变化，请重新复验');corrections.push(record);
      }
    }
    const currentProperties=()=>propertyCorrectionsForModel(this.memory,stored,options.propertyCorrectionPins??true).filter(record=>record.content.entityTypeId===target.id);
    const selectedProperties=currentProperties(),propertyRefs=(records:Artifact[])=>JSON.stringify(records.map(record=>[record.id,record.version]));
    const assertProperties=()=>{assertActive();reader.assertValid();if((options.propertyCorrectionPins??true)===true&&propertyRefs(selectedProperties)!==propertyRefs(currentProperties()))throw new Error('属性纠正决定已变化，请重新读取');};
    const propertyCorrections=await validatePropertyCorrections(this.live,stored,selectedProperties,{...options,modelDefinition:model.content,pins:reader.pins,readMode:reader.readMode,assertActive:assertProperties});
    assertProperties();
    const compiler=new QuerySql(layered,datasets,decisions,corrections,propertyCorrections),sql=compiler.select(query,fields,options.includeGroupMembers);
    const execution={signal:options.signal,timeoutMs:options.timeoutMs};
    const [result,metadata]=await Promise.all([this.snapshots.read(compiler.inputs,sql,{...execution,limit:query.page.limit,offset:query.page.offset}),compiler.metadataSql?this.snapshots.read(compiler.inputs,compiler.metadataSql,{...execution,limit:1}):undefined]);
    const uncertainFilterRows=Number(metadata?.rows[0]?.uncertainFilterRows??0);
    const traversal=metadata&&query.traverse.some(step=>step.recursive)?{cycleDetected:metadata.rows[0]?.cycleDetected===true,truncated:metadata.rows[0]?.truncated===true,maxDepth:Number(metadata.rows[0]?.maxDepth)}:undefined;
    assertProperties();
    if(query.aggregate&&result.total>1000)throw new Error('聚合分组超过 1000，请缩小查询范围');
    const outputFields=query.aggregate?[...query.aggregate.groupBy,...query.aggregate.measures.map(m=>m.as)]:fields;
    const value=(key:string,row:Record<string,Json>):Json=>{const cell=row[compiler.resultAlias(key,query)];return cell===null?null:JSON.parse(String(cell));};
    const items=result.rows.map((row,index)=>({$id:query.aggregate?'group:'+String(query.page.offset+index):String(row.__id),values:Object.fromEntries(outputFields.map(id=>[id,value(id,row)]))}));
    const paths=compiler.traversalPath&&!query.aggregate?result.rows.map(row=>{
      const traces=row.__paths?JSON.parse(String(row.__paths)) as Array<{objectIds:string[];relationTypeIds:string[];entityTypeIds:string[]}>:[],total=Number(row.__pathCount);
      return {objectId:String(row.__id),relationTypeId:compiler.traversalPath!.relationTypeId,paths:traces.map(trace=>trace.objectIds),traces,limit:20,coverage:{total,shown:traces.length,complete:total<=20}};
    }):undefined;
    const evidence=query.aggregate?[]:result.rows.map(row=>({objectId:String(row.__id),properties:Object.fromEntries(fields.map(id=>{
      const correction=propertyCorrections.find(record=>record.content.objectId===String(row.__id)&&record.content.propertyId===id);
      return [id,{status:row[compiler.statusAlias(id)],value:value(id,row),bindings:layered.bindings.properties.filter(b=>b.propertyId===id).map(b=>({bindingId:b.entityBindingId,column:b.column,snapshotId:datasets.get(b.entityBindingId)?.version})),...(correction?{correction:{id:correction.id,version:correction.version,reason:correction.content.reason,evidence:correction.content.evidence,snapshot:correction.content.snapshot}}:{})}];
    }))}));
    const aggregateEvidence=query.aggregate?result.rows.map((row,index)=>({groupId:'group:'+String(query.page.offset+index),measures:Object.fromEntries(query.aggregate!.measures.map((m,i)=>[m.as,{uncertain:Number(row['uncertain'+i]??0),missing:Number(row['missing'+i]??0)}]))})):undefined;
    const uncertainAggregate=aggregateEvidence?.some(group=>Object.values(group.measures).some(measure=>measure.uncertain>0))??false;
    const completeSources=sources.every(s=>s.coverage?.complete===true);
    const groupMembers=query.aggregate&&options.includeGroupMembers?result.rows.map((row,index)=>{
      const members=row.__members?JSON.parse(String(row.__members)) as Array<{objectId:string;values:Record<string,string|null>;status:Record<string,string>}>:[],total=Number(row.__memberTotal);
      return {groupId:items[index].$id,items:members.map(member=>({$id:member.objectId,values:Object.fromEntries(Object.entries(member.values).map(([id,value])=>[id,value===null?null:JSON.parse(value)])),status:member.status})),coverage:{total:completeSources?total:null,shown:members.length,complete:completeSources&&total<=20}};
    }):undefined;
    return {items,evidence,...(aggregateEvidence?{aggregateEvidence}:{}),...(groupMembers?{groupMembers}:{}),...(paths?{paths}:{}),governance:{identityDecisions:decisions.map(d=>({id:d.id,version:d.version})),corrections:corrections.map(d=>({id:d.id,version:d.version})),propertyCorrections:propertyCorrections.map(d=>({id:d.id,version:d.version}))},...(traversal?{traversal}:{}),columns:outputFields.map(id=>{const p=layered.semantic.properties.find(p=>p.id===id);return{id,name:p?.name??id,valueType:p?.valueType??'decimal'};}),
      coverage:{offset:query.page.offset,shown:items.length,total:completeSources&&uncertainFilterRows===0?result.total:null,uncertainFilterRows,uncoveredProperties:[...new Set(evidence.flatMap(e=>Object.entries(e.properties).filter(([,p])=>p.status!=='resolved').map(([id])=>id)))],complete:completeSources&&uncertainFilterRows===0&&!uncertainAggregate&&!traversal?.truncated&&!traversal?.cycleDetected&&query.page.offset===0&&items.length===result.total,sourceComplete:completeSources},
      ...(prepared?{preview:true}:{}),readMode:reader.readMode,versions:{ontology:prepared?null:(model.content.foundationRef??null) as {id:string;version:number}|null,mapping:prepared?null:{id:model.id,version:model.version}},
      sources,consistency:readingConsistency(reader.readMode,sources),multiSourceTime:multipleSourceTimes};
  }
}
