import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workerFailureDetails } from '../../src/knowledge/jobs.ts';

test('worker diagnostics expose SQLSTATE and guidance without raw database details', () => {
  const details = workerFailureDetails({ code: '42P01', position: '17', message: 'private-db-credentials', detail: 'private-source-data' });
  assert.equal(details.code, '42P01');
  assert.equal(details.sqlPosition, '17');
  assert.ok(details.reason.includes('knowledge:init'));
  assert.ok(!JSON.stringify(details).includes('private-'));
  assert.equal(workerFailureDetails({ code: 'https://secret', position: 'private-source-data' }).code, 'UNKNOWN');
});
