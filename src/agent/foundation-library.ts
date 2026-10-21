import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Artifact, Data } from "./contracts.ts";

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};

/** Immutable evidence and historical owner references share the repository's SQLite transaction. */
export class FoundationEvidenceLibrary {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS foundation_evidence (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS foundation_evidence_refs (owner TEXT NOT NULL, position INTEGER NOT NULL, evidence_key TEXT NOT NULL,
        PRIMARY KEY(owner, position), FOREIGN KEY(evidence_key) REFERENCES foundation_evidence(key));
      CREATE INDEX IF NOT EXISTS foundation_evidence_references ON foundation_evidence_refs(evidence_key);`);
  }

  encode(artifact: Artifact): Artifact {
    if (artifact.kind === "engine_candidate" && artifact.content.foundation) {
      const nested = this.encode({ ...artifact, id: `${artifact.id}#foundation`, kind: "foundation", content: artifact.content.foundation as Data });
      return { ...artifact, content: { ...artifact.content, foundation: nested.content } };
    }
    if (!["foundation", "change_evidence_receipt"].includes(artifact.kind)) return artifact;
    // An already encoded historical receipt has its durable owner manifest.
    if (artifact.content.evidenceLibrary && !Array.isArray(artifact.content.evidence)) return artifact;
    const owner = `${artifact.id}@${artifact.version}`;
    const evidence = (artifact.content.evidence ?? []) as Data[];
    const insert = this.db.prepare("INSERT OR IGNORE INTO foundation_evidence(key,body) VALUES(?,?)");
    const retain = this.db.prepare("INSERT OR REPLACE INTO foundation_evidence_refs(owner,position,evidence_key) VALUES(?,?,?)");
    for (const [position, entry] of evidence.entries()) {
      const body = JSON.stringify(entry), key = createHash("sha256").update(canonical(entry)).digest("hex");
      insert.run(key, body); retain.run(owner, position, key);
    }
    const { evidence: _evidence, ...definition } = artifact.content;
    return { ...artifact, content: { ...definition, evidenceLibrary: { version: 1, count: evidence.length } } };
  }

  decode(artifact: Artifact): Artifact {
    if (artifact.kind === "engine_candidate" && artifact.content.foundation) {
      const nested = this.decode({ ...artifact, id: `${artifact.id}#foundation`, kind: "foundation", content: artifact.content.foundation as Data });
      return { ...artifact, content: { ...artifact.content, foundation: nested.content } };
    }
    if (!["foundation", "change_evidence_receipt"].includes(artifact.kind) || !artifact.content.evidenceLibrary || Array.isArray(artifact.content.evidence)) return artifact;
    const rows = this.db.prepare("SELECT e.body FROM foundation_evidence_refs r JOIN foundation_evidence e ON e.key=r.evidence_key WHERE r.owner=? ORDER BY r.position").all(`${artifact.id}@${artifact.version}`) as { body: string }[];
    if (rows.length !== Number((artifact.content.evidenceLibrary as Data).count)) throw new Error("历史本体的依据引用不完整，不能继续使用该定义");
    const { evidenceLibrary: _manifest, ...definition } = artifact.content;
    return { ...artifact, content: { ...definition, evidence: rows.map(row => JSON.parse(row.body) as Data) } };
  }

  /** Repository supplies every retained historical owner, never just the current working definition. */
  collect(retainedOwners: ReadonlySet<string>): number {
    const owners = this.db.prepare("SELECT DISTINCT owner FROM foundation_evidence_refs").all() as { owner: string }[];
    for (const { owner } of owners) if (!retainedOwners.has(owner)) this.db.prepare("DELETE FROM foundation_evidence_refs WHERE owner=?").run(owner);
    return Number(this.db.prepare("DELETE FROM foundation_evidence WHERE NOT EXISTS (SELECT 1 FROM foundation_evidence_refs r WHERE r.evidence_key=foundation_evidence.key)").run().changes);
  }

  stats() {
    const row = this.db.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM foundation_evidence").get() as { entries: number; bytes: number };
    const refs = this.db.prepare("SELECT COUNT(*) AS count FROM foundation_evidence_refs").get() as { count: number };
    return { entries: Number(row.entries), references: Number(refs.count), bytes: Number(row.bytes) };
  }

  select(artifact: Artifact, ids: string[], offset: number, limit: number) {
    if (artifact.kind !== "foundation") throw new Error("需要本体依据引用");
    if (!artifact.content.evidenceLibrary) {
      const entries = ((artifact.content.evidence ?? []) as Data[]).filter(entry => ids.includes(String(entry.id)));
      return { total: entries.length, items: entries.slice(offset, offset + limit) };
    }
    const predicate = "FROM foundation_evidence_refs r JOIN foundation_evidence e ON e.key=r.evidence_key WHERE r.owner=? AND json_extract(e.body,'$.id') IN (SELECT value FROM json_each(?))";
    const args = [`${artifact.id}@${artifact.version}`, JSON.stringify(ids)];
    const count = this.db.prepare(`SELECT COUNT(*) AS total ${predicate}`).get(...args) as {total:number};
    const rows = this.db.prepare(`SELECT e.body ${predicate} ORDER BY r.position LIMIT ? OFFSET ?`).all(...args, limit, offset) as {body:string}[];
    return {total:Number(count.total),items:rows.map(row=>JSON.parse(row.body) as Data)};
  }

  page(artifact: Artifact, offset: number, limit: number) {
    if (artifact.kind !== "foundation") throw new Error("需要本体依据引用");
    if (!artifact.content.evidenceLibrary) {
      const entries = (artifact.content.evidence ?? []) as Data[];
      return { total: entries.length, items: entries.slice(offset, offset + limit) };
    }
    const rows = this.db.prepare("SELECT e.body FROM foundation_evidence_refs r JOIN foundation_evidence e ON e.key=r.evidence_key WHERE r.owner=? ORDER BY r.position LIMIT ? OFFSET ?").all(`${artifact.id}@${artifact.version}`, limit, offset) as { body: string }[];
    return { total: Number((artifact.content.evidenceLibrary as Data).count), items: rows.map(row => JSON.parse(row.body) as Data) };
  }
}
