import {createReadStream} from "node:fs";
import {open} from "node:fs/promises";
import {parse} from "csv-parse";
import type {Transform} from "node:stream";
import iconv from "iconv-lite";
import type {Data} from "../agent/contracts.ts";

export interface TableOptions {encoding?:"utf8"|"gbk"|"gb18030";delimiter?:","|"\t"|";";headerRow?:number;}
export interface ParsedTable {name:string|null;parameters:Data;rows:AsyncIterable<string[]>;captionRows?:number[];}
async function encodingOf(file:string):Promise<"utf8"|"gbk"|"gb18030">{
  const decoder=new TextDecoder("utf-8",{fatal:true});let utf8=true,gb18030=false,tail=Buffer.alloc(0);
  for await(const chunk of createReadStream(file)){
    const bytes=chunk as Buffer;if(utf8)try{decoder.decode(bytes,{stream:true});}catch{utf8=false;}
    const joined=Buffer.concat([tail,bytes]);for(let i=0;i+3<joined.length;i++)if(joined[i]>=0x81&&joined[i]<=0xfe&&joined[i+1]>=0x30&&joined[i+1]<=0x39&&joined[i+2]>=0x81&&joined[i+2]<=0xfe&&joined[i+3]>=0x30&&joined[i+3]<=0x39){gb18030=true;break;}tail=joined.subarray(-3);
  }
  if(utf8)try{decoder.decode();}catch{utf8=false;}
  return utf8?"utf8":gb18030?"gb18030":"gbk";
}
function delimiterOf(text:string):","|"\t"|";"{
  const candidates=[",","\t",";"] as const;let quote=false,counts=[0,0,0],lines:number[][]=[];
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quote&&text[i+1]==='"')i++;else quote=!quote;}else if(!quote&&c==='\n'){if(counts.some(Boolean))lines.push(counts);counts=[0,0,0];if(lines.length>=30)break;}else if(!quote){const at=candidates.indexOf(c as any);if(at>=0)counts[at]++;}}
  if(!quote&&counts.some(Boolean))lines.push(counts);
  const score=(i:number)=>{const frequencies=new Map<number,number>();for(const row of lines)if(row[i])frequencies.set(row[i],(frequencies.get(row[i])??0)+1);return Math.max(0,...[...frequencies].map(([columns,count])=>count*1000+columns));};
  return [...candidates].sort((a,b)=>score(candidates.indexOf(b))-score(candidates.indexOf(a)))[0];
}
export async function csvTable(file:string,options:TableOptions):Promise<ParsedTable>{
  const encoding=options.encoding??await encodingOf(file),fd=await open(file,"r"),buffer=Buffer.alloc(64*1024);let sample:string;
  try{const {bytesRead}=await fd.read(buffer);sample=iconv.decode(buffer.subarray(0,bytesRead),encoding);}finally{await fd.close();}
  const delimiter=options.delimiter??delimiterOf(sample!);
  async function* rows(){
    const source=createReadStream(file),decoder=iconv.decodeStream(encoding) as Transform,parser=parse({delimiter,bom:true,relax_column_count:true,info:true,max_record_size:4*1024*1024});
    source.on("error",error=>parser.destroy(error));decoder.on("error",error=>parser.destroy(error));source.pipe(decoder).pipe(parser);
    let previousLine=0;
    try{for await(const item of parser){const row=item.record as string[];if(row.some(cell=>/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(cell)))throw new Error("表格含无效文本，请修改编码后重新解析");yield row;for(let line=previousLine+1;line<item.info.lines;line++)yield [];previousLine=item.info.lines;}}finally{source.destroy();decoder.destroy();parser.destroy();}
  }
  return {name:null,parameters:{encoding,delimiter},rows:rows()};
}
