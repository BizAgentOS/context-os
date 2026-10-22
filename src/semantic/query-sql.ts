import type {Artifact,Data,Json} from '../agent/contracts.ts';
import {quote,lit,type ExecutionInput} from '../data/executor/engine.ts';
import type {Capability} from '../live/sources.ts';
import type {LayeredModel,PropertyTransform,IdentityRule} from './model.ts';
import type {SemanticQueryRequest,SemanticQueryOptions} from './query-contract.ts';
export const literal=(value:Json):string=>value===null?'NULL':typeof value==='number'?String(value):typeof value==='boolean'?String(value):lit(String(value));
const numericJson=(expression:string)=>`json_type(to_json(${expression})) IN ('BIGINT','UBIGINT','DOUBLE')`;
export const jsonScalar=(expression:string)=>`CASE WHEN ${numericJson(expression)} THEN CASE WHEN CAST(${expression} AS DOUBLE)=floor(CAST(${expression} AS DOUBLE)) AND abs(CAST(${expression} AS DOUBLE))<=9007199254740991 THEN CAST(CAST(${expression} AS BIGINT) AS VARCHAR) ELSE CAST(to_json(CAST(${expression} AS DOUBLE)) AS VARCHAR) END ELSE CAST(to_json(${expression}) AS VARCHAR) END`;
export const transformed=(expression:string,transform:PropertyTransform):string=>{
  switch(transform.op){
    case 'none':return expression;
    case 'trim':return `trim(${expression})`;
    case 'lowercase':return `lower(${expression})`;
    case 'cast':{
      if(transform.valueType==='string')return `CASE WHEN json_type(to_json(${expression}))='VARCHAR' THEN CAST(${expression} AS VARCHAR) ELSE ${jsonScalar(expression)} END`;
      if(transform.valueType==='boolean')return `CASE WHEN ${expression} IS NULL THEN NULL WHEN ${jsonScalar(expression)} IN ('true','1','"true"') THEN TRUE WHEN ${jsonScalar(expression)} IN ('false','0','"false"') THEN FALSE ELSE error('布尔转换失败') END`;
      const numeric=`CAST(${expression} AS DOUBLE)`;
      return `CASE WHEN ${expression} IS NULL THEN NULL WHEN ${numeric} IS NOT NULL AND isfinite(${numeric})${transform.valueType==='integer'?` AND ${numeric}=floor(${numeric})`:''} THEN ${numeric} ELSE error('数值转换失败：需要${transform.valueType==='integer'?'整数':'有限数值'}') END`;
    }
    case 'parse_date':{
      const iso=transform.format==='ISO8601',pattern=iso?'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})':transform.format==='YYYY-MM-DD'?'[0-9]{4}-[0-9]{2}-[0-9]{2}':'[0-9]{4}/[0-9]{2}/[0-9]{2}';
      const value=iso?`strftime(CAST(${expression} AS TIMESTAMPTZ) AT TIME ZONE 'UTC','%Y-%m-%dT%H:%M:%S.%gZ')`:`strftime(strptime(${expression},${lit(transform.format==='YYYY-MM-DD'?'%Y-%m-%d':'%Y/%m/%d')}),'%Y-%m-%d')`;
      return `CASE WHEN ${expression} IS NULL THEN NULL WHEN regexp_full_match(${expression},${lit(pattern)}) THEN ${value} ELSE error('日期不符合声明格式') END`;
    }
  }
};
export interface QueryBinding {table:string;version:string;cap:Capability;coverage:Data}
export function validateQuery(layered:LayeredModel,query:SemanticQueryRequest,options:SemanticQueryOptions){
  const entity=(id:string)=>{const found=layered.semantic.entityTypes.find(e=>e.id===id);if(!found)throw new Error('实体类型不存在');if(options.scope&&!options.scope.entityTypeIds.has(id))throw new Error('实体类型未经授权');return found;};
  let target=entity(query.target.entityTypeId);
  for(const step of query.traverse){
    const relation=layered.semantic.relationTypes.find(r=>r.id===step.relationTypeId);
    if(!relation)throw new Error('关系不存在');if(options.scope&&!options.scope.relationTypeIds.has(relation.id))throw new Error('关系未经授权');
    if((step.direction==='out'?relation.from:relation.to)!==target.id)throw new Error('遍历关系不属于当前实体');
    if(step.recursive&&relation.from!==relation.to)throw new Error('递归遍历仅用于自引用关系');
    target=entity(step.direction==='out'?relation.to:relation.from);
  }
  const property=(id:string)=>{const found=layered.semantic.properties.find(p=>p.id===id&&p.entityTypeId===target.id);if(!found)throw new Error('属性不属于查询结果实体');if(options.scope&&!options.scope.propertyIds.has(id))throw new Error('属性未经授权');return found;};
  const fields=query.fields??layered.semantic.properties.filter(p=>p.entityTypeId===target.id&&(!options.scope||options.scope.propertyIds.has(p.id))).map(p=>p.id);
  for(const id of [...fields,...query.filters.map(f=>f.propertyId),...query.sort.map(s=>s.propertyId),...(query.aggregate?.groupBy??[]),...(query.aggregate?.measures.flatMap(m=>m.propertyId?[m.propertyId]:[])??[])])property(id);
  if(query.page.limit>(options.maxPageSize??100))throw new Error(`每页最多 ${options.maxPageSize??100} 个对象`);
  return {target,fields,property};
}
export class QuerySql {
  readonly ctes:string[]=[];readonly inputs:ExecutionInput[]=[];
  readonly bindings=new Map<string,string>();
  readonly recordIdColumn:string;
  rawId(alias:string){return `${alias}.${quote(this.recordIdColumn)}`;}
  propertyAlias(id:string){const index=this.layered.semantic.properties.findIndex(p=>p.id===id);if(index<0)throw new Error('属性不存在');return 'property'+index;}
  statusAlias(id:string){return 'status'+this.propertyAlias(id);}
  propertyColumn(id:string){return quote(this.propertyAlias(id));}
  statusColumn(id:string){return quote(this.statusAlias(id));}
  resultAlias(id:string,query:SemanticQueryRequest){const index=query.aggregate?.measures.findIndex(m=>m.as===id)??-1;return index>=0?'measure'+index:this.propertyAlias(id);}
  readonly identities=new Map<string,{candidates:string;unique:string}>();
  readonly decisions:Artifact[];
  readonly corrections:Artifact[];
  readonly propertyCorrections:Artifact[];
  metadataSql?:string;
  readonly traversalMetadata:string[]=[];
  traversalPath?:{walk:string;relationTypeId:string};
  readonly layered:LayeredModel;readonly datasets:Map<string,QueryBinding>;
  constructor(layered:LayeredModel,datasets:Map<string,QueryBinding>,decisions:Artifact[]=[],corrections:Artifact[]=[],propertyCorrections:Artifact[]=[]){
    this.decisions=decisions;this.corrections=corrections;this.propertyCorrections=propertyCorrections;
    this.layered=layered;this.datasets=datasets;
    const sourceFields=new Set([...datasets.values()].flatMap(dataset=>dataset.cap.fields.map(field=>field.toLowerCase())));
    let recordIdColumn='__cos_object_id';while(sourceFields.has(recordIdColumn.toLowerCase()))recordIdColumn+='_';this.recordIdColumn=recordIdColumn;
    for(const [id,dataset] of datasets){
      const binding=layered.bindings.entities.find(b=>b.id===id)!;
      const table='raw'+this.inputs.length;this.inputs.push({table,version:dataset.version});
      const name='binding'+this.bindings.size;this.bindings.set(id,name);
      if(!binding){this.ctes.push(`${name} AS (SELECT * FROM ${table})`);continue;}
      const keys=binding.role==='primary'&&binding.keyColumns.length?binding.keyColumns:[dataset.cap.idField];
      const native=keys.length===1&&keys[0]===dataset.cap.idField;
      const identity=native?`CAST(${quote(keys[0])} AS VARCHAR)`:`${lit(keys.length===1?'key:':'composite:')} || rtrim(translate(to_base64(encode(('[' || concat_ws(',',${keys.map(key=>jsonScalar(quote(key))).join(',')}) || ']'))),'+/','-_'),'=')`;
      const conditions=Object.entries(binding.rowFilter??{}).map(([key,value])=>`${quote(key)} = ${literal(value)}`);
      this.ctes.push(`${name} AS (SELECT *,${identity} AS ${quote(this.recordIdColumn)} FROM ${table}${conditions.length?' WHERE '+conditions.join(' AND '):''})`);
    }
  }
  identity(rule:IdentityRule){
    const existing=this.identities.get(rule.id);if(existing)return existing;
    const left=this.bindings.get(rule.left.bindingId),right=this.bindings.get(rule.right.bindingId);
    if(!left||!right)throw new Error('身份规则两端没有快照');
    const active=this.decisions.filter(d=>d.content.ruleId===rule.id);
    const positive=active.filter(d=>d.content.decision==='match');
    const pair=(d:Artifact)=>`${this.rawId('l')}=${lit(String((d.content.left as Data).recordId))} AND ${this.rawId('r')}=${lit(String((d.content.right as Data).recordId))}`;
    const matching=rule.left.columns.map((column,index)=>{
      const a=transformed('l.'+quote(column),rule.transform),b=transformed('r.'+quote(rule.right.columns[index]),rule.transform);
      return `${a} IS NOT NULL AND ${b} IS NOT NULL AND trim(CAST(${a} AS VARCHAR))<>'' AND ${jsonScalar(a)}=${jsonScalar(b)}`;
    }).join(' AND ');
    const overrides=positive.map(d=>lit(String((d.content.left as Data).recordId)));
    const ruleComplete=this.datasets.get(rule.right.bindingId)?.coverage.complete===true&&(rule.kind!=='same_as'||this.datasets.get(rule.left.bindingId)?.coverage.complete===true);
    const normal=`(${ruleComplete?matching:'FALSE'})${overrides.length?` AND ${this.rawId('l')} NOT IN (${overrides.join(',')})`:''}`;
    const exclusions=active.filter(d=>d.content.decision==='no_match').map(d=>d.content.right?`(${pair(d)})`:`${this.rawId('l')}=${lit(String((d.content.left as Data).recordId))}`);
    const candidates='matches'+this.ctes.length,unique='unique'+this.ctes.length;
    this.ctes.push(`${candidates} AS (SELECT DISTINCT ${this.rawId('l')} AS left_id,${this.rawId('r')} AS right_id FROM ${left} l JOIN ${right} r ON ((${normal})${positive.length?' OR '+positive.map(d=>'('+pair(d)+')').join(' OR '):''})${exclusions.length?' WHERE NOT ('+exclusions.join(' OR ')+')':''})`);
    this.ctes.push(`${unique} AS (SELECT * FROM ${candidates} QUALIFY count(*) OVER(PARTITION BY left_id)=1${rule.kind==='same_as'?' AND count(*) OVER(PARTITION BY right_id)=1':''})`);
    const result={candidates,unique};this.identities.set(rule.id,result);return result;
  }
  entity(id:string){
    const primary=this.layered.bindings.entities.find(b=>b.entityTypeId===id&&b.role==='primary');if(!primary)throw new Error('实体没有主绑定');
    const table=this.bindings.get(primary.id);if(!table)throw new Error('实体来源没有可用快照');
    const properties=this.layered.semantic.properties.filter(p=>p.entityTypeId===id),values:string[]=[];
    for(const property of properties){
      const bindings=this.layered.bindings.properties.filter(b=>b.propertyId===property.id),candidates:string[]=[],blockers:string[]=[];
      for(const binding of bindings){
        const raw=this.bindings.get(binding.entityBindingId);if(!raw)continue;
        const value=jsonScalar(transformed('v.'+quote(binding.column),binding.transform));
        if(binding.entityBindingId===primary.id)candidates.push(`SELECT ${value} AS value FROM ${raw} v WHERE ${this.rawId('v')}=${this.rawId('p')}`);
        else{
          const rule=this.layered.bindings.identityRules.find(r=>r.kind==='same_as'&&r.left.bindingId===binding.entityBindingId&&r.right.bindingId===primary.id);
          if(!rule)throw new Error('补充绑定缺少明确身份规则');
          const edges=this.identity(rule);
          candidates.push(`SELECT ${value} AS value FROM ${raw} v JOIN ${edges.unique} e ON e.left_id=${this.rawId('v')} WHERE e.right_id=${this.rawId('p')}`);
          blockers.push(`EXISTS(SELECT 1 FROM ${edges.candidates} e WHERE e.right_id=${this.rawId('p')} AND NOT EXISTS(SELECT 1 FROM ${edges.unique} u WHERE u.left_id=e.left_id AND u.right_id=e.right_id))`);
          if(this.datasets.get(binding.entityBindingId)?.coverage.complete!==true||this.datasets.get(primary.id)?.coverage.complete!==true)blockers.push('TRUE');
        }
      }
      const input=candidates.length?candidates.join(' UNION ALL '):'SELECT NULL::VARCHAR AS value';
      const distinct=`(SELECT count(DISTINCT value) FROM (${input}) vals WHERE value IS NOT NULL AND value<>'null')`;
      const status=`CASE WHEN ${distinct}>1 THEN 'conflict' ${blockers.length?'WHEN '+blockers.join(' OR ')+" THEN 'uncertain' ":''}WHEN ${distinct}=1 THEN 'resolved' ELSE 'missing' END`;
      values.push(`CASE WHEN (${status})='resolved' THEN (SELECT any_value(value) FROM (${input}) vals WHERE value IS NOT NULL AND value<>'null') ELSE NULL END AS ${this.propertyColumn(property.id)}`);
      values.push(`${status} AS ${this.statusColumn(property.id)}`);
    }
    const name='entity'+this.ctes.length;this.ctes.push(`${name} AS (SELECT ${this.rawId('p')} AS __id${values.length?','+values.join(','):''} FROM ${table} p)`);
    const corrections=this.propertyCorrections.filter(record=>record.content.entityTypeId===id);
    if(!corrections.length)return name;
    const replacements=properties.flatMap(property=>{
      const decisions=corrections.filter(record=>record.content.propertyId===property.id);if(!decisions.length)return [];
      const condition=(record:Artifact)=>`__id=${lit(String(record.content.objectId))}`;
      const value=`CASE ${decisions.map(record=>`WHEN ${condition(record)} THEN ${record.content.value===null?'NULL':lit(JSON.stringify(record.content.value))}`).join(' ')} ELSE ${this.propertyColumn(property.id)} END`;
      const status=`CASE WHEN ${decisions.map(condition).join(' OR ')} THEN 'resolved' ELSE ${this.statusColumn(property.id)} END`;
      return [`${value} AS ${this.propertyColumn(property.id)}`,`${status} AS ${this.statusColumn(property.id)}`];
    });
    const corrected='corrected'+this.ctes.length;this.ctes.push(`${corrected} AS (SELECT * REPLACE(${replacements.join(',')}) FROM ${name})`);return corrected;
  }
  relation(id:string){
    const relation=this.layered.semantic.relationTypes.find(r=>r.id===id)!;
    const binding=this.layered.bindings.relations.find(r=>r.relationTypeId===id);if(!binding)throw new Error('关系没有可执行绑定');
    const rule=this.layered.bindings.identityRules.find(r=>r.kind==='belongs_to'&&r.relationTypeId===id);
    const left=this.bindings.get(binding.fromBindingId),right=this.bindings.get(binding.toBindingId);if(!left||!right)throw new Error('关系端点没有快照');
    let original:string;
    const equal=(a:string,b:string)=>`${jsonScalar(a)}=${jsonScalar(b)}`;
    if(rule)original=`SELECT left_id,right_id FROM ${this.identity(rule).unique}`;
    else if(binding.kind==='foreign_key')original=`SELECT DISTINCT ${this.rawId('l')} AS left_id,${this.rawId('r')} AS right_id FROM ${left} l JOIN ${right} r ON ${binding.fromColumns.map((col,i)=>equal('l.'+quote(col),'r.'+quote(binding.toColumns[i]))).join(' AND ')}`;
    else{
      const middle=this.bindings.get('link:'+binding.id);if(!middle)throw new Error('关系中间表没有快照');
      const l=this.layered.bindings.entities.find(b=>b.id===binding.fromBindingId)!,r=this.layered.bindings.entities.find(b=>b.id===binding.toBindingId)!;
      original=`SELECT DISTINCT ${this.rawId('l')} AS left_id,${this.rawId('r')} AS right_id FROM ${left} l JOIN ${middle} m ON ${l.keyColumns.map((col,i)=>equal('l.'+quote(col),'m.'+quote(binding.fromColumns[i]))).join(' AND ')} JOIN ${right} r ON ${r.keyColumns.map((col,i)=>equal('r.'+quote(col),'m.'+quote(binding.toColumns[i]))).join(' AND ')}`;
    }
    const decisions=this.corrections.filter(d=>{const saved=(d.content.snapshot as Data)?.relation as Data;return saved?.relationId===id;});
    const targets=decisions.flatMap(d=>(d.content.targetIds as string[]).map(target=>`SELECT ${lit(String((d.content.target as Data).objectId))} AS left_id,${lit(target)} AS right_id`));
    const excludes=decisions.map(d=>lit(String((d.content.target as Data).objectId)));
    const name='relation'+this.ctes.length;
    this.ctes.push(`${name} AS (SELECT * FROM (${original}) original${excludes.length?' WHERE left_id NOT IN ('+excludes.join(',')+')':''}${targets.length?' UNION '+targets.join(' UNION '):''})`);
    return {name,relation};
  }
  relationReportSql(id:string){
    const {name,relation}=this.relation(id),origins=this.entity(relation.from);
    const matched=`EXISTS(SELECT 1 FROM ${name} edge WHERE edge.left_id=origin.__id)`;
    const sample=`CAST(to_json((SELECT list(struct_pack(objectId:=__id)) FROM (SELECT origin.__id FROM ${origins} origin WHERE NOT ${matched} ORDER BY origin.__id LIMIT 10))) AS VARCHAR)`;
    return `WITH RECURSIVE ${this.ctes.join(',')} SELECT count(*) AS sourceTotal,count(*) FILTER(WHERE ${matched}) AS sourceMatched,${sample} AS unmatchedSamples FROM ${origins} origin`;
  }
  select(query:SemanticQueryRequest,fields:string[],includeGroupMembers=false){
    let currentType=query.target.entityTypeId;
    let table=this.entity(currentType);
    let reachable='reach0';this.ctes.push(`${reachable} AS (SELECT __id,[__id] AS path,[]::VARCHAR[] AS relation_ids,[${lit(currentType)}] AS type_ids FROM ${table}${query.target.id?' WHERE __id='+lit(query.target.id):''})`);
    for(let i=0;i<query.traverse.length;i++){
      const step=query.traverse[i],{name,relation}=this.relation(step.relationTypeId),from=step.direction==='out'?'left_id':'right_id',to=step.direction==='out'?'right_id':'left_id';
      const next='reach'+(i+1),nextType=step.direction==='out'?relation.to:relation.from;
      if(step.recursive){
        const maximum=Math.min(step.maxDepth??10,relation.maxDepth??10),walk='walk'+i;this.traversalPath={walk,relationTypeId:relation.id};
        this.ctes.push(`${walk} AS (SELECT __id,0 AS depth,path,FALSE AS cycle,relation_ids,type_ids,[__id] AS visited FROM ${reachable} UNION ALL SELECT e.${to},w.depth+1,list_append(w.path,e.${to}),list_contains(w.visited,e.${to}),list_append(w.relation_ids,${lit(relation.id)}),list_append(w.type_ids,${lit(nextType)}),list_append(w.visited,e.${to}) FROM ${walk} w JOIN ${name} e ON w.__id=e.${from} WHERE w.depth<${maximum} AND NOT w.cycle)`);
        this.ctes.push(`${next} AS (SELECT DISTINCT __id,path,relation_ids,type_ids FROM ${walk} WHERE depth>0)`);
        this.traversalMetadata.push(`SELECT coalesce(bool_or(cycle OR (depth=${maximum} AND EXISTS(SELECT 1 FROM ${name} e WHERE e.${from}=w.__id AND list_contains(w.visited,e.${to})))),FALSE) AS cycleDetected,coalesce(bool_or(depth=${maximum} AND NOT cycle AND EXISTS(SELECT 1 FROM ${name} e WHERE e.${from}=w.__id AND NOT list_contains(w.visited,e.${to}))),FALSE) AS truncated,${maximum} AS maxDepth FROM ${walk} w`);
      }else this.ctes.push(`${next} AS (SELECT DISTINCT e.${to} AS __id,list_append(r.path,e.${to}) AS path,list_append(r.relation_ids,${lit(relation.id)}) AS relation_ids,list_append(r.type_ids,${lit(nextType)}) AS type_ids FROM ${reachable} r JOIN ${name} e ON r.__id=e.${from})`);
      reachable=next;
      this.traversalPath={walk:reachable,relationTypeId:relation.id};currentType=nextType;
    }
    if(query.traverse.length)table=this.entity(currentType);
    const conditions=query.filters.map(filter=>{
      const predicate=()=>{
      const column=this.propertyColumn(filter.propertyId),text=`json_extract_string(${column},'$')`;
      if(filter.op==='is_null'||filter.op==='not_null')return `${column} IS ${filter.op==='not_null'?'NOT ':''}NULL`;
      if(filter.value===undefined)throw new Error('过滤操作需要明确的值');
      if(filter.op==='contains'){if(typeof filter.value!=='string')throw new Error('包含过滤需要文本值');return `json_type(${column})='VARCHAR' AND contains(${text},${literal(filter.value)})`;}
      if(filter.value===null){if(!['eq','ne'].includes(filter.op))throw new Error('空值只支持等值判断');return `${column} IS ${filter.op==='ne'?'NOT ':''}NULL`;}
      if(['eq','ne'].includes(filter.op))return `${column} ${filter.op==='eq'?'=':'<>'} ${jsonScalar(literal(filter.value))}`;
      if(typeof filter.value!=='number'&&typeof filter.value!=='string')throw new Error('范围过滤需要数字或文本值');
      const expression=typeof filter.value==='number'?`CASE WHEN json_type(${column}) IN ('BIGINT','UBIGINT','DOUBLE') THEN CAST(${text} AS DOUBLE) END`:text;
      return `${expression} ${{gt:'>',gte:'>=',lt:'<',lte:'<='}[filter.op as 'gt']} ${literal(filter.value)}`;
      };
      return `${this.statusColumn(filter.propertyId)} NOT IN ('conflict','uncertain') AND (${predicate()})`;
    });
    conditions.push(`__id IN (SELECT __id FROM ${reachable})`);
    const order=[...query.sort.flatMap(sort=>{const column=this.propertyColumn(sort.propertyId),direction=sort.direction.toUpperCase();return [`CASE WHEN json_type(${column}) IN ('BIGINT','UBIGINT','DOUBLE') THEN CAST(json_extract_string(${column},'$') AS DOUBLE) END ${direction} NULLS LAST`,`json_extract_string(${column},'$') ${direction} NULLS LAST`];}),'__id ASC'];
    const unresolvedFilters=query.filters.length?`(SELECT count(*) FROM ${table} WHERE __id IN (SELECT __id FROM ${reachable}) AND (${query.filters.map(f=>this.statusColumn(f.propertyId)+" IN ('conflict','uncertain')").join(' OR ')}))`:'0';
    if(query.filters.length||this.traversalMetadata.length)this.metadataSql=`WITH RECURSIVE ${this.ctes.join(',')} SELECT ${this.traversalMetadata.length?`(SELECT bool_or(cycleDetected) FROM (${this.traversalMetadata.join(' UNION ALL ')}) metadata)`:'FALSE'} AS cycleDetected,${this.traversalMetadata.length?`(SELECT bool_or(truncated) FROM (${this.traversalMetadata.join(' UNION ALL ')}) metadata)`:'FALSE'} AS truncated,${this.traversalMetadata.length?`(SELECT max(maxDepth) FROM (${this.traversalMetadata.join(' UNION ALL ')}) metadata)`:'0'} AS maxDepth,${unresolvedFilters} AS uncertainFilterRows`;
    const filtered='filtered';
    const grouping=query.aggregate?.groupBy.map(id=>`CASE WHEN ${this.statusColumn(id)} IN ('conflict','uncertain') THEN error('分组属性存在不确定或冲突值') ELSE ${this.propertyColumn(id)} END AS ${this.propertyColumn(id)}`)??[];
    this.ctes.push(`${filtered} AS (SELECT *${grouping.length?' REPLACE('+grouping.join(',')+')':''} FROM ${table} WHERE ${conditions.join(' AND ')})`);
    if(query.aggregate){
      const {groupBy,measures}=query.aggregate;
      if(new Set([...groupBy,...measures.map(m=>m.as)]).size!==groupBy.length+measures.length)throw new Error('聚合输出名称重复');
      if(query.sort.some(s=>!groupBy.includes(s.propertyId)))throw new Error('聚合排序只能引用分组属性');
      const expressions=measures.map((measure,index)=>{
        if(measure.op!=='count'&&!measure.propertyId)throw new Error('数值聚合需要属性');
        const column=measure.propertyId?this.propertyColumn(measure.propertyId):'*';
        const numeric=measure.propertyId?`CASE WHEN ${column} IS NULL THEN NULL WHEN json_type(${column}) IN ('BIGINT','UBIGINT','DOUBLE') THEN CAST(json_extract_string(${column},'$') AS DOUBLE) ELSE error('数值聚合需要数值属性') END`:column;
        const status=measure.propertyId?this.statusColumn(measure.propertyId):null;
        const uncertain=status?`count(*) FILTER(WHERE ${status} IN ('uncertain','conflict'))`:'0';
        const missing=status?`count(*) FILTER(WHERE ${status}='missing')`:'0';
        return `CASE WHEN ${uncertain}>0 THEN NULL ELSE CAST(to_json(${measure.op}(${measure.op==='count'?column:numeric})) AS VARCHAR) END AS ${quote('measure'+index)},${uncertain} AS ${quote('uncertain'+index)},${missing} AS ${quote('missing'+index)}`;
      });
      const group=groupBy.length?' GROUP BY '+groupBy.map(id=>this.propertyColumn(id)).join(','):'';
      const ordering=groupBy.length?' ORDER BY '+groupBy.map(id=>this.propertyColumn(id)+(query.sort.find(s=>s.propertyId===id)?.direction==='desc'?' DESC':' ASC')+' NULLS LAST').join(','):'';
      const select=`SELECT ${[...groupBy.map(id=>this.propertyColumn(id)),...expressions].join(',')}${includeGroupMembers?',count(*) AS __memberTotal':''} FROM ${filtered}${group}`;
      if(!includeGroupMembers)return `WITH RECURSIVE ${this.ctes.join(',')} ${select}${ordering}`;
      this.ctes.push(`groups AS (${select})`);
      const matches=groupBy.map(id=>`member.${this.propertyColumn(id)} IS NOT DISTINCT FROM groups.${this.propertyColumn(id)}`).join(' AND ')||'TRUE';
      const keys=`[${fields.map(lit).join(',')}]::VARCHAR[]`,values=`[${fields.map(id=>this.propertyColumn(id)).join(',')}]::VARCHAR[]`,statuses=`[${fields.map(id=>this.statusColumn(id)).join(',')}]::VARCHAR[]`;
      const members=`CAST(to_json((SELECT list(struct_pack(objectId:=__id,"values":=map(${keys},${values}),status:=map(${keys},${statuses}))) FROM (SELECT * FROM ${filtered} member WHERE ${matches} ORDER BY __id LIMIT 20))) AS VARCHAR)`;
      return `WITH RECURSIVE ${this.ctes.join(',')} SELECT groups.*,${members} AS __members FROM groups${ordering}`;
    }
    const path=this.traversalPath?`,CAST(to_json((SELECT list(struct_pack(objectIds:=path,relationTypeIds:=relation_ids,entityTypeIds:=type_ids)) FROM (SELECT path,relation_ids,type_ids FROM ${this.traversalPath.walk} walk WHERE walk.__id=${filtered}.__id ORDER BY path,relation_ids LIMIT 20))) AS VARCHAR) AS __paths,(SELECT count(*) FROM ${this.traversalPath.walk} walk WHERE walk.__id=${filtered}.__id) AS __pathCount`:'';
    return `WITH RECURSIVE ${this.ctes.join(',')} SELECT __id${path}${fields.length?','+fields.flatMap(id=>[this.propertyColumn(id),this.statusColumn(id)]).join(','):''} FROM ${filtered} ORDER BY ${order.join(',')}`;
  }
}
