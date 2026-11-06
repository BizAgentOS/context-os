import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { getLogger } from './logger.ts';

/** Explicit local experiment artifact, containing source text. Never pass credentials here. */
export async function createModelTrace(enabled: boolean, directory: string) {
  if (!enabled) return undefined;
  const id = randomUUID(), path = resolve(directory, id);
  await mkdir(path, { recursive: true, mode: 0o700 });
  let queue = Promise.resolve();
  let failed = false;
  const save = (name: string, value: unknown) => {
    queue = queue.then(() => writeFile(join(path, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })).catch(() => { failed = true; });
  };
  const event = (kind: string, elapsedMs: number, data: unknown = {}) => {
    queue = queue.then(() => appendFile(join(path, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), elapsedMs, kind, data }) + '\n', { mode: 0o600 })).catch(() => { failed = true; });
  };
  getLogger().info('model.trace.created', { traceId: id, path });
  return { id, path, save, event, async flush() {
    try { await queue; if (failed) throw new Error('write failed'); } catch { getLogger().error('model.trace.write_failed', { traceId: id }); throw new Error('模型追踪文件写入失败，请检查磁盘与目录权限'); }
  } };
}
export const traceHash = (value: string) => createHash('sha256').update(value).digest('hex');
