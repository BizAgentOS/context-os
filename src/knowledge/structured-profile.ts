import { fingerprint, sourceStructureHash, type SourceContent } from './sources.ts';

export const PROFILE_VERSION = 'structured-profile-v1';
interface ColumnStats { observed: number; nulls: number; empty: number; values: Set<string>; overflow: boolean; minLength: number | null; maxLength: number; }
export interface ColumnProfile { column: string; observed: number; nulls: number; empty: number; distinct: number | null; distinctAtLeast: number; observedValues: string[]; minLength: number | null; maxLength: number; }
export interface TableProfile { version:string; rows:number; coverage:'complete_observation'|'sample'; totalRows:number|null; columns:ColumnProfile[]; }
export interface NativeColumn { name:string; type:string; comment?:string; nullable?:boolean; }

/** Bounded memory per column. This never claims that observed values form a closed enum. */
export class TableProfiler {
  private stats = new Map<string,ColumnStats>(); private rows = 0;
  constructor(columns: string[]) { for(const c of columns)this.stats.set(c,{observed:0,nulls:0,empty:0,values:new Set(),overflow:false,minLength:null,maxLength:0}); }
  add(records: Array<{values:Record<string,string|null>}>) {
    for(const {values} of records){this.rows++;
      for(const [name,s] of this.stats){s.observed++;const value=values[name];
        if(value===null||value===undefined){s.nulls++;continue;}
        if(value==='')s.empty++;
        s.minLength=s.minLength===null?value.length:Math.min(s.minLength,value.length);s.maxLength=Math.max(s.maxLength,value.length);
        // Cap both cardinality state and each stored value. Large/sensitive values stay in evidence only.
        if(value.length>120||/password|secret|token|credential/i.test(name)){s.overflow=true;continue;}
        if(!s.values.has(value)){if(s.values.size<32)s.values.add(value);else s.overflow=true;}
      }
    }
  }
  finish(coverage:TableProfile['coverage']='complete_observation',totalRows:number|null=this.rows):TableProfile {
    return {version:PROFILE_VERSION,rows:this.rows,coverage,totalRows,columns:[...this.stats].map(([column,s])=>({column,observed:s.observed,nulls:s.nulls,empty:s.empty,
      distinct:s.overflow?null:s.values.size,distinctAtLeast:s.values.size,observedValues:[...s.values].sort(),minLength:s.minLength,maxLength:s.maxLength}))};
  }
}
export function tableProfile(content:SourceContent):TableProfile {
  const saved=content.metadata?.profile as TableProfile|undefined;
  if(saved?.version===PROFILE_VERSION)return saved;
  const rows=content.rows??[],p=new TableProfiler((content.columns??[]).filter(c=>c!=='__context_record_key'));
  p.add(rows.map(row=>({values:content.nativeValues?.[row[content.keyColumn!]]??row})));
  return p.finish('sample',content.rowCount??null);
}
export function tableStructure(content:SourceContent) {
  const m=content.metadata??{};
  return {kind:content.kind,schema:m.schema,name:m.name,engine:m.engine,comment:m.comment,columns:m.columns,primaryKey:m.primaryKey,...(m.uniqueKeys?{uniqueKeys:m.uniqueKeys}:{}),foreignKeys:m.foreignKeys};
}
export function structureHash(content:SourceContent){return sourceStructureHash(content);}

export function commentCodes(comment:string,numericOnly=false) {
  const numeric=[...comment.matchAll(/(-?\d+)\s*[:：=、]?\s*([^\d\s,，;；()（）]+)(?=\s|[,，;；()（）]|-?\d|$)/g)];
  // Retain the exact v19 projection for explicit old-receipt verification.
  if(numericOnly){const entries=numeric.map(m=>({code:m[1],meaning:m[2]}));return entries.length>=2&&new Set(entries.map(e=>e.code)).size===entries.length?entries:[];}
  const alpha=[...comment.matchAll(/(?:^|[\s,，;；(（])['"]?([A-Za-z][A-Za-z0-9_-]{0,30})['"]?\s*[:：=]\s*([^\s,，;；()（）]+)/g)];
  const entries=[...numeric.filter(m=>!m.index||!/[A-Za-z0-9_-]/.test(comment[m.index-1])),...alpha].sort((a,b)=>(a.index??0)-(b.index??0)).map(m=>({code:m[1],meaning:m[2]}));
  return entries.length>=2&&new Set(entries.map(e=>e.code)).size===entries.length?entries:[];
}

function declaredEnum(type:string):string[]|undefined {
  if(!/^enum\(/i.test(type))return undefined;
  const text=type.slice(type.indexOf('(')+1,-1),values:string[]=[];let i=0;
  while(i<text.length){while(/\s/.test(text[i]??'')&&i<text.length)i++;if(text[i++]!=="'")return undefined;
    let value='',closed=false;while(i<text.length){const c=text[i++];if(c==='\\'){if(i>=text.length)return undefined;const escaped=text[i++];
        const escapes:Record<string,string>={'0':'\0',b:'\b',n:'\n',r:'\r',t:'\t',Z:'\x1a',"'":"'",'\\':'\\','"':'"'};
        if(!(escaped in escapes))return undefined;value+=escapes[escaped];}
      else if(c==="'"){if(text[i]==="'"){value+="'";i++;}else{closed=true;break;}}else value+=c;}
    if(!closed)return undefined;values.push(value);while(i<text.length&&/\s/.test(text[i]))i++;
    if(i<text.length&&text[i++]!==',')return undefined;
  }return values.length?values:undefined;
}
export function structuredCandidates(content:SourceContent, legacy=false,oldCommentCodes=false) {
  const metadata=content.metadata??{},primaryKey=metadata.primaryKey as string[]|undefined;
  const columns=(metadata.columns??[]) as NativeColumn[];
  const profile=tableProfile(content);
  return {structureHash:structureHash(content),profile:{...profile,columns:profile.columns.map(c=>({...c,...(legacy?{observedValues:c.observedValues.slice(0,5),displayedValueLimit:5}:{observedValues:c.observedValues,displayedValueLimit:32,valuesTruncated:c.distinct===null,valuesCoverage:profile.coverage})}))},identity:{declaredPrimaryKey:primaryKey??[],inferred:false},foreignKeys:metadata.foreignKeys??[],
    columns:columns.map(c=>{const type=c.type.toLowerCase(),enumValues=declaredEnum(c.type);
      const valueType=enumValues?'enum':/^(decimal|numeric|float|double|real|bigint)\b/.test(type)?'decimal':/^(tinyint|smallint|mediumint|int|integer)\b/.test(type)?'integer':/^(date|datetime|timestamp)\b/.test(type)?'datetime':'string';
      return {column:c.name,physicalType:c.type,valueType,...(enumValues?{enumValues,enumBasis:'database_declaration'}:{}),...(!legacy?{commentCodeCandidates:commentCodes(c.comment??'',oldCommentCodes),commentBasis:'column_comment_candidate'}:{}),description:c.comment??'',nullable:c.nullable,
        constraintsArePhysical:true,note:'物理空值约束不自动成为业务必填；观测值不自动成为枚举；TIME/数值不按字段名推断为日期。'};
    })};
}
