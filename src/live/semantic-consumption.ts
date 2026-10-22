import {z} from 'zod';
import {metricReferenceSchema} from '../semantic/metric-contract.ts';
import {readMetricReference,semanticMetricQuerySchema,publicMetric} from '../semantic/metric-reading.ts';
import type {Artifact,Data} from '../agent/contracts.ts';
import type {MemoryStore} from '../agent/memory.ts';
import type {LiveMemory} from './memory.ts';
import {parseLayeredModel,layeredModelSchema} from '../semantic/model.ts';
import {SemanticQuery} from '../semantic/query.ts';
import {semanticQuerySchema,type SemanticQueryOptions} from '../semantic/query-contract.ts';
import {consumerSemanticScope,consumerResult,assertConsumerQueryScope,ConsumerScopeError} from './consumer-semantic.ts';
import {snapshotPinsForRelease,correctionPinsForRelease,identityDecisionPinsForRelease,propertyCorrectionPinsForRelease} from './release-pins.ts';
import {jsonData} from './sources.ts';

const name=z.string().trim().min(1).max(200);
// Omitted extensions must stay absent so ordinary MCP reads retain the legacy live/mixed contract.
export const externalObjectsSchema=z.object({type:name,id:z.string().min(1).max(16384).optional(),relation:name.optional(),fields:z.array(name.refine(value=>!value.includes(','))).min(1).max(100).optional(),offset:z.number().int().min(0).safe().optional(),limit:z.number().int().min(1).max(20).optional(),filters:semanticQuerySchema.shape.filters.removeDefault().optional(),sort:semanticQuerySchema.shape.sort.removeDefault().optional()}).strict().refine(args=>!args.relation||!!args.id,'关系查询需要起点对象编号');
export const externalSemanticOperations=[
  {name:'traverse_relations',path:'/v4/traverse',description:'沿授权的稳定关系编号向前或回溯最多3跳；自引用最多10层。对象与属性保持发布版本固定，实际覆盖与截断单独返回。',schema:semanticQuerySchema.refine(query=>query.traverse.length>0&&!query.aggregate,'需要关系路径且不能混入聚合')},
  {name:'aggregate_objects',path:'/v4/aggregate',description:'对获准的稳定属性编号执行count/sum/avg/min/max，可分组、过滤；最多1000组。计数作用于完整固定快照，不把未知或冲突当零。',schema:semanticQuerySchema.refine(query=>!!query.aggregate,'需要明确聚合指标')},
  {name:'search_ontology',path:'/v4/search',description:'按名称、别名、说明搜索此接入方获准的实体、属性与关系，返回稳定语义编号；不会搜索原始文档或隐藏定义。',schema:z.object({query:z.string().trim().min(1).max(500),offset:z.number().int().min(0).safe().default(0),limit:z.number().int().min(1).max(20).default(20)}).strict()},
  {name:'query_metric',path:'/v4/metrics',description:'读取显式获准指标的实际观测，过滤使用其稳定维度属性编号。固定定义口径、粒度、时区和可加总性；不承诺历史口径重算。',schema:semanticMetricQuerySchema},
] as const;

