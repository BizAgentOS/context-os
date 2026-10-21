import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityWorkspace,ref} from './identity-fixture.ts';
import {QuestionAnswering} from '../../src/agent/qa-tools.ts';
import type {Data} from '../../src/agent/contracts.ts';
import {AgentChangeTools} from '../../src/agent/agent-change-tools.ts';
import {freezeAgentTurn} from '../../src/agent/agent-modes.ts';
import {Releases} from '../../src/engine/releases.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../../src/agent/server.ts';
import {seedFoundation} from './program-foundation-fixture.ts';
import {Workspace} from '../../src/agent/workspace.ts';
import {identityWorkspace as releaseWorkspace} from './identity-release-fixture.ts';

test('a real missing relationship moves through user handoff, query preview, adoption and user reask',async()=>{
  const w=await identityWorkspace(),app=w.service.app;
  try{
    const qa=new QuestionAnswering(app.memory,app.foundation,app.live,app.snapshots,app.workspaceVersions,app.changes);app.pendingCenter.register(qa.gaps);
    const from=app.snapshots.bindingDataset(w.sources.accounts.id,'accounts')!,to=app.snapshots.bindingDataset(w.sources.staff.id,'staff')!;
    const proposed=await app.changes.propose({operationId:'gap-relation',origin:'human',type:'relation',baseline:app.changes.currentBaseline(),subject:{from:{datasetId:from.id,column:'email'},to:{datasetId:to.id,column:'email'},cardinality:'N:1'},evidence:'账号邮箱对应通信人员'});
    const verified=await app.changes.verify({...ref(proposed.change),operationId:'gap-verify'});assert.equal(verified.status,'verified',JSON.stringify(verified.content));
    const definition=(await app.changes.preparePreview(ref(verified))).definition!;
    const relation=((definition.layered as Data).semantic as Data).relationTypes as Data[];
    const relationId=String(relation.at(-1)!.id);
    const run=qa.begin({question:'A1的通信人员是谁',dataView:{kind:'working'}});
    const reading=await run.execute('relations_traverse',{target:{entityTypeId:'account',id:'A1'},traverse:[{relationTypeId:'missing-account-contact'}]});
    assert.equal(reading.reason,'missing_relation');
    const gap=(await run.execute('gap_report',{readId:reading.readId,observation:'人员和账号均已存在，但尚无此对应关系'})).gap as any;
    assert.equal(gap.status,'open');assert.equal(app.pendingCenter.summary().counts.gap,1);
    await assert.rejects(qa.gaps.reask({...ref(gap),operationId:'cannot-confirm'}),/采用修复/);
    const handoff=qa.gaps.handoff({...ref(gap),operationId:'fix'});assert.equal(handoff.mode,'build');
    assert.deepEqual(qa.gaps.handoff({...ref(gap),operationId:'fix'}),handoff,'retrying a user action returns its original receipt');
    const session=app.memory.createSession(),agent=new AgentChangeTools(app.memory,app.changes,app.pendingCenter,app.live,qa.gaps);
    let context=app.memory.beginExecution(session.taskId),turn=freezeAgentTurn(app.memory,context,{mode:'build',pendingRef:ref(handoff.gap)},app.pendingCenter);
    const input={...ref(verified),operationId:'preview',gapRef:ref(handoff.gap),relationResolutions:[{fromRelationId:'missing-account-contact',toRelationId:relationId}]};
    const late=agent.execute('change_preview_query',input,context,turn);app.memory.pauseTask(context.taskId);
    await assert.rejects(late,/停止|任务|运行/);assert.equal(qa.gaps.get(gap.id).version,handoff.gap.version);
    app.memory.endExecution(context);context=app.memory.beginExecution(session.taskId);turn=freezeAgentTurn(app.memory,context,{mode:'build',pendingRef:ref(handoff.gap)},app.pendingCenter);
    const preview=await agent.execute('change_preview_query',input,context,turn) as any;
    assert.equal((preview.before as any).reason,'missing_relation');assert.equal((preview.after as any).result.items[0].$id,'H1');
    const linked=preview.linkedGap;
    await assert.rejects(agent.execute('gap_confirm',{id:gap.id},context,turn),/模式|能力/);
    app.memory.endExecution(context);
    assert.equal(((linked.content.query as any).traverse[0]).relationTypeId,'missing-account-contact','the original failed query is preserved');
    const again=await run.execute('relations_traverse',{target:{entityTypeId:'account',id:'A1'},traverse:[{relationTypeId:'missing-account-contact'}]}),other=(await run.execute('gap_report',{readId:again.readId,observation:'复问旧发布也必须如实报告未修复'})).gap as any;
    assert.equal((run.answer('关系待建立').gaps as any[]).length,2);
    const second=qa.gaps.handoff({...ref(other),operationId:'fix-other'}).gap;
    const secondPreview=await qa.gaps.preview({...ref(second),operationId:'preview-other',changeRef:ref(verified),relationResolutions:[{fromRelationId:'missing-account-contact',toRelationId:relationId}]});
    qa.gaps.linkChange({...ref(second),operationId:'link-other',changeRef:ref(verified),previewRef:ref(secondPreview.preview)});
    const releases=new Releases(app.memory,app.live),checked=await releases.check({inputHash:releases.overview().working.inputHash});
    const old=releases.publish({operationId:'before-gap-fix',checkRef:ref(checked),name:'修复前发布'}).release;
    await assert.rejects(run.execute('gap_confirm',{id:linked.id}),/问答|能力/);
    await app.changes.adopt({...ref(verified),operationId:'gap-adopt',acknowledgeReview:true});
    const fixed=qa.gaps.get(linked.id);assert.equal(fixed.status,'fixed');
    assert.equal(app.pendingCenter.summary().counts.gap,2,'adoption awaits user reask');
    const confirmed=await qa.gaps.reask({...ref(fixed),operationId:'reask'});assert.equal(confirmed.gap.status,'confirmed');
    assert.deepEqual(await qa.gaps.reask({...ref(fixed),operationId:'reask'}),confirmed,'reask retry must not query a newer world');
    const reopened=await qa.gaps.reask({...ref(qa.gaps.get(other.id)),operationId:'reask-old',dataView:{kind:'release',releaseRef:ref(old)}});
    assert.equal(reopened.gap.status,'reopened');assert.equal((reopened.result as any).reason,'missing_relation');
    assert.equal(app.pendingCenter.summary().counts.gap,1);assert.equal(qa.gaps.handoff({...ref(reopened.gap),operationId:'reopen-fix'}).gap.status,'in_fix');
  }finally{await w.close();}
});

