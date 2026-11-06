import { fingerprint } from './sources.ts';
import { structuredDiscoveryModelSchema } from './structured-model-boundary.ts';
import { compactCoordinationSchema } from './compact-coordination-schema.ts';
export { compactCoordinationSchema } from './compact-coordination-schema.ts';

type Member = { id: string; sourceColumns: Array<{ sourceVersionId: string; column: string }>;
  uncertainties: Array<{ kind: string; question: string; dimensions?: string[] }>; [key: string]: unknown };
type Entry = { ref: string; kind: 't'|'p'|'l'; table: number; owner?: string; member: Member };
type Group = { refs: string[]; changes?: Record<string, unknown>; reason?: string; bindings?:Member['sourceColumns'] };
const unique = <T>(items: T[]) => [...new Map(items.map(item => [fingerprint(item), item])).values()];

/** Shared mechanical ID qualification; it expresses no semantic identity. */
export function qualifyMemberId(owner:string,id:string,reserved:Set<string>){
  const qualified=`${owner}:${id}`;let next=qualified;
  if(next.length>160||reserved.has(next))next=`${qualified.slice(0,120)}:${fingerprint({owner,id}).slice(0,32)}`;
  let attempt=0;while(reserved.has(next))next=`${qualified.slice(0,120)}:${fingerprint({owner,id,attempt:attempt++}).slice(0,32)}`;
  reserved.add(next);return next;
}
export function coordinationReferences(candidates: unknown[], stable=false) {
  let t = 0, p = 0, l = 0;
  const reserved=new Set<string>();
  const reference=(kind:string,identity:unknown,fallback:number)=>{
    if(!stable)return `${kind}${fallback}`;
    let attempt=0,result:string;
    do{result=kind+BigInt('0x'+fingerprint({identity,attempt:attempt++}).slice(0,14)).toString();}while(reserved.has(result));
    reserved.add(result);return result;
  };
  return candidates.map(raw => {
    const candidate = structuredDiscoveryModelSchema('coordinate').parse(raw);
    return { ...candidate, types: candidate.types.map(type => ({ ...type, ref: reference('t',{id:type.id,sources:[...type.sourceColumns,...type.properties.flatMap(p=>p.sourceColumns)].map(b=>b.sourceVersionId).sort()},t++),
      properties: type.properties.map(property => ({ ...property, ref: reference('p',{owner:type.id,id:property.id,sources:property.sourceColumns},p++) })),
    })), links: candidate.links.map(link => ({ ...link, ref: reference('l',{id:link.id,from:link.from,to:link.to,sources:link.sourceColumns},l++) })) };
  });
}

