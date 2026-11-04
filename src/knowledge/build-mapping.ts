import { claimSchema, validitySchema, type Claim, type Ontology } from './contracts.ts';
import { z } from 'zod';
import { csvPlanSchema, itemKey, type CsvPlan, type PlanReview } from './build-contracts.ts';
import { validateClaim, type SourceContent } from './sources.ts';

function failure(error: unknown) {
  return error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.') || '声明'}：${i.code}`).join('；') : error instanceof Error ? error.message : '映射校验失败';
}
function iso(raw: string, content?: SourceContent, field?: string, datetimeOffset?: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const value = `${raw}T00:00:00.000Z`;
    if (new Date(value).toISOString().slice(0, 10) !== raw) throw new Error('业务日期无效');
    return value;
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(raw)) {
    if (content?.kind !== 'table' || !field) throw new Error('日期时间缺少时区，需使用带时区的 ISO 表示');
    const columns = content.metadata?.columns as Array<{name:string;type:string}> | undefined;
    const type = columns?.find(c => c.name === field)?.type ?? '';
    // The native MySQL reader fixes its session to UTC before reading TIMESTAMP columns.
    const offset = /^timestamp\b/i.test(type) ? '+00:00' : datetimeOffset;
    if (!offset) throw new Error('这是正常的 MySQL 本地日期时间，但未声明时区；请在计划中填写 DATETIME 时区偏移，不根据服务器所在地猜测');
    raw = raw.replace(' ', 'T') + offset;
  }
  const parsed = validitySchema.safeParse({ from: raw, precision: 'instant' });
  if (!parsed.success) throw new Error('无法解析日期时间；需有效日期及明确时区（耗时或未声明单位的数值不能直接当作日期）');
  const value = parsed.data.from!;
  return new Date(value).toISOString();
}
function validity(time: CsvPlan['properties'][number]['time'], row: Record<string, string>, content: SourceContent, datetimeOffset?: string) {
  const columns = content.columns!;
  if (time.mode === 'unknown') {
    if (time.fromColumn || time.toColumn || time.from || time.to) throw new Error('未知时间不能携带时间绑定');
    return validitySchema.parse({});
  }
  if (!time.reason.trim()) throw new Error('已知时间必须说明属于该属性或关系的依据');
  if (time.mode === 'columns') {
    if (time.from || time.to || !(time.fromColumn || time.toColumn)) throw new Error('时间列绑定不完整或混入常量');
    for (const column of [time.fromColumn, time.toColumn].filter((v): v is string => !!v)) if (!columns.includes(column)) throw new Error(`时间列不存在：${column}`);
  } else if (time.fromColumn || time.toColumn || !(time.from || time.to)) throw new Error('固定时间绑定不完整或混入列');
  const from = time.mode === 'columns' ? row[time.fromColumn ?? ''] : time.from;
  const to = time.mode === 'columns' ? row[time.toColumn ?? ''] : time.to;
  const boundary = (value: string | undefined, field: string | undefined, label: string) => {
    if (!value?.trim()) return null;
    try { return iso(value.trim(), content, field, datetimeOffset); }
    catch(error) { throw new Error(`${label}${field ? `（来源字段 ${field}）` : '（固定值）'}：${failure(error)}`); }
  };
  const start = boundary(from, time.mode === 'columns' ? time.fromColumn : undefined, '有效起点 from');
  const end = boundary(to, time.mode === 'columns' ? time.toColumn : undefined, '有效终点 to');
  if (start && end && Date.parse(start) >= Date.parse(end)) throw new Error(`日期格式可解析，但有效区间起点不早于终点（起点：${time.fromColumn ?? '固定值'}；终点：${time.toColumn ?? '固定值'}）；当前要求左闭右开的正区间`);
  return validitySchema.parse({ from: start, to: end, precision: start || end ? 'instant' : 'unknown' });
}

