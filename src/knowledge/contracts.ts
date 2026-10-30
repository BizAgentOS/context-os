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
export const propertySchema = z.object({
  id: key, name: label, valueType: z.enum(['string', 'decimal', 'integer', 'boolean', 'datetime', 'enum']),
  required: z.boolean().default(false), multiple: z.boolean().default(false),
  enumValues: z.array(label).max(100).optional(),
}).strict().refine(p => p.valueType !== 'enum' || !!p.enumValues?.length, '枚举缺少取值');
export const objectTypeSchema = z.object({
  id: key, name: label, description: z.string().max(4000).default(''),
  identityNamespaces: z.array(key).max(20).default([]),
  properties: z.array(propertySchema).min(1).max(100),
}).strict();
export const linkSchema = z.object({
  id: key, name: label, from: key, to: key, multiple: z.boolean().default(true),
}).strict();
export const builtinActions = ['CorrectProperty', 'RejectAssertion', 'CorrectValidity', 'PublishOntologyVersion'] as const;
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
}).strict().refine(c => (c.value !== undefined) !== (c.object !== undefined), '声明必须且只能有标量值或对象引用');
export type Claim = z.infer<typeof claimSchema>;
export const extractionSchema = z.object({ claims: z.array(claimSchema).max(2000) }).strict();
export const mappingSchema = z.object({
  typeId: key, namespace: key, identityColumn: label,
  properties: z.record(key, label),
  links: z.array(z.object({ predicate: key, column: label, targetType: key, targetNamespace: key }).strict()).default([]),
  validity: z.object({ fromColumn: label.optional(), toColumn: label.optional() }).strict().optional(),
}).strict();
export type Mapping = z.infer<typeof mappingSchema>;
export const actionSchema = z.object({
  operationId: key, kind: z.enum(builtinActions), targetId: z.string().uuid(), expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(4000), predicate: key.optional(), value: scalar.optional(),
  validity: validitySchema.optional(), duration: z.enum(['until_revoked', 'source_version']).optional(),
  sourceVersionId: z.string().uuid().optional(),
}).strict();
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
