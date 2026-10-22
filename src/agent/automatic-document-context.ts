import {z} from 'zod';
import type {Artifact,Data,DomainTool} from './contracts.ts';

const sections=['concepts','relations','properties','unknowns','conflicts','evidence'] as const;
const input=z.object({section:z.enum(sections).default('concepts'),offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(20).default(10)}).strict();
export const automaticFoundationRead:DomainTool={name:'foundation_read',mutates:false,
  description:'分页读取本份文档所用的真实本体定义目录。默认概念页；section 可读 relations、properties、unknowns、conflicts、evidence。沿 page.nextOffset 读取后页；不返回执行绑定、发现诊断或完整历史。补充时只提交涉及的已有定义，其他定义由宿主保留。',
  inputSchema:z.toJSONSchema(input)};

const keys=['id','name','description','from','to','entityTypeId','valueType','nullable','evidenceRefs','resolvedBy'] as const;
function summary(item:Data,section:typeof sections[number]):Data {
  if(section==='evidence') return Object.fromEntries(['id','kind','sourceId','sourceVersion','sourceRef','title'].filter(key=>item[key]!==undefined).map(key=>[key,item[key]]));
  const result:Data=Object.fromEntries(keys.filter(key=>item[key]!==undefined).map(key=>[key,item[key]]));
  // Long alias collections are navigation hints. Omit aliases from a proposal to preserve the full stored collection.
  if(Array.isArray(item.aliases)) {
    result.aliases=item.aliases.slice(0,5).map(alias=>String(alias).slice(0,100));
    result.aliasesTotal=item.aliases.length;
    result.aliasesTruncated=item.aliases.length>5||item.aliases.some(alias=>String(alias).length>100);
  }
  return result;
}

/** Background model context is a bounded semantic catalog, never the UI's execution/evidence projection. */
export function automaticDocumentContext(draft:Artifact,adopted:Artifact|null,args:Record<string,unknown>):Data {
  const request=input.parse(args),items=(draft.content[request.section]??[]) as Data[];
  const entries:Data[]=[];
  let position=request.offset;
  while(position<items.length&&entries.length<request.limit) {
    const item=summary(items[position],request.section);
    if(entries.length&&JSON.stringify([...entries,item]).length>8000) break;
    if(JSON.stringify(item).length>8000) throw new Error('单项语义定义超过后台读取范围，请先缩小该定义的说明或依据集合');
    entries.push(item);position++;
  }
  const content:Data={enterprise:draft.content.enterprise,concepts:[],relations:[],properties:[],unknowns:[],conflicts:[],evidence:[],[request.section]:entries};
  return {current:{id:draft.id,version:draft.version,status:draft.status,content},adoptedRef:adopted?{id:adopted.id,version:adopted.version}:null,
    catalog:Object.fromEntries(sections.map(section=>[section,((draft.content[section]??[]) as unknown[]).length])),
    page:{...request,returned:entries.length,total:items.length,nextOffset:position<items.length?position:null},
    note:'只展示本页语义定义；未列出的对象没有被删除。正文依据须使用 foundation_document_read 的本轮 readId。属性目录用于辨认对象，本工具不新增或改写属性。'};
}

export function automaticDocumentReceipt(draft:Artifact,args:Record<string,unknown>):Data {
  return {id:draft.id,version:draft.version,status:draft.status,staged:true,
    updated:Object.fromEntries(['concepts','relations','unknowns','conflicts'].map(section=>[section,((args[section]??[]) as Data[]).map(item=>item.id)])),
    note:'本份补充已暂存，整批完成后由宿主合并提交。需要继续补充时用此 version；已有定义与依据由宿主保留。'};
}
