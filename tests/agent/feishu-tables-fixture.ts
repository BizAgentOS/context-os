import assert from "node:assert/strict";
import type { CliRequest, FeishuCliPort } from "../../src/connectors/feishu-cli.ts";
import type { FeishuConnector } from "../../src/connectors/feishu.ts";

/** Protocol simulation from pinned lark-cli v1.0.92; never a claim of real Feishu authorization. */
export class TableCli implements FeishuCliPort {
  profile="";openId="ou_test_user";scopes="docx:document:readonly base:table:read base:field:read base:record:read";
  calls:string[][]=[];rev=8;gate?:Promise<void>;changedAtOffset:number|null=null;
  tables=[{id:"tbl_people",name:"人员"}];
  fields=[{id:"fld_name",name:"姓名",type:"text"},{id:"fld_score",name:"积分",type:"number"},{id:"fld_active",name:"在职",type:"checkbox"},{id:"fld_tags",name:"标签",type:"select",multiple:true}];
  rows=Array.from({length:205},(_,i)=>({record_id:`rec_${i}`,姓名:`员工${i}`,积分:i,在职:i%2===0,标签:["正式"]}));
  async prepare(signal:AbortSignal){signal.throwIfAborted();}
  async run({args,signal,onLine}:CliRequest){
    this.calls.push(args);signal.throwIfAborted();
    if(args[0]==="--version")return "lark-cli version 1.0.92";
    if(args[0]==="profile")return JSON.stringify(this.profile?[{name:this.profile,brand:"feishu",appId:"cli_test"}]:[]);
    if(args[0]==="config"){this.profile=args.at(-1)!;onLine?.("stderr","https://open.feishu.cn/page/cli?user_code=fixture");return JSON.stringify({brand:"feishu",appId:"cli_test",appSecret:"****"});}
    if(args.includes("login")){const requested=args[args.indexOf("--scope")+1].split(/\s+/);this.scopes=[...new Set([...this.scopes.split(/\s+/),...requested])].join(" ");onLine?.("stdout",JSON.stringify({event:"device_authorization",verification_uri_complete:"https://accounts.feishu.cn/oauth/v1/device/verify?user_code=fixture"}));onLine?.("stdout",JSON.stringify({event:"authorization_complete",granted:requested,missing:[]}));return "";}
    if(args.includes("status"))return JSON.stringify({brand:"feishu",appId:"cli_test",identities:{user:{openId:this.openId,userName:"协议验收账号",verified:true,available:true,scope:this.scopes}}});
    const offset=Number(args[args.indexOf("--offset")+1]??0),limit=Number(args[args.indexOf("--limit")+1]??50);
    if(args.includes("+table-list"))return JSON.stringify({ok:true,identity:"user",data:{tables:this.tables.slice(offset,offset+limit),total:this.tables.length}});
    if(args.includes("+field-list"))return JSON.stringify({ok:true,identity:"user",data:{fields:this.fields.slice(offset,offset+limit),total:this.fields.length}});
    throw new Error("unexpected protocol command: "+args.join(" "));
  }
  async downloadText():Promise<{content:string;bytes:number}>{throw new Error("document download is outside the table flow");}
  async exportRecords({args,signal}:CliRequest){
    this.calls.push(args);await this.gate;signal.throwIfAborted();
    assert(args.includes("--as")&&args.includes("user"));assert(args.includes("+record-list")||args.includes("+record-get"));
    const offset=args.includes("--offset")?Number(args[args.indexOf("--offset")+1]):0,limit=Number(args[args.indexOf("--limit")+1]??100);
    const rows=args.includes("--record-id")?this.rows.filter(row=>row.record_id===args[args.indexOf("--record-id")+1]):this.rows.slice(offset,offset+limit);
    const more=!args.includes("--record-id")&&offset+rows.length<this.rows.length;
    const projection=args.flatMap((arg,index)=>arg==="--field-id"?[args[index+1]]:[]),fields=this.fields.filter(field=>projection.includes(field.id));
    return {records:rows.map(row=>Object.fromEntries(["record_id",...fields.map(field=>field.name)].map(name=>[name,(row as any)[name]??null]))),manifest:{manifest_version:"v1",format:"ndjson",base_token:"base_test",table_id:"tbl_people",rev:this.changedAtOffset!==null&&offset>=this.changedAtOffset?this.rev+1:this.rev,timezone:"Asia/Shanghai",query_context:{record_scope:args.includes("--record-id")?"selected_record_ids":"all_records"},offset,requested_limit:limit,records_count:rows.length,has_more:more,...(more?{next_offset:offset+rows.length}:{}),columns:Object.fromEntries([["record_id",{field_type:"record_id",physical_type:"string"}],...fields.map(field=>[field.name,{field_id:field.id,field_type:field.type,physical_type:field.type==="select"?"array<string>":field.type==="checkbox"?"boolean":field.type==="number"?"number":"string"}])])}};
  }
}
export async function connected(connector:FeishuConnector){connector.start();for(let i=0;i<100;i++){if(connector.status().job?.phase==="connected")return;await new Promise(resolve=>setImmediate(resolve));}throw new Error("simulated connection did not settle");}
