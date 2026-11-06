import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../src/observability/logger.ts';

test('logger persists, filters, redacts and retains bounded rotated files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-log-'));
  try {
    const file = join(dir, 'app.log');
    const logger = createLogger({ file, maxBytes: 250, backups: 2, console: false });
    logger.debug('hidden');
    logger.info('safe', { nested: { apiKey: 'sensitive' }, token: 'sensitive' });
    await logger.flush();
    const first = await readFile(file, 'utf8');
    assert.ok(!first.includes('sensitive')); assert.ok(!first.includes('hidden'));
    assert.equal(JSON.parse(first).nested.apiKey, '[REDACTED]');
    for (let i = 0; i < 10; i++) logger.info('rotation', { index: i });
    await logger.flush();
    assert.deepEqual((await readdir(dir)).sort(), ['app.log', 'app.log.1', 'app.log.2']);
    const current = (await readFile(file, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(current.at(-1).index, 9);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
