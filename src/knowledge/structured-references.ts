import type {DiscoverySource} from './discovery.ts';
import {fingerprint} from './sources.ts';
import {structuredCandidates,tableProfile} from './structured-profile.ts';
type Binding={sourceVersionId:string;column:string};
type CandidateType={id:string;sourceColumns?:Binding[];properties?:Array<{sourceColumns?:Binding[]}>};
type ForeignKey={name:string;column:string;targetTable:string;targetSchema?:string;targetColumn:string;ordinal:number};
type Key={columns:string[];basis:string};
const identity=/id|key|code|_by\b|编号|唯一|标识|用户|角色|区域|分所|关联|参照/i;
const sensitive=/password|secret|token|credential/i;
const compatible=(left?:string,right?:string)=>left===right||!!left&&!!right&&['integer','decimal'].includes(left)&&['integer','decimal'].includes(right);
export const REFERENCE_ROW_LIMIT=1000;
/** Completeness is about the loaded fixed version, never inferred from matching keys. */
export function referenceDataScope(source:DiscoverySource) {
  const loadedRows=source.rows?.length??0,coverage=source.coverage as {total?:unknown}|undefined;
  const statedTotal=source.rowCount??coverage?.total;
  const totalRows=typeof statedTotal==='number'&&Number.isSafeInteger(statedTotal)&&statedTotal>=0?statedTotal:null;
  const checkedRows=Math.min(loadedRows,REFERENCE_ROW_LIMIT);
  return {loadedRows,checkedRows,totalRows,complete:totalRows!==null&&loadedRows===totalRows&&checkedRows===totalRows};
}
export function referenceMatchStatus(checked:number,matched:number,complete:boolean) {
  return !checked?'not_checked':matched?'overlap_observed':complete?'zero_match':'sample_no_match';
}
const tuples=(source:DiscoverySource,columns:string[]) => (source.rows??[]).slice(0,REFERENCE_ROW_LIMIT).map(row=>columns.map(column=>{
  const native=source.nativeValues?.[row[source.keyColumn!]];return native&&Object.hasOwn(native,column)?native[column]:row[column];
})).filter(values=>values.every(value=>value!==null&&value!==undefined&&value!==''));
function keyTypes(types:CandidateType[],sourceId:string,columns:string[]){
  const applicable=types.filter(t=>[...(t.sourceColumns??[]),...(t.properties??[]).flatMap(p=>p.sourceColumns??[])].some(b=>b.sourceVersionId===sourceId));
  const exact=applicable.filter(t=>columns.every(column=>[...(t.sourceColumns??[]),...(t.properties??[]).flatMap(p=>p.sourceColumns??[])].some(b=>b.sourceVersionId===sourceId&&b.column===column)));
  return {targetCandidateTypes:exact.map(t=>t.id),targetTypeScopeCandidates:applicable.map(t=>t.id),targetTypeBinding:exact.length===1?'key_columns_supported':exact.length?'multiple_key_supported_types':'key_owner_unknown'};
}
/** Reproject only semantic ownership; tuple evidence and stable binding refs stay frozen. */
export function currentReferenceTypes(reference:{targetSourceVersionId:string;targetColumns:string[]},candidates:unknown[]) {
  return keyTypes((candidates as Array<{types:CandidateType[]}>).flatMap(c=>c.types),reference.targetSourceVersionId,reference.targetColumns);
}
/** Suggestions, not decisions: key declarations, comments, types and bounded fixed
 * version tuples stay separate. Distinct FK names are distinct business roles. */
