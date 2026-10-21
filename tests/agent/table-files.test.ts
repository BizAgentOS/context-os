import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import iconv from "iconv-lite";
import ExcelJS from "exceljs";
import {MemoryStore} from "../../src/agent/memory.ts";
import {LiveMemory} from "../../src/live/memory.ts";
import {Snapshots} from "../../src/data/snapshots.ts";
import {Workspace} from "../../src/agent/workspace.ts";
import {TableFiles} from "../../src/data/table-files.ts";
import {sourceSummary} from "../../src/agent/source-summary.ts";
import {tableDirectory} from "../../src/data/table-rows.ts";
import {FoundationService} from "../../src/agent/foundation.ts";
import {ProgramBuilds} from "../../src/engine/program-builds.ts";
import type {Data} from "../../src/agent/contracts.ts";

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),"ade-table-files-")),memory=new MemoryStore(directory),live=new LiveMemory(directory,memory),snapshots=new Snapshots(memory,live,directory);
  return {directory,memory,live,snapshots,files:new TableFiles(memory,directory),async close(){await snapshots.close();memory.close();rmSync(directory,{recursive:true,force:true});}};
}

async function buildAndQuery(f:ReturnType<typeof fixture>,expected:Array<{sourceId:string;id:string;fields:Record<string,string>}>) {
  const engine=new ProgramBuilds(f.memory,new FoundationService(f.memory,f.live),f.live,f.snapshots);
  try{
    const run=await engine.build({operationId:'format-build'});
    assert.equal(run.content.outcome,'candidate',JSON.stringify(run.content.issues));
    const candidate=engine.overview().candidate!,checked=await engine.check({id:candidate.id,version:candidate.version});
    assert.equal((checked.content.checks as Data).valid,true,JSON.stringify(checked.content.checks));
    await engine.adopt({id:checked.id,version:checked.version,operationId:'format-adopt'});
    const model=f.live.overview().models.find(item=>item.status==='adopted')!;
    for(const entry of expected){
      const connection=f.live.sources.list().find(source=>(source.content.localSource as Data | undefined)?.id===entry.sourceId)!;
      const type=(model.content.types as Data[]).find(type=>type.sourceId===connection.id)!;
      assert.ok(type,`the uploaded source ${entry.sourceId} has an executable entity binding`);
      const result=await f.live.query({modelId:model.id,type:String(type.name),id:entry.id});
      assert.equal(result.items.length,1);assert.equal(result.items[0].$id,entry.id);
      for(const [column,value] of Object.entries(entry.fields)){
        const field=Object.entries(type.fields as Data).find(([,source])=>source===column)?.[0];
        assert.ok(field,`source column ${column} is bound`);assert.equal(result.items[0][field],value);
      }
      assert.equal(result.coverage.complete,true);
    }
  }finally{await engine.close();}
}

test("a GBK tab-separated upload preserves identifiers through source paging and immutable snapshots",async()=>{
  const f=fixture();
  try{
    const bytes=iconv.encode('企业编号\t企业名称\t备注\r\n001\t青山\t"含制表符\t和换行\n下一行"\r\n002\t海川\t正常\r\n',"gbk");
    const result=await f.files.import({name:"企业.csv",input:Readable.from(Array.from(bytes,b=>Buffer.from([b])))});
    assert.equal(result.sources.length,1);
    const source=result.sources[0];
    assert.equal((source.content.parseParameters as any).encoding,"gbk");
    assert.equal((source.content.parseParameters as any).delimiter,"\t");
    const page=await new Workspace(f.memory).execute("memory_read",{id:source.id,offset:1,limit:1}) as any;
    assert.equal(page.content.total,2);
    assert.equal(page.content.rows[0]["企业编号"],"002");
    await f.snapshots.sync({operationId:"first",sourceIds:[source.id]});
    const dataset=f.snapshots.datasets()[0],preview=await f.snapshots.preview({datasetId:dataset.id});
    assert.deepEqual(preview.rows.map(row=>row["企业编号"]),["001","002"]);
    assert.equal(preview.rows[0]["备注"],"含制表符\t和换行\n下一行");
    await buildAndQuery(f,[{sourceId:source.id,id:'001',fields:{企业名称:'青山',备注:'含制表符\t和换行\n下一行'}}]);
  }finally{await f.close();}
});