/** Omitted members survive; explicit decisions reject duplicate refs and implicit conflict resolution. */
export function materializeCoordination(candidates: unknown[], raw: unknown, stable=false, allowEmpty=false) {
  const input = coordinationReferences(candidates,stable), plan = compactCoordinationSchema.parse(raw);
  const entries = new Map<string, Entry>();
  input.forEach((candidate, table) => {
    for (const { ref, properties, ...member } of candidate.types) {
      entries.set(ref, { ref, kind: 't', table, member: member as Member });
      for (const { ref: propertyRef, ...property } of properties)
        entries.set(propertyRef, { ref: propertyRef, kind: 'p', table, owner: ref, member: property as Member });
    }
    for (const { ref, ...member } of candidate.links) entries.set(ref, { ref, kind: 'l', table, member: member as Member });
  });
  const resolved = new Map<string, Set<number>>();
  for (const resolution of plan.resolutions) {
    const entry = entries.get(resolution.ref);
    if (!entry) throw new Error('协调解疑引用不存在的候选');
    const indexes = resolved.get(resolution.ref) ?? new Set<number>();
    for (const index of resolution.indexes) {
      if (index >= entry.member.uncertainties.length || indexes.has(index)) throw new Error('协调解疑索引不存在或重复');
      indexes.add(index);
    }
    resolved.set(resolution.ref, indexes);
  }
  const added = new Map<string, Member['uncertainties']>();
  for (const { ref, ...issue } of plan.uncertainties) {
    if (!entries.has(ref)) throw new Error('协调疑问引用不存在的候选');
    added.set(ref, [...(added.get(ref) ?? []), issue]);
  }
  const used = new Set<string>(), finalType = new Map<string, string>();
  const select = (item: Group, kind: Entry['kind'], owners?: Set<string>) => item.refs.map(ref => {
    const entry = entries.get(ref);
    if (!entry || entry.kind !== kind) throw new Error('协调引用不存在或成员类别不符');
    if (used.has(ref)) throw new Error('协调候选引用重复，不能重复采用或合并');
    if (owners && !owners.has(entry.owner!) && !item.reason) throw new Error('协调属性跨类型移动必须说明理由');
    used.add(ref); return entry;
  });
  const merge = (item: Group, selected: Entry[], rewrite?: (entry: Entry) => Member) => {
    const changes = item.changes ?? {};
    if ((selected.length > 1 || Object.keys(changes).length || item.bindings) && !item.reason) throw new Error('协调合并或修改必须说明理由');
    const members = selected.map(entry => rewrite ? rewrite(entry) : entry.member);
    const keys = new Set(members.flatMap(member => Object.keys(member)).filter(key => key !== 'sourceColumns' && key !== 'uncertainties'));
    for (const key of keys) if (new Set(members.map(member => fingerprint({ value: member[key] }))).size > 1 && !Object.hasOwn(changes, key))
      throw new Error(`协调合并存在未明确处理的字段冲突：${key}`);
    return { ...members[0], ...changes,
      sourceColumns: item.bindings??unique(members.flatMap(member => member.sourceColumns)),
      uncertainties: unique(selected.flatMap(entry => [
        ...entry.member.uncertainties.filter((_, index) => !resolved.get(entry.ref)?.has(index)), ...(added.get(entry.ref) ?? []),
      ])),
    };
  };
  for(const removal of plan.removals){if(!entries.has(removal.ref)||used.has(removal.ref))throw new Error('删除引用不存在或重复');used.add(removal.ref);}
  const types = plan.types.map(type => {
    const selected = select(type, 't');
    const member = merge(type, selected);
    for (const entry of selected) finalType.set(entry.ref, member.id);
    const owners = new Set(type.refs);
    const properties = type.properties.map(property => merge(property, select(property, 'p', owners)));
    return { ...member, properties };
  });
  // Omission means retention. Explicit groups consume members; omitted properties
  // follow their original owner, including an explicitly merged or renamed owner.
  for(const entry of entries.values())if(entry.kind==='t'&&!used.has(entry.ref)){used.add(entry.ref);finalType.set(entry.ref,entry.member.id);types.push({...merge({refs:[entry.ref]},[entry]),properties:[]});}
  for(const entry of entries.values())if(entry.kind==='p'&&!used.has(entry.ref)){const owner=types.find(t=>t.id===finalType.get(entry.owner!));if(!owner)throw new Error('删除类型必须显式处理其属性');used.add(entry.ref);owner.properties.push(merge({refs:[entry.ref]},[entry]));}
  for(const {member} of plan.additions.types)types.push(member);
  for(const {owner,member} of plan.additions.properties){const target=types.find(t=>t.id===owner);if(!target)throw new Error('新增属性所属类型不存在');target.properties.push(member);}
  const endpoint = (entry: Entry, id: string, explicit?: unknown) => {
    if (typeof explicit === 'string') return explicit;
    const all = [...entries.values()].filter(value => value.kind === 't' && value.member.id === id);
    const local = all.filter(value => value.table === entry.table);
    const targets = new Set((local.length ? local : all).map(value => finalType.get(value.ref)));
    if (targets.size > 1) throw new Error('协调关系端点存在多个候选，必须明确指定最终类型');
    return targets.size === 1 ? [...targets][0]! : id;
  };
  const links = plan.links.map(link => merge(link, select(link, 'l'), entry => ({ ...entry.member,
    from: endpoint(entry, entry.member.from as string, link.changes?.from),
    to: endpoint(entry, entry.member.to as string, link.changes?.to),
  })));
  for(const entry of entries.values())if(entry.kind==='l'&&!used.has(entry.ref)){used.add(entry.ref);links.push(merge({refs:[entry.ref]},[entry],e=>({...e.member,from:endpoint(e,e.member.from as string),to:endpoint(e,e.member.to as string)})));}
  links.push(...plan.additions.links.map(a=>a.member));
  if (used.size !== entries.size) throw new Error('协调结果遗漏候选成员；必须逐项保留、明确合并或标注暂缓，不得静默丢弃');
  // Separate type groups already express separate owners. Qualify inherited
  // property IDs mechanically; never infer a semantic merge from a shared name.
  const propertyGroups = new Map<string, Array<{ owner: string; member: Member; explicit: boolean }>>();
  types.forEach((type, index) => type.properties.forEach((member, propertyIndex) => {
    const explicitIds=new Set(plan.types.flatMap(t=>t.properties.flatMap(p=>typeof p.changes?.id==='string'?[p.changes.id]:[])));
    const group = {changes:explicitIds.has(member.id)?{id:member.id}:{}};
    const items = propertyGroups.get(member.id) ?? [];
    items.push({ owner: type.id, member, explicit: Object.hasOwn(group?.changes ?? {}, 'id') });
    propertyGroups.set(member.id, items);
  }));
  const reserved = new Set([...types, ...types.flatMap(type => type.properties), ...links].map(member => member.id));
  for (const [id, items] of propertyGroups) {
    if (items.length < 2 || new Set(items.map(item => item.owner)).size !== items.length) continue;
    for (const item of items.filter(item => !item.explicit)) {
      item.member.id=qualifyMemberId(item.owner,id,reserved);
    }
  }
  const ids = [...types, ...types.flatMap(type => type.properties), ...links].map(member => member.id);
  if (new Set(ids).size !== ids.length) throw new Error('协调后成员编号重复；必须明确合并或重命名');
  const actions = unique(input.flatMap(candidate => candidate.actions));
  // Re-enter the complete wire contract before evidence and business validation.
  if(allowEmpty&&!types.length&&!links.length)return {name:plan.name,types:[],links:[],actions};
  return structuredDiscoveryModelSchema('coordinate').parse({ name: plan.name, types, links, actions });
}

export const compactCoordinationInstructions = 'coordinationFormat=references-v3：仅提交必要变化；遗漏成员默认保留。types/links/properties使用refs分组；合并、修改及属性跨类型移动必须说明reason，冲突字段必须明确changes；bindings可显式替换来源绑定并给reason。additions显式新增types、properties(owner为最终类型id)、links，每个新增成员须reason及真实sourceColumns；removals显式删除ref并给reason，删除类型须处理其全部属性。resolutions仅按ref和indexedUncertainties给出的原疑问索引解除已核实疑问；未解疑问保留。跨表候选仅建议，唯一命中也不自动采用或合并身份；依据不足保留未知。relationshipBindings按linkId显式选择完整候选candidateRef及对应from/to端点并给reason；中间表路径要分别选择两个端点，不能拼接不同角色或不同列组，分片候选不可选择。端点命名不一致必须结合来源列和目标候选类型判断，以changes.from/to明确修订。类和关系可共同修订，不把表等同于类。';
