import { statusLabel, revealBuildTarget } from './explorer.js';
/** Readable, version-local grouping; source/class lookup never uses another draft. */
export function discoveryDisplayGroups(current) {
  const validation=current?.discovery?.validation??{},names=new Map((validation.tableDecisions??[]).map(s=>[s.sourceVersionId,s.sourceName??s.sourceVersionId]));
  const types=[...(current?.definition?.types??[]),...(validation.tableProposals??[]).flatMap(p=>p.candidate?.types??[])];
  const typeNames=new Map(types.map(t=>[t.id,t.name??t.id]));
  const groups=new Map();
  for(const item of validation.deferred??[]){const member=item.member??{},owner=item.ownerTypeId??item.owner??types.find(t=>(t.properties??[]).some(p=>p.id===member.id))?.id??member.from??member.id;
    const sourceIds=[...new Set((item.evidence??member.sourceColumns??[]).map(e=>e.sourceVersionId))].sort(),reason=item.reason??'业务依据尚未明确';
    const key=JSON.stringify([sourceIds,owner,reason]);let group=groups.get(key);
    if(!group){group={sourceVersionIds:sourceIds,sourceNames:sourceIds.map(id=>names.get(id)??`来源 ${id.slice(0,8)}`),ownerId:owner,ownerName:typeNames.get(owner)??owner??'未知类',reason,members:[]};groups.set(key,group);}
    group.members.push({id:member.id,name:member.name??member.id});
  }
  return [...groups.values()].sort((a,b)=>a.sourceNames.join().localeCompare(b.sourceNames.join())||a.ownerName.localeCompare(b.ownerName));
}
export function relationshipDataMatchLabel(match) {
  if(!match||!['overlap_observed','zero_match','sample_no_match'].includes(match.status))return '所选映射数据检查尚未完成，不能解释为无关系';
  const count=`固定版本有界检查：${match.checked} 条中匹配 ${match.matched} 条`;
  const scopes=[match.sourceScope,...(match.targetScopes??[])].filter(Boolean);
  const coverage=scopes.length?`；源/目标读取覆盖：${scopes.map(s=>`${s.checkedRows}/${s.totalRows??'未知'}`).join('、')} 行`:'';
  if(match.status==='sample_no_match')return `${count}${coverage}；抽样未匹配，不代表全量无关联，业务关系定义保留。`;
  if(match.status==='zero_match')return scopes.length>1&&scopes.every(s=>s.complete===true)?`${count}${coverage}；完整固定版本范围零匹配，业务关系定义保留。`:`${count}；旧检查未记录完整覆盖，不能据此推断全量无关联，业务关系定义保留。`;
  return `${count}${coverage}；值重叠不证明业务含义。`;
}
export function discoveryCompletionLabel(validation) {
  const coverage=validation?.coverageManifest;
  if(coverage?.state==='completed'&&coverage.completed?.length===coverage.planned)return `分析已完成（${coverage.planned} 个协调步骤）；暂缓项仍待业务依据确认`;
  if(coverage&&coverage.state!=='completed')return `分析尚未完成（${coverage.completed?.length??0}/${coverage.planned??'?'} 个协调步骤），不能解释为无关系`;
  return '旧草稿未记录完整协调覆盖；不将缺少记录解释为分析完成或没有关系';
}
/** Keep feedback next to the action and never present an accepted job as a failed submission. */
export async function submitDiscovery({ getState, selectedSourceVersions, baseOntologyId, useBase, api, refresh, feedback }) {
  let accepted, operationId;
  try {
    const state = getState();
    if (!state) throw new Error('请先连接企业实例');
    if (state.maxSourceAssets === undefined) throw new Error('后端仍是旧进程，请先重启服务并刷新页面，再生成候选本体');
    const ids = selectedSourceVersions(), maximum = state.maxSourceAssets;
    if (!ids.length || ids.length > maximum) throw new Error(`请选择 1 至 ${maximum} 个来源`);
    if (ids.some(id => !id)) throw new Error('所选来源尚未采集完成，请等待来源版本就绪');
    if (!state.model) throw new Error('服务未配置模型，请配置后重启服务');
    const base = state.ontologies.find(o => o.id === baseOntologyId());
    feedback(`正在提交 ${ids.length} 个来源的候选本体任务…`);
    operationId = crypto.randomUUID();
    accepted = await api('/api/jobs', { kind: 'discover', operationId, sourceVersionIds: ids,
      ...(useBase() && base ? { baseOntologyId: base.id, baseRevision: base.revision } : {}) });
    feedback(`候选本体任务已创建（${accepted.id}），后台正在处理。可在“构建任务”查看进度，无需重复点击。`);
    await refresh();
    return accepted;
  } catch (error) {
    feedback(accepted ? `候选本体任务已创建（${accepted.id}），但列表刷新失败：${error.message}。请刷新任务列表，不要重复生成。`
      : operationId ? `提交结果尚未确认（请求编号 ${operationId}）：${error.message}。请先刷新任务列表核对，不要重复生成。`
      : `未创建候选本体任务：${error.message}`, true);
    return accepted ?? null;
  }
}

/** A stable operation ID permits checking/retrying an uncertain POST without purchasing another task. */
export async function submitCoordination({jobId,operationId,api,refresh,feedback}) {
  let accepted;
  try {
    feedback('正在校验保存的逐表结果并提交仅协调任务…');
    accepted=await api(`/api/jobs/${jobId}/recoordinate`,{operationId,confirmModelCall:true});
    feedback(`仅协调任务已创建（${accepted.id}）；只在协调阶段调用模型，原草稿保留。`);
    await refresh();
    return accepted;
  } catch(error) {
    feedback(accepted?`仅协调任务已创建（${accepted.id}），列表刷新失败：${error.message}。请刷新列表核对。`:
      `提交结果未确认或被拒绝（请求编号 ${operationId}）：${error.message}。请先核对任务列表；相同请求编号不会重复创建任务。`,true);
    return accepted??null;
  }
}

export function discoveryDecisionState(current) {
  const validation = current?.discovery?.validation;
  const issues = validation?.issues ?? [];
  const review = current?.discovery?.review;
  const saved = !!review && review.definitionHash === validation?.definitionHash && issues.every(i => review.issueIds?.includes(i.id));
  return { issues, saved, pending: current?.status === 'draft' && issues.length > 0 && !saved };
}