/** Additional v4 operations consume the same fixed semantics and grant compiler as consumer QA. */
export class SemanticConsumption {
  private memory:MemoryStore;private live:LiveMemory;
  constructor(memory:MemoryStore,live:LiveMemory){this.memory=memory;this.live=live;}
  private view(dataset:Artifact,assertActive:()=>void){
    assertActive();const releaseRef=dataset.content.releaseRef as {id:string;version:number}|undefined;
    if(!releaseRef)throw new Error('此历史接入没有固定发布，不支持扩展查询');
    const release=this.memory.getArtifact(releaseRef.id,releaseRef.version);
    if(release.kind!=='data_release'||release.status!=='published')throw new Error('发布版本不可读取');
    const definition=release.content.definition as Data,foundationRef=release.content.foundationRef as {id:string;version:number},foundation=this.memory.getArtifact(foundationRef.id,foundationRef.version);
    const modelRef=release.content.modelRef as {id:string;version:number}|null,modelDefinition=definition.model?jsonData({...definition.model as Data,foundationRef}):undefined;
    const properties=Object.keys(layeredModelSchema.shape.semantic.shape.properties.element.shape);
    const layered=modelDefinition?parseLayeredModel(modelDefinition.layered):parseLayeredModel({schemaVersion:1,semantic:{entityTypes:(foundation.content.concepts as Data[]).map(item=>({id:item.id,name:item.name,aliases:item.aliases??[],description:item.description,identityKeys:item.identityKeys??[],kind:item.kind??'record'})),metricReferences:definition.metricReferences??[],properties:((foundation.content.properties??[]) as Data[]).map(item=>Object.fromEntries(properties.filter(key=>item[key]!==undefined).map(key=>[key,item[key]]))),relationTypes:((foundation.content.relations??[]) as Data[]).map(item=>({id:item.id,name:item.name,aliases:item.aliases??[],description:item.description,from:item.from,to:item.to,cardinality:item.cardinality??'N:N',allowSelf:item.from===item.to}))},bindings:{entities:[],properties:[],relations:[],identityRules:[]}});
    layered.semantic.metricReferences=metricReferenceSchema.array().parse(definition.metricReferences??[]);
    const options:SemanticQueryOptions={modelRef:modelRef??undefined,modelDefinition,fixedSemantic:true,readMode:'release_pinned',pins:snapshotPinsForRelease(definition),correctionPins:new Set(correctionPinsForRelease(definition)),identityDecisionPins:new Set(identityDecisionPinsForRelease(definition)),propertyCorrectionPins:new Set(propertyCorrectionPinsForRelease(definition))};
    const scope=consumerSemanticScope(this.memory,this.live,dataset,layered,options);
    const assertValid=()=>{assertActive();scope.assertValid();if(modelRef)this.live.assertModel(modelRef.id,modelRef.version,true,options.pins,modelDefinition);};
    assertValid();return{...scope,assertValid,modelRef};
  }
  async execute(dataset:Artifact,path:string,input:unknown,assertActive:()=>void=()=>{}):Promise<Data>{
    const view=this.view(dataset,assertActive),semantic=view.layered.semantic;
    if(path==='/v4/search'){
      const args=externalSemanticOperations[2].schema.parse(input),term=args.query.toLocaleLowerCase();
      const all=[...semantic.entityTypes.map(item=>({...item,kind:'entity'})),...semantic.properties.map(item=>({...item,kind:'property'})),...semantic.relationTypes.map(item=>({...item,kind:'relation'})),...semantic.metricReferences.map(item=>({...publicMetric(item),aliases:[],kind:'metric_reference'}))].filter(item=>[item.name,item.description,...item.aliases].some(text=>text.toLocaleLowerCase().includes(term)));
      view.assertValid();return jsonData({items:all.slice(args.offset,args.offset+args.limit),coverage:{offset:args.offset,total:all.length,complete:args.offset===0&&all.length<=args.limit}});
    }
    if(path==='/v4/metrics'){
      const args=semanticMetricQuerySchema.parse(input);
      const metric=semantic.metricReferences.find(item=>item.id===args.metricReferenceId);
      if(!metric||Object.keys(args.where).some(id=>!metric.dimensions.some(mapping=>mapping.propertyId===id)))throw new ConsumerScopeError('指标或维度不在接入方授权范围');
      const read=await readMetricReference(this.live,semantic.metricReferences,args,view.assertValid);
      view.assertValid();return jsonData({...read.result,status:read.status,reason:read.reason,message:read.message});
    }
    if(!view.modelRef)throw new ConsumerScopeError('此接入未开放业务记录');
    let expression:unknown=input,legacy=false;
    if(path==='/v4/objects'){
      const args=externalObjectsSchema.parse(input),entity=semantic.entityTypes.find(item=>item.name===args.type||item.id===args.type);
      if(!entity)throw new ConsumerScopeError('类型不在接入方授权范围');
      const relation=args.relation?semantic.relationTypes.find(item=>item.from===entity.id&&(item.name===args.relation||item.id===args.relation)):undefined;
      if(args.relation&&!relation)throw new ConsumerScopeError('关系不在接入方授权范围');
      const target=relation?.to??entity.id;
      const fields=args.fields?.filter(field=>field!=='$id').map(field=>{const property=semantic.properties.find(item=>item.entityTypeId===target&&(item.name===field||item.id===field));if(!property)throw new ConsumerScopeError('属性不在接入方授权范围');return property.id;});
      expression={target:{entityTypeId:entity.id,id:args.id},fields,filters:args.filters,sort:args.sort,traverse:relation?[{relationTypeId:relation.id}]:[],page:{offset:args.offset??0,limit:args.limit??20}};legacy=true;
    }else{
      const operation=externalSemanticOperations.find(item=>item.path===path);if(!operation)throw new Error('查询接口不存在');expression=operation.schema.parse(input);
    }
    const query=semanticQuerySchema.parse(expression);assertConsumerQueryScope(query,view.options.scope!);
    if(!this.live.snapshots?.read)throw new Error('查询需要可读取的固定快照');
    const result=await new SemanticQuery(this.memory,this.live,{read:(...args)=>this.live.snapshots!.read!(...args),bindingDataset:(...args)=>this.live.snapshots!.bindingDataset?.(...args)}).execute(query,{...view.options,maxPageSize:query.aggregate?100:20,assertActive:view.assertValid});
    view.assertValid();const safe=consumerResult(jsonData(result),dataset.id);
    if(legacy)safe.items=result.items.map(item=>({$id:item.$id,...Object.fromEntries(Object.entries(item.values).map(([id,value])=>[semantic.properties.find(property=>property.id===id)!.name,value]))}));
    return safe;
  }
}
