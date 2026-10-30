import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { DocumentFiles } from '../data/document-files.ts';
import { documentLocation } from '../data/document-extraction.ts';
import { claimSchema, mappingSchema, type Claim, type Mapping, type Ontology, validateValue } from './contracts.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export interface SourceContent {
  kind: 'csv' | 'pdf'; text?: string; blocks?: Array<{ kind: string; start: number; end: number; page?: number; headings?: string[] }>;
  rows?: Record<string, string>[]; columns?: string[]; keyColumn?: string; warnings: string[];
}
export interface PreparedSource { hash: string; content: SourceContent; path: string; discard(): Promise<void>; }
export async function prepareCsv(directory: string, text: string, keyColumn: string): Promise<PreparedSource> {
  if (Buffer.byteLength(text) > 5_000_000 || text.includes('\0')) throw new Error('CSV 不能超过 5 MB 或含空字符');
  const matrix = parse(text, { bom: true, skip_empty_lines: true, max_record_size: 100000 }) as string[][];
  const columns = matrix.shift() ?? [];
  if (!columns.length || new Set(columns).size !== columns.length || columns.some(c => !c.trim()) || !columns.includes(keyColumn)) throw new Error('CSV 表头重复、为空或缺少记录主键列');
  if (matrix.length > 10000 || columns.length > 100) throw new Error('第一阶段每次最多 10000 行、100 列');
  const ids = new Set<string>();
  const rows = matrix.map(values => {
    if (values.length !== columns.length) throw new Error('CSV 列数不一致');
    const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
    const id = row[keyColumn];
    if (!id?.trim() || ids.has(id)) throw new Error('CSV 主键为空或重复');
    ids.add(id); return row;
  });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.csv`);
  await writeFile(path, text, { flag: 'wx', mode: 0o600 });
  return { path, hash: fingerprint(text), content: { kind: 'csv', rows, columns, keyColumn, warnings: [] }, discard: () => rm(path, { force: true }) };
}
export async function preparePdf(directory: string, name: string, data: Uint8Array): Promise<PreparedSource> {
  if (!/\.pdf$/i.test(name)) throw new Error('第一阶段文档入口仅接受带文本层 PDF');
  const file = await new DocumentFiles(directory).prepare(name, (async function* () { yield data; })());
  if (file.status !== 'ready') { await file.discard(); throw new Error(String(file.content.parseError)); }
  const metadata = file.content.documentFile as Record<string, any>;
  return { hash: file.signature, path: join(directory, 'documents', String(metadata.file)), content: {
    kind: 'pdf', text: String(file.content.raw), blocks: metadata.blocks, warnings: metadata.warnings,
  }, discard: file.discard };
}
export function locateEvidence(content: SourceContent, ref: Claim['evidence'][number]) {
  if (ref.kind === 'field') {
    if (content.kind !== 'csv' || !content.columns?.includes(ref.field)) throw new Error('字段证据不存在');
    const index = content.rows!.findIndex(row => row[content.keyColumn!] === ref.recordKey);
    if (index < 0) throw new Error('记录证据不存在');
    return { ...ref, row: index + 2, value: content.rows![index][ref.field] };
  }
  if (content.kind !== 'pdf' || !content.text) throw new Error('引文需要文档来源');
  let start = ref.start;
  if (content.text.slice(start, start + ref.quote.length) !== ref.quote) {
    const found = content.text.indexOf(ref.quote);
    if (found < 0 || found !== content.text.lastIndexOf(ref.quote)) throw new Error('引文不存在或无法唯一定位，请核对原文和位置');
    // The host can align a unique verbatim quote; model-generated character arithmetic is not evidence.
    start = found;
  }
  return { ...ref, start, end: start + ref.quote.length, ...(start !== ref.start ? { alignment: 'unique_exact_quote', suppliedStart: ref.start } : {}), unit: 'UTF-16', location: documentLocation({ format: 'pdf', blocks: content.blocks }, start, start + ref.quote.length) };
}
export function validateClaim(ontology: Ontology, claim: Claim) {
  const subject = ontology.types.find(t => t.id === claim.subject.typeId);
  if (!subject) throw new Error('声明主体类型不存在');
  if (claim.object) {
    const link = ontology.links.find(l => l.id === claim.predicate && l.from === subject.id && l.to === claim.object!.typeId);
    if (!link) throw new Error('关系与端点类型不一致');
  } else {
    const property = subject.properties.find(p => p.id === claim.predicate);
    if (!property) throw new Error('属性不属于主体类型');
    validateValue(property, claim.value!);
  }
}
function date(value?: string) {
  if (!value?.trim()) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const iso = `${value}T00:00:00Z`;
    if (new Date(iso).toISOString().slice(0, 10) !== value) throw new Error('日期无效');
    return iso;
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('时间必须显式包含时区');
  return new Date(value).toISOString();
}
export function mapCsv(content: SourceContent, rawMapping: Mapping, ontology: Ontology): { claims: Claim[] } {
  const mapping = mappingSchema.parse(rawMapping);
  if (content.kind !== 'csv') throw new Error('字段映射需要 CSV 来源');
  const type = ontology.types.find(t => t.id === mapping.typeId);
  if (!type) throw new Error('映射对象类型不存在');
  for (const column of [mapping.identityColumn, ...Object.values(mapping.properties), ...mapping.links.map(l => l.column), ...Object.values(mapping.validity ?? {})]) {
    if (!content.columns?.includes(column)) throw new Error(`映射列不存在：${column}`);
  }
  const claims: Claim[] = [];
  for (const row of content.rows ?? []) {
    if (!row[mapping.identityColumn]?.trim()) throw new Error('业务身份列不能缺失');
    const subject = { typeId: type.id, namespace: mapping.namespace, value: row[mapping.identityColumn] };
    const from = date(mapping.validity?.fromColumn ? row[mapping.validity.fromColumn] : undefined);
    const to = date(mapping.validity?.toColumn ? row[mapping.validity.toColumn] : undefined);
    const validity = { from, to, precision: from || to ? 'instant' as const : 'unknown' as const };
    const evidence = (column: string): Claim['evidence'] => [...new Set([column, mapping.identityColumn, ...Object.values(mapping.validity ?? {})])].map(field => ({ kind: 'field', recordKey: row[content.keyColumn!], field }));
    for (const [predicate, column] of Object.entries(mapping.properties)) {
      const property = type.properties.find(p => p.id === predicate);
      if (!property) throw new Error('映射属性不存在');
      const raw = row[column];
      if (!raw.trim() && !property.required) continue;
      let value: string | number | boolean | null = raw;
      if (property.valueType === 'integer') value = Number(raw);
      if (property.valueType === 'boolean') {
        if (!['true', 'false'].includes(raw)) throw new Error('布尔字段必须为 true 或 false');
        value = raw === 'true';
      }
      if (property.valueType === 'datetime') value = date(raw);
      const claim = claimSchema.parse({ subject, predicate, value, validity, evidence: evidence(column) });
      validateClaim(ontology, claim); claims.push(claim);
    }
    for (const link of mapping.links) {
      if (!row[link.column]?.trim()) continue;
      const claim = claimSchema.parse({ subject, predicate: link.predicate, object: { typeId: link.targetType, namespace: link.targetNamespace, value: row[link.column] }, validity, evidence: evidence(link.column) });
      validateClaim(ontology, claim); claims.push(claim);
    }
  }
  return { claims };
}
