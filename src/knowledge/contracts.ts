import { z } from 'zod';

export const key = z.string().trim().min(1).max(160).regex(/^[\p{L}\p{N}_.:-]+$/u);
const label = z.string().trim().min(1).max(300);
export const scalar = z.union([z.string().max(20000), z.number().finite(), z.boolean(), z.null()]);
export const validitySchema = z.object({
  from: z.string().datetime({ offset: true }).nullable().default(null),
  to: z.string().datetime({ offset: true }).nullable().default(null),
  precision: z.enum(['unknown', 'day', 'instant']).default('unknown'),
}).strict().refine(v => !(v.from && v.to) || Date.parse(v.from) < Date.parse(v.to), '有效区间必须为左闭右开正区间')
  .refine(v => v.precision !== 'unknown' || (!v.from && !v.to), '未知时间不能包含已知边界');
export type Validity = z.infer<typeof validitySchema>;
const comparisonValue = label.refine(v => !/未知|未声明|未标明|未注明|未说明|原文未|不详|未提供|unknown|unspecified|not specified|not stated|n\/a/i.test(v), '缺失口径请省略字段，解释写入审核问题，不能作为业务值');
export const strictComparisonSchema = z.object({
  unit: comparisonValue.refine(v => !['金额', 'amount', 'money'].includes(v.toLowerCase()), '金额不是计量单位').optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, '币种须为已核实的三位大写代码；未知请省略').refine(v => Intl.supportedValuesOf('currency').includes(v), '币种不在当前支持列表，需核实并显式扩展；不能猜测代码').optional(),
  scope: comparisonValue.optional(),
}).strict();
// Keep historical data readable; stricter rules are enforced at write boundaries.
export const comparisonSchema = z.object({ unit: label.optional(), currency: label.optional(), scope: label.optional() }).strict();
export const semanticsSchema = z.object({
  polarity: z.enum(['affirmed', 'negated']).default('affirmed'),
  modality: z.enum(['actual', 'planned', 'hypothetical']).default('actual'),
  condition: z.string().trim().min(1).max(4000).optional(),
}).strict();
export type Semantics = z.infer<typeof semanticsSchema>;
export type Comparison = z.infer<typeof comparisonSchema>;
export function reviewReasons(basis: string, semantics?: Partial<Semantics>) {
  const reasons: string[] = [];
  if (basis === 'inferred') reasons.push('inferred_without_verified_derivation');
  if (semantics?.polarity === 'negated') reasons.push('negative_assertion');
  if (semantics?.modality && semantics.modality !== 'actual') reasons.push(`${semantics.modality}_assertion`);
  if (semantics?.condition) reasons.push('conditional_assertion');
  return reasons;
}
export function requiresReview(basis: string, semantics?: Partial<Semantics>) {
  return reviewReasons(basis, semantics).length > 0;
}
export const propertySchema = z.object({
  id: key, name: label, valueType: z.enum(['string', 'decimal', 'integer', 'boolean', 'datetime', 'enum']),
  required: z.boolean().default(false), multiple: z.boolean().default(false),
  enumValues: z.array(label).max(100).optional(),
  comparison: comparisonSchema.optional(),
  comparisonRequired: z.array(z.enum(['unit', 'currency', 'scope'])).max(3).optional(),
}).strict().refine(p => p.valueType !== 'enum' || !!p.enumValues?.length, '枚举缺少取值');
export const objectTypeSchema = z.object({
  id: key, name: label, description: z.string().max(4000).default(''),
  identityNamespaces: z.array(key).max(20).default([]),
  properties: z.array(propertySchema).max(100),
}).strict();
export const linkSchema = z.object({
  id: key, name: label, from: key, to: key, multiple: z.boolean().default(true),
}).strict();
export const builtinActions = ['CorrectProperty', 'RejectAssertion', 'CorrectValidity', 'PublishOntologyVersion', 'RematchIdentity'] as const;
export const ontologySchema = z.object({
  name: label, types: z.array(objectTypeSchema).min(1).max(100), links: z.array(linkSchema).max(200).default([]),
  actions: z.array(z.enum(builtinActions)).default([...builtinActions]),
  discoveryEvidence: z.array(z.object({ memberId: key, sourceVersionId: z.string().uuid(), locator: z.lazy(() => evidenceInputSchema), originalStart: z.number().int().nonnegative().optional() }).strict()).max(1000).default([]),
}).strict().superRefine((o, ctx) => {
  const ids = new Set<string>();
  for (const member of [...o.types, ...o.types.flatMap(t => t.properties), ...o.links]) {
    if (ids.has(member.id)) ctx.addIssue({ code: 'custom', message: `本体成员编号重复：${member.id}` });
    ids.add(member.id);
  }
  const types = new Set(o.types.map(t => t.id));
  for (const l of o.links) if (!types.has(l.from) || !types.has(l.to)) ctx.addIssue({ code: 'custom', message: '关系端点不存在' });
  for (const e of o.discoveryEvidence) if (!ids.has(e.memberId)) ctx.addIssue({ code: 'custom', message: '本体依据引用不存在的成员' });
});
export type Ontology = z.infer<typeof ontologySchema>;
export type Scalar = z.infer<typeof scalar>;
export const identitySchema = z.object({ typeId: key, namespace: key, value: label }).strict();
export const evidenceInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('field'), recordKey: label, field: label }).strict(),
  z.object({ kind: z.literal('quote'), quote: z.string().min(1).max(20000), start: z.number().int().nonnegative() }).strict(),
]);
export const claimSchema = z.object({
  subject: identitySchema, predicate: key,
  value: scalar.optional(), object: identitySchema.optional(),
  validity: validitySchema.default({ from: null, to: null, precision: 'unknown' }),
  evidence: z.array(evidenceInputSchema).min(1).max(20),
  basis: z.enum(['explicit', 'inferred']).default('explicit'),
  semantics: semanticsSchema.default({ polarity: 'affirmed', modality: 'actual' }),
  comparison: comparisonSchema.default({}),
}).strict().refine(c => (c.value !== undefined) !== (c.object !== undefined), '声明必须且只能有标量值或对象引用');
export type Claim = z.infer<typeof claimSchema>;
export const extractionSchema = z.object({ claims: z.array(claimSchema).max(2000) }).strict();
export const mappingSchema = z.object({
  typeId: key, namespace: key, identityColumn: label,
  properties: z.record(key, label),
  links: z.array(z.object({ predicate: key, column: label, targetType: key, targetNamespace: key }).strict()).default([]),
  validity: z.object({ fromColumn: label.optional(), toColumn: label.optional() }).strict().optional(),
  comparisons: z.record(key, comparisonSchema).default({}),
}).strict();
export type Mapping = z.infer<typeof mappingSchema>;
export const actionSchema = z.object({
  operationId: key, kind: z.enum(builtinActions), targetId: z.string().uuid(), expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(4000), predicate: key.optional(), value: scalar.optional(),
  validity: validitySchema.optional(), duration: z.enum(['until_revoked', 'source_version']).optional(),
  sourceVersionId: z.string().uuid().optional(),
  comparison: comparisonSchema.optional(),
  evidence: z.array(z.object({ sourceVersionId: z.string().uuid(), locator: evidenceInputSchema }).strict()).max(20).optional(),
  identity: identitySchema.optional(), newObjectId: z.string().uuid().optional(),
  expectedTargetRevision: z.number().int().positive().optional(),
  assertionIds: z.array(z.string().uuid()).min(1).max(200).optional(),
}).strict().superRefine((action, ctx) => {
  if (action.evidence?.length && !['CorrectProperty', 'CorrectValidity'].includes(action.kind)) ctx.addIssue({ code: 'custom', message: '本次操作不支持修正证据参数' });
  if (action.comparison && action.kind !== 'CorrectProperty') ctx.addIssue({ code: 'custom', message: '比较口径仅用于属性修正' });
  if (action.kind !== 'RematchIdentity' && (action.identity || action.newObjectId || action.expectedTargetRevision || action.assertionIds)) ctx.addIssue({ code: 'custom', message: '身份参数仅用于身份纠错' });
});
export type Action = z.infer<typeof actionSchema>;
export interface Principal { id: string; role: 'admin' | 'editor' | 'viewer'; }
export class AccessDenied extends Error {}
export function authorize(actor: Principal, write = false) {
  if (!actor.id || !['admin', 'editor', 'viewer'].includes(actor.role) || write && actor.role === 'viewer') throw new AccessDenied('没有执行此操作的权限');
}
export function validateValue(property: Ontology['types'][number]['properties'][number], value: Scalar) {
  if (value === null) { if (property.required) throw new Error('必填属性不能为 null'); return; }
  if (property.required && typeof value === 'string' && !value.trim()) throw new Error('必填属性不能为空');
  const type = property.valueType;
  const ok = type === 'decimal' ? typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)
    : type === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value)
    : type === 'boolean' ? typeof value === 'boolean'
    : type === 'datetime' ? typeof value === 'string' && z.string().datetime({ offset: true }).safeParse(value).success
    : type === 'enum' ? typeof value === 'string' && property.enumValues?.includes(value)
    : typeof value === 'string';
  if (!ok) throw new Error(`属性 ${property.id} 的值不符合 ${type} 类型`);
}
