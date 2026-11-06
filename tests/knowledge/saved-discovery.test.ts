import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSavedDiscovery } from '../../src/knowledge/saved-discovery.ts';
test('saved candidate recovery checks ownership, completed submission and exact frozen input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'saved-discovery-'));
  const trace = '00000000-0000-4000-8000-000000000001', job = '00000000-0000-4000-8000-000000000002';
  const directory = join(root, trace), input = { sources: [{ id: 'source' }], evidenceCatalog: [{ evidenceId: 'e1' }], baseOntology: null };
  try {
    await mkdir(directory);
    await writeFile(join(directory, 'request.json'), JSON.stringify({ task: 'discover', context: { jobId: job }, input: JSON.stringify({ task: 'discover', input }) }));
    await writeFile(join(directory, 'summary.json'), JSON.stringify({ status: 'completed', submitted: true }));
    await writeFile(join(directory, 'output.json'), JSON.stringify({ saved: 'candidate' }));
    assert.deepEqual(await loadSavedDiscovery(root, trace, job, input), { saved: 'candidate' });
    await assert.rejects(loadSavedDiscovery(root, trace, trace, input), /不属于/);
    await assert.rejects(loadSavedDiscovery(root, trace, job, { ...input, baseOntology: {} }), /冻结输入/);
    await writeFile(join(directory, 'summary.json'), JSON.stringify({ status: 'timed_out', submitted: true }));
    await assert.rejects(loadSavedDiscovery(root, trace, job, input), /正常完成/);
    await rm(join(directory, 'output.json'));
    await assert.rejects(loadSavedDiscovery(root, trace, job, input), /不可用/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
