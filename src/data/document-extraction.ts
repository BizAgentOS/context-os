import { createHash } from "node:crypto";
export interface DocumentBlock { kind: "page" | "section" | "paragraph" | "table"; start: number; end: number; page?: number; headings?: string[]; }
export interface ExtractedDocument { text: string; blocks: DocumentBlock[]; warnings: string[]; }
export interface DocumentLocation { format: "pdf" | "docx"; pages: number[]; sections: string[]; }
export const MAX_DOCUMENT_TEXT_BYTES = 5_000_000;
export const documentHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function documentLocation(value: unknown, start: number, end: number): DocumentLocation | undefined {
  const file = value as { format?: string; blocks?: DocumentBlock[] } | undefined;
  if (!file || !["pdf", "docx"].includes(file.format ?? "") || !Array.isArray(file.blocks)) return;
  const blocks = file.blocks.filter(block => block.start < end && block.end > start);
  return { format: file.format as "pdf" | "docx", pages: [...new Set(blocks.flatMap(block => block.page ? [block.page] : []))], sections: [...new Set(blocks.flatMap(block => block.headings ?? []))] };
}
