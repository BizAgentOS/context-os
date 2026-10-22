import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {createFeishuCli,FEISHU_VERSION} from "../../src/connectors/feishu-cli.ts";

test("the pinned CLI NDJSON protocol reads its bare manifest and rejects a mismatched file receipt",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"context-os-feishu-export-")),root=join(directory,"connectors","feishu",FEISHU_VERSION),cli=createFeishuCli(directory);await mkdir(root,{recursive:true});
  let mismatch=false;
  // Controlled command port writes the official CLI artifact protocol; no Feishu account is accessed.
  cli.run=async request=>{const file=resolve(root,request.args[request.args.indexOf("--output")+1]),manifestFile=file.replace(/\.ndjson$/,".manifest.json"),body='{"record_id":"rec_1","姓名":"甲"}\n',manifest={manifest_version:"v1",format:"ndjson",base_token:"base_test",table_id:"tbl_people",rev:8,records_count:1,has_more:false,record_file:file,record_file_size_bytes:Buffer.byteLength(body),manifest_file:manifestFile,columns:{}};await writeFile(file,body);await writeFile(manifestFile,JSON.stringify(manifest));return JSON.stringify({...manifest,record_file_size_bytes:manifest.record_file_size_bytes+(mismatch?1:0)});};
  try{const request={args:["--profile=de-test","base","+record-list","--as","user","--json"],signal:AbortSignal.timeout(5000)};const read=await cli.exportRecords!(request);assert.equal(read.records[0].姓名,"甲");mismatch=true;await assert.rejects(cli.exportRecords!(request),/回执/);}finally{await rm(directory,{recursive:true,force:true});}
});
