import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createServer} from '../../src/agent/server.ts';
import {TableUploadBatches} from '../../src/agent/table-upload-batches.ts';
import {tableDirectory} from '../../src/data/table-rows.ts';
import ExcelJS from 'exceljs';

test('one eight-table upload builds all first entities together and queues exactly one naming batch',{timeout:30000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-table-batch-')),service=await createServer({directory}),app=service.app;
  const batches=new TableUploadBatches(app.memory,app.tableFiles,app.automaticApiBuild),task=app.memory.createTask('八表同批接入');
  try{
    const batch=batches.start({operationId:'eight-tables',taskId:task.id,page:'setup'});
    for(const [index,name]of ['customers','products','tickets','people','teams','projects','releases','orders'].entries()){
      const added=await batches.addFile({batchId:batch.id,operationId:`file-${index}`,name:`${name}.csv`},Readable.from([Buffer.from(`id,label\n${name}1,第一条\n${name}2,第二条\n`)]));assert.equal(added.error,undefined,JSON.stringify(added.batch.content));
      app.startAutomaticBuild();await app.idle();
      assert.equal(app.memory.listArtifacts('live_ontology').length,0,'a partially uploaded batch must not become the first adopted structure');
    }
    batches.finalize(batch.id);batches.finalize(batch.id);app.startAutomaticBuild();await app.idle();
    const model=app.memory.listArtifacts('live_ontology').find(item=>item.status==='adopted')!;
    assert.equal((model.content.types as any[]).length,8);assert.equal(app.memory.listArtifacts('engine_build').length,1);
    assert.equal(app.memory.listArtifacts('naming_job').length,1);assert.equal(app.memory.listArtifacts('api_build').length,1);
    assert.equal(app.snapshots.datasets().filter(item=>item.content.activeVersion).length,8);
    await app.canvasTableUpload({page:'setup',name:'later.csv'},Readable.from([Buffer.from('id,title\nL1,新记录\nL2,另一记录\n')]));await app.idle();
    assert.equal((app.memory.listArtifacts('live_ontology').find(item=>item.status==='adopted')!.content.types as any[]).length,8,'a later independent source still requires explicit structural adoption');
    assert(app.pendingCenter.list().items.some(item=>item.category==='structure'));
  }finally{await service.close();rmSync(directory,{recursive:true,force:true,maxRetries:3});}
});

test('table batches retain per-file failures, replay lost receipts, and reject parsed files after finalization',{timeout:15000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-table-batch-boundaries-')),service=await createServer({directory,automaticApi:false}),app=service.app;
  const batches=new TableUploadBatches(app.memory,app.tableFiles,app.automaticApiBuild),task=app.memory.createTask('可恢复上传');let release!:()=>void;
  try{
    const batch=batches.start({operationId:'retry-files',taskId:task.id,page:'setup'}),args={batchId:batch.id,operationId:'good',name:'good.csv'};
    const bytes=Buffer.from('id,name\n1,第一条\n2,第二条\n');
    const first=await batches.addFile(args,Readable.from([bytes]));assert(first.tableImport);
    const replay=await batches.addFile(args,Readable.from([bytes]));assert.equal(replay.replayed,true);assert.deepEqual(replay.tableImport!.sources.map(item=>[item.id,item.version]),first.tableImport.sources.map(item=>[item.id,item.version]));
    await assert.rejects(batches.addFile(args,Readable.from([Buffer.from('id,name\n9,另一文件\n')])),/同一文件/);
    const failed=await batches.addFile({batchId:batch.id,operationId:'invalid',name:'invalid.csv'},Readable.from([Buffer.from('id,id\n1,2\n')]));assert.match(failed.error!,/唯一/);
    const saved=batches.finalize(batch.id);assert.equal((saved.content.errors as any[]).length,1);assert.equal((saved.content.sources as any[]).length,1);assert.equal(app.memory.listArtifacts('api_build').length,1);
    const late=batches.start({operationId:'late-file',taskId:task.id,page:'setup'}),gate=new Promise<void>(resolve=>{release=resolve;});
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    async function* stream(){yield Buffer.from('id,name\n');entered();await gate;yield Buffer.from('3,迟到记录\n');}
    const fileCount=readdirSync(tableDirectory(directory)).length;
    const pending=batches.addFile({batchId:late.id,operationId:'late',name:'late.csv'},stream());await started;
    batches.finalize(late.id);release();await assert.rejects(pending,/批次已结束/);
    assert.equal(app.memory.listArtifacts('source').length,1);assert.equal(readdirSync(tableDirectory(directory)).length,fileCount,'late parsing leaves no original or row files');
  }finally{release?.();await service.close();rmSync(directory,{recursive:true,force:true,maxRetries:3});}
});

test('replaying an Excel upload preserves skipped-sheet warnings and parser parameters after restart',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'context-os-table-batch-receipt-'));let service=await createServer({directory,automaticApi:false});
  try{
    const workbook=new ExcelJS.Workbook();workbook.addWorksheet('数据').addRows([['id','name'],['A','实际数据']]);workbook.addWorksheet('空表');
    const bytes=Buffer.from(await workbook.xlsx.writeBuffer()),task=service.app.memory.createTask('重放上传回执');
    const batch=service.app.tableUploads.start({operationId:'excel-batch',taskId:task.id,page:'setup'}),args={batchId:batch.id,operationId:'excel-file',name:'业务.xlsx'};
    const first=await service.app.tableUploads.addFile(args,Readable.from([bytes]));assert.deepEqual(first.tableImport!.skippedSheets,['空表']);assert(first.tableImport!.warnings.length);assert(first.tableImport!.parameters.length);
    await service.close();service=await createServer({directory,automaticApi:false});
    const replay=await service.app.tableUploads.addFile(args,Readable.from([bytes]));assert.equal(replay.replayed,true);
    assert.deepEqual(replay.tableImport,first.tableImport,'a replay is the same import receipt, including sheets that were not imported');
  }finally{await service.close();rmSync(directory,{recursive:true,force:true,maxRetries:3});}
});
