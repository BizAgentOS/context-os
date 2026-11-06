import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser module is syntax checked separately.
import { correctionTarget, fillCorrectionTarget } from '../../web/knowledge/action-target.js';
const snapshot = { id: 'contract-object', revision: 5, assertions: [{ id: 'amount-claim', revision: 1 }] };
test('property correction always targets object revision even after selecting a statement', () => {
  const claim = snapshot.assertions[0];
  assert.deepEqual(correctionTarget(snapshot, 'CorrectValidity', claim), { id: claim.id, revision: 1, label: '选中的声明' });
  assert.deepEqual(correctionTarget(snapshot, 'CorrectProperty', claim), { id: snapshot.id, revision: 5, label: '当前对象' });
  assert.equal(correctionTarget(snapshot, 'RejectAssertion', claim).id, claim.id);
});
test('missing/stale statement and historical view cannot produce a correction target', () => {
  assert.throws(() => correctionTarget(snapshot, 'CorrectValidity'), /先在声明旁选择/);
  assert.throws(() => correctionTarget(snapshot, 'RejectAssertion', { id: 'other-object-claim', revision: 1 }), /先在声明旁选择/);
  assert.throws(() => correctionTarget({ ...snapshot, revision: null }, 'CorrectProperty'), /历史视图/);
  const form = { elements: { targetId: { value: 'stale', readOnly: false }, expectedRevision: { value: '1', readOnly: false } } };
  fillCorrectionTarget(form, correctionTarget(snapshot, 'CorrectProperty'));
  assert.equal(form.elements.targetId.value, snapshot.id);
  assert.equal(form.elements.expectedRevision.value, 5);
  assert.equal(form.elements.targetId.readOnly, true);
  fillCorrectionTarget(form, null); assert.equal(form.elements.targetId.value, '');
});
