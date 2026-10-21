import {z} from 'zod';
import type {Artifact,Data} from './contracts.ts';
import type {MemoryStore} from './memory.ts';
import type {FoundationService} from './foundation.ts';
import type {LiveMemory} from '../live/memory.ts';
import type {WorkspaceVersions} from '../engine/workspace-versions.ts';
import {readStructure} from '../engine/structure-changes.ts';
import {parseLayeredModel,layeredModelSchema,type LayeredModel} from '../semantic/model.ts';
import type {SemanticQueryOptions} from '../semantic/query.ts';
import {snapshotPinsForRelease,correctionPinsForRelease,identityDecisionPinsForRelease,propertyCorrectionPinsForRelease} from '../live/release-pins.ts';
import {consumerSemanticScope} from '../live/consumer-semantic.ts';
import {jsonData} from '../live/sources.ts';

export const qaReference=z.object({id:z.string().min(1).max(200),version:z.number().int().positive()}).strict();
export const qaDataViewSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('working')}).strict(),
  z.object({kind:z.literal('release'),releaseRef:qaReference}).strict(),
  z.object({kind:z.literal('consumer'),releaseRef:qaReference,connectionRef:qaReference}).strict(),
]);
export type QaDataView=z.infer<typeof qaDataViewSchema>;
export interface QaView {
  selection:QaDataView;receipt:Data;layered:LayeredModel;foundation:Artifact|null;model:Artifact|null;
  options:SemanticQueryOptions;assertValid():void;evidencePropertyIds?:ReadonlySet<string>;
  businessEntityIds?:ReadonlySet<string>;
}
const ref=(artifact:Artifact|null)=>artifact?{id:artifact.id,version:artifact.version}:null;
const set=(value:unknown)=>new Set(Array.isArray(value)?value as string[]:[]);

/** The administrator chooses a view; its definitions, grants and pins are resolved only by the server. */
export function freezeQaView(memory:MemoryStore,foundation:FoundationService,live:LiveMemory,versions:WorkspaceVersions,input:unknown,assertActive:()=>void=()=>{}):QaView {
  assertActive();
  const selection=qaDataViewSchema.parse(input??{kind:'working'});
  let model:Artifact|null,semantic:Artifact|null,layered:LayeredModel,options:SemanticQueryOptions,receipt:Data;
  let authorize=()=>{},evidencePropertyIds:ReadonlySet<string>|undefined,businessEntityIds:ReadonlySet<string>|undefined;
  if(selection.kind==='working'){
    semantic=foundation.read().adopted;model=memory.listArtifacts('live_ontology').find(item=>item.status==='adopted')??null;
    layered=readStructure(memory,foundation,live);
    const current=versions.composition(),projected=model?live.projectModel(model):null;
    options={modelRef:model?ref(model)!:undefined,fixedSemantic:true,readMode:'active_snapshot',modelDefinition:projected?.content,
      pins:model?live.identityReader(projected!).pins:{},correctionPins:set(current.corrections),identityDecisionPins:set(current.identityDecisions),propertyCorrectionPins:set(current.propertyCorrections)};
    receipt=jsonData({dataView:selection,workspaceRef:ref(versions.latest()),workspaceVersion:versions.latest()?.content.number??0,foundationRef:ref(semantic),modelRef:ref(model)});
  }else{
    const release=memory.getArtifact(selection.releaseRef.id,selection.releaseRef.version);
    if(release.kind!=='data_release'||release.status!=='published')throw new Error('所选发布不存在或不可读取');
    const definition=release.content.definition as Data,modelRef=release.content.modelRef as {id:string;version:number}|null;
    const foundationRef=release.content.foundationRef as {id:string;version:number};semantic=memory.getArtifact(foundationRef.id,foundationRef.version);
    model=modelRef?memory.getArtifact(modelRef.id,modelRef.version):null;
    const modelDefinition=definition.model?jsonData({...definition.model as Data,foundationRef}):undefined;
    const propertyKeys=Object.keys(layeredModelSchema.shape.semantic.shape.properties.element.shape);
    layered=modelDefinition?parseLayeredModel(modelDefinition.layered):parseLayeredModel({schemaVersion:1,semantic:{entityTypes:(semantic.content.concepts as Data[]).map(item=>({id:item.id,name:item.name,aliases:item.aliases??[],description:item.description,identityKeys:item.identityKeys??[],kind:item.kind??'record'})),
      properties:((semantic.content.properties??[]) as Data[]).map(item=>Object.fromEntries(propertyKeys.filter(key=>item[key]!==undefined).map(key=>[key,item[key]]))),
      relationTypes:((semantic.content.relations??[]) as Data[]).map(item=>({id:item.id,name:item.name,aliases:item.aliases??[],description:item.description,from:item.from,to:item.to,cardinality:item.cardinality??'N:N',allowSelf:item.from===item.to}))},bindings:{entities:[],properties:[],relations:[],identityRules:[]}});
    options={modelRef:modelRef??undefined,modelDefinition,fixedSemantic:true,readMode:'release_pinned',pins:snapshotPinsForRelease(definition),
      correctionPins:new Set(correctionPinsForRelease(definition)),identityDecisionPins:new Set(identityDecisionPinsForRelease(definition)),propertyCorrectionPins:new Set(propertyCorrectionPinsForRelease(definition))};
    receipt=jsonData({dataView:selection,releaseRef:ref(release),foundationRef,modelRef});
    if(selection.kind==='consumer'){
      const connection=memory.getArtifact(selection.connectionRef.id),datasetRef=connection.content.datasetRef as {id:string;version:number};
      if(connection.kind!=='release_connection'||connection.status!=='active'||connection.version!==selection.connectionRef.version||JSON.stringify(connection.content.releaseRef)!==JSON.stringify(selection.releaseRef))throw new Error('接入方状态、版本或发布范围已变化');
      const dataset=memory.getArtifact(datasetRef.id);
      if(dataset.version!==datasetRef.version)throw new Error('接入方数据授权已变化');
      const scoped=consumerSemanticScope(memory,live,dataset,layered,options);
      authorize=()=>{
        const current=memory.getArtifact(connection.id);
        if(current.status!=='active'||current.version!==connection.version)throw new Error('接入方已停用或变化');
        scoped.assertValid();
      };
      authorize();layered=scoped.layered;options=scoped.options;evidencePropertyIds=scoped.evidencePropertyIds;businessEntityIds=scoped.businessEntityIds;
    }
  }
  const assertValid=()=>{assertActive();authorize();if(model)live.assertModel(model.id,model.version,true,options.pins,options.modelDefinition);};
  assertValid();return {selection,receipt,layered,foundation:semantic,model,options,assertValid,evidencePropertyIds,businessEntityIds};
}
