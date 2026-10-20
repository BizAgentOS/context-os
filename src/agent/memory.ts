import { normalizeCanvasPage } from "./canvas-pages.ts";
import type { ResolvedWorkContext } from "./work-context.ts";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type {
  Artifact,
  ArtifactInput,
  CanvasProgress,
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
  workContext?: ResolvedWorkContext;
}
export interface ConversationSession {
  id: string;
  taskId: string;
  taskIds: string[];
  title: string;
  titleOrigin: "pending" | "agent" | "human";
  archived: boolean;
  summary?: { text: string; throughMessageId: string; count: number };
  createdAt: string;
  updatedAt: string;
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

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const messageFingerprint = (role: string, content: string, binding?: Data) =>
  createHash("sha256")
    .update(role + ":" + content + (binding ? ":" + canonical(binding) : ""))
    .digest("hex");

export class MemoryStore implements Repository {
  private db: DatabaseSync;
  readonly changes = new EventEmitter();
  private pendingChanges: Data[] = [];
  private written: Artifact[] = [];
  /** Runs inside the outermost transaction, just before COMMIT, with every artifact it wrote. A throw rolls the whole write back. */
  beforeCommit?: (written: Artifact[]) => void;

  private changed(change: Data) {
    if (this.db.isTransaction) this.pendingChanges.push(change);
    else this.publishChange(change);
  }

  private publishChange(change:Data) {
    for(const listener of this.changes.listeners("change")) {try {listener(change);} catch {/* A broken viewer cannot roll back a committed domain write. */}}
  }

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "memory.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT, version INTEGER, kind TEXT, body TEXT NOT NULL, PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_receipts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (task_id TEXT, seq INTEGER, body TEXT NOT NULL, PRIMARY KEY(task_id,seq));
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS consumer_evidence_cache (id TEXT PRIMARY KEY, view_id TEXT NOT NULL, expires_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
    this.db.prepare("DELETE FROM consumer_evidence_cache WHERE expires_at <= ?").run(Date.now());
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

  /** Bounded, disposable consumer readings; never part of durable ontology artifacts. */
  saveConsumerEvidence(entries: Array<{id:string;viewId:string;expiresAt:number;body:Data}>) {
    const rows=entries.map(e=>({...e,encoded:JSON.stringify(e.body)}));
    if(rows.length>401 || rows.reduce((n,r)=>n+Buffer.byteLength(r.encoded),0)>512*1024) throw new Error('证据读取超过512KB预算，请缩小字段或分页');
    this.atomic(()=>{
      this.db.prepare('DELETE FROM consumer_evidence_cache WHERE expires_at <= ?').run(Date.now());
      const insert=this.db.prepare('INSERT INTO consumer_evidence_cache(id,view_id,expires_at,body) VALUES(?,?,?,?)');
      for(const r of rows) insert.run(r.id,r.viewId,r.expiresAt,r.encoded);
      for(const viewId of new Set(rows.map(r=>r.viewId))) this.db.prepare('DELETE FROM consumer_evidence_cache WHERE id IN (SELECT id FROM consumer_evidence_cache WHERE view_id=? ORDER BY rowid DESC LIMIT -1 OFFSET 500)').run(viewId);
      this.db.exec('DELETE FROM consumer_evidence_cache WHERE id IN (SELECT id FROM consumer_evidence_cache ORDER BY rowid DESC LIMIT -1 OFFSET 2000)');
      // A batch is <=512KB; prune oldest batches/rows to the global 8MiB ceiling.
      const old=this.db.prepare('SELECT id,length(CAST(body AS BLOB)) AS bytes FROM consumer_evidence_cache ORDER BY rowid DESC').all() as Array<{id:string;bytes:number}>;
      let bytes=0;for(const r of old){bytes+=r.bytes;if(bytes>8*1024*1024)this.db.prepare('DELETE FROM consumer_evidence_cache WHERE id=?').run(r.id);}
    });
  }
  readConsumerEvidence(id:string):Data|undefined {
    this.db.prepare('DELETE FROM consumer_evidence_cache WHERE expires_at <= ?').run(Date.now());
    const row=this.db.prepare('SELECT body FROM consumer_evidence_cache WHERE id=?').get(id);
    return row?parse<Data>(row):undefined;
  }
  deleteConsumerEvidence(viewId:string) { this.db.prepare('DELETE FROM consumer_evidence_cache WHERE view_id=?').run(viewId); }

  close() {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    const changeStart = this.pendingChanges.length;
    this.written = [];
    try {
      const result = fn();
      if (this.written.length && this.beforeCommit) {
        const written = this.written;
        this.beforeCommit(written);
      }
      this.db.exec("COMMIT");
      const committed = this.pendingChanges.splice(changeStart);
      for (const change of committed) this.publishChange(change);
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.pendingChanges.splice(changeStart);
      throw error;
    } finally {
      this.written = [];
    }
  }

  /** Synchronous host decisions commit artifact, messages and progress together. */
  atomic<T>(fn: () => T): T {
    return this.transaction(fn);
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
      .filter((a) => (!kind || a.kind === kind) && !(a.kind === "source" && a.status === "removed") && !(a.kind === "foundation" && a.status === "discarded"));
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

  artifactOperation(
    context: WriteContext,
    operationId: string,
  ): Artifact | null {
    this.assertWritable(context);
    const row = this.db
      .prepare("SELECT body FROM operations WHERE id=?")
      .get(`${context.executionId}:${operationId}`);
    return row ? parse<Artifact>(row) : null;
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
      this.written.push(artifact);
      if (context) this.attachArtifact(context.taskId, artifact);
      this.changed({kind:"artifact",id:artifact.id,version:artifact.version,artifactKind:artifact.kind});
      return artifact;
    });
  }

