import { z } from 'zod';
import { key, claimSchema, comparisonSchema } from './contracts.ts';

// Shared asset-count boundary; byte, evidence and execution budgets remain independent.
export const MAX_SOURCE_ASSETS = 50;
export const sourceVersionIdsSchema = z.array(z.string().uuid()).min(1).max(MAX_SOURCE_ASSETS, `单次最多 ${MAX_SOURCE_ASSETS} 个来源，请缩小授权范围`);

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
  csv: z.array(csvPlanSchema).max(MAX_SOURCE_ASSETS).default([]),
  documents: z.array(z.object({ sourceVersionId: z.string().uuid(), claims: z.array(z.object({
    claim: claimSchema, timeExplanation: z.string().max(4000).default(''),
    timeEvidenceIndexes: z.array(z.number().int().nonnegative()).max(20).default([]),
  }).strict()).max(2000) }).strict()).max(MAX_SOURCE_ASSETS).default([]),
  notes: z.array(z.string().max(4000)).max(50).default([]),
}).strict();
export type PlanProposal = z.infer<typeof planProposalSchema>;
export type CsvPlan = z.infer<typeof csvPlanSchema>;
export const planReviewSchema = z.object({
  datetimeOffset: z.string().regex(/^(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/, '时区偏移须为 Z 或 ±HH:MM，最大 ±14:00').optional(),
  items: z.record(z.string(), z.object({ include: z.boolean(), reviewed: z.boolean() }).strict()).default({}),
  identities: z.record(z.string(), z.object({ decision: z.enum(['pending', 'same', 'separate']), reason: z.string().trim().max(4000).default('') }).strict()).default({}),
  eventAcknowledgement: z.string().optional(),
  reason: z.string().trim().max(4000).default(''),
}).strict();
export type PlanReview = z.infer<typeof planReviewSchema>;
export const itemKey = (source: string, kind: string, id: string | number) => `${source}:${kind}:${id}`;
