import { claimSchema, validitySchema, type Claim, type Ontology } from './contracts.ts';
import { csvPlanSchema, itemKey, type CsvPlan, type PlanReview } from './build-contracts.ts';
import { validateClaim, type SourceContent } from './sources.ts';

function iso(raw: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const value = `${raw}T00:00:00.000Z`;
    if (new Date(value).toISOString().slice(0, 10) !== raw) throw new Error('业务日期无效');
    return value;
  }
  const value = validitySchema.parse({ from: raw, precision: 'instant' }).from!;
  return new Date(value).toISOString();
}
function validity(time: CsvPlan['properties'][number]['time'], row: Record<string, string>, columns: string[]) {
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
  return validitySchema.parse({ from: from?.trim() ? iso(from.trim()) : null, to: to?.trim() ? iso(to.trim()) : null, precision: from?.trim() || to?.trim() ? 'instant' : 'unknown' });
}

/** One row, many objects and explicit endpoints; no user code or SQL is evaluated. */
export function compileCsvPlan(content: SourceContent, raw: unknown, ontology: Ontology, namespace: string, review?: PlanReview) {
  const plan = csvPlanSchema.parse(raw);
  if (content.kind !== 'csv') throw new Error('CSV 绑定只能用于 CSV 来源');
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
      const subject = identity(binding.object);
      const property = ontology.types.find(t => t.id === subject.typeId)?.properties.find(p => p.id === binding.predicate);
      if (!property) throw new Error('属性绑定不属于主体类型');
      if (!content.columns?.includes(binding.column)) throw new Error(`映射列不存在：${binding.column}`);
      const raw = row[binding.column];
      if (!raw.trim() && !property.required) continue;
      let value: string | number | boolean | null = raw;
      if (property.valueType === 'integer') { if (!/^-?\d+$/.test(raw)) throw new Error('整数列无效'); value = Number(raw); }
      if (property.valueType === 'boolean') { if (!['true', 'false'].includes(raw)) throw new Error('布尔列必须为 true 或 false'); value = raw === 'true'; }
      if (property.valueType === 'datetime') { if (!binding.meaning.trim()) throw new Error('日期属性必须说明日期所属业务含义，不能误用关系结束时间'); value = iso(raw); }
      const claim = claimSchema.parse({ subject, predicate: binding.predicate, value, comparison: binding.comparison, validity: validity(binding.time, row, content.columns!), evidence: evidence([objects.get(binding.object)!.identityColumn, binding.column, ...[binding.time.fromColumn, binding.time.toColumn].filter((v): v is string => !!v)]) });
      validateClaim(ontology, claim); claims.push(claim);
    }
    for (const binding of links) {
      const claim = claimSchema.parse({ subject: identity(binding.from), predicate: binding.predicate, object: identity(binding.to), validity: validity(binding.time, row, content.columns!), evidence: evidence([objects.get(binding.from)!.identityColumn, objects.get(binding.to)!.identityColumn, ...[binding.time.fromColumn, binding.time.toColumn].filter((v): v is string => !!v)]) });
      validateClaim(ontology, claim); claims.push(claim);
    }
    if (claims.length > 2000) throw new Error('首期每个来源最多构建 2000 条声明，请缩小来源范围');
  }
  return { claims };
}
