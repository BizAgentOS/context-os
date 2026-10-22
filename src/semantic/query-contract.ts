import {z} from 'zod';
import type {Artifact,Data} from '../agent/contracts.ts';
import type {SnapshotPins} from '../live/memory.ts';
import type {ReadMode} from '../live/reading-contract.ts';
import type {IdentityDecisionPins} from '../live/identity.ts';
import type {PinnedCorrections} from '../live/relation-corrections.ts';
import type {ExecutionOptions} from '../data/executor/jobs.ts';
import type {PropertyCorrectionPins} from '../live/property-corrections.ts';
const id=z.string().trim().min(1).max(200);
const scalar=z.union([z.string(),z.number().finite(),z.boolean(),z.null()]);
export const semanticQuerySchema=z.object({
  target:z.object({entityTypeId:id,id:z.string().min(1).max(16384).optional()}).strict(),
  fields:z.array(id).max(100).optional(),
  filters:z.array(z.object({propertyId:id,op:z.enum(['eq','ne','gt','gte','lt','lte','contains','is_null','not_null']),value:scalar.optional()}).strict()).max(30).default([]),
  sort:z.array(z.object({propertyId:id,direction:z.enum(['asc','desc']).default('asc')}).strict()).max(10).default([]),
  traverse:z.array(z.object({relationTypeId:id,direction:z.enum(['out','in']).default('out'),recursive:z.boolean().default(false),maxDepth:z.number().int().min(1).max(10).optional()}).strict()).max(3).default([]),
  aggregate:z.object({groupBy:z.array(id).max(10).default([]),measures:z.array(z.object({as:id,op:z.enum(['count','sum','avg','min','max']),propertyId:id.optional()}).strict()).min(1).max(20)}).strict().optional(),
  page:z.object({offset:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),limit:z.number().int().min(1).max(100).default(20)}).strict().default({offset:0,limit:20}),
}).strict();
export type SemanticQueryRequest=z.infer<typeof semanticQuerySchema>;
export interface SemanticQueryOptions extends ExecutionOptions {
  modelRef?:{id:string;version:number};readMode?:ReadMode;pins?:SnapshotPins;fixedSemantic?:boolean;
  correctionPins?:boolean|PinnedCorrections;identityDecisionPins?:IdentityDecisionPins;propertyCorrectionPins?:PropertyCorrectionPins;
  assertActive?:()=>void;maxPageSize?:number;modelDefinition?:Data;preparedFoundation?:Artifact;
  includeGroupMembers?:boolean;
  /** Host-only relationship diagnostics; never accepted as part of the query expression. */
  relationReportId?:string;
  preparedModel?:{definition:Data;foundation:Artifact;assertUnchanged:()=>void};
  scope?:{entityTypeIds:ReadonlySet<string>;propertyIds:ReadonlySet<string>;relationTypeIds:ReadonlySet<string>};
}