test('a local relationship repair previews the original failed question without adopting a correction',async()=>{
  const w=await releaseWorkspace(),app=w.service.app;
  try{
    const qa=new QuestionAnswering(app.memory,app.foundation,app.live,app.snapshots,app.workspaceVersions,app.changes),run=qa.begin({question:'旧邮箱账号属于谁'});
    const read=await run.execute('relations_traverse',{target:{entityTypeId:'account',id:'a-old'},traverse:[{relationTypeId:'account_owner'}]});assert.equal(read.reason,'unmatched');
    const reported=(await run.execute('gap_report',{readId:read.readId,observation:'旧邮箱无法自动对应人员'})).gap as any,gap=qa.gaps.handoff({...ref(reported),operationId:'local-repair'}).gap;
    const proposed=await app.changes.propose({operationId:'local-account-fix',origin:'human',type:'local_correction',baseline:app.changes.currentBaseline(),subject:{kind:'relation',entityTypeId:'account',objectId:'a-old',relationTypeId:'account_owner',targetIds:['P1'],reason:'管理员核对旧账号',evidence:'人员登记确认'}}),checked=await app.changes.verify({...ref(proposed.change),operationId:'local-account-check'});
    assert.equal(checked.status,'verified',JSON.stringify(checked.content.verification));
    const preview=await qa.gaps.preview({...ref(gap),operationId:'local-account-preview',changeRef:ref(checked)});
    assert.equal(preview.before.reason,'unmatched');assert.equal((preview.after.result as any).items[0].$id,'P1');
    assert.equal(app.memory.listArtifacts('relation_correction').filter(item=>item.status==='adopted').length,0);
  }finally{await w.close();}
});

