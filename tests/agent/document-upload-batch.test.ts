import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {AddressInfo} from "node:net";
import {createServer} from "../../src/agent/server.ts";

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
