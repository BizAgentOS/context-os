/** FEATURE_066 release gate. Runs isolated public seams serially; no real model or commercial account is called. */
import {spawn} from 'node:child_process';
import {createWriteStream,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {cpus,loadavg,tmpdir,totalmem} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const outputArg=process.argv.find(arg=>arg.startsWith('--output='));
const output=outputArg?resolve(outputArg.slice('--output='.length)):mkdtempSync(join(tmpdir(),'context-os-enterprise-scale-'));
mkdirSync(output,{recursive:true});const keyDirectory=mkdtempSync(join(tmpdir(),'context-os-enterprise-scale-keys-'));
const groups=[
 {id:'storage',covers:['按类别索引与2万成果列表','历史大内容迁移','精确引文保留','不含凭据的备份恢复'],files:['memory-scale','enterprise-scale','workspace-retention','workspace-backup']},
 {id:'discovery',covers:['发现结果一次物化分页','高基数保守签名与全量核实','24实体与20类型容量提示','跨系统身份候选和自引用'],files:['discovery-scale','engine-discovery']},
 {id:'files',covers:['多sheet Excel','GBK CSV/TSV','50,001行完整构建查询','100MB拒绝上限','字段和值保真'],files:['table-files','snapshot-value-fidelity']},
 {id:'query',covers:['10万行4请求<15秒','20对象×3附源批量读取','3跳版本任务查询与产品分组','复合键与中间表'],files:['semantic-query','layered-live']},
 {id:'sources',covers:['游标/页码/Link分页','中页OAuth凭据失效恢复','终局凭据失效保留旧快照','空返回质量熔断','定时/断点/增量'],files:['source-enhancements','sync-governance']},
];
const report={feature:'FEATURE_066',startedAt:new Date().toISOString(),runtime:{node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryBytes:totalmem(),loadAtStart:loadavg(),testFileConcurrency:1,scope:'此脚本内串行；同机其他进程负载另记，不宣称整机独占'},
  limits:{types:20,relations:40,supplementsPerType:3,discoveryRelationsPerBundle:30,changed:false,assessment:'维持当前上限：24实体用例明确报告额外4项，3附源有批量读取证据；尚无超过40关系或3附源的端到端资源证据，不能据发现成功直接放开映射与发布预算。'},groups:[] as Array<{id:string;covers:string[];passed:boolean;exitCode:number|null;elapsedMs:number;log:string;diagnostics:string[]}>,finishedAt:'',passed:false};
try{
 for(const group of groups){
  const start=Date.now(),log=join(output,group.id+'.log');console.log(`开始 ${group.id}: ${group.covers.join('、')}`);
  const exitCode=await new Promise<number|null>((done,reject)=>{
   const stream=createWriteStream(log,{flags:'wx'}),child=spawn(process.execPath,['--test','--test-concurrency=1',...group.files.map(name=>`tests/agent/${name}.test.ts`)],{cwd:root,env:{...process.env,CONTEXT_OS_VAULT_KEY_DIRECTORY:keyDirectory},stdio:['ignore','pipe','pipe']});
   const timeout=setTimeout(()=>{child.kill('SIGTERM');},10*60*1000);
   child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});child.once('error',error=>{clearTimeout(timeout);stream.end();reject(error);});child.once('close',code=>{clearTimeout(timeout);stream.end(()=>done(code));});
  });
  const diagnostics=readFileSync(log,'utf8').split('\n').filter(line=>/100000-row|executor reads|page p95|24 entities|# tests |# pass |# fail |ℹ tests |ℹ pass |ℹ fail /.test(line));
  report.groups.push({id:group.id,covers:group.covers,passed:exitCode===0,exitCode,elapsedMs:Date.now()-start,log,diagnostics});
  console.log(`${exitCode===0?'通过':'失败'} ${group.id}: ${Date.now()-start} ms`);for(const line of diagnostics)console.log(line);
  if(exitCode!==0)break;
 }
 report.passed=report.groups.length===groups.length&&report.groups.every(group=>group.passed);
}finally{
 report.finishedAt=new Date().toISOString();writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));rmSync(keyDirectory,{recursive:true,force:true,maxRetries:3,retryDelay:50});
 console.log(`验收记录：${join(output,'report.json')}`);if(!report.passed)process.exitCode=1;
}
