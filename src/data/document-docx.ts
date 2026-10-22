import { Open, type File as ZipEntry } from "unzipper";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { MAX_DOCUMENT_TEXT_BYTES, type ExtractedDocument } from "./document-extraction.ts";

const WORD = new Set(["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"]);
const attribute = (tag: SaxesTagNS, name: string) => Object.values(tag.attributes).find(item => item.local === name)?.value;
type Handlers = { open?: (tag: SaxesTagNS) => void; close?: (tag: SaxesTagNS) => void; text?: (text: string) => void };
async function xml(entry: ZipEntry, handlers: Handlers) {
  const parser = new SaxesParser({ xmlns: true }), decoder = new TextDecoder("utf8", { fatal: true }), stream = entry.stream(); let bytes = 0;
  parser.on("doctype", () => { throw new Error("DOCX 不支持外部 XML 定义"); });
  parser.on("opentag", tag => { if (WORD.has(tag.uri)) handlers.open?.(tag); });
  parser.on("closetag", tag => { if (WORD.has(tag.uri)) handlers.close?.(tag); });
  parser.on("text", text => handlers.text?.(text));
  try {
    for await (const chunk of stream) { bytes += (chunk as Buffer).length; if (bytes > 50_000_000 || bytes > entry.uncompressedSize) throw new Error("DOCX 正文 XML 展开超过 50 MB 或声明范围"); parser.write(decoder.decode(chunk, { stream: true })); }
    parser.write(decoder.decode()); parser.close();
  } finally { stream.destroy(); }
}

async function headings(entry?: ZipEntry) {
  const styles = new Map<string, { basedOn?: string; level?: number }>(); let current: { id: string; basedOn?: string; level?: number } | undefined;
  if (entry) await xml(entry, {
    open(tag) {
      if (tag.local === "style") current = { id: attribute(tag, "styleId") ?? "" };
      if (current && tag.local === "basedOn") current.basedOn = attribute(tag, "val");
      if (current && tag.local === "outlineLvl") { const value = Number(attribute(tag, "val")); if (Number.isInteger(value) && value >= 0 && value <= 8) current.level = value + 1; }
    },
    close(tag) { if (tag.local === "style" && current) { styles.set(current.id, current); current = undefined; } },
  });
  return (id: string) => {
    let next: string | undefined = id; const visited = new Set<string>();
    while (next && !visited.has(next) && visited.size < 20) {
      visited.add(next); const style = styles.get(next); if (style?.level) return style.level;
      const builtIn = /^Heading([1-9])$/i.exec(next); if (builtIn) return Number(builtIn[1]);
      next = style?.basedOn;
    }
    return undefined;
  };
}

export async function extractDocx(file: string): Promise<ExtractedDocument> {
  let zip;
  try { zip = await Open.file(file); } catch { throw new Error("DOCX 压缩包损坏或格式无效"); }
  if (zip.files.length > 10000 || zip.files.reduce((sum, item) => sum + item.uncompressedSize, 0) > 500_000_000) throw new Error("DOCX 展开内容超过处理范围，请拆分后上传");
  const names = zip.files.map(entry => entry.path);
  if (new Set(names).size !== names.length || names.some(name => /(^|\/)\.\.(\/|$)|\\|^\//.test(name))) throw new Error("DOCX 包含无效或重复的文件路径");
  const main = zip.files.find(entry => entry.path === "word/document.xml");
  if (!main || !names.includes("[Content_Types].xml")) throw new Error("文件不是支持的 DOCX 文档");
  const levelOf = await headings(zip.files.find(entry => entry.path === "word/styles.xml"));
  let text = "", paragraph: { text: string; style?: string; level?: number } | undefined, reading = false, deleted = 0, body = false;
  const path: string[] = [], blocks: ExtractedDocument["blocks"] = [], tables: Array<{ rows: string[]; cells: string[]; paragraphs: string[] }> = [];
  function append(kind: "section" | "paragraph" | "table", value: string) {
    if (!value.trim()) return;
    if (text) text += "\n\n";
    const start = text.length; text += value;
    if (Buffer.byteLength(text) > MAX_DOCUMENT_TEXT_BYTES) throw new Error("抽取正文超过 5 MB，请拆分文档后上传；未截断正文");
    if (blocks.length >= 20000) throw new Error("文档超过 20000 个正文段落，请拆分后上传");
    blocks.push({ kind, start, end: text.length, ...(path.length ? { headings: path.filter(Boolean) } : {}) });
  }
  await xml(main, {
    open(tag) {
      if (tag.local === "body") body = true;
      if (!body) return;
      if (tag.local === "del") { deleted++; return; } if (deleted) return;
      if (tag.local === "tbl") tables.push({ rows: [], cells: [], paragraphs: [] });
      if (tag.local === "tr" && tables.length) tables.at(-1)!.cells = [];
      if (tag.local === "tc" && tables.length) tables.at(-1)!.paragraphs = [];
      if (tag.local === "p") paragraph = { text: "" };
      if (paragraph && tag.local === "pStyle") paragraph.style = attribute(tag, "val");
      if (paragraph && tag.local === "outlineLvl") { const level = Number(attribute(tag, "val")); if (Number.isInteger(level) && level >= 0 && level <= 8) paragraph.level = level + 1; }
      if (paragraph && tag.local === "t") reading = true;
      if (paragraph && tag.local === "tab") paragraph.text += "\t";
      if (paragraph && ["br", "cr"].includes(tag.local)) paragraph.text += "\n";
    },
    text(value) { if (reading && paragraph && !deleted) paragraph.text += value; },
    close(tag) {
      if (tag.local === "del") { deleted--; return; } if (!body || deleted) return;
      if (tag.local === "t") reading = false;
      if (tag.local === "p" && paragraph) {
        const value = paragraph.text.trim(), table = tables.at(-1), level = paragraph.level ?? levelOf(paragraph.style ?? "");
        if (table) table.paragraphs.push(value);
        else if (level && value) { path.length = level - 1; path[level - 1] = value; append("section", value); }
        else append("paragraph", value);
        paragraph = undefined;
      }
      if (tag.local === "tc" && tables.length) tables.at(-1)!.cells.push(tables.at(-1)!.paragraphs.join("\n"));
      if (tag.local === "tr" && tables.length) tables.at(-1)!.rows.push(tables.at(-1)!.cells.join("\t"));
      if (tag.local === "tbl" && tables.length) { const value = tables.pop()!.rows.join("\n"); if (tables.length) tables.at(-1)!.paragraphs.push(value); else append("table", value); }
      if (tag.local === "body") body = false;
    },
  });
  if (!text.trim()) throw new Error("未检出可抽取的 DOCX 正文，纯图片文档暂不支持；没有进行 OCR");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(text)) throw new Error("DOCX 正文包含无效文本，无法可靠保存引用");
  return { text, blocks, warnings: ["抽取正文段落与表格；图片、页眉页脚和批注不作为正文，没有进行 OCR。"] };
}
