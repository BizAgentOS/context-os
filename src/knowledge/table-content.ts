import type { Sql } from './database.ts';
import type { SourceContent } from './sources.ts';

export const TABLE_RECORD_KEY = '__context_record_key';
/** Source versions store a bounded manifest; rows live separately, never in its JSONB. */
export async function sourceContent(sql: Sql, id: string, content: SourceContent, limit?: number, keys?: string[]): Promise<SourceContent> {
  if (content.kind !== 'table') return content;
  const take = limit ?? 100001;
  const result = await sql.query<{ record_key: string; values: Record<string, string | null> }>(
    'SELECT record_key,values FROM knowledge.source_records WHERE source_version_id=$1 AND ($3::text[] IS NULL OR record_key=ANY($3)) ORDER BY ordinal LIMIT $2', [id, take, keys ?? null]);
  if (limit === undefined && result.rows.length > 100000) throw new Error('表记录超过当前执行预算，请配置更小的授权范围');
  return { ...content, nativeValues: Object.fromEntries(result.rows.map(r => [r.record_key, r.values])), keyColumn: TABLE_RECORD_KEY, rows: result.rows.map(r => ({ ...Object.fromEntries(Object.entries(r.values).map(([k,v]) => [k,v ?? ''])), [TABLE_RECORD_KEY]: r.record_key })) };
}