/** One row, many objects and explicit endpoints; no user code or SQL is evaluated. */
export function compileCsvPlan(content: SourceContent, raw: unknown, ontology: Ontology, namespace: string, review?: PlanReview) {
  const plan = csvPlanSchema.parse(raw);
  if (!['csv', 'table'].includes(content.kind)) throw new Error('结构化绑定只支持 CSV 文件或数据库表来源');
  const ids = [...plan.objects, ...plan.properties, ...plan.links].map(v => v.id);
  if (new Set(ids).size !== ids.length) throw new Error('同一来源的绑定编号必须唯一');
  const included = (kind: string, id: string) => review?.items[itemKey(plan.sourceVersionId, kind, id)]?.include !== false;
  const objects = new Map(plan.objects.filter(o => included('object', o.id)).map(o => [o.id, o]));
  for (const obj of objects.values()) {
    if (!ontology.types.some(t => t.id === obj.typeId)) throw new Error('对象绑定类型不存在');
    if (!content.columns?.includes(obj.identityColumn)) throw new Error(`身份列不存在：${obj.identityColumn}`);
  }
  const properties = plan.properties.filter(p => included('property', p.id));
  const links = plan.links.filter(p => included('link', p.id));
  const claims: Claim[] = [];
  for (const row of content.rows ?? []) {
    const identity = (id: string) => {
      const obj = objects.get(id);
      if (!obj) throw new Error('声明引用了缺失或已排除的对象绑定');
      const value = row[obj.identityColumn];
      if (!value?.trim()) throw new Error('身份列存在空编号，请排除或修复对应绑定');
      return { typeId: obj.typeId, namespace, value };
    };
    const evidence = (fields: string[]): Claim['evidence'] => [...new Set(fields)].map(field => {
      if (!content.columns?.includes(field)) throw new Error(`映射列不存在：${field}`);
      return { kind: 'field', recordKey: row[content.keyColumn!], field };
    });
    for (const binding of properties) {
      try {
      const subject = identity(binding.object);
      const property = ontology.types.find(t => t.id === subject.typeId)?.properties.find(p => p.id === binding.predicate);
      if (!property) throw new Error('属性绑定不属于主体类型');
      if (!content.columns?.includes(binding.column)) throw new Error(`映射列不存在：${binding.column}`);
      const raw = row[binding.column];
      if (content.kind === 'table' && content.nativeValues?.[row[content.keyColumn!]]?.[binding.column] === null) {
        if (property.required) throw new Error('必填属性为 SQL NULL，不能转为空字符串');
        continue;
      }
      if (!raw.trim() && !property.required) continue;
      let value: string | number | boolean | null = raw;
      if (property.valueType === 'integer') { if (!/^-?\d+$/.test(raw)) throw new Error('整数列无效'); value = Number(raw); }
      if (property.valueType === 'boolean') { if (!['true', 'false'].includes(raw)) throw new Error('布尔列必须为 true 或 false'); value = raw === 'true'; }
      if (property.valueType === 'datetime') { if (content.kind === 'table' && /^0000-|^\d{4}-00-|^\d{4}-\d{2}-00/.test(raw)) { if (property.required) throw new Error('必填日期为来源零值，无法作为业务时间'); continue; } if (!binding.meaning.trim()) throw new Error('日期属性必须说明日期所属业务含义，不能误用关系结束时间'); value = iso(raw, content, binding.column, review?.datetimeOffset); }
      const claim = claimSchema.parse({ subject, predicate: binding.predicate, value, comparison: binding.comparison, validity: validity(binding.time, row, content, review?.datetimeOffset), evidence: evidence([objects.get(binding.object)!.identityColumn, binding.column, ...[binding.time.fromColumn, binding.time.toColumn].filter((v): v is string => !!v)]) });
      validateClaim(ontology, claim); claims.push(claim);
      } catch(error) { throw new Error(`属性绑定 ${binding.id} / ${binding.predicate}（取值列 ${binding.column}）：${failure(error)}`); }
    }
    for (const binding of links) {
      try {
      const claim = claimSchema.parse({ subject: identity(binding.from), predicate: binding.predicate, object: identity(binding.to), validity: validity(binding.time, row, content, review?.datetimeOffset), evidence: evidence([objects.get(binding.from)!.identityColumn, objects.get(binding.to)!.identityColumn, ...[binding.time.fromColumn, binding.time.toColumn].filter((v): v is string => !!v)]) });
      validateClaim(ontology, claim); claims.push(claim);
      } catch(error) { throw new Error(`关系绑定 ${binding.id} / ${binding.predicate}：${failure(error)}`); }
    }
    if (claims.length > 2000) throw new Error('首期每个来源最多构建 2000 条声明，请缩小来源范围');
  }
  return { claims };
}
