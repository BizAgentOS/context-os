import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import type {AddressInfo} from "node:net";
import ExcelJS from "exceljs";
import {createServer} from "../../src/agent/server.ts";

test("management upload accepts real Excel and streamed tables, protects the boundary, and exposes editable parsing",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"ade-table-http-")),service=await createServer({directory,automaticApi:false});
  await new Promise<void>(resolve=>service.server.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
  const headers={"X-DataEngine-Token":service.adminToken,"Content-Type":"application/octet-stream"};
  const url=(name:string)=>origin+"/api/canvas/upload/table?"+new URLSearchParams({page:"setup",name});
  try{
    const bytes=Buffer.from("id,name\n001,甲\n");
    const unauthenticated=await fetch(url("denied.csv"),{method:"POST",headers:{"Content-Type":"application/octet-stream"},body:bytes});
    assert.equal(unauthenticated.status,403);
    const consumer=await fetch(url("denied.csv"),{method:"POST",headers:{...headers,Authorization:"Bearer consumer-key"},body:bytes});assert.equal(consumer.status,403);
    const crossOrigin=await fetch(url("denied.csv"),{method:"POST",headers:{...headers,Origin:"https://other.example"},body:bytes});assert.equal(crossOrigin.status,403);
    const book=new ExcelJS.Workbook();book.addWorksheet("人员").addRows([["id","name"],["001","甲"]]);book.addWorksheet("订单").addRows([["id","person_id"],["O1","001"]]);
    const uploaded=await fetch(url("two.xlsx"),{method:"POST",headers,body:Buffer.from(await book.xlsx.writeBuffer())});
    const response=await uploaded.json() as any;assert.equal(uploaded.status,200,JSON.stringify(response));assert.equal(response.tableImport.sources.length,2);
    assert.deepEqual(response.tableImport.parameters.map((p:any)=>p.sheet),["人员","订单"]);
    const first=response.tableImport.sources[0];
    const reparse=await fetch(origin+"/api/canvas/upload/reparse",{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({page:"setup",sourceId:first.id,version:first.version,options:{headerRow:1}})});
    const updated=await reparse.json() as any;assert.equal(reparse.status,200,JSON.stringify(updated));assert.equal(updated.tableImport.sources[0].id,first.id);assert.equal(updated.tableImport.sources[0].version,2);
    const changed=await fetch(origin+"/api/canvas/upload/reparse",{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({page:"setup",sourceId:first.id,version:first.version,options:{headerRow:1}})});assert.ok(changed.status>=400);
    async function* large(){yield Buffer.from("id,name\n");for(let n=0;n<65000;n++)yield Buffer.from(`${String(n).padStart(6,"0")},${"x".repeat(100)}\n`);}
    const streamed=await fetch(url("over-five-mb.csv"),{method:"POST",headers,body:Readable.toWeb(Readable.from(large())) as ReadableStream,duplex:"half"} as RequestInit);
    const largeResult=await streamed.json() as any;assert.equal(streamed.status,200,JSON.stringify(largeResult));assert.equal(largeResult.tableImport.sources[0].content.rowCount,65000);
    const summary=await (await fetch(origin+"/api/sources/summary",{headers})).json() as any;
    const table=summary.sources.find((s:any)=>s.title==="over-five-mb.csv");assert.equal(table.size.value,65000);assert.equal(table.parseParameters.delimiter,",");
    async function* oversized(){const chunk=Buffer.alloc(1_000_000,65);for(let n=0;n<101;n++)yield chunk;}
    const tooLarge=await fetch(url("over-limit.csv"),{method:"POST",headers,body:Readable.toWeb(Readable.from(oversized())) as ReadableStream,duplex:"half"} as RequestInit);
    assert.ok(tooLarge.status>=400);assert.match(JSON.stringify(await tooLarge.json()),/100 MB/);
    const after=await (await fetch(origin+"/api/sources/summary",{headers})).json() as any;
    assert.equal(after.total,3,"denied and failed uploads never add sources");
  }finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});
