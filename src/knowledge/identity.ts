import { randomUUID } from 'node:crypto';
import { ontologySchema, type Action } from './contracts.ts';
import type { Sql } from './database.ts';

type Revise = (sql: Sql, id: string, revision: number, changes: Record<string, unknown>, systemAt: string) => Promise<unknown>;
async function required(sql: Sql, query: string, values: unknown[]) {
  const row = (await sql.query(query, values)).rows[0];
  if (!row) throw new Error('身份绑定或对象修订已变化，请重新读取后检查');
  return row;
}

/** Explicit source-assertion reassignment, not a general object merge or automatic split. */
export async function rematchIdentity(sql: Sql, input: Action, revise: Revise) {
  if (!input.identity || !input.assertionIds?.length || new Set(input.assertionIds).size !== input.assertionIds.length) throw new Error('身份纠错需要标识和不重复的已审核声明列表');
  if (input.newObjectId && !input.expectedTargetRevision || !input.newObjectId && input.expectedTargetRevision) throw new Error('已有目标对象必须提供其修订号');
  if (input.newObjectId === input.targetId) throw new Error('新旧对象不能相同');
  const old = await required(sql, 'SELECT * FROM knowledge.objects WHERE id=$1 AND revision=$2', [input.targetId, input.expectedRevision]);
  if (old.type_id !== input.identity.typeId) throw new Error('标识类型与旧对象不一致');
  const model = await required(sql, "SELECT definition FROM knowledge.ontologies WHERE status='published' ORDER BY published_at DESC LIMIT 1", []);
  if (!ontologySchema.parse(model.definition).actions.includes('RematchIdentity')) throw new Error('本体未启用身份纠错');
  const { typeId, namespace, value } = input.identity;
  await required(sql, 'SELECT * FROM knowledge.identifiers WHERE type_id=$1 AND namespace=$2 AND value=$3 AND object_id=$4', [typeId, namespace, value, old.id]);
  const selected = [];
  for (const id of input.assertionIds) {
    const row = await required(sql, `SELECT a.*,r.value,r.target_id,r.valid_from,r.valid_to,r.time_precision,r.status,r.basis,r.semantics,r.comparison,r.reason
      FROM knowledge.assertions a JOIN knowledge.assertion_revisions r ON r.assertion_id=a.id AND r.system_to IS NULL
      JOIN knowledge.source_versions v ON v.id=a.source_version_id JOIN knowledge.sources s ON s.active_version=v.id
      WHERE a.id=$1 AND a.origin='source' AND r.status IN ('accepted','pending') AND (a.object_id=$2 OR r.target_id=$2)`, [id, old.id]);
    selected.push(row);
  }
  const targetId = input.newObjectId ?? randomUUID();
  const boundary = await required(sql, `SELECT to_char(GREATEST(clock_timestamp(),
    (SELECT max(system_from)+interval '1 microsecond' FROM knowledge.assertion_revisions WHERE assertion_id=ANY($1::uuid[]) AND system_to IS NULL),
    (SELECT system_from+interval '1 microsecond' FROM knowledge.identity_bindings WHERE type_id=$2 AND namespace=$3 AND value=$4 AND system_to IS NULL)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp`, [input.assertionIds, typeId, namespace, value]);
  if (input.newObjectId) {
    const target = await required(sql, 'SELECT * FROM knowledge.objects WHERE id=$1 AND revision=$2', [targetId, input.expectedTargetRevision]);
    if (target.type_id !== old.type_id) throw new Error('身份纠错目标必须为同类型对象');
  } else await sql.query('INSERT INTO knowledge.objects(id,type_id,created_at) VALUES($1,$2,$3)', [targetId, old.type_id, boundary.stamp]);

  const binding = await required(sql, `UPDATE knowledge.identity_bindings SET system_to=$4
    WHERE type_id=$1 AND namespace=$2 AND value=$3 AND system_to IS NULL RETURNING system_to::text AS stamp`, [typeId, namespace, value, boundary.stamp]);
  await sql.query('INSERT INTO knowledge.identity_bindings(id,type_id,namespace,value,object_id,system_from,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), typeId, namespace, value, targetId, binding.stamp, input.operationId]);
  await sql.query('UPDATE knowledge.identifiers SET object_id=$4 WHERE type_id=$1 AND namespace=$2 AND value=$3', [typeId, namespace, value, targetId]);
  const moves = [];
  const touched = new Set<string>([old.id, targetId]);
  for (const row of selected) {
    const id = randomUUID();
    const subjectId = row.object_id === old.id ? targetId : row.object_id;
    const endpointId = row.target_id === old.id ? targetId : row.target_id;
    // New assertion retains the source's immutable content; the identity decision is in action_events.
    await sql.query(`INSERT INTO knowledge.assertions(id,object_id,predicate,ontology_id,source_version_id,run_id,origin)
      VALUES($1,$2,$3,$4,$5,$6,'source')`, [id, subjectId, row.predicate, row.ontology_id, row.source_version_id, row.run_id]);
    await sql.query(`INSERT INTO knowledge.assertion_revisions(assertion_id,revision,value,target_id,valid_from,valid_to,time_precision,status,basis,semantics,comparison,reason,system_from)
      VALUES($1,1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`, [id, endpointId ? null : JSON.stringify(row.value), endpointId, row.valid_from, row.valid_to, row.time_precision, row.status, row.basis, JSON.stringify(row.semantics), JSON.stringify(row.comparison), row.reason, boundary.stamp]);
    await sql.query('INSERT INTO knowledge.assertion_evidence(assertion_id,evidence_id) SELECT $2,evidence_id FROM knowledge.assertion_evidence WHERE assertion_id=$1', [row.id, id]);
    await sql.query('INSERT INTO knowledge.assertion_revision_evidence(assertion_id,revision,evidence_id) SELECT $2,1,evidence_id FROM knowledge.assertion_revision_evidence WHERE assertion_id=$1 AND revision=$3', [row.id, id, row.revision]);
    await revise(sql, row.id, row.revision, { status: 'superseded', reason: `身份纠错：${input.reason}` }, boundary.stamp);
    touched.add(subjectId); if (endpointId) touched.add(endpointId);
    moves.push({ oldAssertionId: row.id, newAssertionId: id, oldObjectId: row.object_id, newObjectId: subjectId, oldTargetId: row.target_id, newTargetId: endpointId });
  }
  for (const id of touched) {
    await sql.query('UPDATE knowledge.objects SET revision=revision+1 WHERE id=$1', [id]);
    await sql.query('DELETE FROM knowledge.projections WHERE object_id=$1', [id]);
  }
  return { oldObjectId: old.id, newObjectId: targetId, identity: input.identity, moves, systemAt: boundary.stamp, scope: 'selected_source_assertions_only' };
}