test('stopping a gap preview after its first actual read prevents subsequent source reads',async t=>{
  const w=await releaseWorkspace(),app=w.service.app;
  try{
    await w.decide('a-user','match','P1','confirmed-user');
    const qa=new QuestionAnswering(app.memory,app.foundation,app.live,app.snapshots,app.workspaceVersions,app.changes),run=qa.begin({question:'旧邮箱账号属于谁'});
    const read=await run.execute('relations_traverse',{target:{entityTypeId:'account',id:'a-old'},traverse:[{relationTypeId:'account_owner'}]});assert.equal(read.reason,'unmatched');
    const reported=(await run.execute('gap_report',{readId:read.readId,observation:'旧账号尚未找到人员'})).gap as any,gap=qa.gaps.handoff({...ref(reported),operationId:'stop-gap-fix'}).gap;
    const proposed=await app.changes.propose({operationId:'stop-gap-wording',origin:'human',type:'naming',baseline:app.changes.currentBaseline(),subject:{target:'concept',id:'account',aliases:['登录账号']}}),checked=await app.changes.verify({...ref(proposed.change),operationId:'stop-gap-check'});
    assert.equal(checked.status,'verified');
    const session=app.memory.createSession(),context=app.memory.beginExecution(session.taskId),turn=freezeAgentTurn(app.memory,context,{mode:'build',pendingRef:ref(gap)},app.pendingCenter),agent=new AgentChangeTools(app.memory,app.changes,app.pendingCenter,app.live,qa.gaps);
    const original=app.snapshots.readPinned.bind(app.snapshots);let reads=0;
    t.mock.method(app.snapshots,'readPinned',async(...args:Parameters<typeof original>)=>{
      reads++;const result=await original(...args);
      if(reads===1)app.memory.pauseTask(context.taskId);
      return result;
    });
    await assert.rejects(agent.execute('change_preview_query',{...ref(checked),operationId:'stopped-gap-preview',gapRef:ref(gap)},context,turn),/停止|任务|运行/);
    assert.equal(reads,1,'a completed source read must observe stop before the next source is requested');
    assert.equal(qa.gaps.get(gap.id).version,gap.version);assert.equal(app.memory.listArtifacts('gap_preview').length,0);
    app.memory.endExecution(context);
  }finally{await w.close();}
});

