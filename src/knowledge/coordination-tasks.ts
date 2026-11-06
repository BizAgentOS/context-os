import {fingerprint} from './sources.ts';
import {modelRequestSize} from './model.ts';
import {compactCoordinationSchema} from './compact-coordination-schema.ts';
export const COORDINATION_REQUEST_LIMIT=48000;
type Json=any;
export interface CoverageSlice {path:Array<string|number>;offset:number;length:number;total:number;kind:'array'|'text';}
export interface CoordinationPage {input:Json; slices:CoverageSlice[];}
const copy=<T>(v:T):T=>structuredClone(v);
const at=(value:Json,path:Array<string|number>)=>path.reduce((v,k)=>v[k],value);
function replace(value:Json,path:Array<string|number>,part:Json){const result=copy(value);if(!path.length)return part;at(result,path.slice(0,-1))[path.at(-1)!]=part;return result;}
/** Lossless recursive request partition. Every array item/text code point belongs
 * to explicit coverage slices. No prefix is silently discarded, including when
 * a single property, declaration, uncertainty, or global directory is large. */
export function coordinationPages(input:Json,limit=COORDINATION_REQUEST_LIMIT):CoordinationPage[]{
  const output:CoordinationPage[]=[];
  const visit=(value:Json,slices:CoverageSlice[])=>{
    const decorated={...value,inputCoverage:{complete:slices.length===0,slices,rule:'本页为显式部分上下文；不得将未在本页出现的成员、候选或代码判为不存在。复合键分片不能作为完整绑定；只有完整疑问可按原索引解疑。'}};
    if(modelRequestSize('discover',decorated,compactCoordinationSchema)<=limit){output.push({input:decorated,slices});return;}
    const choices:Array<{path:Array<string|number>;size:number;kind:'array'|'text'}>=[];
    const scan=(v:Json,path:Array<string|number>)=>{
      if(path.at(-1)==='jointEvidence'||value.coverage&&path.at(-1)==='globalDirectory')return;
      if(['sourceColumns','targetColumns','columns','targetCandidateTypes','targetTypeScopeCandidates'].includes(String(path.at(-1))))return;
      if(Array.isArray(v)){if(v.length>1)choices.push({path,size:Buffer.byteLength(JSON.stringify(v)),kind:'array'});v.forEach((item,i)=>scan(item,[...path,i]));}
      else if(v&&typeof v==='object'){for(const [key,child]of Object.entries(v))if(!['ref','id','sourceVersionId','coordinationFormat','stage','instructions','businessQuestion'].includes(key))scan(child,[...path,key]);}
      else if(typeof v==='string'&&[...v].length>1)choices.push({path,size:Buffer.byteLength(v),kind:'text'});
    };
    scan(value,[]);choices.sort((a,b)=>b.size-a.size);
    const choice=choices[0];
    if(!choice)throw new Error('协调协议最小信封超过配置预算，尚未调用模型；不能截断合同或报告分析完成');
    const original=at(value,choice.path),items=choice.kind==='array'?original:[...original],middle=Math.ceil(items.length/2);
    const prior=slices.findLast(s=>JSON.stringify(s.path)===JSON.stringify(choice.path)&&s.kind===choice.kind);
    for(const [offset,length]of [[0,middle],[middle,items.length-middle]]){
      const part=items.slice(offset,offset+length),slice:CoverageSlice={path:choice.path,offset:(prior?.offset??0)+offset,length,total:prior?.total??items.length,kind:choice.kind};
      visit(replace(value,choice.path,choice.kind==='array'?part:part.join('')),[...slices,slice]);
    }
  };
  visit(input,[]);return output;
}
export function taskIdentity(kind:string,scope:unknown){return `coordinate:${kind}:${fingerprint(scope).slice(0,24)}`;}
/** Full pairwise page coverage keeps global discovery even when the directory
 * cannot fit a single request. Each catalog pair is checked exactly once. */
export function catalogPairs<T>(items:T[],pageSize=8):Array<{left:T[];right:T[];i:number;j:number}>{
  const pages:Array<T[]>=[];let page:T[]=[];
  for(const item of items){if(page.length&&(page.length>=pageSize||Buffer.byteLength(JSON.stringify([...page,item]))>12000)){pages.push(page);page=[];}page.push(item);}
  if(page.length)pages.push(page);
  if(!pages.length)pages.push([]);
  return pages.flatMap((left,i)=>pages.slice(i).map((right,k)=>({left,right:k===0?[]:right,i,j:i+k})));
}

/** Atomic source/profile windows. Composite constraints and each column stay
 * together. Oversized prose is explicitly segmented with context and offsets;
 * every segment is paired with every other window, never separate-source pages.
 * These are evidence comparison windows, not assertions of object identity. */
export function semanticWindows(sources:any[],maxBytes=5500):any[][] {
  const units:any[]=[];
  const add=(context:any,value:any)=>{
    if(Buffer.byteLength(JSON.stringify({context,value}))<=maxBytes){units.push({context,value});return;}
    if(Array.isArray(value)&&value.length>1){for(const [index,item]of value.entries())add({...context,index},item);return;}
    if(value&&typeof value==='object'&&!Array.isArray(value)){for(const [field,item]of Object.entries(value))add({...context,field},item);return;}
    if(typeof value==='string'&&[...value].length>1){const chars=[...value],size=Math.max(1,Math.floor(maxBytes/8));for(let offset=0;offset<chars.length;offset+=size)add({...context,textSlice:{offset,total:chars.length}},chars.slice(offset,offset+size).join(''));return;}
    throw new Error('完整业务键或来源标识超过最小比较窗口预算；不能把未联合检查标为覆盖完成');
  };
  for(const source of sources){
    const {metadata,keyProfiles,...header}=source;add({sourceVersionId:source.id,kind:'source_header'},header);
    if(keyProfiles){const {columns,profile,...rest}=keyProfiles;add({sourceVersionId:source.id,kind:'profile_scope'}, {...rest,profile:profile?{...profile,columns:undefined}:undefined});
      for(const c of columns??[])add({sourceVersionId:source.id,kind:'column_profile',column:c.column},{...c,observed:profile?.columns?.find((p:any)=>p.column===c.column)});}
    for(const [field,value]of Object.entries(metadata??{})){
      if(value===undefined||value===null)continue;
      // Key tuples remain complete in every window, including unusually wide keys.
      if(['primaryKey','uniqueKeys','foreignKeys'].includes(field)){
        const groups=new Map<string,any[]>();if(field==='foreignKeys')for(const fk of value as any[]){const key=JSON.stringify([fk.name,fk.targetSchema,fk.targetTable]);groups.set(key,[...(groups.get(key)??[]),fk]);}
        const tuples=field==='primaryKey'?[value]:field==='foreignKeys'?[...groups.values()].map(g=>g.sort((a,b)=>a.ordinal-b.ordinal)):value as any[];
        for(const tuple of tuples){const unit={context:{sourceVersionId:source.id,kind:field},value:tuple};if(Buffer.byteLength(JSON.stringify(unit))>maxBytes)throw new Error('完整复合键超过比较窗口预算，覆盖未完成');units.push(unit);}}
      else if(field==='columns')for(const column of value as any[])add({sourceVersionId:source.id,kind:'column',column:column.name},column);
      else add({sourceVersionId:source.id,kind:field},value);
    }
  }
  const windows:any[][]=[];let window:any[]=[];
  for(const unit of units){if(window.length&&Buffer.byteLength(JSON.stringify([...window,unit]))>maxBytes){windows.push(window);window=[];}window.push(unit);}
  if(window.length)windows.push(window);return windows.length?windows:[[]];
}
