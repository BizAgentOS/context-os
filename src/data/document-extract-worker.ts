import { readFile } from "node:fs/promises";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { MAX_DOCUMENT_TEXT_BYTES, type ExtractedDocument } from "./document-extraction.ts";
import { extractDocx } from "./document-docx.ts";

async function sections(document: PDFDocumentProxy) {
  const byPage = new Map<number, string[]>(), warnings: string[] = []; let count = 0;
  async function walk(items: NonNullable<Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>>, parents: string[], depth: number) {
    if (depth > 20) throw new Error("PDF 书签层级超过 20 层");
    for (const item of items) {
      if (++count > 20000) throw new Error("PDF 书签超过 20000 项");
      const headings = [...parents, item.title].filter(Boolean);
      const dest = typeof item.dest === "string" ? await document.getDestination(item.dest) : item.dest;
      if (Array.isArray(dest) && dest.length) {
        const page = (typeof dest[0] === "number" ? dest[0] : await document.getPageIndex(dest[0])) + 1;
        if (page >= 1 && page <= document.numPages) byPage.set(page, [...new Set([...(byPage.get(page) ?? []), ...headings])]);
      }
      if (item.items.length) await walk(item.items, headings, depth + 1);
    }
  }
  try { const outline = await document.getOutline(); if (outline?.length) { await walk(outline, [], 1); warnings.push("PDF 章节由书签按页定位，同页多个章节不代表引文已精确归属某一节。"); } }
  catch { byPage.clear(); warnings.push("PDF 书签无法完整解析，正文仅按页码定位。"); }
  return { byPage, warnings };
}

async function pdf(file: string): Promise<ExtractedDocument> {
  const loading = getDocument({ data: new Uint8Array(await readFile(file)), useSystemFonts: false, disableFontFace: true, enableXfa: false, useWorkerFetch: false, verbosity: 0 });
  let document;
  try {
    document = await loading.promise;
    if (document.numPages > 2000) throw new Error("PDF 超过 2000 页，请拆分后上传");
    const outline = await sections(document);
    let text = "", headings: string[] = []; const blocks: ExtractedDocument["blocks"] = [], empty: number[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      headings = outline.byPage.get(number) ?? headings;
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        const body = content.items.flatMap(item => "str" in item ? [item.str + (item.hasEOL ? "\n" : " ")] : []).join("").trim();
        if (!body) { empty.push(number); continue; }
        if (text) text += "\n\n";
        const start = text.length; text += body; blocks.push({ kind: "page", page: number, start, end: text.length, ...(headings.length ? { headings } : {}) });
        if (Buffer.byteLength(text) > MAX_DOCUMENT_TEXT_BYTES) throw new Error("抽取正文超过 5 MB，请拆分文档后上传；未截断正文");
      } finally { page.cleanup(); }
    }
    if (!text.trim()) throw new Error("未检出可抽取的正文，扫描件或纯图片 PDF 暂不支持；请提供带文本层的文件");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(text)) throw new Error("PDF 正文包含无效文本，无法可靠保存引用");
    return { text, blocks, warnings: [...outline.warnings, ...(empty.length ? [`${empty.length} 页未检出正文，可能是空白页或图片；没有进行 OCR。页码：${empty.slice(0, 30).join("、")}${empty.length > 30 ? "…" : ""}`] : [])] };
  } catch (error) {
    if ((error as Error).name === "PasswordException") throw new Error("PDF 已加密，请提供解除密码保护的副本");
    if ((error as Error).name === "InvalidPDFException") throw new Error("PDF 文件损坏或格式无效，无法抽取正文");
    throw error;
  } finally { await loading.destroy(); }
}

try {
  const [file, format] = process.argv.slice(2);
  if (!["pdf", "docx"].includes(format)) throw new Error("暂不支持此文档格式");
  process.stdout.write(JSON.stringify({ ok: true, result: format === "pdf" ? await pdf(file) : await extractDocx(file) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String((error as Error).message).slice(0, 1000) }));
}
