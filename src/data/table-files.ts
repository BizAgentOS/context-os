import {randomUUID,createHash} from "node:crypto";
import {createWriteStream} from "node:fs";
import {mkdir,rm} from "node:fs/promises";
import {join} from "node:path";
import {once} from "node:events";
import {finished} from "node:stream/promises";
import {z} from "zod";
import type {Artifact,Data} from "../agent/contracts.ts";
import type {MemoryStore} from "../agent/memory.ts";
import {csvTable,type ParsedTable,type TableOptions} from "./table-parser.ts";
import {tableDirectory,storedTableFile} from "./table-rows.ts";
import {xlsxTables} from "./table-xlsx.ts";

export const MAX_TABLE_FILE_BYTES=100_000_000;
const optionsSchema=z.object({encoding:z.enum(["utf8","gbk","gb18030"]).optional(),delimiter:z.enum([",","\t",";"]).optional(),headerRow:z.number().int().min(1).max(1000).optional()}).strict();
export interface TableImport {name:string;input:AsyncIterable<Uint8Array>;options?:unknown;}
export interface TableImportResult {sources:Artifact[];skippedSheets:string[];warnings:string[];parameters:Data[];}

export class TableFiles {
  private memory:MemoryStore;private directory:string;
  constructor(memory:MemoryStore,directory:string){this.memory=memory;this.directory=directory;}
  async import(input:TableImport):Promise<TableImportResult>{
    if(typeof input.name!=="string"||!input.name||input.name.length>180||/[\\/\u0000-\u001f]/.test(input.name)||! /\.(csv|tsv|xlsx)$/i.test(input.name))throw new Error("仅支持 CSV、TSV 和 XLSX 表格文件名");
    const options=optionsSchema.parse(input.options??{}),dir=tableDirectory(this.directory);await mkdir(dir,{recursive:true,mode:0o700});
    const original=randomUUID()+".original",file=join(dir,original),out=createWriteStream(file,{flags:"wx",mode:0o600}),done=finished(out);void done.catch(()=>{});let bytes=0;const hash=createHash("sha256");
    try{for await(const chunk of input.input){bytes+=chunk.byteLength;if(bytes>MAX_TABLE_FILE_BYTES)throw new Error("表格文件不能超过 100 MB");hash.update(chunk);if(!out.write(chunk))await once(out,"drain");}out.end();await done;
      if(!bytes)throw new Error("表格文件为空");return await this.parseAndSave(input.name,original,hash.digest("hex"),bytes,options);
    }catch(error){out.destroy();await done.catch(()=>{});await rm(file,{force:true});throw error;}
  }
  async reparse(input:{sourceId:string;version:number;options:unknown}):Promise<TableImportResult>{
    const source=this.memory.getArtifact(input.sourceId),original=source.content.tableFile as Data|undefined;
    if(source.kind!=="source"||source.status!=="ready"||source.version!==input.version||!original)throw new Error("表格来源已变化，请刷新后重新解析");
    storedTableFile(this.memory,original.file);
    return this.parseAndSave(String(original.name),String(original.file),String(original.hash),Number(original.bytes),optionsSchema.parse(input.options),source);
  }
  private async parseAndSave(name:string,original:string,hash:string,bytes:number,options:TableOptions,only?:Artifact):Promise<TableImportResult>{
    const file=storedTableFile(this.memory,original),excel=/\.xlsx$/i.test(name),created:string[]=[],skippedSheets:string[]=[],prepared:Array<{name:string|null;parsed:NonNullable<Awaited<ReturnType<TableFiles["storeRows"]>>>}>=[];
    if(excel&&(options.encoding||options.delimiter))throw new Error("Excel 不使用 CSV 编码或分隔符");
    try{
      const tables=excel?xlsxTables(file):[await csvTable(file,options)];
      for await(const table of tables){
        if(only&&excel&&table.name!==(only.content.parseParameters as Data)?.sheet){for await(const _ of table.rows){/* Drain the stream before the next sheet. */}continue;}
        const parsed=await this.storeRows(table,options,created);
        if(!parsed){skippedSheets.push(table.name??name);continue;}prepared.push({name:table.name,parsed});
      }
      if(!prepared.length)throw new Error("表格没有有效表头或数据");
      const sources=this.memory.atomic(()=>{
        if(only&&this.memory.getArtifact(only.id).version!==only.version)throw new Error("表格来源已变化，请重新解析");
        if(excel&&!only){
          const present=new Set(prepared.map(table=>table.name));
          const missing=this.memory.listArtifacts("source").filter(source=>source.status==="ready"&&(source.content.tableFile as Data|undefined)?.name===name)
            .map(source=>(source.content.parseParameters as Data)?.sheet).filter(sheet=>typeof sheet==="string"&&!present.has(sheet));
          if(missing.length)throw new Error(`新工作簿缺少或清空了已接入工作表 ${missing.join("、")}；请先明确移除这些旧来源，再重新上传`);
        }
        return prepared.map(({name:sheet,parsed})=>{
          const title=sheet?`${name} · ${sheet}`:name,prior=only??this.memory.listArtifacts("source").find(a=>a.title===title&&a.content.origin!=="feishu");
          return this.memory.putArtifact({...(prior?{id:prior.id,expectedVersion:prior.version}:{}),kind:"source",title,status:"ready",content:{format:"csv",fileFormat:excel?"xlsx":"csv",hash,columns:parsed.columns,rows:parsed.preview,rowCount:parsed.count,rowStorage:{file:parsed.file},tableFile:{file:original,name,hash,bytes},parseParameters:parsed.parameters}});
        });
      });
      return {sources,skippedSheets,warnings:skippedSheets.map(sheet=>`工作表 ${sheet} 为空，已跳过`),parameters:prepared.map(p=>p.parsed.parameters)};
    }catch(error){await Promise.all(created.map(file=>rm(join(tableDirectory(this.directory),file),{force:true})));throw error;}
  }
  private async storeRows(table:ParsedTable,options:TableOptions,created:string[]){
    const iterator=table.rows[Symbol.asyncIterator](),initial:string[][]=[];let next:IteratorResult<string[]>;
    try {
    while(initial.length<(options.headerRow??30)&&!(next=await iterator.next()).done)initial.push(next.value);
    if(!initial.some(row=>row.some(cell=>cell!=="")))return null;
    const isTitle=(row:string[],index:number)=>!!table.captionRows?.includes(index+1)&&row.length>1&&row.every(cell=>cell===row[0]);
    const candidates=initial.map((row,index)=>({row,index})).filter(({row,index})=>!isTitle(row,index)&&row.some(cell=>cell.trim()));
    const detected=candidates.find(({row})=>row.length>1)??candidates[0];
    const headerIndex=options.headerRow?options.headerRow-1:detected?.index??-1;
    const columns=(initial[headerIndex]??[]).map(cell=>cell.trim());
    if(!columns.length||columns.some(column=>!column)||new Set(columns).size!==columns.length)throw new Error("表格需要唯一、非空列名；请修改表头行后重试");
    const file=randomUUID()+".jsonl",out=createWriteStream(join(tableDirectory(this.directory),file),{flags:"wx",mode:0o600}),done=finished(out);void done.catch(()=>{});created.push(file);const preview:Data[]=[];let count=0,size=0;
    const write=async(cells:string[])=>{if(!cells.some(cell=>cell!==""))return;if(table.name&&cells.length<columns.length)cells=Array.from({length:columns.length},(_,i)=>cells[i]??"");if(cells.length!==columns.length)throw new Error(`表格第 ${headerIndex+count+2} 行列数不一致`);const row=Object.fromEntries(columns.map((column,i)=>[column,cells[i]]));const line=JSON.stringify(row)+"\n";size+=Buffer.byteLength(line);if(size>500_000_000)throw new Error("表格展开后超过 500 MB，请拆分来源");if(preview.length<25)preview.push(row);count++;if(!out.write(line))await once(out,"drain");};
    try{for(const row of initial.slice(headerIndex+1))await write(row);while(!(next=await iterator.next()).done)await write(next.value);out.end();await done;}catch(error){out.destroy();await done.catch(()=>{});await iterator.return?.();throw error;}
    return {columns,preview,count,file,parameters:{...table.parameters,headerRow:headerIndex+1}};
    } finally { await iterator.return?.(); }
  }
}
