import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {AddressInfo} from "node:net";
import {createServer} from "../../src/agent/server.ts";
import {textPdf} from './document-fixture.ts';

test("document uploads keep a durable batch, partial errors and replay; only finalization queues the whole batch",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"ade-document-upload-"));
  let service=await createServer({directory,automaticApi:false});
  async function listen(){await new Promise<void>(resolve=>service.server.listen(0,"127.0.0.1",resolve));}
  async function post(path:string,body:unknown){
    const response=await fetch(`http://127.0.0.1:${(service.server.address() as AddressInfo).port}${path}`,{method:"POST",headers:{"content-type":"application/json","X-DataEngine-Token":service.adminToken},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as any};
  }
  try{
    await listen();const begun=await post("/api/canvas/upload/batch/start",{operationId:"upload-20",page:"setup"});
    assert.equal(begun.status,200,JSON.stringify(begun.body));const batchId=begun.body.batch.id;
    for(let i=0;i<20;i++){
      const reply=await post("/api/canvas/upload/batch/file",{batchId,operationId:`file-${i}`,name:`资料${i}.md`,content:`# 客户说明\n第${i}份业务资料。`});
      assert.equal(reply.status,200,JSON.stringify(reply.body));
    }
    await post("/api/canvas/upload/batch/file",{batchId,operationId:"bad",name:"错误.md",error:"文件不是有效文本"});
    assert.equal(service.app.memory.listArtifacts("document_build").length,0);
    await service.close();service=await createServer({directory,automaticApi:false});await listen();
    const replay=await post("/api/canvas/upload/batch/file",{batchId,operationId:"file-0",name:"资料0.md",content:"# 客户说明\n第0份业务资料。"});
    assert.equal(replay.status,200);assert.equal(replay.body.batch.content.sources.length,20);
    assert.equal((await post("/api/canvas/upload/batch/file",{batchId,operationId:"file-0",name:"资料0.md",content:"不同的内容"})).status,400);
    const final=await post("/api/canvas/upload/batch/finalize",{batchId});
    assert.equal(final.status,200,JSON.stringify(final.body));assert.equal(final.body.uploadBatch.content.errors.length,1);
    assert.equal(service.app.memory.listArtifacts("document_build").length,20);
    assert.ok(service.app.memory.listArtifacts("document_build").every(job=>job.content.batchId===batchId));
    assert.equal((await post("/api/canvas/upload/batch/finalize",{batchId})).status,200);
    assert.equal(service.app.memory.listArtifacts("document_build").length,20);
    assert.equal((await post("/api/canvas/upload/batch/file",{batchId,operationId:"late",name:"晚到.md",content:"晚到"})).status,400);
  }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('binary document upload is an authenticated batch member and queues only after finalization',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ade-document-http-')),service=await createServer({directory,automaticApi:false});
 await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
 const post=async(path:string,body:unknown)=>{const response=await fetch(origin+path,{method:'POST',headers:{'X-DataEngine-Token':service.adminToken,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return await response.json() as any;};
 try{
  const {batch}=await post('/api/canvas/upload/batch/start',{page:'setup',operationId:'binary-batch'});
  const path='/api/canvas/upload/document?'+new URLSearchParams({batchId:batch.id,operationId:'binary-pdf',name:'definition.pdf'}),bytes=textPdf(['Customer definition','A customer has an active contract.']);
  assert.equal((await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:bytes})).status,403);
  const response=await fetch(origin+path,{method:'POST',headers:{'X-DataEngine-Token':service.adminToken,'Content-Type':'application/octet-stream'},body:bytes});
  assert.equal(response.status,200,await response.clone().text());const uploaded=await response.json() as any;
  assert.equal(uploaded.batch.content.sources.length,1);assert.equal(service.app.memory.listArtifacts('document_build').length,0);
  const source=service.app.memory.getArtifact(uploaded.batch.content.sources[0].id);assert.match(String(source.content.raw),/active contract/);assert.equal(source.content.format,'text');
  const receiptPath=origin+'/api/canvas/upload/batch/read?id='+encodeURIComponent(batch.id);
  assert.equal((await fetch(receiptPath)).status,403);
  const receipt=await fetch(receiptPath,{headers:{'X-DataEngine-Token':service.adminToken}});assert.equal(receipt.status,200);
  const recorded=await receipt.json() as any;assert.equal(recorded.batch.content.operations[0].operationId,'binary-pdf');assert.equal(recorded.batch.content.sources.length,1);
  const replay=await fetch(origin+path,{method:'POST',headers:{'X-DataEngine-Token':service.adminToken,'Content-Type':'application/octet-stream'},body:bytes});assert.equal(replay.status,200);assert.equal(service.app.memory.listArtifacts('source').length,1);
  await post('/api/canvas/upload/batch/finalize',{batchId:batch.id});assert.equal(service.app.memory.listArtifacts('document_build').length,1);assert.equal(service.app.memory.listArtifacts('foundation').length,0);
 }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});
