import { crc32 } from "node:zlib";

/** Small authored PDF fixtures; offsets are byte offsets in the finished PDF, not parser output. */
export function textPdf(pages: string[], bookmarks: Array<{title:string;page:number}>=[]) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (const [index, text] of pages.entries()) {
    const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, value => "\\" + value)}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  if(bookmarks.length){
    const root=objects.length+1,first=root+1;
    objects[0]=`<< /Type /Catalog /Pages 2 0 R /Outlines ${root} 0 R >>`;
    objects.push(`<< /Type /Outlines /First ${first} 0 R /Last ${first+bookmarks.length-1} 0 R /Count ${bookmarks.length} >>`);
    for(const [index,item] of bookmarks.entries())objects.push(`<< /Title (${item.title}) /Parent ${root} 0 R /Dest [${4+(item.page-1)*2} 0 R /Fit]${index?` /Prev ${first+index-1} 0 R`:""}${index+1<bookmarks.length?` /Next ${first+index+1} 0 R`:""} >>`);
  }
  let body = "%PDF-1.4\n"; const positions = [0];
  for (const [index, object] of objects.entries()) { positions.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${positions.slice(1).map(position => `${String(position).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

export async function* fileChunks(bytes: Buffer) { for (let offset = 0; offset < bytes.length; offset += 127) yield bytes.subarray(offset, offset + 127); }

export function documentZip(entries: Record<string, string>) {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [path, text] of Object.entries(entries)) {
    const name = Buffer.from(path), bytes = Buffer.from(text), crc = crc32(bytes), header = Buffer.alloc(30), index = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt32LE(crc, 16); index.writeUInt32LE(bytes.length, 20); index.writeUInt32LE(bytes.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(index, name); offset += header.length + name.length + bytes.length;
  }
  const end = Buffer.alloc(22), directory = Buffer.concat(central); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export function textDocx(strict = false) {
  const entries = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "word/styles.xml": '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="hOne"><w:name w:val="一级标题"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>',
    "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="hOne"/></w:pPr><w:r><w:t>客户定义</w:t></w:r></w:p><w:p><w:r><w:t>客户指签订有效合同的企业。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>等级</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>金牌</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>后续说明。</w:t></w:r></w:p></w:body></w:document>',
  };
  return documentZip(Object.fromEntries(Object.entries(entries).map(([path, value]) => [path, strict ? value.replaceAll("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main") : value])));
}
