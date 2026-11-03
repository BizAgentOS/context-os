import { z } from 'zod';
import { key, claimSchema, comparisonSchema } from './contracts.ts';

export const planTimeSchema = z.object({
  mode: z.enum(['unknown', 'columns', 'fixed']).default('unknown'),
  fromColumn: z.string().min(1).optional(), toColumn: z.string().min(1).optional(),
  from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
  reason: z.string().max(4000).default(''),
}).strict();
export const csvPlanSchema = z.object({
  sourceVersionId: z.string().uuid(),
  objects: z.array(z.object({ id: key, typeId: key, identityColumn: z.string().min(1) }).strict()).min(1).max(100),
  properties: z.array(z.object({ id: key, object: key, predicate: key, column: z.string().min(1), time: planTimeSchema.default({ mode: 'unknown', reason: '' }), comparison: comparisonSchema.default({}), meaning: z.string().max(4000).default('') }).strict()).max(200),
  links: z.array(z.object({ id: key, predicate: key, from: key, to: key, time: planTimeSchema.default({ mode: 'unknown', reason: '' }) }).strict()).max(200),
}).strict();
export const planProposalSchema = z.object({
  csv: z.array(csvPlanSchema).max(10).default([]),
  documents: z.array(z.object({ sourceVersionId: z.string().uuid(), claims: z.array(z.object({
    claim: claimSchema, timeExplanation: z.string().max(4000).default(''),
    timeEvidenceIndexes: z.array(z.number().int().nonnegative()).max(20).default([]),
  }).strict()).max(2000) }).strict()).max(10).default([]),
  notes: z.array(z.string().max(4000)).max(50).default([]),
}).strict();
export type PlanProposal = z.infer<typeof planProposalSchema>;
export type CsvPlan = z.infer<typeof csvPlanSchema>;
export const planReviewSchema = z.object({
  items: z.record(z.string(), z.object({ include: z.boolean(), reviewed: z.boolean() }).strict()).default({}),
  identities: z.record(z.string(), z.object({ decision: z.enum(['pending', 'same', 'separate']), reason: z.string().trim().max(4000).default('') }).strict()).default({}),
  eventAcknowledgement: z.string().optional(),
  reason: z.string().trim().max(4000).default(''),
}).strict();
export type PlanReview = z.infer<typeof planReviewSchema>;
export const itemKey = (source: string, kind: string, id: string | number) => `${source}:${kind}:${id}`;
