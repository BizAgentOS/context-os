/** Mock model decision: explicitly merge identical IDs, retain every candidate reference. */
export function retainedCoordination(input: any) {
  const original=(id:string)=>input.candidateIdOrigins?.find((m:any)=>m.candidateId===id)?.originalId??id;
  const byId = (items: any[]): any[][] => {
    const groups = new Map<string, any[]>();
    for (const item of items) groups.set(original(item.id), [...(groups.get(original(item.id)) ?? []), item]);
    return [...groups.values()];
  };
  return { name: '统一候选', types: byId(input.tableCandidates.flatMap((candidate: any) => candidate.types)).map(types => ({
    refs: types.map(type => type.ref), ...(types.length > 1 ? { reason: '夹具明确确认同一定义',...(new Set(types.map(t=>t.id)).size>1?{changes:{id:original(types[0].id)}}:{}) } : {}),
    properties: byId(types.flatMap(type => type.properties)).map(properties => ({
      refs: properties.map(property => property.ref), ...(properties.length > 1 ? { reason: '夹具明确确认同一属性' } : {}),
    })),
  })), links: byId(input.tableCandidates.flatMap((candidate: any) => candidate.links)).map(links => ({
    refs: links.map(link => link.ref), ...(links.length > 1 ? { reason: '夹具明确确认同一关系' } : {}),
  })) };
}
