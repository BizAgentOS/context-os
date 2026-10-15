// Adapted from Helix Foundry services/executor/src/jobs.ts (Apache-2.0, commit 00d7927).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Executed, Execution, Materialized } from "./engine.ts";
import { duration, timeLimit } from "./limits.ts";
import { scratchRoot } from "./paths.ts";

const runner = fileURLToPath(new URL("./runner.ts", import.meta.url));
const owned = /^(job|executor)-/;

export class ExecutorError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Runs each DuckDB job in a disposable child process: two at a time, up to 50 waiting, killed at its time or output limit. */
export class Executor {
  readonly root: string;
  private active = 0;
  private waiters: Array<(ok: boolean) => void> = [];
  private children = new Set<ChildProcess>();
  private jobs = new Set<Promise<unknown>>();
  private stopping = false;
  private swept: Promise<void>;

  constructor(root: string) {
    this.root = root;
    // Nothing of this executor runs yet, so owned scratch left by a killed process is stale.
    this.swept = (async () => {
      const dir = scratchRoot(root);
      await mkdir(dir, { recursive: true });
      for (const name of (await readdir(dir)).filter(n => owned.test(n))) await rm(resolve(dir, name), { recursive: true, force: true }).catch(() => undefined);
    })().catch(() => undefined);
  }

  run(job: Execution & { mode: "materialize" }): Promise<Materialized>;
  run(job: Execution): Promise<Executed>;
  async run(job: Execution): Promise<Executed | Materialized> {
    await this.swept;
    const limit = timeLimit(job), deadline = Date.now() + limit.ms;
    if (this.active >= 2) {
      if (this.waiters.length >= 50) throw new ExecutorError(429, "数据执行队列已满，请稍后重试。");
      if (!await this.turn(limit.ms)) throw new ExecutorError(503, `数据执行在时限内一直排队（${duration(limit.ms)}，${limit.setting}）。`);
    }
    this.active++;
    try {
      const r = await this.track(this.spawn(JSON.stringify({ job, root: this.root }), Math.max(1, deadline - Date.now())));
      if (r.failed) throw new ExecutorError(500, r.failed);
      if (r.code === 0) {
        try { return JSON.parse(r.out); } catch { throw new ExecutorError(500, "数据执行返回无效结果"); }
      }
      throw new ExecutorError(422, r.timedOut ? `数据执行超过时限（${duration(limit.ms)}，${limit.setting}）` : r.err.slice(0, 1500) || "查询超过执行限制");
    } finally {
      this.active--;
      this.waiters.shift()?.(true);
    }
  }

  /** Kills running jobs, refuses new ones and waits until their scratch is removed. */
  async stop() {
    this.stopping = true;
    for (const child of this.children) child.kill("SIGKILL");
    await Promise.allSettled(this.jobs);
  }

  private turn(wait: number) {
    return new Promise<boolean>(done => {
      const waiter = (ok: boolean) => { clearTimeout(timer); done(ok); };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        done(false);
      }, wait);
      this.waiters.push(waiter);
    });
  }

  private track<T>(job: Promise<T>) {
    this.jobs.add(job);
    const done = () => this.jobs.delete(job);
    job.then(done, done);
    return job;
  }

  private async spawn(body: string, timeout: number, maxOutput = 10_000_000) {
    await mkdir(scratchRoot(this.root), { recursive: true });
    const scratch = await mkdtemp(resolve(scratchRoot(this.root), "job-"));
    try {
      return await new Promise<{ code: number | null; out: string; err: string; failed?: string; timedOut?: boolean }>(done => {
        if (this.stopping) return done({ code: null, out: "", err: "", failed: "数据执行服务正在停止" });
        // A minimal environment: source credentials and admin tokens never reach the child.
        const child = spawn(process.execPath, [runner], { env: { PATH: process.env.PATH, DUCKDB_MEMORY: process.env.DUCKDB_MEMORY || "", DUCKDB_SPILL_LIMIT: process.env.DUCKDB_SPILL_LIMIT || "",
          EXECUTOR_RESULT_LIMIT: process.env.EXECUTOR_RESULT_LIMIT || "", EXECUTOR_SCRATCH: scratch }, stdio: ["pipe", "pipe", "pipe"] });
        this.children.add(child);
        let out = "", err = "", timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
        child.stdout.on("data", x => { out += x; if (out.length > maxOutput) child.kill("SIGKILL"); });
        child.stderr.on("data", x => (err += x));
        child.stdin.on("error", () => undefined);
        child.on("error", e => {
          if (child.pid !== undefined) return;
          this.children.delete(child); clearTimeout(timer);
          done({ code: null, out, err, failed: e.message });
        });
        child.on("close", code => {
          this.children.delete(child); clearTimeout(timer);
          done({ code, out, err, timedOut });
        });
        child.stdin.end(body);
      });
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