test("Excel worksheets become separate sources with detected headers, expanded merges and faithful dates and codes",async()=>{
  const f=fixture();
  try{
    const book=new ExcelJS.Workbook(),people=book.addWorksheet("人员"),orders=book.addWorksheet("订单");book.addWorksheet("空表");
    people.mergeCells("A1:D1");people.getCell("A1").value="人员明细";
    people.addRow(["人员编号","部门","姓名","入职日期"]);
    people.addRow([1,"研发","张一",new Date("2024-02-29T00:00:00.000Z")]);
    people.getCell("A3").numFmt="000000";people.getCell("D3").numFmt="yyyy-mm-dd";
    people.addRow([2,null,"李二",new Date("2024-03-01T08:30:00.000Z")]);
    people.getCell("A4").numFmt="000000";people.getCell("D4").numFmt="yyyy-mm-dd hh:mm:ss";people.mergeCells("B3:B4");
    orders.addRow(["订单编号","人员编号","合计"]);orders.addRow(["O001","000001",{formula:"2+3",result:5}]);
    const bytes=Buffer.from(await book.xlsx.writeBuffer());
    const result=await f.files.import({name:"企业.xlsx",input:Readable.from([bytes])});
    assert.deepEqual(result.sources.map(s=>s.title),["企业.xlsx · 人员","企业.xlsx · 订单"]);
    assert.deepEqual(result.skippedSheets,["空表"]);
    const p=result.sources[0];assert.equal((p.content.parseParameters as any).headerRow,2);
    await f.snapshots.sync({operationId:"excel"});
    const dataset=f.snapshots.datasets().find(d=>d.content.sourceId===p.id)!;
    assert.deepEqual((await f.snapshots.preview({datasetId:dataset.id})).rows,[
      {"人员编号":"000001","部门":"研发","姓名":"张一","入职日期":"2024-02-29"},
      {"人员编号":"000002","部门":"研发","姓名":"李二","入职日期":"2024-03-01T08:30:00.000Z"},
    ]);
    const order=f.snapshots.datasets().find(d=>d.content.sourceId===result.sources[1].id)!;
    assert.equal((await f.snapshots.preview({datasetId:order.id})).rows[0]["合计"],"5");
    await buildAndQuery(f,[
      {sourceId:p.id,id:'000002',fields:{部门:'研发',姓名:'李二',入职日期:'2024-03-01T08:30:00.000Z'}},
      {sourceId:result.sources[1].id,id:'O001',fields:{人员编号:'000001',合计:'5'}},
    ]);
    const again=await f.files.import({name:"企业.xlsx",input:Readable.from([bytes])});
    assert.deepEqual(again.sources.map(s=>s.id),result.sources.map(s=>s.id));
    assert.deepEqual(again.sources.map(s=>s.version),[2,2]);
  }finally{await f.close();}
});

test('GBK comma CSV and UTF-8 TSV each build an ontology with queryable original identifiers',async(t)=>{
  for(const format of [{name:'企业-gbk.csv',encoding:'gbk',delimiter:','},{name:'企业.tsv',encoding:'utf8',delimiter:'\t'}]){
    await t.test(format.name,async()=>{
      const f=fixture();
      try{
        const text=['企业编号','企业名称'].join(format.delimiter)+'\n'+['0007','青山公司'].join(format.delimiter)+'\n'+['0008','海川公司'].join(format.delimiter)+'\n';
        const {sources:[source]}=await f.files.import({name:format.name,input:Readable.from([iconv.encode(text,format.encoding)])});
        assert.equal((source.content.parseParameters as Data).delimiter,format.delimiter);
        assert.equal((source.content.parseParameters as Data).encoding,format.encoding);
        await buildAndQuery(f,[{sourceId:source.id,id:'0007',fields:{企业名称:'青山公司'}}]);
      }finally{await f.close();}
    });
  }
});