const exclusions = items => JSON.stringify(Object.keys(items).filter(id => items[id]?.include === false).sort());
const key = (source, kind, id) => `${source}:${kind}:${id}`;
export function createPlanWorkspace({ api, work, node, button, notice, getState, getOntologyId, refresh, openOntology }) {
  const $ = s => document.querySelector(s);
  const selectedSources = new Set(), seen = new Set();
  let plan, ontology, sources = new Map(), dirty = false,jsonDirty=false, savedProposal = '', savedExclusions = '', savedDatetimeOffset;
  const pretty = value => JSON.stringify(value, null, 2);
  const mutable = () => plan && plan.status !== 'approved' && !plan.staleReason && getState()?.actor.role !== 'viewer';
  const review = id => plan.review.items[id] ??= { include: true, reviewed: false };
  function changed(id) {
    dirty = true;
    if (id) review(id).reviewed = false;
    $('#plan-status').textContent = '有未保存修改，请保存并重新预检。'; syncControls();
  }
  function label(text, control) { const wrapper = node('label', text); wrapper.append(control); return wrapper; }
  function input(text, value, update, id, type = 'text') {
    const el = node('input'); el.type = type; el.value = value ?? ''; el.disabled = !mutable();
    el.addEventListener('input', () => { update(el.value); changed(id); }); return label(text, el);
  }
  function select(text, value, values, update, id) {
    const el = node('select');
    const choices = values.map(v => typeof v === 'string' ? { value: v, label: v } : v);
    if (!choices.some(v => v.value === value)) choices.unshift({ value: value ?? '', label: `请选择或修正：${value ?? ''}` });
    for (const v of choices) { const option = node('option', v.label); option.value = v.value; el.append(option); }
    el.value = value ?? ''; el.disabled = !mutable();
    el.addEventListener('change', () => { update(el.value); changed(id); }); return label(text, el);
  }
  function decisions(id, title) {
    const row = node('div'); row.className = 'row'; row.append(node('strong', title));
    for (const [field, text] of [['include', '纳入本次构建（自动校验，可主动排除）']]) {
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = review(id)[field]; checkbox.disabled = !mutable();
      checkbox.addEventListener('change', () => { review(id)[field] = checkbox.checked; dirty = true; $('#plan-status').textContent = '审核有变更，请保存并重新预检。'; syncControls(); });
      row.append(label(text, checkbox));
    }
    return row;
  }
  function timeEditor(container, time, columns, id) {
    container.append(select('此条声明的业务时间', time.mode, [
      { value: 'unknown', label: '未知（不套用其他声明时间）' }, { value: 'columns', label: '来自指定来源字段' }, { value: 'fixed', label: '明确起止时间（需说明依据）' },
    ], value => { time.mode = value; delete time.fromColumn; delete time.toColumn; delete time.from; delete time.to; changed(id); render(); }, id));
    if (time.mode === 'columns') {
      container.append(select('有效起点列', time.fromColumn ?? '', ['', ...columns], value => { if (value) time.fromColumn = value; else delete time.fromColumn; }, id));
      container.append(select('有效终点列', time.toColumn ?? '', ['', ...columns], value => { if (value) time.toColumn = value; else delete time.toColumn; }, id));
    }
    if (time.mode === 'fixed') {
      for (const [field, text] of [['from', '业务有效起点（ISO 含时区）'], ['to', '业务有效终点（可空）']]) container.append(input(text, time[field], value => { if (value) time[field] = value; else delete time[field]; }, id));
    }
    container.append(input('为何这个时间属于此条属性或关系', time.reason, value => time.reason = value, id));
  }
  function comparisonEditor(container, comparison, id) {
    for (const [field, text] of [['unit', '单位'], ['currency', '币种'], ['scope', '税口径 / 统计范围']]) container.append(input(text, comparison[field], value => { if (value.trim()) comparison[field] = value.trim(); else delete comparison[field]; }, id));
  }
  const expandedSections = new Map();
  function heading(container, title, open = true, sectionKey = title) {
    const stateKey = `${plan?.id}:${sectionKey}`;
    const section = node('details'); section.className = 'plan-disclosure';
    section.open = expandedSections.get(stateKey) ?? open;
    section.addEventListener('toggle', () => { if (section.isConnected) expandedSections.set(stateKey, section.open); });
    section.append(node('summary', title)); container.append(section); return section;
  }
  function renderCsv(source) {
    const data = sources.get(source.sourceVersionId), columns = data?.content.columns ?? [];
    const sourceTitle = data?.title ?? plan.manifest.find(s => s.id === source.sourceVersionId)?.title ?? source.sourceVersionId;
    const root = heading($('#plan-bindings'), `${data?.content.kind === 'table' ? '数据库表' : 'CSV 文件'} · ${sourceTitle}`, false);
    const objectOptions = () => source.objects.map(o => ({ value: o.id, label: `${o.id} · ${o.typeId}` }));
    for (const object of source.objects) {
      const id = key(source.sourceVersionId, 'object', object.id), row = heading(root, `对象绑定 ${object.id}`, false);
      row.append(decisions(id, '身份取自指定编号列；默认只在本来源内有效'));
      row.append(select('业务对象类型', object.typeId, ontology.definition.types.map(t => ({ value: t.id, label: `${t.name} · ${t.id}` })), value => { object.typeId = value; changed(id); render(); }, id));
      row.append(select('编号列', object.identityColumn, columns, value => object.identityColumn = value, id));
      row.append(select('SQL NULL 对象策略',object.onNull??'error',[{value:'error',label:'身份不能为空；缺失报错'},{value:'skip_object',label:'原生可空非主键角色：不生成对象及其声明'}],value=>object.onNull=value,id));
    }
    for (const property of source.properties) {
      const id = key(source.sourceVersionId, 'property', property.id), row = heading(root, `属性绑定 ${property.id}`, false);
      row.append(decisions(id, property.predicate));
      row.append(select('所属对象绑定', property.object, objectOptions(), value => { property.object = value; changed(id); render(); }, id));
      const typeId = source.objects.find(o => o.id === property.object)?.typeId;
      const properties = ontology.definition.types.find(t => t.id === typeId)?.properties ?? [];
      row.append(select('业务属性', property.predicate, properties.map(p => ({ value: p.id, label: `${p.name} · ${p.id}` })), value => { property.predicate = value; if(properties.find(p=>p.id===value)?.valueType!=='boolean')delete property.booleanEncoding; changed(id); render(); }, id));
      row.append(select('取值列', property.column, columns, value => property.column = value, id));
      if(properties.find(p=>p.id===property.predicate)?.valueType==='boolean')row.append(select('布尔值编码（需业务依据）',property.booleanEncoding??'literal',[{value:'literal',label:'原文 false / true'},{value:'zero_one',label:'显式：0=false，1=true'}],value=>property.booleanEncoding=value,id));
      if (properties.find(p => p.id === property.predicate)?.valueType === 'datetime') row.append(node('p', '这是业务日期属性的值。请检查是否误把任职/关系的结束时间当成合同等对象自身的终止日期。'));
      row.append(input('属性业务含义（日期属性必填）', property.meaning, value => property.meaning = value, id));
      timeEditor(row, property.time, columns, id); comparisonEditor(row, property.comparison, id);
    }
    for (const relation of source.links) {
      const id = key(source.sourceVersionId, 'link', relation.id), row = heading(root, `关系绑定 ${relation.id}`, false);
      row.append(decisions(id, relation.predicate));
      row.append(select('本体关系（方向按定义）', relation.predicate, ontology.definition.links.map(l => ({ value: l.id, label: `${l.name} · ${l.from} → ${l.to} · ${l.multiple ? '多值' : '主体侧单值'}` })), value => relation.predicate = value, id));
      row.append(select('from 对象绑定', relation.from, objectOptions(), value => relation.from = value, id));
      row.append(select('to 对象绑定', relation.to, objectOptions(), value => relation.to = value, id));
      timeEditor(row, relation.time, columns, id);
    }
    if (mutable()) {
      root.append(button('补充对象绑定', async () => { source.objects.push({ id: `object_${crypto.randomUUID().slice(0, 8)}`, typeId: ontology.definition.types[0].id, identityColumn: columns[0] ?? '' }); changed(); render(); }));
      root.append(button('补充属性绑定', async () => { source.properties.push({ id: `property_${crypto.randomUUID().slice(0, 8)}`, object: source.objects[0]?.id ?? '', predicate: '', column: columns[0] ?? '', time: { mode: 'unknown', reason: '' }, comparison: {}, meaning: '' }); changed(); render(); }));
      root.append(button('补充关系绑定', async () => { source.links.push({ id: `link_${crypto.randomUUID().slice(0, 8)}`, predicate: ontology.definition.links[0]?.id ?? '', from: source.objects[0]?.id ?? '', to: source.objects[1]?.id ?? '', time: { mode: 'unknown', reason: '' } }); changed(); render(); }));
    }
  }
  function renderDocument(source) {
    const data = sources.get(source.sourceVersionId);
    const root = heading($('#plan-bindings'), `PDF 候选声明 · ${data?.title ?? source.sourceVersionId}`, false);
    source.claims.forEach((entry, index) => {
      const id = key(source.sourceVersionId, 'claim', index), c = entry.claim;
      const row = heading(root, `${index + 1}. ${c.subject.value} · ${c.predicate} · ${c.object?.value ?? c.value}`, false);
      row.append(decisions(id, '确认语义、证据和时间；不正确可修改或排除'));
      row.append(select('主体类型', c.subject.typeId, ontology.definition.types.map(t => ({ value: t.id, label: `${t.name} · ${t.id}` })), value => { c.subject.typeId = value; changed(id); render(); }, id));
      row.append(input('主体原始编号（必须在证据中）', c.subject.value, value => c.subject.value = value, id));
      const type = ontology.definition.types.find(t => t.id === c.subject.typeId);
      const predicates = c.object ? ontology.definition.links.filter(l => l.from === c.subject.typeId) : type?.properties ?? [];
      row.append(select('属性或关系', c.predicate, predicates.map(p => ({ value: p.id, label: `${p.name} · ${p.id}` })), value => { c.predicate = value; changed(id); render(); }, id));
      if (c.object) {
        row.append(select('关系目标类型', c.object.typeId, ontology.definition.types.map(t => ({ value: t.id, label: `${t.name} · ${t.id}` })), value => c.object.typeId = value, id));
        row.append(input('目标原始编号', c.object.value, value => c.object.value = value, id));
        if (mutable()) row.append(button('交换主体与目标（需同时核对本体方向）', async () => { [c.subject, c.object] = [c.object, c.subject]; changed(id); render(); }));
      } else {
        const property = type?.properties.find(p => p.id === c.predicate);
        row.append(input('属性值', c.value === null ? 'null' : String(c.value), value => {
          c.value = value === 'null' ? null : property?.valueType === 'integer' ? Number(value) : property?.valueType === 'boolean' ? value === 'true' ? true : value === 'false' ? false : value : value;
        }, id));
        if (property?.valueType === 'datetime') row.append(node('p', '日期属性：必须确认这是对象自身业务日期，而不是负责人关系的起止。'));
      }
      row.append(select('语气', c.semantics.modality, ['actual', 'planned', 'hypothetical'], value => c.semantics.modality = value, id));
      row.append(select('肯定或否定', c.semantics.polarity, ['affirmed', 'negated'], value => c.semantics.polarity = value, id));
      row.append(input('原文条件（空为无条件）', c.semantics.condition, value => { if (value.trim()) c.semantics.condition = value; else delete c.semantics.condition; }, id));
      row.append(select('时间精度', c.validity.precision, ['unknown', 'day', 'instant'], value => { c.validity.precision = value; if (value === 'unknown') c.validity.from = c.validity.to = null; changed(id); render(); }, id));
      for (const [field, text] of [['from', '此声明业务有效起点（ISO 含时区）'], ['to', '此声明业务有效终点']]) row.append(input(text, c.validity[field], value => c.validity[field] = value || null, id));
      row.append(input('时间/日期归属的原文解释', entry.timeExplanation, value => entry.timeExplanation = value, id));
      c.evidence.forEach((ref, evidenceIndex) => {
        const evidence = node('div');
        if (ref.kind === 'quote') {
          const text = node('textarea'); text.rows = 3; text.value = ref.quote; text.disabled = !mutable();
          text.addEventListener('change', () => { ref.quote = text.value; ref.start = Math.max(0, data.content.text.indexOf(ref.quote)); changed(id); });
          evidence.append(label(`依据 ${evidenceIndex + 1} · 逐字原文`, text));
          evidence.append(input('原文位置（重复引文需精确定位）', ref.start, value => ref.start = Number(value), id, 'number'));
        } else evidence.append(node('pre', pretty(ref)));
        const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = entry.timeEvidenceIndexes.includes(evidenceIndex); checkbox.disabled = !mutable();
        checkbox.addEventListener('change', () => { entry.timeEvidenceIndexes = checkbox.checked ? [...new Set([...entry.timeEvidenceIndexes, evidenceIndex])] : entry.timeEvidenceIndexes.filter(i => i !== evidenceIndex); changed(id); });
        evidence.append(label('这段依据支持此声明的有效时间', checkbox)); row.append(evidence);
      });
      comparisonEditor(row, c.comparison, id);
    });
    if (mutable()) root.append(button('补充文档属性声明', async () => {
      const type = ontology.definition.types.find(t => t.properties.length);
      if (!type) throw new Error('本体没有可用属性');
      source.claims.push({ claim: { subject: { typeId: type.id, namespace: `source.${data.source_id}`, value: '' }, predicate: type.properties[0].id, value: '', validity: { from: null, to: null, precision: 'unknown' }, evidence: [{ kind: 'quote', quote: '', start: 0 }], basis: 'explicit', semantics: { polarity: 'affirmed', modality: 'actual' }, comparison: {} }, timeExplanation: '', timeEvidenceIndexes: [] }); changed(); render();
    }));
  }
  function render() {
    $('#plan-status').textContent = `计划 ${plan.id} · r${plan.revision} · ${statusLabel(plan.effectiveStatus ?? plan.status)}${plan.staleReason ? ` · 已失效：${plan.staleReason}` : ''}${dirty ? ' · 未保存' : ''}`;
    if (plan.preview?.errors?.length) $('#plan-status').textContent += ` · 尚未执行：${plan.preview.errors.length} 项阻断（展开预检详情查看）`;
    const summary=$('#plan-summary');
    if(summary){
      summary.replaceChildren(node('h3','本轮构建范围'),node('p',`本体：${ontology.definition.name}。来源 ${plan.manifest.length} 份；本体发布和事实构建分别以真实回执为准。`));
      const typeName=id=>ontology.definition.types.find(t=>t.id===id)?.name??id;
      const timeText=t=>!t||t.mode==='unknown'?'时间未知，不解释为永久有效':t.mode==='columns'?`按字段 ${t.fromColumn||'未提供起点'} 至 ${t.toColumn||'未提供终点'} 读取`:`固定 ${t.from||'未提供起点'} 至 ${t.to||'未提供终点'}；依据：${t.reason||'待补充'}`;
      const comparison=c=>[['unit','单位'],['currency','币种'],['scope','范围']].filter(([k])=>c?.[k]).map(([k,n])=>`${n} ${c[k]}`).join('，')||'口径未提供，不补猜';
      for(const source of plan.proposal.csv){
        const ref=plan.manifest.find(r=>r.id===source.sourceVersionId),card=heading(summary,`${ref?.title??'来源'} · ${source.objects.length} 个对象绑定 / ${source.properties.length} 个属性 / ${source.links.length} 个关系`,false,`scope:${source.sourceVersionId}`);
        const included=plan.review.items[key(source.sourceVersionId,'source','include')]?.include!==false;
        card.append(node('h4',ref?.title??'来源'),node('p',source.objects.map(o=>`${typeName(o.typeId)}：按「${o.identityColumn}」识别`).join('；')),node('p',included?'构建时替代本来源的旧来源声明，人工修正和历史保留。':'本来源已在审核中排除，不执行替代。'));
        for(const p of source.properties){const binding=source.objects.find(o=>o.id===p.object),type=ontology.definition.types.find(t=>t.id===binding?.typeId),property=type?.properties.find(v=>v.id===p.predicate);card.append(node('p',`${property?.name??p.predicate} ← ${p.column}；${timeText(p.time)}；${comparison(p.comparison)}`));}
        for(const l of source.links){const definition=ontology.definition.links.find(v=>v.id===l.predicate);card.append(node('p',`${definition?.name??l.predicate}：${typeName(source.objects.find(o=>o.id===l.from)?.typeId)} → ${typeName(source.objects.find(o=>o.id===l.to)?.typeId)}；${timeText(l.time)}`));}
      }
      for(const source of plan.proposal.documents){const card=heading(summary,`${plan.manifest.find(r=>r.id===source.sourceVersionId)?.title??'文档'} · ${source.claims.length} 条候选声明`,false,`scope:${source.sourceVersionId}`);card.append(node('h4',plan.manifest.find(r=>r.id===source.sourceVersionId)?.title??'文档'),node('p',`${source.claims.length} 条候选声明。采用后替代此来源的旧来源声明，原始依据和人工修正保留。`));for(const item of source.claims.slice(0,20)){const c=item.claim;card.append(node('p',`${typeName(c.subject.typeId)} ${c.subject.value} · ${c.predicate}；${c.validity?.precision==='unknown'?'时间未知':`${c.validity?.from||'未提供起点'} 至 ${c.validity?.to||'未提供终点'}`}；${comparison(c.comparison)}`));}if(source.claims.length>20)card.append(node('p','摘要显示前20条，完整候选和依据在高级配置中。'));}
    }
    $('#plan-manifest').replaceChildren(node('p', '普通绑定自动校验，无需逐项确认；只处理下方重大事件。正式构建会替代选中来源的旧来源声明，人工修正与历史保留。'));
    if ([...sources.values()].some(s => s.content.kind === 'table')) {
      $('#plan-manifest').append(node('p', '数据库 DATETIME 不携带时区。仅在已确认所选来源采用相同本地时区时，填写偏移（如 +08:00 或 Z）；不默认猜测。TIMESTAMP 已由采集连接按 UTC 读取，不受此项重复偏移。'));
      $('#plan-manifest').append(input('本计划数据库 DATETIME 的时区偏移（未知可留空）', plan.review.datetimeOffset, value => { plan.review.datetimeOffset = value.trim() || undefined; }, undefined));
    }
    for (const ref of plan.manifest) {
      const row = node('div'),skipped=plan.proposal.skipped?.find(s=>s.sourceVersionId===ref.id); row.append(skipped?node('p',`${ref.title}：本轮跳过并保留旧正式事实；原因：${skipped.reason}`):decisions(key(ref.id, 'source', 'include'), `${ref.title} · ${ref.id}`), node('pre', pretty(ref.coverage))); $('#plan-manifest').append(row);
    }
    $('#plan-bindings').replaceChildren(); plan.proposal.csv.forEach(renderCsv); plan.proposal.documents.forEach(renderDocument);
    for(const skip of plan.proposal.skipped??[]){
      const section=heading($('#plan-bindings'),`本轮不构建 · ${plan.manifest.find(s=>s.id===skip.sourceVersionId)?.title??skip.sourceVersionId}`);
      section.append(node('p',`${skip.reason}；来源证据及旧正式结果保留。改变范围后须重新预检。`));
      if(mutable())section.append(button('为此来源补充映射',async()=>{
        plan.proposal.skipped=plan.proposal.skipped.filter(s=>s.sourceVersionId!==skip.sourceVersionId);
        plan.proposal.csv.push({sourceVersionId:skip.sourceVersionId,objects:[{id:'object_1',typeId:ontology.definition.types[0].id,identityColumn:sources.get(skip.sourceVersionId)?.content.columns?.[0]??''}],properties:[],links:[]});changed();render();
      }));
    }
    $('#plan-identities').replaceChildren(node('h3', '身份对应摘要（仅本批具体编号）'));
    const batchGroups = (plan.preview?.identities ?? []).filter(g => !g.autoContinued);
    if (batchGroups.length && mutable()) {
      $('#plan-identities').append(node('p', `本批 ${batchGroups.length} 组需决定。可统一决定、填写一次理由；展开单组可设置例外，不创建长期匹配规则。`));
      const commonReason = node('input'); commonReason.placeholder = '本批身份对应的范围与依据'; commonReason.value = plan.review.reason; commonReason.addEventListener('input', () => { plan.review.reason = commonReason.value; $('#plan-reason').value = commonReason.value; dirty = true; syncControls(); });
      $('#plan-identities').append(label('统一决定理由', commonReason));
      for (const [decision, text] of [['same', '批准本批对应并继续构建'], ['separate', '本批保持独立并继续构建']]) $('#plan-identities').append(button(text, async () => {
        if (jsonDirty || JSON.stringify(plan.proposal) !== savedProposal || exclusions(plan.review.items) !== savedExclusions || plan.review.datetimeOffset !== savedDatetimeOffset) throw new Error('映射、时区或纳入范围有未保存修改，请先保存并重新预检，再决定本批对应');
        const reason = commonReason.value.trim() || $('#plan-reason').value.trim();
        if (!reason) throw new Error('请填写一次本批决定理由');
        const overrides = Object.fromEntries(batchGroups.flatMap(g => { const choice = plan.review.identities[g.key]; return choice?.decision && choice.decision !== 'pending' ? [[g.key, { decision: choice.decision, reason: choice.reason || reason }]] : []; }));
        const result = await api(`/api/plans/${plan.id}/identities`, { expectedRevision: plan.revision, candidateHash: plan.preview.identityCandidateHash, decision, reason, overrides });
        await open(result.id, false);
        if (result.continuationJobId) { await refresh(); notice('本批决定已保存，后台继续预检与构建，不重新调用模型。'); } else await enqueueContinuation();
      }));
    }
    for (const group of plan.preview?.identities ?? []) {
      if (group.autoContinued) { $('#plan-identities').append(node('p', `${group.typeId} · ${group.value}：已批准且未变化的来源绑定，自动沿用。`)); continue; }
      const decision = plan.review.identities[group.key] ??= { decision: 'pending', reason: '' };
      const details = node('details'); details.append(node('summary', `${group.typeId} · ${group.value}（可选：单组例外与证据）`)); $('#plan-identities').append(details);
      const row = heading(details, `${group.typeId} · ${group.value}`);
      row.append(node('p', '仅首次合并或新增对应需要决定；未变化的批准绑定自动沿用。已有统一绑定不能在这里直接拆分，请先进行身份纠错。'));
      for (const p of group.participants) row.append(node('pre', pretty({ 来源: p.title, 版本: p.sourceVersionId, 证据: p.evidence, 已有对象: p.objectId, 当前绑定: p.bindingId, 统一身份: p.canonicalNamespace })));
      row.append(select('身份决定', decision.decision, [{ value: 'pending', label: '待处理' }, { value: 'same', label: '批准这些编号属于同一对象' }, { value: 'separate', label: '保持各来源独立' }], value => decision.decision = value));
      row.append(input('身份范围及决定理由', decision.reason, value => decision.reason = value));
    }
    $('#plan-reason').value = plan.review.reason; $('#plan-reason').disabled = !mutable();
    $('#plan-json').value = pretty(plan.proposal); $('#plan-json').disabled = !mutable();
    $('#plan-preview').replaceChildren();
    if (plan.preview) {
      $('#plan-preview').append(node('p', `普通项由系统校验，无需逐项确认；当前候选 ${plan.items?.length ?? 0} 项；重大构建事件 ${plan.preview.events?.length ?? 0} 项。`));
      if (plan.preview.acknowledgementPlanId) $('#plan-preview').append(node('p', `已沿用相同事件的决定：${plan.preview.acknowledgementPlanId}`));
      if (plan.preview.events?.length && !plan.preview.acknowledgementPlanId) {
        $('#plan-preview').append(node('h3', '重大事件摘要'), node('pre', pretty(plan.preview.events)), button('确认本次重大事件并重新预检', async () => {
          if (!mutable()) throw new Error('计划不可编辑');
          const reason = $('#plan-reason').value.trim(); if (!reason) throw new Error('请为重大事件填写业务决定理由');
          plan.review.eventAcknowledgement = plan.preview.eventHash; plan.review.reason = reason;
          await save(); await enqueueContinuation();
        }));
      }
      $('#plan-preview').append(node('h3', plan.preview.ready ? (plan.status === 'approved' ? '预检通过，已批准' : '预检通过，等待本体发布节点') : '预检需处理'), node('p', `阻断 ${plan.preview.errors?.length ?? 0} 项 · 提示 ${plan.preview.warnings?.length ?? 0} 项`));
      const report = heading($('#plan-preview'), '查看预检完整报告（数量、阻断与提示）', false, 'preflight-report');
      report.append(node('pre', pretty({ 数量: plan.preview.counts, 阻断: plan.preview.errors, 提示: plan.preview.warnings })));
      for (const output of plan.preview.outputs) {
        const row = heading($('#plan-preview'), `执行预览 · ${output.sourceVersionId} · ${output.output.claims.length} 条`, false);
        row.append(node('pre', pretty(output.output.claims.slice(0, 30))), node('p', '页面最多展示前 30 条；服务端预检执行全部选中 CSV 行，PDF 为保存的候选集合，不保证召回完整。'));
      }
    }
    if (plan.progress?.length) {
      $('#plan-preview').append(node('h3','逐来源执行结果'));
      for(const ref of plan.manifest){
        const receipts=plan.progress.filter(r=>r.source_version_id===ref.id),latest=receipts.at(-1),panel=heading($('#plan-preview'),`${ref.title} · ${latest?statusLabel(latest.status):'未执行'}`,false,`receipt:${ref.id}`);
        panel.append(node('h4',ref.title),node('p',`${latest?statusLabel(latest.status):'未执行'}${latest?(latest.is_current?' · 当前构建头':' · 非当前构建头'):''}`));
        if(latest?.result){panel.append(node('p',`本次回执：${latest.result.count??'未提供'} 条声明；${latest.result.objects?.length??'未提供'} 个涉及对象。领域回执未拆分“新建/变更”，不以涉及数量冒充新增数量。`));for(const id of latest.result.objects?.slice(0,20)??[]){const link=node('a',`查看结果对象 ${id.slice(0,8)} →`);link.href=`#browse?type=&object=${encodeURIComponent(id)}`;panel.append(link,node('br'));}panel.append(node('p','剩余事实问题未全量统计；打开结果对象按当前投影查证，不能据构建成功认定无分歧。'));}
        const detail=node('details');detail.append(node('summary','查看真实执行回执'),node('pre',pretty(receipts)));panel.append(detail);
      }
      const link=node('a','查看正式本体与对象 →');link.href='#browse';$('#plan-preview').append(link);
    }
    syncControls();
  }
  function syncControls() {
    $('#plan-save').disabled = $('#plan-preflight').disabled = $('#plan-import-json').disabled = !mutable();
    $('#plan-refresh').disabled = !plan;
    $('#plan-approve').disabled = !mutable() || !plan?.preview?.ready || dirty || jsonDirty || (ontology?.status === 'draft' && getState()?.actor.role !== 'admin');
    $('#plan-build').disabled = jsonDirty || !plan || !!plan?.staleReason || getState()?.actor.role === 'viewer';
  }
  async function open(id, scroll = true) {
    plan = await api(`/api/plans/${id}`); ontology = await api(`/api/ontologies/${plan.ontology_id}`);
    sources = new Map(await Promise.all(plan.manifest.map(async ref => [ref.id, await api(`/api/source-versions/${ref.id}`)])));
    dirty = false;jsonDirty=false; savedProposal = JSON.stringify(plan.proposal); savedExclusions = exclusions(plan.review.items); savedDatetimeOffset = plan.review.datetimeOffset; $('#plan-select').value = id; render(); if (scroll) revealBuildTarget($('#build-plans')).scrollIntoView();
  }
  async function save() {
    if (!mutable()) throw new Error('请先选择可编辑计划');
    if(jsonDirty)throw new Error('高级 JSON 有尚未载入的修改，请先点击载入 JSON；已保留编辑。');
    plan.review.reason = $('#plan-reason').value;
    const result = await api(`/api/plans/${plan.id}/save`, { expectedRevision: plan.revision, proposal: plan.proposal, review: plan.review });
    await open(result.id); return result;
  }
  $('#plan-reason').addEventListener('input', () => { if (plan) { plan.review.reason = $('#plan-reason').value; changed(); } });
  $('#plan-json').addEventListener('input',()=>{jsonDirty=true;$('#plan-status').textContent='高级 JSON 有未载入修改，刷新将保留编辑。';});
  $('#plan-select').addEventListener('change', () => {
    const next=$('#plan-select').value;if(!next)return;
    if(dirty||jsonDirty){$('#plan-select').value=plan?.id??'';notice('当前方案有未保存或未载入修改，先保存后再切换；已保留编辑。',true);return;}
    void work(()=>open(next));
  });
  async function refreshCurrent() { if (dirty||jsonDirty) return false; if (plan) await open(plan.id, false); return true; }
  $('#plan-refresh').addEventListener('click', () => void work(async () => { notice(await refreshCurrent() ? '计划状态已刷新。' : '保留未保存的审核内容，请先保存再刷新计划。'); }));
  $('#plan-save').addEventListener('click', () => void work(async () => { await save(); notice('审核已保存，请运行预检。'); }));
  $('#plan-preflight').addEventListener('click', () => void work(async () => { const result = await save(); await api(`/api/plans/${result.id}/preflight`, { expectedRevision: result.revision }); await open(result.id); notice('预检已完成。无阻断且本体已发布时，计划自动批准；仅重大事件或首次身份合并需要决定。'); }));
  $('#plan-approve').addEventListener('click', () => void work(async () => {
    if (!plan || dirty || jsonDirty) throw new Error('请先保存并预检');
    let published = false, approved = false;
    try {
      const current = await api(`/api/ontologies/${plan.ontology_id}`);
      published = current.status === 'published';
      if (!published) {
        await api('/api/actions', { operationId: crypto.randomUUID(), kind: 'PublishOntologyVersion', targetId: current.id, expectedRevision: current.revision, reason: plan.review.reason || '自动校验通过，执行本体发布节点' });
        published = true;
      }
      await api(`/api/plans/${plan.id}/approve`, { expectedRevision: plan.revision }); approved = true;
      await refresh(); await open(plan.id); notice('本体已发布，当前计划已批准；可执行构建。');
    } catch (error) {
      try { await refresh(); await open(plan.id, false); } catch { /* Keep the original failure visible. */ }
      throw new Error(`${approved ? '计划已批准，但刷新失败' : published ? '本体已发布，但计划批准未确认，请刷新查看后重试批准' : '发布或批准未完成，请刷新确认状态'}：${error.message}`);
    }
  }));
  async function enqueueContinuation() {
    if (!plan) throw new Error('请先选择计划');
    if(jsonDirty)throw new Error('高级 JSON 有尚未载入的修改，请先载入 JSON；未提交构建任务。');
    if (dirty && mutable()) await save();
    await api('/api/jobs', { kind: 'build', operationId: crypto.randomUUID(), planId: plan.id, preflight: true });
    await refresh(); notice('已继续后台流程：自动预检、批准并构建；只在重大业务事件暂停，不重新调用模型。');
  }
  $('#plan-build').addEventListener('click', () => void work(enqueueContinuation));
  $('#plan-import-json').addEventListener('click', () => void work(async () => { if (!mutable()) throw new Error('计划不可编辑'); plan.proposal = JSON.parse($('#plan-json').value);jsonDirty=false; plan.review = { items: {}, identities: {}, reason: '' }; changed(); await save(); notice('高级修改已载入，所有审核决定已清除，请重新预检。'); }));
  async function generatePlan(autoBuild) {
    const ontologyId = getOntologyId(); if (!ontologyId) throw new Error('请先选择已保存本体');
    const current = await api(`/api/ontologies/${ontologyId}`);
    const collectDecisions = current.status !== 'published';
    const ids = selectedSourceVersions(); if (!ids.length || ids.length > (getState()?.maxSourceAssets??50)) throw new Error(`请选择 1 至 ${getState()?.maxSourceAssets??50} 个来源`);
    await api('/api/jobs', { kind: 'plan', operationId: crypto.randomUUID(), ontologyId, expectedRevision: current.revision, sourceVersionIds: ids, autoBuild: autoBuild && !collectDecisions, collectDecisions, ...(plan?.ontology_id === ontologyId ? { basePlanId: plan.id } : {}) });
    await refresh(); notice(collectDecisions ? '已在草稿上生成计划；本体与身份事项将在本轮决定包集中处理。' : autoBuild ? '已开始构建知识：后台自动生成计划、预检、批准及构建；需要业务决定时会显示待决定任务。' : '仅生成计划，完成后可查看或从计划继续。');
  }
  $('#generate-plan').addEventListener('click', () => void work(() => generatePlan(true)));
  $('#generate-plan-only').addEventListener('click', () => void work(() => generatePlan(false)));
  function selectedSourceVersions() { return getState().sources.filter(s => selectedSources.has(s.id)).map(s => s.active_version); }
  function update(state) {
    $('#discovery-sources').replaceChildren();
    for (const source of state.sources) {
      if (!seen.has(source.id)) { seen.add(source.id); selectedSources.add(source.id); }
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedSources.has(source.id);
      checkbox.addEventListener('change', () => checkbox.checked ? selectedSources.add(source.id) : selectedSources.delete(source.id));
      $('#discovery-sources').append(label(`${source.title} · ${source.kind} · v${source.active_revision}`, checkbox));
    }
    const select = $('#plan-select'); select.replaceChildren();
    const placeholder = node('option', '请选择计划'); placeholder.value = ''; select.append(placeholder);
    for (const saved of state.plans ?? []) { const option = node('option', `${statusLabel(saved.effective_status ?? saved.status)} · ${saved.id.slice(0, 8)} · ${saved.manifest.length} 份资料`); option.value = saved.id; select.append(option); }
    if (plan) select.value = plan.id;
  }
  function ontologyCoverage(current) {
    const panel = $('#discovery-coverage'); panel.replaceChildren(); if (!current) return;
    const advanced = node('details'); advanced.append(node('summary', '查看发现来源与变更的技术详情'), node('pre', pretty(current.discovery ?? { note: '手动或旧版本，未记录自动发现覆盖' })));
    panel.append(advanced);
    const validation = current.discovery?.validation;
    if (!validation) return;
    if(current.status==='draft'&&current.discovery?.validation?.tableProposals?.length&&current.discovery.sources?.every(s=>s.kind==='table')) {
      panel.append(node('p','仅重新协调会调用当前模型，可能收费；复用原任务已保存的逐表结果，缺失或不兼容时直接停止。当前草稿的手工修改不会进入本次协调；新建独立草稿，不自动生成计划、发布或构建。'));
      const coordinateOriginId=current.discovery.coordinationReuse?.jobId??current.discovery.jobId;
      const coordinateOperationId=`recoordinate:${coordinateOriginId}:${getState()?.promptVersion}`;
      panel.append(button('复用逐表结果，仅重新协调（调用模型，可能收费）',async()=>{
        await submitCoordination({jobId:current.discovery.jobId,operationId:coordinateOperationId,api,refresh,feedback:notice});
      }));
      panel.append(button('本地重新评估审核项（不调用模型）',async()=>{
        const editor=document.querySelector('#definition');
        if(editor&&JSON.stringify(JSON.parse(editor.value))!==JSON.stringify(current.definition))throw new Error('请先保存当前定义修改，避免覆盖未保存内容');
        await api(`/api/ontologies/${current.id}/reassess`,{expectedRevision:current.revision});
        await openOntology(current.id);
        notice('已本地重新评估审核项；未调用模型。已暂缓或排除的候选仍保留，恢复它们可能需要显式重新协调。');
      }));
    }
    const dictionaryHints=(validation.structuredProfiles??[]).flatMap(p=>(p.candidates?.columns??[]).filter(c=>c.commentCodeCandidates?.length).map(c=>({sourceVersionId:p.sourceVersionId,...c})));
    if(dictionaryHints.length){const hints=node('details');hints.append(node('summary', `列注释代码候选（${dictionaryHints.length} 列，尚未确认封闭业务枚举）`));for(const c of dictionaryHints)hints.append(node('p', `${c.sourceVersionId} · ${c.column}：${c.description}；${c.commentCodeCandidates.map(v=>`${v.code}=${v.meaning}`).join('，')}`));panel.append(hints);}
    panel.append(node('h3', '重大本体事件'), node('p', '普通成员由程序校验，无需逐项确认。这里只展示首次发布、已有语义变更或新增硬约束等重大事件。'));
    panel.append(node('p', `${discoveryCompletionLabel(validation)}。覆盖仅适用于本草稿来源范围；正式查询以其发布版本为准。`));
    if (validation.deferred?.length) {
      panel.append(node('h3', `已暂缓的候选（${validation.deferred.length} 项）`));
      for(const group of discoveryDisplayGroups(current)){
        const card=node('details');card.append(node('summary', `${group.sourceNames.join('、')||'来源未明确'} · ${group.ownerName} · ${group.members.length} 项`));
        card.append(node('p',group.reason));const members=node('ul');for(const member of group.members)members.append(node('li',`${member.name}（${member.id}）`));card.append(members);panel.append(card);
      }
    }
    if(validation.relationshipChecks?.length){
      const checks=node('details');checks.append(node('summary',`关系业务依据、来源绑定与数据检查（${validation.relationshipChecks.length} 项）`));
      for(const check of validation.relationshipChecks){
        const relation=current.definition.links.find(l=>l.id===check.memberId);checks.append(node('h4',relation?.name??check.memberId));
        checks.append(node('p',`业务含义依据：${check.businessMeaning.reasons?.join('；')||'暂无独立业务确认，仅保留提议与证据'}`));
        const bindings=check.sourceBinding.bindings??[];checks.append(node('p',bindings.length?bindings.map(b=>`${b.endpoint}：${b.sourceVersionId} [${b.sourceColumns.join('、')}] → ${b.targetSourceVersionId} [${b.targetColumns.join('、')}]`).join('；'):'来源映射尚未显式选择，不将唯一建议自动采用'));
        checks.append(node('p',relationshipDataMatchLabel(check.dataMatch)));
      }
      panel.append(checks);
    }
    if (!validation.issues.length) { panel.append(node('p', '无重大本体事件，普通候选已完成自动结构/证据校验，可继续发布和构建。')); return; }
    const decision = discoveryDecisionState(current);
    const status = node('p', current.status === 'published' ? '本体已发布。' : decision.saved ? '重大事件决定已保存；可点击“发布选中草稿”。修改定义后需要重新确认受影响的事件。' : `发布前还需保存 ${decision.issues.length} 项重大事件的决定。请先看下面的决定内容，再填写理由并确认。`);
    status.className = decision.pending ? 'uncertain' : 'resolved'; panel.append(status);
    const definition = current.definition;
    panel.append(node('h4', `本次拟启用：${definition.name}`));
    for (const type of definition.types) {
      const card = node('div'); card.append(node('strong', `${type.name}（${type.id}）`), node('p', type.description || '尚未提供类型说明'));
      const properties = node('ul');
      for (const property of type.properties) properties.append(node('li', `${property.name}：${property.valueType}，${property.required ? '必填' : '可缺省'}，${property.multiple ? '多值' : '单值'}${property.comparison ? `；口径 ${pretty(property.comparison)}` : ''}`));
      card.append(properties, node('p', `身份范围：${type.identityNamespaces?.join('、') || '未声明共享身份空间；跨源对象对应在构建方案中决定'}`)); panel.append(card);
    }
    panel.append(node('h4', '关系定义'));
    const relations = node('ul');
    for (const link of definition.links) relations.append(node('li', `${link.name}：${link.from} → ${link.to}，${link.multiple ? '可关联多个对象' : '最多关联一个对象'}`));
    panel.append(relations);
    const titles = { first_release: '首次启用本体', semantic_change: '修改已有业务含义或约束', new_constraint: '新增身份或业务约束', constraint_confirmation: '确认业务枚举完整性', datetime_confirmation: '确认日期表示与业务含义', deferred_candidates: '确认本轮暂缓范围', source_exclusion: '确认来源本轮不构建', removal: '删除已有定义', resolve_deferred: '采用此前暂缓的定义' };
    const evidenceSources = new Map();
    for (const issue of validation.issues) {
      panel.append(node('h4', titles[issue.kind] ?? '待处理的重大事件'), node('p', issue.kind === 'first_release' ? `需要决定：是否将上面的“${definition.name}”作为本实例首次启用的业务模型，用于后续资料构建？请整体核对对象范围、属性含义及关系。` : issue.question));
      if (issue.kind === 'first_release') panel.append(node('p', '确认范围：采用这套类型和关系定义。具体记录的金额冲突、缺失信息及跨源身份对应由后续计划处理。定义需要调整时，先编辑并保存草稿，再确认。'));
      const evidenceView = node('div');
      panel.append(button('查看该项原始依据', async () => {
        evidenceView.replaceChildren();
        const refs = current.definition.discoveryEvidence.filter(e => issue.memberId === 'ontology' || e.memberId === issue.memberId);
        if (!refs.length) { evidenceView.append(node('p', '没有本次原文依据；核查是否为沿用的基础成员，不能以常识补成事实。')); return; }
        for (const ref of refs) {
          let source = evidenceSources.get(ref.sourceVersionId);
          if (!source) { source = await api(`/api/source-versions/${ref.sourceVersionId}`); evidenceSources.set(ref.sourceVersionId, source); }
          const locator = ref.locator, content = source.content;
          const value = locator.kind === 'column' ? { 声明: content.metadata?.columns?.find(c => c.name === locator.field), 范围: '仅为结构依据，不代表存在非空记录值' } : locator.kind === 'field' ? (content.kind === 'table' ? content.nativeValues?.[locator.recordKey]?.[locator.field] : content.rows?.find(r => r[content.keyColumn] === locator.recordKey)?.[locator.field]) : content.text?.slice(locator.start, locator.start + locator.quote.length);
          evidenceView.append(node('pre', pretty({ sourceVersionId: ref.sourceVersionId, locator, 原始内容: value })));
        }
      }), evidenceView);
    }
    const reason = node('textarea'); reason.rows = 3; reason.placeholder = '说明采用本次业务范围和关键定义的依据；如仍有定义问题，请先修改草稿'; reason.value = current.discovery.review?.reason ?? '';
    reason.disabled = current.status !== 'draft' || getState()?.actor.role === 'viewer'; panel.append(label('本次决定理由（必填）', reason));
    if (current.status === 'draft' && getState()?.actor.role !== 'viewer') panel.append(button(decision.issues.length === 1 && decision.issues[0].kind === 'first_release' ? '确认首次启用并保存决定' : '确认上述重大事件并保存决定', async () => {
      if (!reason.value.trim()) throw new Error('请填写本次决定理由，说明为何采用上述定义，然后保存决定');
      const edited = JSON.parse($('#definition').value);
      if (JSON.stringify(edited) !== JSON.stringify(current.definition)) throw new Error('页面定义有未保存修改，请先保存草稿并重新读取审核项');
      await api(`/api/ontologies/${current.id}/review`, { expectedRevision: current.revision, issueIds: validation.issues.map(i => i.id), reason: reason.value });
      await openOntology(current.id); notice('决定已保存。下一步点击“发布选中草稿”；不需要重新生成候选本体。');
    }));
  }
  syncControls();
  return { update, open, async openForIssue(id){
    if(dirty||jsonDirty){if(plan?.id!==id)throw new Error('当前构建方案有未保存修改，请先保存后再打开其他方案；未覆盖编辑。');revealBuildTarget($('#build-plans')).scrollIntoView();return;}
    await open(id);
  }, selectedSourceVersions, ontologyCoverage, syncControls, refreshCurrent };
}
