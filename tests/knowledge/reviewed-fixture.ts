/** Core-only fixtures: explicitly seed an approved snapshot; lifecycle approval is tested in build-plans.test.ts. */
import { randomUUID } from 'node:crypto';
import { extractionSchema, ontologySchema, type Principal } from '../../src/knowledge/contracts.ts';
import { fingerprint } from '../../src/knowledge/sources.ts';
import type { KnowledgeCore } from '../../src/knowledge/service.ts';
export async function commitReviewedFixture(core: KnowledgeCore, actor: Principal, input: Parameters<KnowledgeCore['commitExtraction']>[1]) {
  let planId = (await core.db.pool.query('SELECT build_plan_id FROM knowledge.extraction_runs WHERE operation_id=$1', [input.operationId])).rows[0]?.build_plan_id;
  if (!planId) {
    const output = extractionSchema.parse(input.output);
    planId = await core.db.transaction(async sql => {
      const source = (await sql.query('SELECT * FROM knowledge.source_versions WHERE id=$1', [input.sourceVersionId])).rows[0];
      const ontology = (await sql.query('SELECT * FROM knowledge.ontologies WHERE id=$1', [input.ontologyId])).rows[0];
      const unique = new Map();
      for (const c of output.claims) for (const target of [c.subject, ...(c.object ? [c.object] : [])]) {
        const original = { ...target, namespace: `source.${source.source_id}` };
        const b = (await sql.query('SELECT id,object_id FROM knowledge.identity_bindings WHERE type_id=$1 AND namespace=$2 AND value=$3 AND system_to IS NULL', [original.typeId, original.namespace, original.value])).rows[0];
        const t = (await sql.query('SELECT id,object_id FROM knowledge.identity_bindings WHERE type_id=$1 AND namespace=$2 AND value=$3 AND system_to IS NULL', [target.typeId, target.namespace, target.value])).rows[0];
        unique.set(fingerprint(original), { source: original, target, bindingId: b?.id ?? null, objectId: b?.object_id ?? null, targetBindingId: t?.id ?? null, targetObjectId: t?.object_id ?? null });
      }
      const id = randomUUID();
      await sql.query("INSERT INTO knowledge.build_plans(id,ontology_id,ontology_hash,manifest,proposal,status,created_by,approved_by,approved_at,provenance) VALUES($1,$2,$3,'[]','{}','approved',$4,$4,clock_timestamp(),'{\"testFixture\":true}')", [id, input.ontologyId, fingerprint(ontologySchema.parse(ontology.definition)), actor.id]);
      await sql.query('INSERT INTO knowledge.approved_plan_outputs(plan_id,source_version_id,output,output_hash,namespaces,identity_mappings) VALUES($1,$2,$3::jsonb,$4,$5,$6::jsonb)', [id, source.id, JSON.stringify(output), fingerprint(output), [...new Set([...unique.values()].map(m => m.target.namespace))], JSON.stringify([...unique.values()])]);
      return id;
    });
  }
  return core.commitExtraction(actor, { ...input, buildPlanId: planId });
}
