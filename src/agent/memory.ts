import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Artifact,
  ArtifactInput,
  Data,
  Investigation,
  Repository,
  Task,
  WriteContext,
} from "./contracts.ts";

export interface Message {
  id: string;
  taskId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
export interface TaskEvent {
  seq: number;
  taskId: string;
  kind: string;
  data: Data;
  createdAt: string;
}
const now = () => new Date().toISOString();
const parse = <T>(row: unknown): T =>
  JSON.parse((row as { body: string }).body) as T;

export class MemoryStore implements Repository {
  private db: DatabaseSync;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "memory.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT, version INTEGER, kind TEXT, body TEXT NOT NULL, PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (task_id TEXT, seq INTEGER, body TEXT NOT NULL, PRIMARY KEY(task_id,seq));
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
    for (const task of this.listTasks()) {
      if (task.executionId) {
        task.executionId = null;
        if (task.status === "running") task.status = "paused";
        task.revision++;
        task.nextStep = "服务已重启，已保存成果可读取；继续时将重新加载任务。";
        this.saveTask(task);
      }
    }
  }

  close() {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listArtifacts(kind?: string): Artifact[] {
    const rows = this.db
      .prepare(
        `SELECT a.body FROM artifacts a JOIN
      (SELECT id,MAX(version) version FROM artifacts GROUP BY id) latest
      ON a.id=latest.id AND a.version=latest.version ORDER BY a.rowid DESC`,
      )
      .all();
    return rows
      .map((row) => parse<Artifact>(row))
      .filter((a) => !kind || a.kind === kind);
  }

  getArtifact(id: string, version?: number): Artifact {
    const row =
      version === undefined
        ? this.db
            .prepare(
              "SELECT body FROM artifacts WHERE id=? ORDER BY version DESC LIMIT 1",
            )
            .get(id)
        : this.db
            .prepare("SELECT body FROM artifacts WHERE id=? AND version=?")
            .get(id, version);
    if (!row) throw new Error("成果不存在或该版本不可用");
    return parse<Artifact>(row);
  }

  putArtifact(
    input: ArtifactInput,
    context?: WriteContext,
    operationId?: string,
  ): Artifact {
    return this.transaction(() => {
      if (context) this.assertWritable(context);
      const key = operationId
        ? `${context?.executionId ?? "user"}:${operationId}`
        : null;
      if (key) {
        const previous = this.db
          .prepare("SELECT body FROM operations WHERE id=?")
          .get(key);
        if (previous) return parse<Artifact>(previous);
      }
      const prior = input.id ? this.getArtifact(input.id) : null;
      if (
        prior &&
        (input.expectedVersion !== prior.version || prior.kind !== input.kind)
      ) {
        throw new Error("成果版本已变化，请重新读取后再修改");
      }
      const artifact: Artifact = {
        id: prior?.id ?? randomUUID(),
        kind: input.kind,
        title: input.title,
        status: input.status,
        content: input.content,
        version: (prior?.version ?? 0) + 1,
        createdAt: now(),
      };
      this.db
        .prepare("INSERT INTO artifacts VALUES (?,?,?,?)")
        .run(
          artifact.id,
          artifact.version,
          artifact.kind,
          JSON.stringify(artifact),
        );
      if (key)
        this.db
          .prepare("INSERT INTO operations VALUES (?,?)")
          .run(key, JSON.stringify(artifact));
      if (context) this.attachArtifact(context.taskId, artifact);
      return artifact;
    });
  }

  listTasks(): Task[] {
    return this.db
      .prepare("SELECT body FROM tasks ORDER BY rowid DESC")
      .all()
      .map((row) => parse<Task>(row));
  }

  getTask(id: string): Task {
    const row = this.db.prepare("SELECT body FROM tasks WHERE id=?").get(id);
    if (!row) throw new Error("任务不存在");
    return parse<Task>(row);
  }

  private saveTask(task: Task): Task {
    task.updatedAt = now();
    this.db
      .prepare(
        "INSERT INTO tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(task.id, JSON.stringify(task));
    this.event(task.id, "task.changed", {
      status: task.status,
      revision: task.revision,
      nextStep: task.nextStep,
    });
    return task;
  }

  createTask(goal: string): Task {
    return this.saveTask({
      id: randomUUID(),
      revision: 1,
      goal,
      status: "paused",
      nextStep: "准备开始",
      pending: null,
      artifactRefs: [],
      sessionId: null,
      executionId: null,
      createdAt: now(),
      updatedAt: now(),
    });
  }

  beginExecution(taskId: string): WriteContext {
    const task = this.getTask(taskId);
    if (this.listTasks().some((t) => t.executionId))
      throw new Error("已有运行尚未结束");
    task.revision++;
    task.status = "running";
    task.pending = null;
    task.nextStep = "正在处理当前任务";
    task.executionId = randomUUID();
    this.saveTask(task);
    return {
      taskId,
      taskRevision: task.revision,
      executionId: task.executionId,
    };
  }

  assertWritable(context: WriteContext): Task {
    const task = this.getTask(context.taskId);
    if (
      task.revision !== context.taskRevision ||
      task.executionId !== context.executionId ||
      task.status !== "running"
    ) {
      throw new Error("本次运行已失效或任务正在等待用户，不能继续操作");
    }
    return task;
  }

  session(taskId: string, sessionId: string) {
    const task = this.getTask(taskId);
    task.sessionId = sessionId;
    return this.saveTask(task);
  }

  attachArtifact(taskId: string, artifact: Artifact) {
    const task = this.getTask(taskId);
    task.artifactRefs = task.artifactRefs.filter((r) => r.id !== artifact.id);
    task.artifactRefs.push({ id: artifact.id, version: artifact.version });
    this.saveTask(task);
    this.event(taskId, "artifact.committed", {
      id: artifact.id,
      version: artifact.version,
      kind: artifact.kind,
      title: artifact.title,
    });
  }

  checkpoint(context: WriteContext, nextStep: string): Task {
    const task = this.assertWritable(context);
    task.nextStep = nextStep;
    return this.saveTask(task);
  }

  getInvestigation(taskId: string): Investigation | null {
    return this.getTask(taskId).investigation ?? null;
  }

  bindInvestigation(context: WriteContext, scope: Investigation): void {
    const task = this.assertWritable(context);
    if (
      task.investigation &&
      JSON.stringify(task.investigation) !== JSON.stringify(scope)
    )
      throw new Error("任务已有固定调查依据，请显式刷新后再切换");
    task.investigation = scope;
    this.saveTask(task);
  }

  clearInvestigation(taskId: string, reason: string): void {
    const task = this.getTask(taskId);
    if (task.executionId) throw new Error("运行尚未结束，不能切换调查依据");
    task.investigation = null;
    task.revision++;
    task.nextStep = reason;
    this.saveTask(task);
    this.event(taskId, "investigation.refreshed", { reason });
  }

  ask(context: WriteContext, question: Data): Task {
    const task = this.assertWritable(context);
    if (typeof question.question !== "string" || !question.question.trim())
      throw new Error("需要具体问题");
    task.pending = { ...question, id: randomUUID() };
    task.status = "waiting";
    task.nextStep = question.question;
    this.saveTask(task);
    this.event(task.id, "decision.pending", task.pending);
    return task;
  }

  complete(
    context: WriteContext,
    artifactIds: string[],
    summary: string,
  ): Task {
    const task = this.assertWritable(context);
    if (!artifactIds.length) throw new Error("请先保存成果并提供成果引用");
    for (const id of artifactIds) {
      const ref = task.artifactRefs.find((r) => r.id === id);
      if (!ref) throw new Error("交付成果尚未关联当前任务");
      this.getArtifact(ref.id, ref.version);
    }
    task.status = "completed";
    task.nextStep = summary;
    task.pending = null;
    return this.saveTask(task);
  }

  restoreWaiting(taskId: string, pending: Data, reason: string): Task {
    const task = this.getTask(taskId);
    if (task.executionId) throw new Error("运行尚未结束，不能恢复等待状态");
    task.status = "waiting";
    task.pending = pending;
    task.nextStep = `采用未完成：${reason}`;
    return this.saveTask(task);
  }

  pauseTask(taskId: string, reason = "已停止，已保存的成果保留。"): Task {
    const task = this.getTask(taskId);
    task.revision++;
    task.status = "paused";
    task.nextStep = reason;
    // Leave the execution identity until its actual SDK run settles. Writes already fail on revision.
    return this.saveTask(task);
  }

  endExecution(context: WriteContext, error?: string): Task {
    const task = this.getTask(context.taskId);
    if (task.executionId !== context.executionId) return task;
    task.executionId = null;
    if (task.status === "running") {
      task.status = "paused";
      task.nextStep = error ?? "本次执行已结束；成果已保留，可继续当前任务。";
    }
    this.saveTask(task);
    this.event(task.id, "run.ended", {
      executionId: context.executionId,
      ...(error ? { error } : {}),
    });
    return task;
  }

  addMessage(
    taskId: string,
    role: Message["role"],
    content: string,
    id: string = randomUUID(),
  ): Message {
    const previous = this.db
      .prepare("SELECT body FROM messages WHERE id=?")
      .get(id);
    if (previous) {
      const message = parse<Message>(previous);
      if (
        message.taskId !== taskId ||
        message.role !== role ||
        message.content !== content
      )
        throw new Error("消息标识已使用");
      return message;
    }
    const message: Message = { id, taskId, role, content, createdAt: now() };
    this.db
      .prepare("INSERT INTO messages VALUES (?,?,?)")
      .run(id, taskId, JSON.stringify(message));
    return message;
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare("SELECT body FROM messages WHERE id=?").get(id);
    return row ? parse<Message>(row) : null;
  }

  messages(taskId: string): Message[] {
    return this.db
      .prepare("SELECT body FROM messages WHERE task_id=? ORDER BY rowid")
      .all(taskId)
      .map((row) => parse<Message>(row));
  }

  event(taskId: string, kind: string, data: Data): TaskEvent {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq),0)+1 seq FROM events WHERE task_id=?")
      .get(taskId) as { seq: number };
    const event: TaskEvent = {
      seq: row.seq,
      taskId,
      kind,
      data,
      createdAt: now(),
    };
    this.db
      .prepare("INSERT INTO events VALUES (?,?,?)")
      .run(taskId, event.seq, JSON.stringify(event));
    return event;
  }

  events(taskId: string, after = 0): TaskEvent[] {
    return this.db
      .prepare(
        "SELECT body FROM events WHERE task_id=? AND seq>? ORDER BY seq DESC LIMIT 300",
      )
      .all(taskId, after)
      .map((row) => parse<TaskEvent>(row))
      .reverse();
  }

  getSettings(): Data {
    const row = this.db
      .prepare("SELECT body FROM settings WHERE id=?")
      .get("model");
    return row ? parse<Data>(row) : {};
  }

  saveSettings(settings: Data) {
    // Callers provide only provider/model; credential values are never persisted.
    const safe = { provider: settings.provider, model: settings.model };
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run("model", JSON.stringify(safe));
  }
}
