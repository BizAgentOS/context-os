import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { fingerprint } from './sources.ts';
/** Reads a completed, owned trace only. Missing files never trigger a paid fallback. */
export async function loadSavedDiscovery(directory: string, traceId: string, jobId: string, expectedInput: unknown) {
  z.string().uuid().parse(traceId); z.string().uuid().parse(jobId);
  let request: any, summary: any, output: unknown;
  try {
    const files = await Promise.all(['request.json', 'summary.json', 'output.json'].map(name => readFile(join(directory, traceId, name), 'utf8')));
    [request, summary, output] = files.map(s => JSON.parse(s));
  } catch { throw new Error('保存的完整候选或追踪文件不可用；未重新调用模型，请保留诊断后处理'); }
  if (request.task !== 'discover' || request.context?.jobId !== jobId || summary.status !== 'completed' || !summary.submitted) throw new Error('保存结果不属于该任务的正常完成提交，不能复用');
  const input = JSON.parse(request.input).input;
  if (fingerprint(input) !== fingerprint(expectedInput)) throw new Error('冻结输入、本体或证据目录与旧任务不同，不能复用保存结果');
  return output;
}
