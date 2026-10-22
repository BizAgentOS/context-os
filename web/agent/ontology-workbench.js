import {el, action, field, message, transact, table, when} from './engine-ui.js';
import {safeText, displayValue, developerView, technicalDetails} from './ui-display.js';
import {requestPending} from './pending-center.js';
import {buildOntologyGraph} from './ontology-space-model.js';
import {createOntologyScene} from './ontology-scene.js';
import {renderAnswerVisualization} from './answer-visualization.js';

const states={adopted:'已采用',pending:'待确认',missing:'缺失',empty:'无数据'};
const ref=item=>({id:item.id,version:item.version});
const section=(parent,title)=>{const box=el('section',null,'ow-section');box.append(el('h3',title));parent.append(box);return box;};
const svgEl=(name,attrs={})=>{const node=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [key,value]of Object.entries(attrs))node.setAttribute(key,String(value));return node;};

/** A single ontology surface: graph, accessible directory and persistent detail column. */
export function renderOntologyWorkspace(state,actions){
 const root=el('section',null,'ontology-workspace');root.setAttribute('aria-label','本体工作区');
 const header=el('header',null,'ow-header'),title=el('h1','企业本体'),version=el('span',null,'engine-badge');
 const toolbar=el('div',null,'engine-actions'),search=el('input');search.type='search';search.placeholder='查找实体、属性、关系或对象编号';search.setAttribute('aria-label','查找本体');
 const pending=action('待处理',()=>requestPending());header.append(title,version,search,pending,toolbar);
 const hints=el('div',null,'ow-next'),main=el('div',null,'ow-main'),visual=el('div',null,'ow-visual'),graphHost=el('div',null,'ow-graph');
 const directory=el('nav',null,'ow-directory');directory.setAttribute('aria-label','实体与关系目录');
 const sidebar=el('aside',null,'ow-sidebar');sidebar.setAttribute('aria-label','本体详情');sidebar.tabIndex=-1;
 const status=message(root);main.append(visual,sidebar);visual.append(graphHost,directory);root.append(header,hints,main);
 let data,selected=null,generation=0,detailGeneration=0,disposed=false,scene=null,mode=window.matchMedia('(max-width: 700px)').matches?'list':'plane',edit=false,linkedAnswer=actions.linkedAnswer||null,highlight=null,answerView=null;
 const saved=actions.selections?.get('ontology-workspace');if(saved?.mode&&!window.matchMedia('(max-width: 700px)').matches)mode=saved.mode;
 const save=()=>actions.selections?.set('ontology-workspace',{mode,selected});
 const baselineOf=value=>structuredClone({foundationRef:value?.foundationRef??null,modelRef:value?.modelRef??null});
 toolbar.append(action('新增实体',()=>entityEditor()));
 const tools=[['plane','平面'],['3d','三维'],['list','列表']];
 for(const [value,label]of tools){const button=action(label,()=>{mode=value;save();draw();});button.dataset.mode=value;toolbar.append(button);}
 const legend=el('div',null,'ow-legend');for(const [key,label]of Object.entries(states))legend.append(el('span',label,`ow-state ow-${key}`));visual.prepend(legend);
 const selectedKey=(kind,id)=>selected?.kind===kind&&selected?.id===id;
 function directoryEntry(kind,item,label=item.name){const button=action(label,()=>void select(kind,item.id));button.dataset.state=item.state||'adopted';button.setAttribute('aria-pressed',String(selectedKey(kind,item.id)));return button;}
 function drawDirectory(){
  directory.replaceChildren();const term=search.value.trim().toLocaleLowerCase();
  for(const entity of data.entities){const props=entity.properties||[];if(![entity.name,...(entity.aliases||[]),...props.map(p=>p.name)].some(x=>x.toLocaleLowerCase().includes(term)))continue;
   const row=el('div',null,'ow-directory-row');row.append(directoryEntry('entity',entity,`${entity.name}${entity.unnamed?' · 待命名':''}`),el('small',`${states[entity.state]} · ${props.length} 个属性`));directory.append(row);}
  for(const relation of data.relations){const label=`${relation.fromName} → ${relation.name} → ${relation.toName}`;if(label.toLocaleLowerCase().includes(term))directory.append(directoryEntry('relation',relation,label));}
  if(!directory.childElementCount)directory.append(el('p','没有匹配的定义。输入对象编号后，选择实体的数据页查询。'));
 }
 function draw(){
  if(!data)return;scene?.dispose();scene=null;graphHost.replaceChildren();graphHost.hidden=mode==='list';
  for(const button of toolbar.querySelectorAll('[data-mode]'))button.setAttribute('aria-pressed',String(button.dataset.mode===mode));
  drawDirectory();
  if(mode==='3d'){
   const artifact={id:data.foundationRef?.id,version:data.foundationRef?.version,content:{concepts:data.entities,relations:data.relations,evidence:[]}};
      const graph=buildOntologyGraph(artifact,{highlight});
   scene=createOntologyScene(graphHost,graph,{onActivate:key=>{const [kind,...id]=key.split(':');void select(kind==='concept'?'entity':'relation',id.join(':'));},onBackground:()=>{},onUnavailable:()=>{mode='plane';draw();status.textContent='当前设备无法绘制三维，已切换平面。';}});
   if(selected?.kind==='entity')scene?.setView({stage:'local',focus:selected.id,target:{kind:'foundation_concept',member:selected.id},evidenceId:null});
   if(selected?.kind==='relation'){const relation=data.relations.find(item=>item.id===selected.id);if(relation)scene?.setView({stage:'local',focus:relation.from,target:{kind:'foundation_relation',member:selected.id},evidenceId:null});}
   return;
  }
  if(mode!=='plane')return;
  const width=data.entities.length<=2?440:600,height=Math.max(400,Math.ceil(data.entities.length/4)*160),svg=svgEl('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':'本体关系图'});graphHost.append(svg);
  const points=new Map(data.entities.map((item,index)=>[item.id,{x:width/2+Math.cos(index*2*Math.PI/Math.max(1,data.entities.length))*Math.min(width/2-70,120+data.entities.length*12),y:height/2+Math.sin(index*2*Math.PI/Math.max(1,data.entities.length))*Math.min(height/2-75,180)}]));
  const pairs=new Map();for(const relation of data.relations){const key=[relation.from,relation.to].sort().join('|');if(!pairs.has(key))pairs.set(key,[]);pairs.get(key).push(relation);}
  for(const relation of data.relations){const a=points.get(relation.from),b=points.get(relation.to);if(!a||!b)continue;const group=pairs.get([relation.from,relation.to].sort().join('|')),index=group.indexOf(relation),bend=(index-(group.length-1)/2)*80;
   const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1,m={x:(a.x+b.x)/2-dy/len*bend,y:(a.y+b.y)/2+dx/len*bend};
   const loop=120+index*45,d=relation.from===relation.to?`M ${a.x} ${a.y-24} C ${a.x-loop} ${a.y-loop-40} ${a.x+loop} ${a.y-loop-40} ${a.x} ${a.y-24}`:`M ${a.x} ${a.y} Q ${m.x} ${m.y} ${b.x} ${b.y}`;
   const path=svgEl('path',{d,class:`ow-edge ow-${relation.state}${selectedKey('relation',relation.id)||highlight?.relationTypeIds.includes(relation.id)?' selected':''}${highlight&&!highlight.relationTypeIds.includes(relation.id)?' ow-dimmed':''}`,tabindex:0,role:'button','aria-label':`${relation.fromName} → ${relation.name} → ${relation.toName}`});
   path.onclick=()=>void select('relation',relation.id);path.onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();void select('relation',relation.id);}};
   const text=svgEl('text',{x:m.x,y:relation.from===relation.to?a.y-105-index*34:(a.y+b.y)/2+bend/2-8,'text-anchor':'middle',class:'ow-edge-label'});text.textContent=safeText(`${relation.name}${relation.pending?` · 待处理 ${relation.pending}`:''}`);svg.append(path,text);
  }
  if(highlight?.missing){const from=points.get(highlight.missing.from);if(from){const x=from.x,y=from.y;svg.append(svgEl('path',{d:`M ${x} ${y} l 100 -70`,class:'ow-edge ow-missing'}));const label=svgEl('text',{x:x+100,y:y-78,class:'ow-edge-label'});label.textContent='缺少可验证的连接';svg.append(label);}}
  for(const entity of data.entities){const point=points.get(entity.id),group=svgEl('g',{transform:`translate(${point.x},${point.y})`,class:`ow-node ow-${entity.state}${selectedKey('entity',entity.id)||highlight?.entityTypeIds.includes(entity.id)?' selected':''}${highlight&&!highlight.entityTypeIds.includes(entity.id)?' ow-dimmed':''}`,tabindex:0,role:'button','aria-label':`${entity.name} · ${states[entity.state]}`});
   group.onclick=()=>void select('entity',entity.id);group.onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();void select('entity',entity.id);}};
   group.append(svgEl('circle',{r:34}));const text=svgEl('text',{y:58,'text-anchor':'middle'});text.textContent=safeText(entity.name);group.append(text);if(entity.pending){const badge=svgEl('text',{x:35,y:-30,class:'ow-badge'});badge.textContent=entity.pending;group.append(badge);}svg.append(group);
  }
 }
 search.oninput=drawDirectory;
 search.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();void findObject();}};
 async function findObject(){
  if(!data||!search.value.trim())return;const id=search.value.trim(),tick=++detailGeneration;edit=false;sidebar.replaceChildren(el('h2','查找对象'),el('p','正在按完整对象编号查询…'));
  const candidates=data.entities.filter(item=>item.bindings.length&&!item.proposalRef).slice(0,12);
  const results=await Promise.allSettled(candidates.map(async entity=>({entity,result:await actions.api('/api/live/query',{modelId:data.modelRef.id,modelVersion:data.modelRef.version,conceptId:entity.id,id,limit:1})})));
  if(disposed||tick!==detailGeneration)return;sidebar.replaceChildren(el('h2',`对象查找 · ${id}`));let found=0,failed=0;
  for(const result of results){if(result.status==='rejected'){failed++;continue;}for(const row of result.value.result.items){found++;const {entity}=result.value;sidebar.append(action(`${entity.name} · ${row.$id}`,async()=>{const detail=await actions.api(`/api/ontology/detail?kind=entity&id=${encodeURIComponent(entity.id)}`);if(tick===detailGeneration)void objectDetail(detail,row,result.value.result);}));}}
  if(!found)sidebar.append(el('p','当前已查询的实体中没有此编号的对象。'));
  if(failed||data.entities.filter(item=>item.bindings.length).length>12)sidebar.append(el('p','本次查找范围不完整；可选择具体实体，在数据分区继续核对。'));
 }
 function detailsHeader(detail){sidebar.replaceChildren();const head=el('header',null,'ow-detail-head');head.append(el('h2',detail.title),action('关闭详情',()=>{detailGeneration++;edit=false;selected=null;save();sidebar.replaceChildren(el('p','选择一个实体或关系查看详情。'));draw();}));sidebar.append(head,el('p',detail.description||'尚未补充说明'));}
 async function select(kind,id,tab='overview'){
  if(linkedAnswer)exitAnswer();
  const proposed=(kind==='entity'?data?.entities:data?.relations)?.find(item=>item.id===id)?.proposalRef;
  if(proposed){requestPending(proposed);return;}
  edit=false; selected={kind,id,tab};save();draw();const tick=++detailGeneration;sidebar.replaceChildren(el('p','正在读取详情…'));
  try{const detail=await actions.api(`/api/ontology/detail?${new URLSearchParams({kind,id,developer:String(developerView())})}`);if(disposed||tick!==detailGeneration)return;
   detailsHeader(detail);const tabs=el('nav',null,'ow-tabs');tabs.setAttribute('aria-label','详情内容');
   const available=kind==='entity'?[['overview','概览'],['properties','属性'],['relations','关系'],['data','数据'],['evidence','依据'],['pending','待处理']]:[['overview','概览'],['evidence','依据'],['pending','待处理']];
   for(const [value,label]of available){const button=action(label,()=>void select(kind,id,value));button.setAttribute('aria-current',value===tab?'page':'false');tabs.append(button);}sidebar.append(tabs);
   if(tab==='properties')renderProperties(detail);else if(tab==='relations')renderRelations(detail);else if(tab==='data')await renderData(detail,tick);else if(tab==='evidence')renderEvidence(detail);else if(tab==='pending')renderPending(detail);else renderOverview(detail);
   if(detail.technical)sidebar.append(technicalDetails(detail.technical));sidebar.focus({preventScroll:true});
  }catch(error){if(tick===detailGeneration){sidebar.replaceChildren(el('p',error.message));}}
 }
 function renderOverview(detail){
  sidebar.append(el('p',`${states[detail.state]}${detail.pending.filteredTotal?` · ${detail.pending.filteredTotal} 项待处理`:''}`));
  const metadata=section(sidebar,'名称与说明');metadata.append(el('p',`别名：${detail.aliases?.join('、')||'无'}`));metadata.append(action('编辑名称与说明',()=>wordingEditor(detail,metadata)));
  if(detail.kind==='entity'){
   sidebar.append(el('p',`${detail.properties.length} 个属性 · ${detail.relations.length} 条关系`));
   const sources=section(sidebar,'数据来源');for(const binding of detail.bindings)sources.append(el('p',`${binding.roleLabel} · ${binding.sourceTitle} · ${binding.dataset.capability}`));
   if(!detail.bindings.length)sources.append(el('p','尚未连接数据，定义仍可查看。'),action('前往数据接入',actions.data));
   sources.append(action('调整数据绑定',()=>bindingEditor(detail,sources)));
  }else{
   const relation=section(sidebar,'关系与绑定');relation.append(el('p',`${detail.fromName} → ${detail.name} → ${detail.toName}`),el('p',`基数：${detail.cardinality}`));
   for(const binding of detail.bindings)relation.append(el('p',`${binding.kind==='link_table'?'中间表关联':'字段关联'}：${binding.fromColumns.join('、')} → ${binding.toColumns.join('、')}`));
   if(!detail.bindings.length)relation.append(el('p','尚未绑定数据，不能报告匹配率。'));
   const match=detail.match;
   if(match?.status==='measured'){
    relation.append(el('h4','实际关联覆盖'),el('p',match.coverage.complete?(match.total?`${match.matched} / ${match.total} 个起点对象有可验证关联 · 匹配率 ${Math.round(match.matchRate*10000)/100}%`:'当前起点没有对象，匹配率不适用。'):`当前读取范围内 ${match.observed.matched} / ${match.observed.total} 个对象有连接；来源覆盖不完整，不报告全量匹配率。`));
    relation.append(el('p',`按当前工作版、身份决定和局部纠正计算；检查时间 ${when(match.checkedAt)}。`,'engine-muted'));
    for(const source of match.sources||[])relation.append(el('p',`${source.name} · 快照时间 ${when(source.dataAsOf)}`,'engine-muted'));
    relation.append(el('h4',`未匹配示例${match.unmatched.total===null?'':`（共 ${match.unmatched.total} 个）`}`));
    if(match.unmatched.items.length)relation.append(table(match.unmatched.items,[['起点对象编号',item=>item.objectId]]));
    else relation.append(el('p',match.coverage.complete?'当前没有未匹配对象。':'当前已读取范围中没有未匹配示例。'));
    if(!match.unmatched.complete)relation.append(el('p',`示例最多显示 ${match.unmatched.limit} 个；不是全部对象清单。`,'engine-muted'));
   }else if(match)relation.append(el('p',`尚不能测量：${match.reason}`,'engine-message'));
   relation.append(action('让助手核对匹配与未匹配记录',()=>actions.ask(`请核对「${detail.title}」在当前快照中的匹配率与未匹配记录，引用实际查询结果。`)));
  }
  sidebar.append(action('围绕此内容提问',async()=>{ if(detail.foundationRef)await actions.select?.(detail.foundationRef,{kind:detail.kind==='entity'?'foundation_concept':'foundation_relation',member:detail.id},()=>root.isConnected);actions.ask(`请围绕「${detail.title}」分析，先读取最新定义与依据。`); }));
 }
 async function propose(type,subject,evidence,baseline,auto=false){
  const {change}=await actions.api('/api/changes/propose',{operationId:crypto.randomUUID(),origin:'human',type,subject,baseline,evidence});
  const checked=(await actions.api('/api/changes/verify',{operationId:crypto.randomUUID(),...ref(change)})).change;
  if(!auto){requestPending(ref(checked));return checked;}
  const adopted=(await actions.api('/api/changes/adopt',{operationId:crypto.randomUUID(),...ref(checked)})).change;return adopted;
 }
 function wordingEditor(detail,parent,target=detail.kind==='entity'?'concept':detail.kind,source=detail){
  let baseline=baselineOf(source),saved=structuredClone({name:detail.name,aliases:detail.aliases||[],description:detail.description||''});
  const selection=structuredClone(selected);
  edit=true;parent.replaceChildren(el('h3','编辑名称与说明'));const name=field(parent,'名称',saved.name),aliases=field(parent,'别名（用逗号分隔）',saved.aliases.join('，')),description=field(parent,'说明',saved.description,true),output=message(parent);
  const adopt=async(type,subject,evidence)=>{
   const result=await propose(type,subject,evidence,baseline,true),effect=result.content?.effect;
   if(!effect||!Object.hasOwn(effect,'foundationRef')||!Object.hasOwn(effect,'modelRef'))throw new Error('保存回执缺少下一次编辑的基线，请重新读取详情。');
   // Only our own successful adoption may advance this form's baseline.
   baseline=baselineOf(effect);
  };
  parent.append(action('保存',()=>transact(parent,output,async()=>{
   const names=aliases.value.split(/[,，]/).map(x=>x.trim()).filter(Boolean);
   if(name.value!==saved.name||JSON.stringify(names)!==JSON.stringify(saved.aliases)){
    await adopt('naming',{target,id:detail.id,name:name.value,aliases:names},'用户在本体详情中修改名称与别名');
    saved.name=name.value;saved.aliases=names;
   }
   if(description.value!==saved.description){await adopt('description',{target,id:detail.id,description:description.value},'用户在本体详情中修改说明');saved.description=description.value;}
   if(disposed||!parent.isConnected)return;
   await actions.refresh();edit=false;await load();if(selection)await select(selection.kind,selection.id,selection.tab);status.textContent='名称与说明已保存。';
  }),'engine-primary'),action('取消',()=>{edit=false;if(selection)void select(selection.kind,selection.id,selection.tab);}));
 }
 function renderProperties(detail){
  for(const property of detail.properties){const box=section(sidebar,property.name);box.append(el('p',`${property.valueType}${property.unit?` · ${property.unit}`:''}${property.isIdentity?' · 身份属性':''}`),el('p',property.description||'暂无说明'),action('编辑名称与说明',()=>wordingEditor(property,box,'property',detail)),action('修改属性结构',()=>propertyEditor(detail,property,box)));}
  sidebar.append(action('新增属性',()=>propertyEditor(detail,null,section(sidebar,'新增属性'))));
 }
 function enumEditor(parent,values){
  const box=section(parent,'枚举取值'),list=el('div'),entries=[];box.append(el('p','每项单独填写；文本中的逗号会完整保留。'),list);
  const append=original=>{
   const item=el('fieldset'),kind=el('select');kind.setAttribute('aria-label','枚举值类型');
   for(const [value,label]of [['string','文本'],['number','数值'],['boolean','布尔值']]){const option=el('option',label);option.value=value;kind.append(option);}
   const initial=original?structuredClone(original):null,initialKind=typeof(initial?.value??'');
   kind.value=initialKind;item.append(kind);
   const value=field(item,'枚举值',initial?.value==null?'':String(initial.value)),description=field(item,'取值说明（可选）',initial?.description||'');
   const entry={item,read:()=>{
    if(initial&&kind.value===initialKind&&value.value===(initial.value==null?'':String(initial.value))&&description.value===(initial.description||''))return structuredClone(initial);
    let parsed=value.value;
    if(kind.value==='number'){if(!value.value.trim()||!Number.isFinite(Number(value.value)))throw new Error('枚举数值必须是有效数字。');parsed=Number(value.value);}
    else if(kind.value==='boolean'){if(!['true','false'].includes(value.value.trim()))throw new Error('枚举布尔值请填写 true 或 false。');parsed=value.value.trim()==='true';}
    return{value:parsed,...(description.value.trim()?{description:description.value.trim()}:{})};
   }};
   const update=()=>{value.placeholder=kind.value==='boolean'?'true 或 false':kind.value==='number'?'例如 0、1 或 1.5':'';};kind.onchange=update;update();
   item.append(action('删除此枚举项',()=>{entries.splice(entries.indexOf(entry),1);item.remove();}));entries.push(entry);list.append(item);
  };
  for(const value of values||[])append(value);
  box.append(action('新增枚举项',()=>append()));return{box,read:()=>entries.map(entry=>entry.read())};
 }
 function propertyEditor(detail,property,parent){
  const baseline=baselineOf(detail),propertyId=property?.id||`property_${crypto.randomUUID().replaceAll('-','')}`;
  edit=true;parent.replaceChildren(el('h3',property?'修改属性结构':'新增属性'));const name=field(parent,'属性名称',property?.name||''),type=el('select');type.setAttribute('aria-label','属性类型');for(const value of ['unknown','string','integer','decimal','boolean','date','datetime','enum','reference']){const option=el('option',value);option.value=value;type.append(option);}type.value=property?.valueType||'string';parent.append(type);
  const unit=field(parent,'单位（可选）',property?.unit||''),identityLabel=el('label','作为对象身份属性'),identity=el('input');identity.type='checkbox';identity.checked=property?.isIdentity||false;identityLabel.prepend(identity);parent.append(identityLabel);
  const enums=enumEditor(parent,property?.enumValues),reason=field(parent,'变更依据','',true),output=message(parent);
  type.onchange=()=>{enums.box.hidden=type.value!=='enum';};type.onchange();
  parent.append(action('生成属性变更',()=>transact(parent,output,async()=>{await propose('property',{action:property?'update':'add',property:{id:propertyId,entityTypeId:detail.id,name:name.value,valueType:type.value,isIdentity:identity.checked,...(type.value==='enum'?{enumValues:enums.read()}:{}),...(unit.value.trim()?{unit:unit.value.trim()}:property?.unit?{unit:null}:{})}},reason.value,baseline);edit=false;output.textContent='已生成变更，请在待处理中心核对并采用。';}),'engine-primary'),action('取消',()=>{edit=false;void select(selected.kind,selected.id,selected.tab);}));
 }
 function entityEditor(){
  const baseline=baselineOf(data);
  edit=true;selected=null;detailGeneration++;sidebar.replaceChildren(el('h2','新增业务实体'));
  const entityId=`entity_${crypto.randomUUID().replaceAll('-','')}`,name=field(sidebar,'实体名称'),description=field(sidebar,'业务说明','',true),reason=field(sidebar,'新增依据','',true),output=message(sidebar);
  sidebar.append(action('生成实体变更',()=>transact(sidebar,output,async()=>{await propose('entity',{action:'add',entity:{id:entityId,name:name.value,description:description.value}},reason.value,baseline);edit=false;output.textContent='已生成实体变更，请在待处理中心核对并采用。';}),'engine-primary'),action('取消',()=>{edit=false;sidebar.replaceChildren(el('p','选择一个实体或关系查看详情。'));void load();}));
 }
 function bindingEditor(detail,parent){
  const baseline=baselineOf(detail);
  edit=true;const box=section(parent,'编辑主来源绑定'),catalog=(data.sourceCatalog||[]).flatMap(source=>source.capabilities.map(cap=>({source,cap}))),existing=detail.bindings.find(item=>item.role==='primary');
  if(!detail.identityKeys?.length){box.append(el('p','请先新增一个身份属性，再为该实体绑定数据。'),action('编辑属性',()=>void select('entity',detail.id,'properties')));edit=false;return;}
  const label=el('label','来源表'),pick=el('select');label.append(pick);box.append(label);for(const [index,item]of catalog.entries()){const option=el('option',`${item.source.name} · ${item.cap.name}`);option.value=String(index);pick.append(option);}
  const initial=catalog.findIndex(item=>item.source.id===existing?.dataset.sourceId&&item.cap.name===existing?.dataset.capability);if(initial>=0)pick.value=String(initial);
  const fields=el('div');box.append(fields);let mappings=[];
  const render=()=>{fields.replaceChildren();mappings=[];const chosen=catalog[Number(pick.value)];if(!chosen)return;for(const property of detail.properties){const row=el('label',`${property.name}${property.isIdentity?'（身份）':''}`),column=el('select');const blank=el('option','不绑定该属性');blank.value='';column.append(blank);for(const value of chosen.cap.fields){const option=el('option',value);option.value=value;column.append(option);}const previous=detail.propertyBindings?.find(binding=>binding.propertyId===property.id&&binding.entityBindingId===existing?.id);column.value=chosen.cap.fields.includes(previous?.column)?previous.column:property.isIdentity?chosen.cap.idField:'';row.append(column);fields.append(row);mappings.push({property,column,previous});}};
  pick.onchange=render;render();const reason=field(box,'绑定依据','',true),output=message(box),bindingId=existing?.id||`entity_binding_${crypto.randomUUID().replaceAll('-','')}`;
  box.append(action('生成绑定变更',()=>transact(box,output,async()=>{const chosen=catalog[Number(pick.value)];if(!chosen)throw new Error('请先接入并同步结构化来源。');const keyColumns=detail.identityKeys.map(id=>mappings.find(item=>item.property.id===id)?.column.value);if(keyColumns.some(column=>!column))throw new Error('每个身份属性都需要对应来源字段。');const propertyBindings=mappings.filter(item=>item.column.value).map(item=>({propertyId:item.property.id,column:item.column.value,transform:{op:'none'}}));
    if(existing){const changed=mappings.filter(item=>item.column.value&&item.column.value!==item.previous?.column);if(chosen.source.id!==existing.dataset.sourceId||chosen.cap.name!==existing.dataset.capability)throw new Error('更换主来源需要同时复核身份与既有关系，请让构建助手提出完整的绑定调整。');if(changed.length!==1)throw new Error('请每次调整一个属性字段；新增主来源可一次声明全部映射。');const item=changed[0];await propose('binding',{action:item.previous?'update':'add',kind:'property',binding:{id:item.previous?.id||`property_binding_${crypto.randomUUID().replaceAll('-','')}`,propertyId:item.property.id,entityBindingId:bindingId,column:item.column.value,transform:{op:'none'}}},reason.value,baseline);}
    else await propose('binding',{action:'add',kind:'entity',binding:{id:bindingId,entityTypeId:detail.id,role:'primary',dataset:{sourceId:chosen.source.id,capability:chosen.cap.name},keyColumns},properties:propertyBindings},reason.value,baseline);
    edit=false;output.textContent='已生成绑定变更，请复验后采用。';}),'engine-primary'),action('让助手提出完整绑定调整',()=>{edit=false;actions.askBuild?.(`请检查「${detail.name}」的现有属性和来源，为主来源、补充来源及身份规则提出完整绑定调整并复验，交给我采用。`);}),action('取消',()=>{edit=false;void select('entity',detail.id);}));
 }

 function renderRelations(detail){for(const relation of detail.relations)sidebar.append(directoryEntry('relation',relation,`${relation.fromName} → ${relation.name} → ${relation.toName}`));if(!detail.relations.length)sidebar.append(el('p','尚无关系。'));sidebar.append(action('提出关系调整',()=>actions.askBuild?.(`请核对「${detail.name}」缺少或错误的关系，给出有数据依据的变更提议。`)));}
 function renderEvidence(detail){
  const box=section(sidebar,`定义依据（${detail.evidence.total}）`);
  const append=page=>{for(const evidence of page.items){const item=el('article');item.append(el('h4',evidence.title||'原始依据'),el('blockquote',evidence.quote||'无引文'),el('p',evidence.kind==='web'?'公开网页':evidence.kind==='document'?'企业资料':'用户陈述'));
   const location=evidence.documentLocation;
   if(location){const parts=[location.format==='pdf'&&location.pages?.length?`PDF 第 ${location.pages.join('、')} 页`:location.format==='docx'?'Word 文档':'',location.sections?.length?`章节：${location.sections.join(' / ')}`:''].filter(Boolean);if(parts.length)item.append(el('p',parts.join(' · '),'engine-muted'));}
   for(const warning of evidence.documentWarnings||[])item.append(el('p',`读取限制：${warning}`,'engine-message'));
   if(evidence.url&&/^https?:\/\//.test(evidence.url)){const link=el('a','打开原文');link.href=evidence.url;link.target='_blank';link.rel='noopener noreferrer';item.append(link);}box.append(item);}};
  append(detail.evidence);if(detail.evidence.nextOffset!=null)box.append(action('更多依据',async()=>{const tick=detailGeneration;const next=await actions.api(`/api/ontology/detail?${new URLSearchParams({kind:detail.kind,id:detail.id,evidenceOffset:detail.evidence.nextOffset})}`);if(disposed||tick!==detailGeneration)return;detail.evidence=next.evidence;renderEvidence(next);}));
  if(!detail.evidence.total)box.append(el('p','尚无可定位的定义依据。'));
 }
 function renderPending(detail){for(const item of detail.pending.items){const row=el('article');row.append(el('h3',item.title),el('p',item.evidence),action('查看并处理',()=>requestPending(ref(item))));sidebar.append(row);}if(!detail.pending.filteredTotal)sidebar.append(el('p','此内容没有待处理事项。'));}
 async function renderData(detail,tick){
  if(!detail.modelRef||!detail.bindings.length){sidebar.append(el('p','尚无可查询的数据绑定。'));return;}
  const form=el('form',null,'engine-actions'),identity=field(form,'对象编号（可选）',search.value.trim()),submit=action('查询对象',()=>{});submit.type='submit';form.append(submit);sidebar.append(form);
  const output=message(sidebar),rows=el('div');sidebar.append(rows);let offset=0,queryGeneration=0;
  const loadRows=async()=>{const queryTick=++queryGeneration;try{output.textContent='正在读取当前获准数据…';const result=await actions.api('/api/live/query',{modelId:detail.modelRef.id,modelVersion:detail.modelRef.version,conceptId:detail.id,offset,limit:20,...(identity.value.trim()?{id:identity.value.trim()}:{})});if(disposed||tick!==detailGeneration||queryTick!==queryGeneration)return;
   const reads=result.sources||[],live=reads.filter(source=>source.readMode==='live').length,reading=live===reads.length&&live?'实时读取':live?'快照与实时混合读取':reads.length?'固定快照':'读取方式未报告';
   output.textContent=`${reading} · ${result.coverage.total??'未知'} 条记录 · ${result.coverage.complete?'当前范围完整':'分页或覆盖不完整'}`;rows.replaceChildren();
   for(const source of reads)rows.append(el('p',`${source.name} · ${source.readMode==='live'?`实际读取 ${when(source.readAt||source.dataAsOf)}`:`数据截至 ${when(source.dataAsOf)}`}`,'engine-muted'));
   for(const row of result.items){const item=action(`查看对象 · ${displayValue(row.$id)}`,()=>void objectDetail(detail,row,result));rows.append(item);}
   if(!result.items.length)rows.append(el('p','当前范围没有记录。'));
   if(offset)rows.append(action('上一页',()=>{offset=Math.max(0,offset-20);void loadRows();}));
   if(result.items.length===20&&(result.coverage.total==null||offset+20<result.coverage.total))rows.append(action('下一页',()=>{offset+=20;void loadRows();}));
  }catch(error){if(tick===detailGeneration&&queryTick===queryGeneration)output.textContent=error.message;}};
  form.onsubmit=e=>{e.preventDefault();offset=0;void loadRows();};await loadRows();
 }
 async function objectDetail(detail,row,result){
  if(linkedAnswer)exitAnswer();
  const tick=++detailGeneration;sidebar.replaceChildren(action('返回数据',()=>void select('entity',detail.id,'data')),el('h2',`${detail.name} · ${displayValue(row.$id)}`));
  const evidence=result.evidence?.find(item=>String(item.objectId)===String(row.$id));
  for(const [name,value]of Object.entries(row).filter(([key])=>key!=='$id')){const box=section(sidebar,name),property=evidence?.properties?.[name];box.append(el('p',displayValue(value)),el('small',({resolved:'值已确定',conflict:'来源存在冲突',missing:'无可用值',uncertain:'仍需核对'})[property?.status]||'来源未报告状态'));
   for(const source of property?.evidence||[])box.append(el('p',`${source.sourceTitle} · 记录 ${displayValue(source.recordId)} · 字段 ${source.field}：${displayValue(source.value)} · ${when(source.readAt)}`));
   const definition=detail.properties.find(item=>item.name===name);
   if(definition&&!definition.isIdentity)box.append(action('纠正这一条属性值',()=>correctionEditor(detail,row,definition,box)));
  }
  for(const relation of detail.relations.filter(item=>item.from===detail.id)){
   const box=section(sidebar,relation.name),output=message(box);try{const related=await actions.api('/api/live/query',{modelId:detail.modelRef.id,modelVersion:detail.modelRef.version,conceptId:detail.id,id:String(row.$id),relation:relation.name,limit:20});if(disposed||tick!==detailGeneration)return;
    output.textContent=related.items.length?`已连接 ${related.items.length} 条记录`:'没有匹配的相连对象';for(const target of related.items)box.append(action(`${relation.toName} · ${displayValue(target.$id)}`,async()=>{const targetDetail=await actions.api(`/api/ontology/detail?kind=entity&id=${encodeURIComponent(relation.to)}`);if(tick===detailGeneration)void objectDetail(targetDetail,target,related);}));
    box.append(action('纠正这个对象的关系',()=>correctionEditor(detail,row,relation,box,related.items.map(item=>String(item.$id)))));
   }catch(error){output.textContent=error.message;}
  }
 }
 function correctionEditor(detail,row,definition,parent,targetIds){
  const baseline=baselineOf(detail);
  edit=true;const box=section(parent,targetIds?'仅纠正这个对象的关系':'仅纠正这个对象的属性值');box.append(el('p',`对象：${detail.name} · ${row.$id}。原始来源与其他对象保持原值，纠正需复验后采用。`));
  const value=field(box,targetIds?'正确目标编号（每行一个；留空表示无关联）':'纠正后的值',targetIds?targetIds.join('\n'):String(row[definition.name]??''),!!targetIds);
  const clearLabel=el('label','明确清空此属性'),clear=el('input');clear.type='checkbox';clearLabel.prepend(clear);if(!targetIds)box.append(clearLabel);
  const reason=field(box,'纠正理由','',true),evidence=field(box,'纠正依据','',true),output=message(box);
  box.append(action('生成局部纠正变更',()=>transact(box,output,async()=>{
   let corrected=value.value;
   if(!targetIds&&!clear.checked){if(['integer','decimal'].includes(definition.valueType)){if(!corrected.trim()||!Number.isFinite(Number(corrected)))throw new Error('请填写有效数值。');corrected=Number(corrected);}else if(definition.valueType==='boolean'){if(!['true','false'].includes(corrected))throw new Error('布尔值请填写 true 或 false。');corrected=corrected==='true';}}
   const common={entityTypeId:detail.id,objectId:String(row.$id),reason:reason.value.trim(),evidence:evidence.value.trim()};
   await propose('local_correction',targetIds?{kind:'relation',...common,relationTypeId:definition.id,targetIds:value.value.split('\n').map(id=>id.trim()).filter(Boolean)}:{kind:'property',...common,propertyId:definition.id,value:clear.checked?null:corrected},evidence.value.trim(),baseline);edit=false;output.textContent='局部纠正已保存，待你核对并采用。';
  }),'engine-primary'),action('取消',()=>{edit=false;box.remove();}));
 }
 function exitAnswer(){linkedAnswer=null;answerView?.dispose();answerView=null;highlight=null;actions.exitAnswer?.();sidebar.replaceChildren(el('p','选择一个实体或关系查看详情。'));draw();}
 root.showAnswer=answer=>{linkedAnswer=structuredClone(answer);if(!data)return;detailGeneration++;edit=false;selected=null;answerView?.dispose();sidebar.replaceChildren();answerView=renderAnswerVisualization(linkedAnswer,{onHighlight:value=>{highlight=value;draw();},onExit:exitAnswer});sidebar.append(answerView);sidebar.focus({preventScroll:true});};
 async function load(){const tick=++generation;try{const response=await actions.api('/api/ontology/workspace');if(disposed||tick!==generation)return;data=response;title.textContent=safeText(data.title);version.textContent=`工作版 v${data.workspaceVersion}`;pending.textContent=`待处理（${data.pending.total}）`;hints.replaceChildren();for(const hint of data.nextSteps)hints.append(action(hint.label,()=>hint.action==='data'?actions.data():hint.action==='ask'?actions.ask('请根据当前企业本体给出可以回答的业务问题。'):requestPending({category:hint.category})));status.textContent='';draw();if(linkedAnswer)root.showAnswer(linkedAnswer);else if(!selected)sidebar.replaceChildren(el('p','选择一个实体或关系查看详情。'));}catch(error){if(tick===generation)status.textContent=error.message;}}
 root.focusReferences=ids=>{if(!data)return false;const entity=data.entities.find(x=>ids.includes(x.id)),relation=data.relations.find(x=>ids.includes(x.id));if(entity||relation){void select(entity?'entity':'relation',(entity||relation).id);return true;}return false;};
 let signature=JSON.stringify([state.workspaceVersion,state.pendingSummary]);root.updateWorkspace=next=>{if(next.pendingSummary)pending.textContent=`待处理（${next.pendingSummary.total}）`;const current=JSON.stringify([next.workspaceVersion,next.pendingSummary]);if(current!==signature){signature=current;if(!edit)void load();}return true;};root.dispose=()=>{disposed=true;generation++;detailGeneration++;scene?.dispose();answerView?.dispose();};
 void load();return root;
}