  /** Create version 1 under an id the caller owns, such as an immutable file's storage key. */
  createArtifact(id: string, input: Omit<ArtifactInput, "id" | "expectedVersion">): Artifact {
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM artifacts WHERE id=? LIMIT 1").get(id)) throw new Error("成果标识已存在");
      const artifact: Artifact = { id, kind: input.kind, title: input.title, status: input.status, content: input.content, version: 1, createdAt: now() };
      this.db.prepare("INSERT INTO artifacts VALUES (?,?,?,?)").run(artifact.id, artifact.version, artifact.kind, JSON.stringify(artifact));
      this.changed({kind:"artifact",id:artifact.id,version:artifact.version,artifactKind:artifact.kind});
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
    this.changed({kind:"task",id:task.id,version:task.revision});
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
    if (task.executionId)
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

  dismissPending(taskId: string): Task {
    const task = this.getTask(taskId);
    if (task.executionId) throw new Error("运行尚未结束");
    task.pending = null;
    task.status = "paused";
    task.nextStep = "可以继续查看和完善当前页面。";
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
    binding?: Data,
    workContext?: ResolvedWorkContext,
  ): Message {
    this.hasMessageReceipt(id, taskId, role, content, binding);
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
    const message: Message = {
      id,
      taskId,
      role,
      content,
      createdAt: now(),
      ...(workContext ? { workContext } : {}),
    };
    const fingerprint = messageFingerprint(role, content, binding);
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO message_receipts VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
        )
        .run(id, taskId, fingerprint);
      this.db
        .prepare("INSERT INTO messages VALUES (?,?,?)")
        .run(id, taskId, JSON.stringify(message));
      this.changed({kind:"message",id,taskId});
    });
    return message;
  }

  hasMessageReceipt(
    id: string,
    taskId: string | string[],
    role: Message["role"],
    content: string,
    binding?: Data,
  ): boolean {
    const receipt = this.db
      .prepare("SELECT task_id,fingerprint FROM message_receipts WHERE id=?")
      .get(id) as { task_id: string; fingerprint: string } | undefined;
    if (!receipt) return false;
    const fingerprint = messageFingerprint(role, content, binding);
    if (
      !(Array.isArray(taskId) ? taskId : [taskId]).includes(receipt.task_id) ||
      receipt.fingerprint !== fingerprint
    )
      throw new Error("消息标识已使用");
    return true;
  }

  messageReceived(id: string, taskIds: string[]): boolean {
    const receipt = this.db
      .prepare("SELECT task_id FROM message_receipts WHERE id=?")
      .get(id) as { task_id: string } | undefined;
    if (receipt && !taskIds.includes(receipt.task_id))
      throw new Error("消息标识属于其他页面");
    return !!receipt;
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

  /** Stable backward pagination; model context retention is independent of storage. */
  messagePage(taskId: string, { before, limit = 40 }: { before?: string; limit?: number } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("无效的消息分页大小");
    const cursor = before ? this.db.prepare("SELECT rowid FROM messages WHERE id=? AND task_id=?").get(before, taskId) as { rowid: number } | undefined : undefined;
    if (before && !cursor) throw new Error("消息分页位置不存在或属于其他会话");
    const rows = cursor
      ? this.db.prepare("SELECT body FROM messages WHERE task_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?").all(taskId, cursor.rowid, limit + 1)
      : this.db.prepare("SELECT body FROM messages WHERE task_id=? ORDER BY rowid DESC LIMIT ?").all(taskId, limit + 1);
    const messages = rows.slice(0, limit).map(row => parse<Message>(row)).reverse();
    return { messages, nextBefore: rows.length > limit ? messages[0].id : null };
  }

  trimMessages(taskId: string, limit = 12, characterLimit = 12000): Message[] {
    const messages = this.messages(taskId);
    let count = 0;
    let size = 0;
    const retained: Message[] = [];
    for (const message of messages.reverse()) {
      if (count >= limit || size + message.content.length > characterLimit)
        break;
      retained.unshift(message);
      count++;
      size += message.content.length;
    }
    return retained;
  }

  listSessions(includeArchived = false): ConversationSession[] {
    return this.db.prepare("SELECT body FROM conversation_sessions ORDER BY rowid DESC").all()
      .map(row => parse<ConversationSession>(row)).filter(session => includeArchived || !session.archived);
  }

  getSession(id: string): ConversationSession {
    const row = this.db.prepare("SELECT body FROM conversation_sessions WHERE id=?").get(id);
    if (!row) throw new Error("会话不存在");
    return parse<ConversationSession>(row);
  }

  sessionForTask(taskId: string): ConversationSession | undefined {
    return this.listSessions(true).find(session => session.taskIds.includes(taskId));
  }

  private saveSession(session: ConversationSession) {
    session.updatedAt = now();
    this.db.prepare("INSERT INTO conversation_sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run(session.id, JSON.stringify(session));
    this.changed({kind:"session",id:session.id});
    return session;
  }

  createSession(title?: string, taskIds?: string[]): ConversationSession {
    if (title !== undefined && (!title.trim() || title.length > 80)) throw new Error("会话标题应为 1 至 80 字");
    return this.atomic(() => {
      const taskId = taskIds?.[0] ?? this.createTask("新的企业数据会话").id;
      return this.saveSession({id:randomUUID(),taskId,taskIds:taskIds ?? [taskId],title:title?.trim() ?? "新会话",
        titleOrigin:title ? "human" : "pending",archived:false,createdAt:now(),updatedAt:now()});
    });
  }

  defaultSession(): ConversationSession {
    const sessions = this.listSessions();
    if (sessions.length) return sessions.at(-1)!;
    // The migration groups the old page dialogues into one inspectable conversation.
    // Existing message IDs, task IDs, pending decisions and receipts remain unchanged.
    if(this.listSessions(true).length)return this.createSession();
    const progress = this.getCanvas();
    const taskIds = [...new Set(Object.values(progress?.taskIds ?? {}).filter((id): id is string => !!id))];
    return this.createSession(taskIds.length ? "历史工作会话" : undefined, taskIds.length ? [this.createTask("继续企业数据工作会话").id,...taskIds] : undefined);
  }

  updateSession(id: string, patch: {title?: string;archived?: boolean}, origin: "human" | "agent" = "human") {
    const session = this.getSession(id);
    if (patch.title !== undefined) {
      if (!patch.title.trim() || patch.title.length > 80) throw new Error("会话标题应为 1 至 80 字");
      if (origin === "agent" && session.titleOrigin !== "pending") return session;
      session.title = patch.title.trim();session.titleOrigin = origin;
    }
    if (patch.archived !== undefined) {
      if (typeof patch.archived !== "boolean") throw new Error("归档状态必须为布尔值");
      if (session.taskIds.some(taskId => this.getTask(taskId).executionId)) throw new Error("请先停止该会话运行再归档");
      session.archived = patch.archived;
    }
    return this.saveSession(session);
  }

  saveSessionSummary(id: string, summary: NonNullable<ConversationSession["summary"]>) {
    const session = this.getSession(id);session.summary=summary;return this.saveSession(session);
  }

  sessionMessages(id: string, {before,limit=40}:{before?:string;limit?:number}={}) {
    const session=this.getSession(id);
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error("无效的消息分页大小");
    const placeholders=session.taskIds.map(()=>"?").join(",");
    const cursor=before ? this.db.prepare(`SELECT rowid FROM messages WHERE id=? AND task_id IN (${placeholders})`).get(before,...session.taskIds) as {rowid:number}|undefined : undefined;
    if(before&&!cursor)throw new Error("消息分页位置不存在或属于其他会话");
    const rows=cursor
      ? this.db.prepare(`SELECT body FROM messages WHERE task_id IN (${placeholders}) AND rowid<? ORDER BY rowid DESC LIMIT ?`).all(...session.taskIds,cursor.rowid,limit+1)
      : this.db.prepare(`SELECT body FROM messages WHERE task_id IN (${placeholders}) ORDER BY rowid DESC LIMIT ?`).all(...session.taskIds,limit+1);
    const messages=rows.slice(0,limit).map(row=>parse<Message>(row)).reverse();
    return {messages,nextBefore:rows.length>limit?messages[0].id:null};
  }

  sessionHistory(id: string): Message[] {
    const session=this.getSession(id), placeholders=session.taskIds.map(()=>"?").join(",");
    return this.db.prepare(`SELECT body FROM messages WHERE task_id IN (${placeholders}) ORDER BY rowid`).all(...session.taskIds).map(row=>parse<Message>(row));
  }

  getCanvas(): CanvasProgress | null {
    const row = this.db
      .prepare("SELECT body FROM settings WHERE id='canvas'")
      .get();
    if (!row) return null;
    const saved = parse<CanvasProgress>(row);
    if (saved.layoutVersion === 2) return {...saved,currentPage:"setup",setupSection:"company"};
    // Metadata only: old tasks, receipts, pending decisions and artifacts retain
    // their identities. New dialogue gets its own task, so trimming cannot erase
    // either of the old conversations. The snapshot and migration commit together.
    return this.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO settings VALUES ('canvas-v1',?)")
        .run(JSON.stringify(saved));
      const migrated: CanvasProgress = {
        layoutVersion: 2,
        currentPage: "setup",
        setupSection: "company",
        reached: [...new Set(saved.reached.map(normalizeCanvasPage))],
        completed: saved.completed.filter(
          (page) => page !== "company" && page !== "sources",
        ),
        taskIds: {
          ...(saved.taskIds.setup ? { setup: saved.taskIds.setup } : {}),
          ...(saved.taskIds.ontology
            ? { ontology: saved.taskIds.ontology }
            : {}),
          ...(saved.taskIds.consumption
            ? { consumption: saved.taskIds.consumption }
            : {}),
        },
        legacyTaskIds: {
          ...(saved.taskIds.company ? { company: saved.taskIds.company } : {}),
          ...(saved.taskIds.sources ? { sources: saved.taskIds.sources } : {}),
        },
      };
      if (
        saved.completed.includes("company") &&
        saved.completed.includes("sources")
      )
        migrated.completed.unshift("setup");
      this.saveCanvas(migrated);
      return migrated;
    });
  }

  workspaceId(): string {
    const row = this.db
      .prepare("SELECT body FROM settings WHERE id='workspace-id'")
      .get();
    if (row) return parse<string>(row);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO settings VALUES ('workspace-id',?)")
      .run(JSON.stringify(id));
    return id;
  }

  saveCanvas(progress: CanvasProgress) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES ('canvas',?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(JSON.stringify({layoutVersion:progress.layoutVersion,completed:progress.completed,reached:progress.reached,taskIds:progress.taskIds,legacyTaskIds:progress.legacyTaskIds}));
    this.changed({kind:"canvas"});
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
    this.changed({kind:"step",id:taskId,version:event.seq,event:kind,data});
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

  getOnboarding(): Data | null {
    const row = this.db.prepare("SELECT body FROM settings WHERE id=?").get("onboarding");
    return row ? parse<Data>(row) : null;
  }
  saveOnboarding(state: Data) {
    this.db.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body")
      .run("onboarding", JSON.stringify(state));
    this.changed({kind:"settings"});
  }

  saveSettings(settings: Data) {
    // Metadata only; credentials live in the separate restricted credential store.
    const safe = { provider: settings.provider, model: settings.model,
      ...(settings.provider === "custom" ? {baseUrl: settings.baseUrl, protocol: settings.protocol} : {}),
    };
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run("model", JSON.stringify(safe));
    this.changed({kind:"settings"});
  }
}
