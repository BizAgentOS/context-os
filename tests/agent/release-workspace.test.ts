import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identityWorkspace,ref} from './identity-fixture.ts';
import {Releases} from '../../src/engine/releases.ts';

test('release differences identify business objects and a pending data issue requires a human decision',async()=>{
  const w=await identityWorkspace(),app=w.service.app,releases=new Releases(app.memory,app.live);
  try{
    const baseCheck=await releases.check({inputHash:releases.overview().working.inputHash});releases.publish({operationId:'baseline',name:'基线',checkRef:ref(baseCheck)});
    await w.adopt('naming',{target:'concept',id:'account',name:'登录账号'});
    const working=releases.overview().working as any,diff=working.objectDiff.find((item:any)=>item.kind==='entity'&&item.id==='account');
    assert.equal(diff.change,'modified');assert.equal(diff.name,'登录账号');assert.equal(diff.before.name,'账号');assert.equal(diff.after.name,'登录账号');assert.match(diff.summary,/名称/);
    w.rows.accounts=[];await app.snapshots.sync({operationId:'broken-accounts',sourceIds:[w.sources.accounts.id]});
    const issue=app.syncGovernance.list().find(item=>item.sources.some(source=>source.id===w.sources.accounts.id))!;assert.ok(issue);
    const blocked=await releases.check({inputHash:releases.overview().working.inputHash});assert.equal(blocked.status,'blocked');assert.ok((blocked.content.issues as any[]).some(item=>item.code==='unconfirmed_data_issue'));
    app.syncGovernance.resolve({...ref(issue),operationId:'retain-accounts',decision:'retain',reason:'已确认接口故障，发布继续使用原完整快照'});
    const ready=await releases.check({inputHash:releases.overview().working.inputHash});assert.equal(ready.status,'ready',JSON.stringify(ready.content.issues));
    assert.equal((await app.live.query({modelId:w.model.id,modelVersion:w.model.version,type:'登录账号'})).coverage.total,3);
  }finally{await w.close();}
});