test("50,001 streamed rows remain complete beyond preview and build a queryable ontology",async()=>{
  const f=fixture(),engine=new ProgramBuilds(f.memory,new FoundationService(f.memory,f.live),f.live,f.snapshots);
  try{
    async function* input(){yield Buffer.from("person_id,name\n");for(let start=0;start<50001;start+=1000)yield Buffer.from(Array.from({length:Math.min(1000,50001-start)},(_,n)=>`${String(start+n).padStart(6,"0")},人员${start+n}\n`).join(""));}
    const {sources:[source]}=await f.files.import({name:"people.csv",input:input()});
    assert.equal((source.content.rows as unknown[]).length,25,"only a bounded preview is stored in the artifact");
    assert.equal(sourceSummary(f.memory).sources[0].size.value,50001);
    const page=await new Workspace(f.memory).execute("memory_read",{id:source.id,offset:50000,limit:1}) as any;
    assert.equal(page.content.total,50001);assert.equal(page.content.rows[0].person_id,"050000");
    const run=await engine.build({operationId:"large-table-build"});
    assert.equal(run.content.outcome,"candidate",JSON.stringify(run.content.issues));
    const candidate=engine.overview().candidate!,checked=await engine.check({id:candidate.id,version:candidate.version});
    assert.equal((checked.content.checks as any).valid,true,JSON.stringify(checked.content.checks));
    const adopted=await engine.adopt({id:checked.id,version:checked.version,operationId:"adopt-large"});
    const model=(adopted as any).model??f.live.overview().models.find(m=>m.status==="adopted")!;
    const type=(model.content.types as any[])[0].name;
    const result=await f.live.query({modelId:model.id,type,id:"050000"});
    assert.equal(result.items.length,1);assert.ok(JSON.stringify(result.items[0]).includes("人员50000"));
    assert.equal((f.snapshots.datasets()[0].content.profile as any).rows,50001);
  }finally{await engine.close();await f.close();}
});

test("encoding and delimiter can be corrected from retained bytes without changing historical snapshots",async()=>{
  const f=fixture();
  try{
    const text="编号;名称\n0007;𠀀公司\n0008;青山\n",bytes=iconv.encode(text,"gb18030");
    const {sources:[source]}=await f.files.import({name:"客户.csv",input:Readable.from([bytes])});
    assert.equal((source.content.parseParameters as any).encoding,"gb18030");assert.equal((source.content.parseParameters as any).delimiter,";");
    await f.snapshots.sync({operationId:"before-options"});const dataset=f.snapshots.datasets()[0],pinned=String(dataset.content.activeVersion);
    const updated=await f.files.reparse({sourceId:source.id,version:source.version,options:{encoding:"gb18030",delimiter:";",headerRow:1}});
    assert.equal(updated.sources[0].id,source.id);assert.equal(updated.sources[0].version,2);
    const page=await new Workspace(f.memory).execute("memory_read",{id:source.id,version:1}) as any;
    assert.deepEqual(page.content.rows,[{"编号":"0007","名称":"𠀀公司"},{"编号":"0008","名称":"青山"}]);
    assert.equal((await f.snapshots.preview({datasetId:dataset.id,snapshotId:pinned})).rows[0]["名称"],"𠀀公司");
    await assert.rejects(f.files.reparse({sourceId:source.id,version:1,options:{delimiter:","}}),/已变化/);
  }finally{await f.close();}
});

