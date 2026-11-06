/** Query hints belong to the selected published version and exact source versions. */
export function publishedDiscoveryCoverage(model:{id:string;status:string;discovery?:any},sourceVersionIds:string[]){
  const released=new Set<string>((model.status==='published'?model.discovery?.sources??[]:[]).map((s:any)=>s.id));
  const scope=[...new Set(sourceVersionIds)].filter(id=>released.has(id));
  const allowed=new Set(scope);
  const deferred=(model.status==='published'?model.discovery?.validation?.deferred??[]:[]).filter((d:any)=>d.evidence?.some((e:any)=>allowed.has(e.sourceVersionId)));
  return {ontologyId:model.id,sourceVersionIds:scope,status:model.status!=='published'?'not_applicable':scope.length?'recorded_release_scope':'coverage_unknown',
    deferred:deferred.map((d:any)=>({memberId:d.member.id,name:d.member.name,ownerTypeId:d.ownerTypeId,reason:d.reason,sourceVersionIds:[...new Set(d.evidence.map((e:any)=>e.sourceVersionId))].filter(id=>allowed.has(id as string))})),
    note:'仅适用于所选发布版本和列出的来源版本；未检查或缺少记录不表示没有业务关系，其他草稿不参与本次覆盖提示'};
}
