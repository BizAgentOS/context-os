import { z } from 'zod';
import { objectTypeSchema, propertySchema, linkSchema, ontologySchema, strictComparisonSchema } from './contracts.ts';
import { uncertaintySchema } from './discovery.ts';

const ref = z.string().max(20).regex(/^[tpl]\d+$/);
const reason = z.string().trim().min(1).max(2000);
const group = { bindings:z.array(z.object({sourceVersionId:z.string().uuid(),column:z.string().min(1).max(300)}).strict()).min(1).max(50).optional(),refs: z.array(ref).min(1).max(5000), reason: reason.optional() };
// A partial schema with Zod defaults can still inject absent fields. A rename
// must never reset required/identity/cardinality or erase an existing description.
function patch(shape: z.ZodRawShape) {
  return z.object(Object.fromEntries(Object.entries(shape).map(([key, value]) => {
    let field = value as z.ZodType;
    while (field instanceof z.ZodDefault || field instanceof z.ZodOptional) field = field.unwrap() as z.ZodType;
    return [key, field.optional()];
  }))).strict();
}
const binding = z.object({sourceVersionId:z.string().uuid(),column:z.string().min(1).max(300)}).strict();
const provenance={sourceColumns:z.array(binding).min(1).max(50),uncertainties:z.array(z.object({kind:uncertaintySchema.shape.kind,question:uncertaintySchema.shape.question,dimensions:uncertaintySchema.shape.dimensions}).strict()).max(100).default([])};
const newProperty=z.object({...propertySchema.shape,...provenance}).strict();
const newType=z.object({...objectTypeSchema.shape,properties:z.array(newProperty).max(100),...provenance}).strict();
const newLink=z.object({...linkSchema.shape,...provenance}).strict();
const propertyChanges = patch({ ...propertySchema.shape, comparison: strictComparisonSchema });
/** Return references and actual changes, never retransmit unchanged definitions or source bindings. */
export const compactCoordinationSchema = z.object({
  name: ontologySchema.shape.name,
  types: z.array(z.object({ ...group,
    changes: patch(objectTypeSchema.omit({ properties: true }).shape).optional(),
    properties: z.array(z.object({ ...group, changes: propertyChanges.optional() }).strict()).max(100),
  }).strict()).max(100).default([]),
  links: z.array(z.object({ ...group, changes: patch(linkSchema.shape).optional() }).strict()).max(200).default([]),
  additions:z.object({types:z.array(z.object({member:newType,reason}).strict()).max(100).default([]),properties:z.array(z.object({owner:z.string().min(1),member:newProperty,reason}).strict()).max(100).default([]),links:z.array(z.object({member:newLink,reason}).strict()).max(200).default([])}).strict().default({types:[],properties:[],links:[]}),
  relationshipBindings:z.array(z.object({linkId:linkSchema.shape.id,bindings:z.array(z.object({candidateRef:z.string().regex(/^r[a-f0-9]{18}$/),endpoint:z.enum(['from','to'])}).strict()).min(1).max(10),reason}).strict()).max(200).default([]),
  removals:z.array(z.object({ref,reason}).strict()).max(5000).default([]),
  resolutions: z.array(z.object({ ref, indexes: z.array(z.number().int().nonnegative()).min(1).max(100), reason }).strict()).max(5000).default([]),
  uncertainties: z.array(z.object({ ref, kind: uncertaintySchema.shape.kind, question: uncertaintySchema.shape.question,
    dimensions: uncertaintySchema.shape.dimensions }).strict()).max(5000).default([]),
}).strict();
