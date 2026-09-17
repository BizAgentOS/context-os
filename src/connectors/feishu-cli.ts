import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, mkdtemp, lstat, rm } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { gunzipSync } from "node:zlib";

// Command protocol and pinned release checked against KodaX Space's Feishu adapter.
// This adapter is implemented for DataEngine's local Node host, without Electron.
export const FEISHU_VERSION = "1.0.92";
const releases: Record<string, { name: string; sha256: string }> = {
  "darwin-arm64": { name: "darwin-arm64.tar.gz", sha256: "abb1b96eee5ad32da4e12f434e44d48a9e01ebb0e81772419ac0347f91c34265" },
  "darwin-x64": { name: "darwin-amd64.tar.gz", sha256: "421b36f95966028fb047231cb6351c4224a0fdcb076d2bc434d4aed1bb6d1891" },
  "linux-arm64": { name: "linux-arm64.tar.gz", sha256: "683546b6754c780e0f828e87cb00ccf7c0710798a9f1ddb8c6b956afbfb570ae" },
  "linux-x64": { name: "linux-amd64.tar.gz", sha256: "ef0e19799c1edd94eb52d3bb5d587e00d0a2898e0a4b407a1b8dc66d56181ef1" },
};
export interface CliRequest {
  args: string[];
  signal: AbortSignal;
  timeoutMs?: number;
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
}
export interface FeishuCliPort {
  prepare(signal: AbortSignal): Promise<void>;
  run(request: CliRequest): Promise<string>;
  downloadText(request: CliRequest): Promise<{ content: string; bytes: number }>;
}
export function extractExecutable(archive: Buffer): Buffer {
  const tar = gunzipSync(archive, { maxOutputLength: 100 * 1024 * 1024 });
  let executable: Buffer | undefined;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().split("\0")[0];
    const sizeText = header.subarray(124, 136).toString().replace(/\0/g, "").trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("连接组件压缩包格式错误");
    const size = parseInt(sizeText, 8);
    const start = offset + 512;
    if (start + size > tar.length) throw new Error("连接组件压缩包不完整");
    if (name.split("/").at(-1) === "lark-cli") {
      if (executable || ![0, 48].includes(header[156])) throw new Error("连接组件不是普通可执行文件");
      executable = tar.subarray(start, start + size);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!executable?.length) throw new Error("未找到飞书连接组件");
  return executable;
}
export function createFeishuCli(directory: string): FeishuCliPort {
  const root = resolve(directory, "connectors", "feishu", FEISHU_VERSION);
  const binary = join(root, "lark-cli");
  const archiveFile = join(root, "release.tar.gz");
  const asset = releases[`${process.platform}-${process.arch}`];
  let prepared = false;
  let preparing: Promise<void> | undefined;
  const cli: FeishuCliPort = {
    async prepare(signal) {
      if (prepared) return;
      if (!asset) throw new Error("当前系统尚未适配飞书连接组件");
      if (!preparing) preparing = (async () => {
        await mkdir(root, { recursive: true, mode: 0o700 });
        let bytes: Buffer;
        try { bytes = await readFile(archiveFile); } catch { bytes = Buffer.alloc(0); }
        const valid = (value: Buffer) => createHash("sha256").update(value).digest("hex") === asset.sha256;
        if (!valid(bytes)) {
          const response = await fetch(`https://github.com/larksuite/cli/releases/download/v${FEISHU_VERSION}/lark-cli-${FEISHU_VERSION}-${asset.name}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]) });
          if (!response.ok || !response.body) throw new Error("飞书连接组件下载失败，请重试");
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 25 * 1024 * 1024) throw new Error("飞书连接组件大小异常");
            chunks.push(chunk);
          }
          bytes = Buffer.concat(chunks);
          if (!valid(bytes)) throw new Error("飞书连接组件校验失败");
          await writeFile(archiveFile, bytes, { mode: 0o600 });
        }
        signal.throwIfAborted();
        // Re-extract from verified archive on each host startup; never trust PATH.
        await writeFile(`${binary}.tmp`, extractExecutable(bytes), { mode: 0o700 });
        await rename(`${binary}.tmp`, binary);
        prepared = true;
      })().finally(() => { preparing = undefined; });
      await preparing;
    },
    async run({ args, signal, timeoutMs = 45000, onLine }) {
      signal.throwIfAborted();
      const allowed = ["PATH", "HOME", "USERPROFILE", "USER", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
      const env = Object.fromEntries(allowed.flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(binary, args, { shell: false, cwd: root, env: { ...env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
        const buffers = { stdout: "", stderr: "" };
        let stdout = "", size = 0, failure: Error | undefined;
        const stop = (error: Error) => {
          failure ??= error;
          try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
        };
        const abort = () => stop(new Error("飞书操作已取消"));
        const timer = setTimeout(() => stop(new Error("飞书操作超时，请重试")), timeoutMs);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        for (const stream of ["stdout", "stderr"] as const) {
          child[stream].setEncoding("utf8");
          child[stream].on("data", (chunk: string) => {
            size += Buffer.byteLength(chunk);
            if (size > 2 * 1024 * 1024) return stop(new Error("飞书返回内容过大，请缩小范围"));
            if (stream === "stdout") stdout += chunk;
            buffers[stream] += chunk;
            const lines = buffers[stream].split(/\r?\n/);
            buffers[stream] = lines.pop() || "";
            try { lines.forEach(line => onLine?.(stream, line)); } catch { stop(new Error("飞书授权响应无法验证")); }
          });
        }
        child.on("error", () => { failure ??= new Error("飞书连接组件启动失败"); });
        child.on("close", code => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          try { for (const stream of ["stdout", "stderr"] as const) if (buffers[stream]) onLine?.(stream, buffers[stream]); } catch { failure ??= new Error("飞书授权响应无法验证"); }
          if (failure) reject(failure);
          else if (code !== 0) reject(new Error("飞书操作失败，请检查授权或重试"));
          else resolve(stdout);
        });
      });
    },
    async downloadText(request) {
      const directory = await mkdtemp(join(root, ".reading-"));
      const file = join(directory, "content.txt");
      const limit = 256_000, controller = new AbortController();
      const tooLarge = () => new Error("文件超过单次读取范围（250 KB），请拆分后读取");
      // The CLI only permits paths beneath its working directory. The path is host-generated.
      const timer = setInterval(() => {
        void lstat(file).then(s => { if (s.size > limit) controller.abort(tooLarge()); }).catch(() => {});
      }, 50);
      try {
        const raw = await cli.run({ ...request, args: [...request.args, "--output", relative(root, file)], signal: AbortSignal.any([request.signal, controller.signal]) });
        const receipt = JSON.parse(raw);
        const info = await lstat(file);
        if (info.size > limit) throw tooLarge();
        if (!info.isFile() || receipt?.ok !== true || receipt.identity !== "user" || receipt.data?.saved_path !== file || receipt.data.size_bytes !== info.size)
          throw new Error("文件读取回执无法验证");
        const bytes = await readFile(file);
        let content: string;
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { throw new Error("文件不是 UTF-8 文本，请转换编码后重试"); }
        if (content.includes("\0") || content.length > 60000) throw new Error("文件不是支持的文本或超过 60000 字符，请拆分后读取");
        return { content, bytes: bytes.length };
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
      } finally { clearInterval(timer); await rm(directory, { recursive: true, force: true }); }
    },
  };
  return cli;
}
