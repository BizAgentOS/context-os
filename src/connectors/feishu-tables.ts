import {z} from "zod";
import type {Artifact,Data,Repository} from "../agent/contracts.ts";
import {FeishuConnector,feishuBaseUrl} from "./feishu.ts";
import {continuation,resume,pagingScope} from "../live/source-pagination.ts";

const identifier=z.string().trim().min(1).max(200),url=z.string().url().max(2048);
const selectInput=z.object({operationId:identifier,url,tableIds:z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1).max(20)}).strict();
const data=(value:unknown):Data=>JSON.parse(JSON.stringify(value));
const scalar=new Set(["text","number","checkbox","datetime","created_at","updated_at","auto_number","formula","lookup"]);
const complex=new Set(["select","user","group_chat","created_by","updated_by","link","attachment","location"]);
type Field={id:string;name:string;type:string;multiple:boolean;encoding:"scalar"|"json"};
type Binding={url:string;tableId:string;accountKey:string;fields:Field[]};
export class FeishuPageChanged extends Error { constructor(){super("飞书表格在分页期间发生变化，本次快照未生效；请重新同步");} }

/** Only explicitly selected tables become scheduled sources. No CLI command or credential is supplied by a caller. */
export class FeishuTableConnections {
  private repo:Repository;private connector:FeishuConnector;private saved:(source:Artifact)=>void;
  constructor(repo:Repository,connector:FeishuConnector,saved:(source:Artifact)=>void) {this.repo=repo;this.connector=connector;this.saved=saved;}
  async browse(input:unknown){const args=z.object({url,offset:z.number().int().min(0).max(10000).default(0)}).strict().parse(input);return this.connector.tableDirectory(args.url,args.offset);}
  async describe(input:unknown){
    const args=z.object({url,tableId:identifier}).strict().parse(input),fields=await this.connector.tableFields(args.url,args.tableId);
    return {fields:fields.map(field=>({...field,supported:scalar.has(field.type)||complex.has(field.type),encoding:complex.has(field.type)?"json":"scalar",mappedType:field.type==="number"?"number":field.type==="checkbox"?"boolean":"string"})),warnings:["按整张表同步；多值、人员、关联和附件字段保存为 JSON 文本，不展开记录或自动建立对象关系。","公式与查找字段按飞书导出的文本保存，不推断为数值。"]};
  }
  assertConnection(source:Artifact){if(source.kind!=="source_connection"||source.status!=="ready"||source.content.adapter!=="feishu")throw new Error("飞书表格来源已停用");this.connector.assertAccount((source.content.feishuTable as unknown as Binding).accountKey);}
  disconnect(){for(const source of this.repo.listArtifacts("source_connection").filter(item=>item.content.adapter==="feishu"&&item.status!=="disabled"))this.repo.putArtifact({...source,expectedVersion:source.version,status:"disabled"});}
  async select(input:unknown){
    const args=selectInput.parse(input),base=feishuBaseUrl(args.url),ids=[...new Set(args.tableIds)].sort();if(ids.length!==args.tableIds.length)throw new Error("不能重复选择同一张表");
    const signature=pagingScope({...args,url:base.url,tableIds:ids}),key=this.connector.accountKey();if(!key)throw new Error("请先连接飞书账号");
    const replay=()=>{const receipt=this.repo.listArtifacts("feishu_table_selection").find(item=>item.content.operationId===args.operationId);if(!receipt)return null;if(receipt.content.signature!==signature||receipt.content.accountKey!==key)throw new Error("接入操作标识已用于其他范围或账号");const sources=(receipt.content.sources as Data[]).map(ref=>this.repo.getArtifact(String(ref.id)));sources.forEach(source=>this.assertConnection(source));return {sources,warnings:receipt.content.warnings as string[]};};
    const previous=replay();if(previous)return previous;
    const available:Array<{id:string;name:string}>=[];let offset:number|null=0;
    while(offset!==null){const page=await this.connector.tableDirectory(base.url,offset,100);available.push(...page.tables);offset=page.coverage.nextOffset;if(available.length>10000)throw new Error("表格目录超过选择范围，请缩小来源");}
    const selected:Array<{table:{id:string;name:string};fields:Field[];warnings:string[]}>=[];
    for(const id of ids){
      const table=available.find(item=>item.id===id);if(!table)throw new Error("所选飞书数据表不存在或没有权限");
      const description=await this.describe({url:base.url,tableId:id});
      const fields=description.fields.filter(field=>field.supported).map(({id,name,type,multiple,encoding})=>({id,name,type,multiple,encoding})) as Field[];
      if(!fields.length||fields.length>99)throw new Error("所选表需有 1 至 99 个可读取字段；请在飞书整理后接入");
      const warnings=[...description.warnings,...description.fields.filter(field=>!field.supported).map(field=>`字段“${field.name}”类型 ${field.type} 暂不读取。`)];
      await this.connector.tableRecords({url:base.url,tableId:id,fieldIds:fields.map(field=>field.id),offset:0,limit:1,accountKey:key});
      selected.push({table,fields,warnings});
    }
    this.connector.assertAccount(key);
    const transaction=(this.repo as Repository & {atomic?:<T>(fn:()=>T)=>T}).atomic;if(!transaction)throw new Error("当前宿主不支持原子接入表格");
    const result=transaction.call(this.repo,()=>{
      const prior=replay();if(prior)return prior;this.connector.assertAccount(key);
      const sources=selected.map(({table,fields})=>{
        const before=this.repo.listArtifacts("source_connection").find(item=>item.content.adapter==="feishu"&&(item.content.feishuTable as unknown as Binding).url===base.url&&(item.content.feishuTable as unknown as Binding).tableId===table.id&&(item.content.feishuTable as unknown as Binding).accountKey===key);
        const binding:Binding={url:base.url,tableId:table.id,accountKey:key,fields};
        if(before?.status==="ready"&&pagingScope(before.content.feishuTable)===pagingScope(binding)&&before.title===table.name)return before;
        return this.repo.putArtifact({...(before?{id:before.id,expectedVersion:before.version}:{}),kind:"source_connection",title:table.name,status:"ready",content:data({name:table.name,protocol:"feishu",adapter:"feishu",url:base.url,feishuTable:binding,capabilities:[{name:"records",contentKind:"records",fields:["record_id",...fields.map(field=>field.name)],idField:"record_id",idType:"string",itemsPath:"items",limitParam:"limit",offsetParam:"offset",filters:{record_id:"record_id"}}]})});
      });
      const warnings=[...new Set(selected.flatMap(item=>item.warnings))];this.repo.putArtifact({kind:"feishu_table_selection",title:"已接入飞书数据表",status:"completed",content:data({operationId:args.operationId,signature,accountKey:key,sources:sources.map(source=>({id:source.id,version:source.version})),warnings})});return {sources,warnings};
    }) as {sources:Artifact[];warnings:string[]};
    result.sources.forEach(source=>this.saved(source));return result;
  }
  async readPage(source:Artifact,where:Data,offset:number,limit:number,cursor?:string){
    this.assertConnection(source);const binding=source.content.feishuTable as unknown as Binding;
    if(Object.keys(where).some(field=>field!=="record_id")||where.record_id!==undefined&&typeof where.record_id!=="string")throw new Error("飞书实时读取只支持按记录编号定位；其他筛选使用固定数据快照");
    const scope=pagingScope([source.id,source.version,where]),oldRevision=cursor?resume(cursor,scope,offset):undefined;
    if(offset&&!cursor&&!where.record_id)throw new Error("飞书分页需要上一页的明确续读回执");
    const page=await this.connector.tableRecords({url:binding.url,tableId:binding.tableId,fieldIds:binding.fields.map(field=>field.id),offset,limit,accountKey:binding.accountKey,...(where.record_id?{recordId:String(where.record_id)}:{})});
    this.assertConnection(this.repo.getArtifact(source.id));if(this.repo.getArtifact(source.id).version!==source.version)throw new Error("飞书来源读取范围已变化");
    if(oldRevision!==undefined&&oldRevision!==page.manifest.rev)throw new FeishuPageChanged();
    const columns=page.manifest.columns as Record<string,{field_id?:string;field_type?:string}>,mapped=new Map<string,Field>();
    if(!columns||typeof columns!=="object"||Array.isArray(columns))throw new Error("飞书字段映射回执缺失");
    for(const [name,column] of Object.entries(columns)){
      if(name==="record_id")continue;
      const field=binding.fields.find(field=>field.id===column.field_id);if(!field||field.type!==column.field_type)throw new Error("飞书字段类型或投影已变化，请重新选择来源");mapped.set(name,field);
    }
    if(mapped.size!==binding.fields.length)throw new Error("飞书返回字段缺失，请重新选择来源");
    const seen=new Set<string>(),items:Data[]=page.records.map(row=>{
      if(typeof row.record_id!=="string"||!row.record_id||seen.has(row.record_id)||where.record_id&&row.record_id!==where.record_id)throw new Error("飞书记录身份重复、缺失或与请求不一致");seen.add(row.record_id);
      const output:Data={record_id:row.record_id};
      for(const [name,field] of mapped){const value=row[name];if(value===undefined)throw new Error("飞书字段值缺失");if(value!==null&&(field.type==="number"?typeof value!=="number"||!Number.isFinite(value):field.type==="checkbox"?typeof value!=="boolean":field.encoding==="json"?typeof value!=="object":typeof value!=="string"))throw new Error("飞书字段值与声明类型不相容");output[name]=field.encoding==="json"&&value!==null?JSON.stringify(value):value as string|number|boolean|null;}
      return output;
    });
    const nextOffset=offset+items.length,more=page.manifest.has_more===true;
    return {items,observedFields:["record_id",...mapped.keys()],coverage:{offset,shown:items.length,total:more?null:nextOffset,complete:offset===0&&!more},continuation:more?continuation({scope,offset:nextOffset,next:Number(page.manifest.rev)}):null,
      provenance:{sourceId:source.id,connectionVersion:source.version,capability:"records",readAt:new Date().toISOString(),historicalReplay:false,remoteRevision:page.manifest.rev}};
  }
}