test("oversized or malformed uploads leave the prior source intact and remove incomplete files",async()=>{
  const f=fixture();
  try{
    const {sources:[source]}=await f.files.import({name:"safe.csv",input:Readable.from([Buffer.from("id,name\n001,原文\n")])});
    const before=readdirSync(tableDirectory(f.directory)).sort();
    await assert.rejects(f.files.import({name:"safe.csv",input:Readable.from([Buffer.from('id,name\n001,"未闭合')])}),/Quote|quote|引号/);
    async function* oversized(){const chunk=Buffer.alloc(1_000_000,65);for(let i=0;i<101;i++)yield chunk;}
    await assert.rejects(f.files.import({name:"large.csv",input:oversized()}),/100 MB/);
    await assert.rejects(f.files.import({name:"../safe.csv",input:Readable.from([])}),/文件名/);
    assert.equal(f.memory.getArtifact(source.id).version,1);
    assert.deepEqual(readdirSync(tableDirectory(f.directory)).sort(),before);
  }finally{await f.close();}
});

test("duplicate CSV headers fail instead of silently promoting the first data row to a header",async()=>{
  const f=fixture();
  try{
    await assert.rejects(f.files.import({name:"duplicate.csv",input:Readable.from([Buffer.from("id,id\n001,青山\n002,海川\n")])}),/唯一|列名/);
    await assert.rejects(f.files.import({name:"empty-header.csv",input:Readable.from([Buffer.from("id,,name\n001,研发,青山\n002,销售,海川\n")])}),/唯一|列名/);
    assert.equal(f.memory.listArtifacts("source").length,0);
  }finally{await f.close();}
});

test("CSV header overrides refer to visible file rows including blank and quoted multiline preambles",async()=>{
  const f=fixture();
  try{
    const bytes=Buffer.from('\n"说明\n续行"\nid;name\n001;青山\n');
    const {sources:[source]}=await f.files.import({name:"notes.csv",input:Readable.from([bytes]),options:{headerRow:4,delimiter:";"}});
    assert.deepEqual(source.content.columns,["id","name"]);
    assert.deepEqual(source.content.rows,[{id:"001",name:"青山"}]);
    assert.equal((source.content.parseParameters as any).headerRow,4);
  }finally{await f.close();}
});

test("replacing a workbook cannot silently leave a removed sheet active",async()=>{
  const f=fixture();
  try{
    const book=new ExcelJS.Workbook();
    for(const name of ["A","B"]){const sheet=book.addWorksheet(name);sheet.addRow(["id","name"]);sheet.addRow(["001",name]);}
    const {sources}=await f.files.import({name:"refresh.xlsx",input:Readable.from([Buffer.from(await book.xlsx.writeBuffer())])});
    const before=readdirSync(tableDirectory(f.directory)).sort();
    book.removeWorksheet("B");book.getWorksheet("A")!.getCell("B2").value="更新";
    await assert.rejects(f.files.import({name:"refresh.xlsx",input:Readable.from([Buffer.from(await book.xlsx.writeBuffer())])}),/B.*移除|移除.*B/);
    assert.deepEqual(sources.map(source=>f.memory.getArtifact(source.id).version),[1,1]);
    assert.deepEqual(readdirSync(tableDirectory(f.directory)).sort(),before);
  }finally{await f.close();}
});

test("cached empty Excel formula results are valid while formulas without saved results are rejected",async()=>{
  const f=fixture();
  try{
    const book=new ExcelJS.Workbook(),sheet=book.addWorksheet("数据");sheet.addRow(["id","result"]);
    sheet.addRow(["001",{formula:'IF(1=1,"","x")',result:""}]);
    const {sources:[source]}=await f.files.import({name:"formula.xlsx",input:Readable.from([Buffer.from(await book.xlsx.writeBuffer())])});
    assert.deepEqual(source.content.rows,[{id:"001",result:""}]);
    sheet.getCell("B2").value={formula:"2+3"};
    await assert.rejects(f.files.import({name:"formula.xlsx",input:Readable.from([Buffer.from(await book.xlsx.writeBuffer())])}),/没有已保存结果/);
    assert.equal(f.memory.getArtifact(source.id).version,1);
  }finally{await f.close();}
});
