import {Open, type File as ZipEntry} from "unzipper";
import {SaxesParser} from "saxes";
import {StringDecoder} from "node:string_decoder";
import {DatabaseSync} from "node:sqlite";
import {rm} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {dirname,join,posix} from "node:path";
import type {ParsedTable} from "./table-parser.ts";

type Event={kind:"open"|"close"|"text";name:string;attributes?:Record<string,string>};
type Merge={firstRow:number;lastRow:number;firstCol:number;lastCol:number};
type Cell={ref:string;type:string;style:number;value:string;formula:boolean;cached:boolean};
const MAX_EXPANDED=500_000_000;
const local=(name:string)=>name.split(":").at(-1)!;

/** OOXML is read from indexed ZIP entries, so file ordering cannot change the result. */
async function* xml(entry:ZipEntry):AsyncGenerator<Event>{
  const parser=new SaxesParser(),decoder=new StringDecoder("utf8"),stream=entry.stream();
  let events:Event[]=[],bytes=0;
  parser.on("doctype",()=>{throw new Error("Excel 不支持外部 XML 定义");});
  parser.on("opentag",node=>events.push({kind:"open",name:local(node.name),attributes:node.attributes as Record<string,string>}));
  parser.on("closetag",node=>events.push({kind:"close",name:local(node.name)}));
  parser.on("text",text=>events.push({kind:"text",name:text}));
  try{
    for await(const chunk of stream){
      bytes+=(chunk as Buffer).length;
      if(bytes>MAX_EXPANDED||bytes>entry.uncompressedSize)throw new Error("Excel 展开内容超出文件声明或 500 MB 限制");
      parser.write(decoder.write(chunk as Buffer));yield* events;events=[];
    }
    parser.write(decoder.end());parser.close();yield* events;
  }finally{stream.destroy();}
}
function address(value:string){
  const match=/^([A-Z]{1,3})([1-9][0-9]*)$/.exec(value);
  if(!match)throw new Error("Excel 单元格范围无效");
  const row=Number(match[2]),col=[...match[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
  if(row>1048576||col>16384)throw new Error("Excel 单元格范围无效");
  return {row,col};
}
async function mergesOf(entry:ZipEntry){
  const ranges:Merge[]=[];
  for await(const event of xml(entry))if(event.kind==="open"&&event.name==="mergeCell"){
    const refs=String(event.attributes?.ref??"").split(":"),first=address(refs[0]),last=address(refs[1]??refs[0]);
    if(last.row<first.row||last.col<first.col||ranges.length>=10000)throw new Error("Excel 合并区域无效或超过 10000 个");
    ranges.push({firstRow:first.row,lastRow:last.row,firstCol:first.col,lastCol:last.col});
  }
  return ranges;
}
async function stylesOf(entry:ZipEntry|undefined){
  const formats=new Map<number,string>([[14,"mm-dd-yy"],[15,"d-mmm-yy"],[16,"d-mmm"],[17,"mmm-yy"],[18,"h:mm AM/PM"],[19,"h:mm:ss AM/PM"],[20,"h:mm"],[21,"h:mm:ss"],[22,"m/d/yy h:mm"],[45,"mm:ss"],[46,"[h]:mm:ss"],[47,"mmss.0"]]);
  const styles:number[]=[];let cellXfs=false;
  if(entry)for await(const event of xml(entry)){
    if(event.kind==="open"&&event.name==="numFmt")formats.set(Number(event.attributes?.numFmtId),String(event.attributes?.formatCode??""));
    if(event.name==="cellXfs")cellXfs=event.kind==="open";
    if(cellXfs&&event.kind==="open"&&event.name==="xf")styles.push(Number(event.attributes?.numFmtId??0));
  }
  return styles.map(id=>formats.get(id)??"");
}
function numeric(value:string,format:string,date1904:boolean,ref:string){
  const number=Number(value),simple=format.replace(/"[^"]*"|\\.|\[[^\]]*\]/g,"");
  if(!Number.isFinite(number))throw new Error(`单元格 ${ref} 数值无效`);
  if(/[ymdhs]/i.test(simple)){
    if(!date1904&&number>=60&&number<61)throw new Error(`单元格 ${ref} 使用了不存在的 1900-02-29 日期`);
    const days=number+(date1904?1462:number<60?1:0),date=new Date(Math.round((days-25569)*86400000));
    if(!Number.isFinite(date.getTime()))throw new Error(`单元格 ${ref} 日期无效`);
    return /[hs]/i.test(simple)?date.toISOString():date.toISOString().slice(0,10);
  }
  // Preserve the literal stored number, including identifiers beyond JS integer precision.
  const section=format.split(";")[0];
  return /^\d+$/.test(value)&&/^0+$/.test(section)?value.padStart(section.length,"0"):value;
}
function cellValue(cell:Cell,styles:string[],date1904:boolean,lookup:(id:number)=>string){
  if(cell.formula&&!cell.cached)throw new Error(`单元格 ${cell.ref} 的公式没有已保存结果；请在 Excel 中计算并保存`);
  if(cell.type==="s")return lookup(Number(cell.value));
  if(["inlineStr","str"].includes(cell.type))return cell.value;
  if(cell.type==="e")throw new Error(`单元格 ${cell.ref} 包含错误 ${cell.value}`);
  if(cell.type==="b")return cell.value==="1"?"true":"false";
  if(cell.type==="d"){
    const date=new Date(cell.value);if(!Number.isFinite(date.getTime()))throw new Error(`单元格 ${cell.ref} 日期无效`);return date.toISOString();
  }
  return cell.value?numeric(cell.value,styles[cell.style]??"",date1904,cell.ref):"";
}
async function* sheetRows(entry:ZipEntry,merges:Merge[],styles:string[],date1904:boolean,lookup:(id:number)=>string){
  let row:string[]=[],number=0,previous=0,cell:Cell|null=null,reading=false,phonetic=false;
  const masters=new Map<Merge,string>();
  function expanded(at:number,cells:string[]){
    for(const merge of merges){
      if(at<merge.firstRow||at>merge.lastRow)continue;
      if(at===merge.firstRow)masters.set(merge,cells[merge.firstCol-1]??"");
      for(let col=merge.firstCol;col<=merge.lastCol;col++)cells[col-1]=masters.get(merge)??"";
      if(at===merge.lastRow)masters.delete(merge);
    }
    return Array.from({length:cells.length},(_,i)=>cells[i]??"");
  }
  for await(const event of xml(entry)){
    if(event.kind==="open"){
      if(event.name==="row"){
        number=Number(event.attributes?.r??previous+1);
        if(!Number.isInteger(number)||number<=previous||number>1048576)throw new Error("Excel 行号无效");
        for(let at=previous+1;at<number;at++)yield expanded(at,[]);row=[];
      }
      if(event.name==="c")cell={ref:String(event.attributes?.r??""),type:String(event.attributes?.t??"n"),style:Number(event.attributes?.s??0),value:"",formula:false,cached:false};
      if(event.name==="rPh")phonetic=true;
      if(cell&&event.name==="f")cell.formula=true;
      if(cell&&event.name==="v")cell.cached=true;
      if(cell&&["v","t"].includes(event.name)&&!phonetic)reading=true;
    }else if(event.kind==="text"){
      if(cell&&reading){cell.value+=event.name;if(cell.value.length>4*1024*1024)throw new Error("Excel 单个单元格超过 4 MB");}
    }else{
      if(["v","t"].includes(event.name))reading=false;
      if(event.name==="rPh")phonetic=false;
      if(event.name==="c"&&cell){const pos=address(cell.ref);if(pos.row!==number)throw new Error("Excel 单元格行号不一致");row[pos.col-1]=cellValue(cell,styles,date1904,lookup);cell=null;}
      if(event.name==="row"){yield expanded(number,row);previous=number;}
    }
  }
  const end=Math.max(previous,...merges.map(merge=>merge.lastRow));
  for(let at=previous+1;at<=end;at++)yield expanded(at,[]);
}

export async function* xlsxTables(file:string):AsyncGenerator<ParsedTable>{
  const archive=await Open.file(file),entries=new Map(archive.files.filter(entry=>entry.type==="File").map(entry=>[entry.path,entry]));
  if(archive.files.length>10000||archive.files.reduce((n,entry)=>n+entry.uncompressedSize,0)>MAX_EXPANDED)throw new Error("Excel 展开后超过 500 MB 或文件条目过多");
  const workbook=entries.get("xl/workbook.xml"),relations=entries.get("xl/_rels/workbook.xml.rels");
  if(!workbook||!relations)throw new Error("文件不是有效的 XLSX 工作簿");
  const sheets:Array<{name:string;ref:string}>=[],targets=new Map<string,string>();let date1904=false;
  for await(const event of xml(workbook))if(event.kind==="open"){
    if(event.name==="workbookPr")date1904=["1","true"].includes(event.attributes?.date1904??"");
    if(event.name==="sheet")sheets.push({name:String(event.attributes?.name??""),ref:String(event.attributes?.["r:id"]??"")});
  }
  for await(const event of xml(relations))if(event.kind==="open"&&event.name==="Relationship"&&event.attributes?.TargetMode!=="External"){
    const target=String(event.attributes?.Target??"");targets.set(String(event.attributes?.Id),posix.normalize(target.startsWith("/")?target.slice(1):posix.join("xl",target)));
  }
  if(!sheets.length)throw new Error("Excel 没有工作表");
  const styles=await stylesOf(entries.get("xl/styles.xml")),temp=join(dirname(file),randomUUID()+".strings.sqlite"),strings=new DatabaseSync(temp);
  try{
    strings.exec("CREATE TABLE strings(id INTEGER PRIMARY KEY,value TEXT NOT NULL); BEGIN");
    const insert=strings.prepare("INSERT INTO strings VALUES(?,?)"),get=strings.prepare("SELECT value FROM strings WHERE id=?");
    const shared=entries.get("xl/sharedStrings.xml");let id=0,text="",reading=false,phonetic=false;
    if(shared)for await(const event of xml(shared)){
      if(event.kind==="open"){
        if(event.name==="si")text="";
        if(event.name==="rPh")phonetic=true;
        if(event.name==="t"&&!phonetic)reading=true;
      }else if(event.kind==="text"&&reading){text+=event.name;if(text.length>4*1024*1024)throw new Error("Excel 单个共享文本超过 4 MB");}
      else if(event.kind==="close"){
        if(event.name==="t")reading=false;
        if(event.name==="rPh")phonetic=false;
        if(event.name==="si")insert.run(id++,text);
      }
    }
    strings.exec("COMMIT");
    const lookup=(id:number)=>{if(!Number.isSafeInteger(id)||id<0)throw new Error("Excel 共享文本索引无效");const value=get.get(id);if(!value)throw new Error("Excel 引用了不存在的共享文本");return String(value.value);};
    for(const sheet of sheets){
      const entry=entries.get(targets.get(sheet.ref)??"");if(!entry)throw new Error(`Excel 工作表 ${sheet.name} 的内容不存在`);
      const merges=await mergesOf(entry);
      yield {name:sheet.name,captionRows:merges.filter(m=>m.firstRow===m.lastRow&&m.firstCol===1&&m.lastCol>1).map(m=>m.firstRow),parameters:{fileFormat:"xlsx",sheet:sheet.name,mergedRanges:merges.length,dateMode:"iso8601",dateSystem:date1904?"1904":"1900",formulas:"cached_results"},rows:sheetRows(entry,merges,styles,date1904,lookup)};
    }
  }finally{strings.close();await rm(temp,{force:true});}
}
