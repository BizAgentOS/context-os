import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { spawn } from "node:child_process";
import type { Data } from "../agent/contracts.ts";
import { documentHash, type ExtractedDocument } from "./document-extraction.ts";

export const MAX_DOCUMENT_FILE_BYTES = 100_000_000;
export interface PreparedDocument { name: string; status: string; content: Data; signature: string; discard(): Promise<void>; }

/** Parsing is isolated from the HTTP host and never receives model or source credentials. */
function extract(file: string, format: string): Promise<ExtractedDocument> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(["PATH", "SYSTEMROOT", "TMPDIR", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    const child = spawn(process.execPath, ["--max-old-space-size=384", fileURLToPath(new URL("./document-extract-worker.ts", import.meta.url)), file, format], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", size = 0, failure: Error | undefined;
    const stop = (message: string) => { failure ??= new Error(message); child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop("文档解析超过 60 秒，请拆分后重试"), 60000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { size += Buffer.byteLength(chunk); if (size > 16_000_000) stop("文档解析结果超出范围，请拆分后重试"); else output += chunk; });
    child.stderr.resume();
    child.on("error", () => { failure ??= new Error("文档解析进程无法启动"); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error("文档解析失败或超出处理资源，请检查文件或拆分后重试"));
      try { const reply = JSON.parse(output); if (!reply.ok) throw new Error(reply.error); resolve(reply.result); }
      catch (error) { reject(error instanceof SyntaxError ? new Error("文档解析返回无效结果") : error); }
    });
  });
}

export class DocumentFiles {
  private directory: string;
  constructor(directory: string) { this.directory = join(directory, "documents"); }
  async prepare(name: string, input: AsyncIterable<Uint8Array>): Promise<PreparedDocument> {
    if (typeof name !== "string" || !name || name.length > 180 || /[\\/\u0000-\u001f]/.test(name) || !/\.(pdf|docx)$/i.test(name)) throw new Error("请选择 PDF 或 DOCX 文档文件");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = randomUUID() + ".original", file = join(this.directory, filename), out = createWriteStream(file, { flags: "wx", mode: 0o600 }), done = finished(out);
    void done.catch(() => {});
    const hash = createHash("sha256"); let bytes = 0;
    try {
      for await (const chunk of input) { bytes += chunk.byteLength; if (bytes > MAX_DOCUMENT_FILE_BYTES) throw new Error("文档文件不能超过 100 MB"); hash.update(chunk); if (!out.write(chunk)) await once(out, "drain"); }
      out.end(); await done; if (!bytes) throw new Error("文档文件为空");
      const signature = hash.digest("hex"), format = name.toLowerCase().endsWith(".pdf") ? "pdf" : "docx";
      let result: ExtractedDocument = { text: "", blocks: [], warnings: [] }, parseError: string | undefined;
      try { result = await extract(file, format); } catch (error) { parseError = (error as Error).message; }
      return { name, signature, status: parseError ? "failed" : "ready", content: { origin: "upload", format: "text", raw: result.text, hash: documentHash(result.text),
        documentFile: JSON.parse(JSON.stringify({ format, file: filename, hash: signature, bytes, blocks: result.blocks, warnings: result.warnings, extractor: "ade-document-v1" })), ...(parseError ? { parseError } : {}) }, discard: () => rm(file, { force: true }) };
    } catch (error) { out.destroy(); await done.catch(() => {}); await rm(file, { force: true }); throw error; }
  }
}
