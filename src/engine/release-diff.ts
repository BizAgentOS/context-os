import { createHash } from "node:crypto";
import type { Data, Json } from "../agent/contracts.ts";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const fingerprint = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export interface ReleaseDifference {
  path: string;
  kind: "added" | "removed" | "changed";
  before: Json;
  after: Json;
}

/** Compare actual semantic content; keyed lists retain stable object identities. */
export function releaseDiff(before: unknown, after: unknown, path = ""): ReleaseDifference[] {
  if (canonical(before) === canonical(after)) return [];
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const keyed = (v: unknown[]): Record<string, unknown> | null => {
    if (!v.every(item => plain(item) && typeof (item.id ?? item.name ?? item.sourceId) === "string")) return null;
    const pairs = v.map(item => {
      const r = item as Record<string, unknown>;
      return [String(r.id ?? (r.from ? `${r.from}/${r.name}` : r.name) ?? r.sourceId), r] as const;
    });
    return new Set(pairs.map(([k]) => k)).size === pairs.length ? Object.fromEntries(pairs) : null;
  };
  if (Array.isArray(before) && Array.isArray(after)) {
    const a = keyed(before), b = keyed(after);
    if (a && b) return releaseDiff(a, b, path);
  }
  if (plain(before) && plain(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(k => releaseDiff(before[k], after[k], `${path}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}`));
  return [{ path: path || "/", kind: before === undefined ? "added" : after === undefined ? "removed" : "changed", before: (before ?? null) as Json, after: (after ?? null) as Json }];
}

/** Business objects are compared once by their stable identity; technical JSON paths remain available separately. */
export function releaseObjectDiff(before:unknown,after:unknown){
  const records=(input:unknown)=>{
    const definition=(input??{}) as Data,model=(definition.model??{}) as Data,layered=(model.layered??{}) as Data,semantic=(layered.semantic??{}) as Data,bindings=(layered.bindings??{}) as Data;
    const rows=(value:unknown):Data[]=>Array.isArray(value)?value:[];
    const merge=(a:Data[],b:Data[])=>[...new Map([...a,...b].map(item=>[String(item.id),item])).values()];
    const entities=merge(rows(semantic.entityTypes),rows(definition.concepts)),properties=merge(rows(semantic.properties),rows(definition.properties)),relations=merge(rows(semantic.relationTypes),rows(definition.relations));
    const entityName=(id:unknown)=>String(entities.find(item=>item.id===id)?.name??'业务对象');
    const object=(kind:string,item:Data,name=String(item.name??'业务对象'))=>({kind,id:String(item.id),name,entityTypeId:kind==='entity'?item.id:item.entityTypeId??item.from??null,value:item});
    const clean=(item:Data,fields:string[])=>Object.fromEntries(fields.filter(key=>item[key]!==undefined).map(key=>[key,item[key]])) as Data;
    return new Map([
      ...entities.map(item=>object('entity',clean(item,['id','name','aliases','description','kind','identityKeys','deprecated']))),
      ...properties.map(item=>object('property',clean(item,['id','name','aliases','description','entityTypeId','valueType','unit','enumValues','isIdentity','deprecated']),`${entityName(item.entityTypeId)} · ${item.name}`)),
      ...relations.map(item=>object('relation',clean(item,['id','name','aliases','description','from','to','cardinality','allowSelf','deprecated']))),
      ...rows(definition.metricReferences).map(item=>object('metric_reference',item,`${entityName(item.entityTypeId)} · ${item.name}`)),
      ...rows(bindings.entities).map(item=>object('binding',item,`${entityName(item.entityTypeId)} · 数据绑定`)),
      ...rows(bindings.properties).map(item=>object('property_binding',{...item,id:`${item.entityBindingId}:${item.propertyId}`},`${properties.find(property=>property.id===item.propertyId)?.name??'属性'} · 字段绑定`)),
      ...rows(bindings.relations).map(item=>object('relation_binding',item,`${relations.find(relation=>relation.id===item.relationTypeId)?.name??'关系'} · 关系绑定`)),
      ...rows(bindings.identityRules).map(item=>object('identity_rule',item,'身份对应规则')),
      ...rows(definition.identityDecisions).map(item=>object('identity_decision',item,'记录身份决定')),
      ...rows(definition.corrections).map(item=>object('correction',item,'对象关系纠正')),
      ...rows(definition.propertyCorrections).map(item=>object('property_correction',item,'对象属性纠正')),
    ].map(item=>[`${item.kind}:${item.id}`,item]));
  };
  const old=records(before),next=records(after),labels:Record<string,string>={name:'名称',aliases:'别名',description:'说明',valueType:'值类型',unit:'单位',enumValues:'枚举范围',isIdentity:'身份属性',identityKeys:'身份字段',from:'起点',to:'终点',cardinality:'数量约束',dataset:'数据来源',column:'字段映射',transform:'转换',targetIds:'目标集合',value:'纠正值',decision:'身份决定',definition:'指标口径',definitionHash:'指标定义',dimensions:'维度对应',access:'来源能力'};
  return [...new Set([...old.keys(),...next.keys()])].flatMap(key=>{
    const a=old.get(key),b=next.get(key);if(canonical(a?.value)===canonical(b?.value))return[];
    const current=b??a!,change=!b||b.value.deprecated===true?'deprecated':!a?'added':'modified';
    const fields=a&&b?[...new Set([...Object.keys(a.value),...Object.keys(b.value)])].filter(field=>canonical(a.value[field])!==canonical(b.value[field])):[];
    return[{kind:current.kind,id:current.id,name:current.name,entityTypeId:current.entityTypeId,change,summary:change==='added'?`新增「${current.name}」`:change==='deprecated'?`弃用「${current.name}」`:`${fields.map(field=>labels[field]??'配置').filter((field,index,all)=>all.indexOf(field)===index).join('、')}已修改`,before:a?.value??null,after:b?.value??null}];
  });
}
