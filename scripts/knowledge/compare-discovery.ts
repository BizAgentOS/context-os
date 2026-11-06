import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { configuredModel } from '../../src/knowledge/model.ts';
import { discoveryInput, discoveryCandidateSchema, validateDiscovery, type DiscoverySource, type CatalogEntry } from '../../src/knowledge/discovery.ts';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--report')) {
  const dir = resolve(process.env.CONTEXT_OS_KNOWLEDGE_MODEL_TRACE_DIRECTORY ?? 'local-state/model-traces');
  const rows = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    try {
      const s = JSON.parse(await readFile(join(dir, item.name, 'summary.json'), 'utf8'));
      rows.push({ trace: item.name, sources: (s.sourceKinds ?? []).join('+'), model: s.model, generationStatus: s.status, domainValidation: '见独立校验报告；完成不等于合格', submitted: s.submitted, seconds: s.durationMs / 1000, firstVisibleSeconds: s.firstVisibleResponseMs === null ? null : s.firstVisibleResponseMs / 1000, httpRequests: s.httpRequests ?? null, outputTokens: s.sdkUsageTotals?.outputTokens ?? null, iterations: s.iterations, submissions: s.submissions, rejections: s.rejections, requestBytes: s.requestBytes, inputHash: s.inputHash?.slice(0, 12) });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  console.table(rows);
} else {
  const file = option('--input'), selection = option('--sources');
  if (!file || !['csv', 'csv+pdf'].includes(selection ?? '')) throw new Error('用法：--input 路径/request.json --sources csv|csv+pdf [--run]；--report 查看汇总。没有 --run 只预览，不调用模型。');
  const original = JSON.parse(await readFile(file, 'utf8'));
  if (original.task !== 'discover') throw new Error('仅支持 discover 追踪输入');
  const frozen = JSON.parse(original.input);
  const sources: DiscoverySource[] = frozen.input.sources.filter((s: { kind: string }) => s.kind === 'csv' || selection === 'csv+pdf' && s.kind === 'pdf');
  if (!sources.length) throw new Error('未选中来源');
  // Fixed no-base comparison: do not let earlier model output become later input.
  // New traces contain catalog slices rather than duplicated raw documents. Restore only those shown slices.
  for (const source of sources) {
    source.warnings ??= [];
    if (source.kind === 'csv' && !source.rows && frozen.input.evidenceCatalog) {
      const rows = new Map<string, Record<string, string>>();
      for (const e of frozen.input.evidenceCatalog.filter((e: any) => e.sourceVersionId === source.id && e.kind === 'field')) {
        const row = rows.get(e.recordKey) ?? {}; row[e.field] = e.value; rows.set(e.recordKey, row);
      }
      source.rows = [...rows.values()];
    }
    if (source.kind === 'pdf' && source.text === undefined && frozen.input.evidenceCatalog) {
      let text = '';
      for (const e of frozen.input.evidenceCatalog.filter((e: any) => e.sourceVersionId === source.id && e.kind === 'quote')) {
        if (!Number.isSafeInteger(e.start) || e.start < 0 || e.start > 40000) throw new Error('目录快照缺少有效原文偏移，请使用原始冻结样本');
        text = text.padEnd(e.start, ' '); text = text.slice(0, e.start) + e.text + text.slice(e.start + e.text.length);
      }
      source.text = text;
    }
  }
  const selected = new Set(sources.map(s => s.id));
  const frozenCatalog = frozen.input.evidenceCatalog?.filter((e: any) => selected.has(e.sourceVersionId));
  const prepared = frozenCatalog ? {
    catalog: frozenCatalog.map((e: any): CatalogEntry => ({ id: e.evidenceId, sourceVersionId: e.sourceVersionId, value: e.kind === 'field' ? e.value : e.text, locator: e.kind === 'field' ? { kind: 'field', recordKey: e.recordKey, field: e.field } : { kind: 'quote', quote: e.text, start: e.start } })),
    input: { sources: frozen.input.sources.filter((s: any) => selected.has(s.id)), baseOntology: null, evidenceCatalog: frozenCatalog },
  } : discoveryInput(sources, null);
  const input = prepared.input;
  if (selection === 'csv+pdf' && !sources.some((s: { kind: string }) => s.kind === 'pdf')) throw new Error('冻结输入不包含 PDF，无法做 CSV＋PDF 对比');
  console.log(JSON.stringify({ mode: args.includes('--run') ? '真实调用' : '预览，无调用', sourceVersions: sources.map((s: { id: string; kind: string }) => ({ id: s.id, kind: s.kind })), baseOntology: null }, null, 2));
  if (args.includes('--run')) {
    process.env.CONTEXT_OS_KNOWLEDGE_MODEL_TRACE = '1';
    const model = configuredModel('local-state/knowledge/compare-runtime');
    if (!model) throw new Error('请先配置模型');
    try {
      const raw = await model.generate('discover', input, discoveryCandidateSchema);
      const reportId = randomUUID(), dir = resolve('local-state/model-comparison-validations');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        const result = validateDiscovery(raw, sources, prepared.catalog, null);
        await writeFile(join(dir, `${reportId}.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
        console.log(`结构和目录引用校验通过，业务语义仍需逐项审核；未写入产品本体。报告：${join(dir, `${reportId}.json`)}`);
      } catch (error) {
        await writeFile(join(dir, `${reportId}.json`), JSON.stringify({ schemaValid: true, evidenceValid: false, publishable: false, error: error instanceof Error ? error.message : '领域校验失败' }, null, 2), { mode: 0o600 });
        throw error;
      }
    }
    finally { await model.close(); }
  }
}
