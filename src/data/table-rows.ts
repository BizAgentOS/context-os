import {sourceRowsLength} from "../agent/source-content.ts";
import {createReadStream,openSync,readSync,closeSync,realpathSync} from "node:fs";
import {join,resolve} from "node:path";
import {createInterface} from "node:readline";
import {StringDecoder} from "node:string_decoder";
import type {Artifact,Data,Repository} from "../agent/contracts.ts";

export const tableDirectory=(directory:string)=>join(resolve(directory),"data","table-files");
export function storedTableFile(repo:Pick<Repository,"directory">,file:unknown){
  if(!repo.directory||typeof file!=="string"||!/^[-a-f0-9]{36}\.(jsonl|original)$/.test(file))throw new Error("表格文件引用无效");
  const base=realpathSync(tableDirectory(repo.directory)),path=join(base,file);
  if(base!==join(realpathSync(repo.directory),"data","table-files"))throw new Error("表格目录不属于当前工作区");
  if(realpathSync(path)!==path)throw new Error("表格文件不属于当前工作区");
  return path;
}
export function tableRowCount(source:Artifact){return source.content.rowStorage?Number(source.content.rowCount):sourceRowsLength(source);}
export async function* tableRows(source:Artifact,repo:Pick<Repository,"directory">):AsyncGenerator<Data>{
  if(!source.content.rowStorage){yield*((source.content.rows??[]) as Data[]);return;}
  const file=storedTableFile(repo,(source.content.rowStorage as Data).file),input=createReadStream(file),lines=createInterface({input,crlfDelay:Infinity});
  try{for await(const line of lines)if(line)yield JSON.parse(line) as Data;}finally{lines.close();input.destroy();}
}
/** Compatibility for synchronous legacy tools; iterate without buffering the entire file. */
export function* tableRowsSync(source:Artifact,repo:Pick<Repository,"directory">):Generator<Data>{
  if(!source.content.rowStorage){yield*((source.content.rows??[]) as Data[]);return;}
  const fd=openSync(storedTableFile(repo,(source.content.rowStorage as Data).file),"r"),buffer=Buffer.alloc(64*1024),decoder=new StringDecoder("utf8");let pending="";
  try{let read:number;while((read=readSync(fd,buffer,0,buffer.length,null))){pending+=decoder.write(buffer.subarray(0,read));let end:number;while((end=pending.indexOf("\n"))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(line)yield JSON.parse(line) as Data;}}pending+=decoder.end();if(pending)yield JSON.parse(pending) as Data;}finally{closeSync(fd);}
}
export function tablePage(source:Artifact,repo:Pick<Repository,"directory">,offset:number,limit:number){const rows:Data[]=[];let index=0;for(const row of tableRowsSync(source,repo)){if(index++<offset)continue;rows.push(row);if(rows.length>=limit)break;}return {rows,total:tableRowCount(source)};}
