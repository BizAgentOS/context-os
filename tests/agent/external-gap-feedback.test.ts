import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityWorkspace,ref} from './identity-release-fixture.ts';
import {QuestionAnswering} from '../../src/agent/qa-tools.ts';
import {ExternalGapFeedback} from '../../src/engine/external-gap-feedback.ts';
import {AgentDelegations} from '../../src/engine/delegations.ts';
import type {AgentDriver} from '../../src/agent/runtime.ts';
import {withActor} from '../../src/security/actors.ts';

test('external gap feedback requires administrator opt-in and retains replay metadata without returned business evidence',async()=>{
  const w=await identityWorkspace(),app=w.service.app;
  try{
    const release=await w.publish('缺口回传范围'),connection=await w.connect(release,'外部调查'),policy=new ExternalGapFeedback(app.memory);
    const qa=new QuestionAnswering(app.memory,app.foundation,app.live,app.snapshots,app.workspaceVersions,app.changes);
    const view={kind:'consumer',releaseRef:ref(release),connectionRef:ref(connection.connection)},run=qa.begin({question:'旧账号为何未找到所属人员',dataView:view});
    const read=await run.execute('relations_traverse',{target:{entityTypeId:'account',id:'a-old'},traverse:[{relationTypeId:'account_owner'}]});
    assert.equal(read.reason,'unmatched');assert.equal(policy.read(ref(connection.connection)).enabled,false);
    await assert.rejects(run.execute('gap_report',{readId:read.readId,observation:'旧邮箱 old@example.test'}),/默认关闭|未开启/);
    const enabled=policy.configure({connectionRef:ref(connection.connection),enabled:true,operationId:'enable'});
    assert.equal(enabled.enabled,true);assert.deepEqual(policy.configure({connectionRef:ref(connection.connection),enabled:true,operationId:'enable'}),enabled);
    await assert.rejects(run.execute('gap_report',{readId:'invented',observation:'虚构读取'}),/本轮实际/);
    const reply=await run.execute('gap_report',{readId:read.readId,observation:'请保存原值 old@example.test'}),gap=qa.gaps.get(String((reply.gap as any).id));
    assert.equal(gap.status,'open');assert.equal(gap.content.external,true);assert.equal((gap.content.query as any).target.id,'a-old');
    assert.equal((gap.content.receipt as any).readId,read.readId);assert.equal((gap.content.receipt as any).reason,'unmatched');
    assert.doesNotMatch(JSON.stringify(gap),/old@example|sourceId|bindingId|\"items\"|\"evidence\"|请保存原值/);
    assert.equal((reply.gap as any).content,undefined,'external tool returns a reference, not administrator workflow details');
    assert.equal((await run.execute('gap_report',{readId:read.readId,observation:'再次报告'})).gap&&app.memory.listArtifacts('question_gap').length,1);
    policy.configure({connectionRef:ref(connection.connection),enabled:false,operationId:'disable'});
    await assert.rejects(run.execute('gap_report',{readId:read.readId,observation:'关闭后的旧读取'}),/默认关闭|未开启/);
    policy.configure({connectionRef:ref(connection.connection),enabled:true,operationId:'enable-again'});
    await w.manage('/api/releases/revoke',{operationId:'revoke-feedback',connectionRef:ref(connection.connection)});
    await assert.rejects(run.execute('gap_report',{readId:read.readId,observation:'撤权后旧读取'}),/授权|变化|停用/);
    assert.throws(()=>policy.configure({connectionRef:ref(connection.connection),enabled:true,operationId:'stale-enable'}),/变化|停用/);
  }finally{await w.close();}
});

test('delegation feedback uses only its own authorized readings and rechecks the model immediately before execution',async()=>{
  const w=await identityWorkspace(),app=w.service.app;
  try{
    const release=await w.publish('委托缺口回传'),connection=await w.manage('/api/releases/connect',{operationId:'delegated-gap',name:'外部调查',releaseRef:ref(release),conceptIds:['account','person'],relationIds:['account_owner'],agentEnabled:true,business:{grants:[
      {type:'账号',fields:['$id','邮箱','名称'],relations:['所属人员']},{type:'人员',fields:['$id','邮箱','姓名'],relations:[]},
    ]}});
    const policy=new ExternalGapFeedback(app.memory),qa=new QuestionAnswering(app.memory,app.foundation,app.live,app.snapshots,app.workspaceVersions,app.changes);
    policy.configure({connectionRef:ref(connection.connection),enabled:true,operationId:'allow-delegated-gap'});
    let running:Promise<void>|undefined,beforeRuns=0,modelReady=true,calls=0;
    const driver:AgentDriver={async run(request){
      calls++;assert.equal(beforeRuns,1);assert.ok(request.tools.some(tool=>tool.name==='gap_report'));
      await assert.rejects(request.onTool('gap_report',{readId:'another-task-reading',observation:'假的'}),/本轮实际/);
      await assert.rejects(request.onTool('external_gap_feedback_configure',{enabled:true}),/不允许/);
      const read=await request.onTool('relations_traverse',{target:{entityTypeId:'account',id:'a-old'},traverse:[{relationTypeId:'account_owner'}]}) as any;
      assert.equal(read.reason,'unmatched');
      const reported=await request.onTool('gap_report',{readId:read.readId,observation:'读取未匹配'}) as any;
      assert.equal(reported.gap.status,'open');assert.equal(reported.gap.content,undefined);
      withActor({kind:'human',id:'local-admin',name:'管理员',role:'admin'},()=>policy.configure({connectionRef:ref(connection.connection),enabled:false,operationId:'disable-during-run'}));
      await assert.rejects(request.onTool('gap_report',{readId:read.readId,observation:'晚到报告'}),/默认关闭|未开启/);
      return {text:'对应关系尚未确认，已回传缺口元数据。',sessionId:'protocol-fixture',runId:'protocol-fixture'};
    },async stop(){},async close(){}};
    const delegated=new AgentDelegations(app.memory,app.live,driver,{
      configured:()=>true,
      beforeRun:()=>{beforeRuns++;if(!modelReady)throw new Error('模型保险库已锁定');},
      start:(taskId,run)=>{running=Promise.resolve().then(()=>run(app.memory.beginExecution(taskId)));return true;},
      stop:async()=>{},safeError:error=>(error as Error).message,
    },qa);
    const task=delegated.submit({operationId:'delegate',prompt:'旧账号为什么未找到人员'},connection.key).task;await running;
    const completed=delegated.read(task.id,connection.key).task;assert.equal(completed.status,'completed',JSON.stringify(completed.content));
    assert.equal(app.memory.listArtifacts('question_gap').length,1);assert.equal(calls,1);
    modelReady=false;
    const locked=delegated.submit({operationId:'locked-delegate',prompt:'凭据锁定后不得调用模型'},connection.key).task;await running;
    assert.equal(delegated.read(locked.id,connection.key).task.status,'failed');assert.equal(calls,1,'configured at enqueue is not authority to invoke a later model run');assert.equal(beforeRuns,2);
  }finally{await w.close();}
});
