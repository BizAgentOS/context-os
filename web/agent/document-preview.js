const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);return node;};
export function documentPosition(location){
 if(!location)return '';
 const parts=[];if(location.pages?.length)parts.push(`PDF 第 ${location.pages.join('、')} 页`);if(location.sections?.length)parts.push(`章节：${location.sections.join(' / ')}`);
 return parts.join(' · ');
}

/** Displays saved extraction ranges; changing a page never asks the source for different content. */
export function renderDocumentPreview(source){
 const root=el('section'),raw=String(source.content.raw||''),file=source.content.documentFile,blocks=file.blocks||[],size=12000;
 const sections=blocks.filter(block=>block.kind==='section');
 let segments=file.format==='pdf'?blocks.filter(block=>block.kind==='page').map(block=>({...block,label:documentPosition({pages:[block.page],sections:block.headings})})):sections.map((block,index)=>({...block,end:sections[index+1]?.start??raw.length,label:(block.headings||[]).join(' / ')||`章节 ${index+1}`}));
 if(segments.length&&segments[0].start>0)segments.unshift({start:0,end:segments[0].start,label:'文档开头'});
 if(!segments.length)segments=Array.from({length:Math.max(1,Math.ceil(raw.length/size))},(_,index)=>({start:index*size,end:Math.min(raw.length,(index+1)*size),label:`正文片段 ${index+1}`}));
 root.append(el('p',`${file.format==='pdf'?'PDF':'Word'} 抽取正文 · ${raw.length.toLocaleString('zh-CN')} 字符；定位绑定这份保存版本。`));
 for(const warning of file.warnings||[])root.append(el('p',warning));
 if(!raw.length){root.append(el('p','这份文档没有可抽取的正文。'));return root;}
 const label=el('label','文档页或章节'),select=el('select');select.setAttribute('aria-label','文档页或章节');
 for(const [index,segment]of segments.entries()){const option=el('option',segment.label);option.value=String(index);select.append(option);}label.append(select);
 const scope=el('p'),text=el('pre'),previous=el('button','上一段文字'),next=el('button','继续查看文字');text.className='source-text';previous.type=next.type='button';let offset=0;
 function render(){const segment=segments[Number(select.value)],start=segment.start+offset,end=Math.min(segment.end,start+size);text.textContent=raw.slice(start,end)||'这一区间没有可抽取的文字。';scope.textContent=`保存正文的字符范围 ${start+1}—${end} / ${raw.length}${end<segment.end?'；本页或章节尚有后续文字':''}`;previous.disabled=offset===0;next.disabled=end>=segment.end;}
 select.onchange=()=>{offset=0;render();};previous.onclick=()=>{offset=Math.max(0,offset-size);render();};next.onclick=()=>{offset+=size;render();};
 root.append(label,scope,text,previous,next);render();return root;
}
