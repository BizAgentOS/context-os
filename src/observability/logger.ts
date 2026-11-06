import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';
const levels: Level[] = ['debug', 'info', 'warn', 'error'];
// Callers must use fixed event names and approved metadata, never request bodies or raw errors.
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /token|password|secret|authorization|api.?key|connectionstring/i.test(k) ? '[REDACTED]' : redact(v)]));
  return value;
}
export function createLogger(options: { file: string; level?: Level; maxBytes?: number; backups?: number; console?: boolean }) {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const backups = options.backups ?? 5;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(backups) || backups < 1 || backups > 100) throw new Error('Invalid log rotation configuration');
  let queue = Promise.resolve();
  let warned = false;
  function log(level: Level, event: string, fields: Record<string, unknown> = {}) {
    if (levels.indexOf(level) < levels.indexOf(options.level ?? 'info')) return;
    const line = JSON.stringify({ ...redact(fields) as object, time: new Date().toISOString(), level, event }) + '\n';
    if (options.console !== false) process.stderr.write(line);
    queue = queue.then(async () => {
      await mkdir(dirname(options.file), { recursive: true, mode: 0o700 });
      const size = await stat(options.file).then(s => s.size).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return 0; throw e; });
      if (size && size + Buffer.byteLength(line) > maxBytes) {
        await rm(`${options.file}.${backups}`, { force: true });
        for (let i = backups - 1; i >= 0; i--) {
          await rename(i ? `${options.file}.${i}` : options.file, `${options.file}.${i + 1}`).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
        }
      }
      await appendFile(options.file, line, { mode: 0o600 });
      warned = false;
    }).catch(() => {
      if (!warned) process.stderr.write('日志文件写入失败，请检查日志路径、权限或磁盘空间。\n');
      warned = true;
    });
  }
  return { log, debug: (e: string, f?: Record<string, unknown>) => log('debug', e, f), info: (e: string, f?: Record<string, unknown>) => log('info', e, f), warn: (e: string, f?: Record<string, unknown>) => log('warn', e, f), error: (e: string, f?: Record<string, unknown>) => log('error', e, f), flush: () => queue };
}
let instance: ReturnType<typeof createLogger> | undefined;
export function getLogger() {
  if (!instance) {
    const level = process.env.CONTEXT_OS_LOG_LEVEL ?? 'info';
    if (!levels.includes(level as Level)) throw new Error('CONTEXT_OS_LOG_LEVEL 必须为 debug/info/warn/error');
    instance = createLogger({ file: resolve(process.env.CONTEXT_OS_LOG_FILE ?? 'local-state/logs/context-os.log'), level: level as Level, maxBytes: Number(process.env.CONTEXT_OS_LOG_MAX_BYTES ?? 10485760), backups: Number(process.env.CONTEXT_OS_LOG_BACKUPS ?? 5) });
  }
  return instance;
}