export function crossTableReferences(sources:DiscoverySource[],candidates:unknown[]){
  const types=(candidates as Array<{types:CandidateType[]}>).flatMap(c=>c.types);
  const prepared=sources.map(source=>({source,fields:structuredCandidates(source).columns,profile:tableProfile(source)}));
  const result=[];
  for(const {source,fields}of prepared){
    const foreignKeys=(source.metadata?.foreignKeys??[]) as ForeignKey[];
    const sourceKeys=[...((source.metadata?.primaryKey??[]) as string[]),...((source.metadata?.uniqueKeys??[]) as Array<string[]|{columns:string[]}>).flatMap(k=>Array.isArray(k)?k:k.columns)];
    for(const field of fields){
      if(sensitive.test(field.column)||!identity.test(field.column+' '+field.description)&&!sourceKeys.includes(field.column)&&!foreignKeys.some(f=>f.column===field.column))continue;
      const alternatives=[];
      for(const {source:target,fields:targetFields,profile}of prepared){
        const metadata=target.metadata??{};
        const keys:Key[]=[{columns:(metadata.primaryKey??[]) as string[],basis:'declared_primary_key'},
          ...((metadata.uniqueKeys??[]) as Array<string[]|{columns:string[]}>).map(k=>({columns:Array.isArray(k)?k:k.columns,basis:'declared_unique_key'})),
          ...targetFields.filter(f=>!sensitive.test(f.column)&&(identity.test(f.column+' '+f.description)||profile.coverage==='complete_observation'&&profile.columns.some(c=>c.column===f.column&&c.observed>0&&c.nulls===0&&c.empty===0&&c.distinct===c.observed))).map(f=>({columns:[f.column],basis:identity.test(f.column+' '+f.description)?'business_identifier_candidate':'complete_observed_unique_candidate'}))];
        const roles=new Map<string,ForeignKey[]>();
        for(const fk of foreignKeys.filter(f=>f.targetTable===metadata.name&&(!f.targetSchema||f.targetSchema===metadata.schema))){const group=roles.get(fk.name)??[];group.push(fk);roles.set(fk.name,group);}
        for(const role of roles.values()){role.sort((a,b)=>a.ordinal-b.ordinal);keys.push({columns:role.map(f=>f.targetColumn),basis:'declared_foreign_key_target'});}
        const uniqueKeys=[...new Map(keys.filter(k=>k.columns.length&&k.columns.every(c=>targetFields.some(f=>f.column===c))).map(k=>[fingerprint(k.columns),k])).values()];
        for(const key of uniqueKeys){
          const mappings:Array<{columns:string[];role?:string;basis:string;search?:{checked:number;complete:boolean;limit:number}}>=[];
          for(const [name,role]of roles){if(!role.some(f=>f.column===field.column))continue;
            if(key.columns.length===role.length&&key.columns.every(c=>role.some(f=>f.targetColumn===c)))mappings.push({columns:key.columns.map(c=>role.find(f=>f.targetColumn===c)!.column),role:name,basis:'declared_foreign_key'});
          }
          if(!mappings.length){
            if(key.columns.length===1)mappings.push({columns:[field.column],basis:'structural_candidate'});
            else if(key.columns.includes(field.column)&&key.columns.every(c=>fields.some(f=>f.column===c)))mappings.push({columns:key.columns,basis:'structural_candidate'});
            else{
              const normalize=(name:string)=>name.toLowerCase().replace(/[_\s]/g,'').replace(/(?:id|key|code)$/,'');
              const options=key.columns.map(column=>fields.filter(f=>compatible(f.valueType,targetFields.find(t=>t.column===column)?.valueType)&&!sensitive.test(f.column)).sort((a,b)=>Number(normalize(b.column)===normalize(column))-Number(normalize(a.column)===normalize(column))).map(f=>f.column));
              let checked=0,exhausted=true;const found:string[][]=[];
              const targetValues=new Set(tuples(target,key.columns).map(v=>JSON.stringify(v)));
              const search=(prefix:string[])=>{
                if(checked>=64){exhausted=false;return;}
                if(prefix.length===options.length){if(!prefix.includes(field.column))return;checked++;if(tuples(source,prefix).some(v=>targetValues.has(JSON.stringify(v))))found.push(prefix);return;}
                for(const column of options[prefix.length])if(!prefix.includes(column)){search([...prefix,column]);if(checked>=64){exhausted=false;break;}}
              };
              if(key.columns.length<=4&&source.rows?.length&&target.rows?.length)search([]);else exhausted=false;
              const searchCoverage={checked,complete:exhausted,limit:64};
              for(const columns of found)mappings.push({columns,basis:'bounded_tuple_mapping_candidate',search:searchCoverage});
              if(!found.length||!exhausted)mappings.push({columns:[],basis:'composite_mapping_unknown',search:searchCoverage});
            }
          }
          for(const mapping of mappings){
            const columns=mapping.columns;
            // Suppress only inferred identity joins; explicit FK roles and ordered remappings remain candidates.
            if(source.id===target.id&&mapping.basis!=='declared_foreign_key'&&columns.length===key.columns.length&&columns.every((column,i)=>column===key.columns[i]))continue;
            if(columns.length&&!columns.every((c,i)=>compatible(fields.find(f=>f.column===c)?.valueType,targetFields.find(f=>f.column===key.columns[i])?.valueType)))continue;
            const left=columns.length?tuples(source,columns):[],targetTuples=tuples(target,key.columns),right=new Set(targetTuples.map(v=>JSON.stringify(v)));
            const matched=left.filter(v=>right.has(JSON.stringify(v))).length;
            const sourceScope=referenceDataScope(source),targetScope=referenceDataScope(target);
            const targetReadable=!!target.rows?.length||targetScope.complete;
            alternatives.push({ref:'r'+fingerprint({source:source.id,columns,target:target.id,key:key.columns,role:mapping.role}).slice(0,18),targetSourceVersionId:target.id,targetColumns:key.columns,
              ...keyTypes(types,target.id,key.columns),sourceColumns:columns,role:mapping.role??null,bindingBasis:mapping.basis,basis:key.basis,
              sourceComment:field.description,targetComment:metadata.comment??'',columnComments:targetFields.filter(f=>key.columns.includes(f.column)).map(f=>({column:f.column,comment:f.description})),
              bindingValidity:columns.length?'declared_columns_exist':'composite_mapping_unknown',businessMeaning:'unconfirmed',identityMerge:false,
              dataMatch:{checked:left.length,matched,targetChecked:targetTuples.length,status:targetReadable?referenceMatchStatus(left.length,matched,sourceScope.complete&&targetScope.complete):'not_checked',scope:'frozen_loaded_records',rowLimit:REFERENCE_ROW_LIMIT,sourceScope,targetScope,interpretation:'抽样未匹配不代表全量无关联；值重叠不证明业务含义，零匹配不删除关系定义',sourceLoadedRows:source.rows?.length??0,targetLoadedRows:target.rows?.length??0,sourceCoverage:source.coverage,targetCoverage:target.coverage},
              mappingSearch:{...mapping.search,complete:mapping.search?.complete??!!columns.length,reason:columns.length?'explicit_ordered_columns':'没有声明外键或已验证的完整列映射；保留复合键候选，不按单列重叠简化'}});
          }
        }
      }
      result.push({sourceVersionId:source.id,columns:[field.column],comment:field.description,physicalType:field.physicalType,alternatives,ambiguity:alternatives.length===1?'single_suggestion':alternatives.length?'multiple_suggestions':'unknown',adoption:'requires_explicit_coordination',identityMerge:false});
    }
  }
  return result;
}