test('the first data binding can preview an unbound-entity gap without persisting a pretend model',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ade-first-binding-preview-')),server=await createServer({directory,automaticApi:false}),app=server.app;
  try{
    seedFoundation(app.memory,app.foundation,{enterprise:'公司目录',concepts:[{id:'company',name:'公司',description:'业务公司'}]});
    const identity=await app.changes.propose({operationId:'company-identity',type:'property',origin:'human',baseline:app.changes.currentBaseline(),subject:{action:'add',property:{id:'company-id',entityTypeId:'company',name:'公司编号',description:'目录唯一编号',isIdentity:true,valueType:'string'}}}),identityCheck=await app.changes.verify({...ref(identity.change),operationId:'company-identity-check'});await app.changes.adopt({...ref(identityCheck),operationId:'company-identity-adopt'});
    const source=new Workspace(app.memory).upload('companies.csv','id,name\nC1,星桥\n'),connection=app.live.sources.connectUpload(source.id,source.version,'id');await app.snapshots.sync({operationId:'company-snapshot'});
    const qa=new QuestionAnswering(app.memory,app.foundation,app.live,app.snapshots,app.workspaceVersions,app.changes),run=qa.begin({question:'公司 C1 是否存在'});
    const read=await run.execute('objects_query',{target:{entityTypeId:'company',id:'C1'},fields:[]});assert.equal(read.reason,'unbound');
    const reported=(await run.execute('gap_report',{readId:read.readId,observation:'公司已有定义但尚未绑定目录'})).gap as any,gap=qa.gaps.handoff({...ref(reported),operationId:'bind-fix'}).gap;
    const proposed=await app.changes.propose({operationId:'first-binding',type:'binding',origin:'human',baseline:app.changes.currentBaseline(),subject:{action:'add',kind:'entity',binding:{id:'company-binding',entityTypeId:'company',role:'primary',dataset:{sourceId:connection.id,capability:'records'},keyColumns:['id']},properties:[{propertyId:'company-id',column:'id',transform:{op:'none'}}]}});
    const checked=await app.changes.verify({...ref(proposed.change),operationId:'first-binding-check'});assert.equal(checked.status,'verified',JSON.stringify(checked.content.verification));
    const preview=await qa.gaps.preview({...ref(gap),operationId:'first-binding-preview',changeRef:ref(checked)});
    assert.equal(preview.before.reason,'unbound');assert.deepEqual((preview.after.result as any).items,[{$id:'C1',values:{}}]);
    assert.equal((preview.after.result as any).preview,true);assert.equal((preview.after.result as any).versions.mapping,null);
    assert.equal(app.memory.listArtifacts('live_ontology').length,0);
    qa.gaps.linkChange({...ref(gap),operationId:'first-binding-link',changeRef:ref(checked),previewRef:ref(preview.preview)});
    await app.changes.adopt({...ref(checked),operationId:'first-binding-adopt'});
    const confirmed=await qa.gaps.reask({...ref(qa.gaps.get(gap.id)),operationId:'first-binding-reask'});assert.equal(confirmed.gap.status,'confirmed');
  }finally{await server.close();rmSync(directory,{recursive:true,force:true});}
});

test('gaps require an actual eligible reading and dismiss requires a reason',async()=>{
  const w=await identityWorkspace(),app=w.service.app;
  try{
    const qa=new QuestionAnswering(app.memory,app.foundation,app.live,app.snapshots,app.workspaceVersions,app.changes),run=qa.begin({question:'未知关系',dataView:{kind:'working'}});
    await assert.rejects(run.execute('gap_report',{readId:'invented',observation:'假依据'}),/本轮实际/);
    const empty=await run.execute('objects_query',{target:{entityTypeId:'account',id:'does-not-exist'}});assert.equal(empty.reason,'empty');
    await assert.rejects(run.execute('gap_report',{readId:empty.readId,observation:'真实为空不应报缺口'}),/实际读取/);
    const missing=await run.execute('relations_traverse',{target:{entityTypeId:'account',id:'A1'},traverse:[{relationTypeId:'unmodeled-owner'}]});
    const gap=(await run.execute('gap_report',{readId:missing.readId,observation:'关系尚未建模'})).gap as any;
    const replay=(await run.execute('gap_report',{readId:missing.readId,observation:'重复读取同一缺口'})).gap as any;assert.equal(replay.id,gap.id);
    assert.throws(()=>qa.gaps.dismiss({...ref(gap),operationId:'ignore',reason:''}));
    const dismissed=qa.gaps.dismiss({...ref(gap),operationId:'ignore',reason:'暂不建模'});assert.equal(dismissed.gap.status,'dismissed');
    assert.deepEqual(qa.gaps.dismiss({...ref(gap),operationId:'ignore',reason:'暂不建模'}),dismissed);
    assert.throws(()=>qa.gaps.dismiss({...ref(gap),operationId:'ignore',reason:'换一个理由'}),/幂等|标识/);
  }finally{await w.close();}
});
