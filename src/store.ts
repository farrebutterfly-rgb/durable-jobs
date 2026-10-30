import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { IdempotencyConflictError } from "./errors.ts";
import { canonicalJson, sha256, type Json } from "./json.ts";
import { JobView } from "./view.ts";

/** Steps every job gets unless submitJob is told otherwise. Matches the document pipeline. */
export const DEFAULT_STEPS = ["read_document", "extract_fields", "write_report"] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  idempotency_key  TEXT NOT NULL UNIQUE,
  payload_hash     TEXT NOT NULL,
  payload          TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  claims           INTEGER NOT NULL DEFAULT 0,
  lease_owner      TEXT,
  lease_expires_at INTEGER,
  run_after        INTEGER NOT NULL,
  error            TEXT,
  result           TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_runnable ON jobs (status, run_after, created_at);

CREATE TABLE IF NOT EXISTS steps (
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  idx         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  output      TEXT,
  started_at  INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (job_id, idx),
  UNIQUE (job_id, name)
);

-- The local side effect. UNIQUE(job_id) means a second write for the same job cannot
-- create a second row, whatever the worker does.
CREATE TABLE IF NOT EXISTS reports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  document       TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  supplier       TEXT NOT NULL,
  currency       TEXT NOT NULL,
  total_cents    INTEGER NOT NULL,
  due_date       TEXT NOT NULL,
  extracted_by   TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  job_id TEXT,
  worker TEXT,
  type   TEXT NOT NULL,
  data   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job ON events (job_id, seq);
`;

export interface StoredEvent {
  seq: number;
  ts: string;
  job_id: string | null;
  worker: string | null;
  type: string;
  [k: string]: unknown;
}

export interface JobStore {
  readonly path: string;
  readonly db: DatabaseSync;
  /** Called after commit for every event written in that transaction. Used for console output. */
  onEvent?: (e: StoredEvent) => void;
  close(): void;
}

interface StoreInternals extends JobStore {
  pending: StoredEvent[];
}

/** Open (or create) the job database. WAL mode, foreign keys on, 5 s busy timeout for cross-process locking. */
export function createJobStore(path: string): JobStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec("PRAGMA busy_timeout = 5000"); // set by pragma, not the constructor option, which needs a newer Node 22
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);
  const store: StoreInternals = { path, db, pending: [], close: () => db.close() };
  return store;
}

/**
 * Run fn inside BEGIN IMMEDIATE ... COMMIT. IMMEDIATE takes the write lock up front, so two
 * processes cannot both read "queued" and both claim the same job. Events emitted inside are
 * only echoed after a successful commit.
 */
export function tx<T>(store: JobStore, fn: () => T): T {
  const s = store as StoreInternals;
  s.db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    s.db.exec("COMMIT");
    const flushed = s.pending.splice(0);
    for (const e of flushed) s.onEvent?.(e);
    return r;
  } catch (e) {
    if (s.db.isTransaction) s.db.exec("ROLLBACK");
    s.pending.length = 0;
    throw e;
  }
}

/** Write a log event. Call inside tx() so the event and the state change commit together. */
export function emit(store: JobStore, jobId: string | null, worker: string | null, type: string, data: Record<string, unknown> = {}) {
  const ts = Date.now();
  const r = store.db
    .prepare("INSERT INTO events (ts, job_id, worker, type, data) VALUES (?, ?, ?, ?, ?)")
    .run(ts, jobId, worker, type, JSON.stringify(data));
  const e: StoredEvent = { seq: Number(r.lastInsertRowid), ts: new Date(ts).toISOString(), job_id: jobId, worker, type, ...data };
  const s = store as StoreInternals;
  if (s.db.isTransaction) s.pending.push(e);
  else s.onEvent?.(e);
}

export interface SubmitResult {
  job_id: string;
  /** false when the key was seen before with the same body: the existing job is returned. */
  created: boolean;
  status: JobView["status"];
}

/**
 * Create a job, or return the existing one for a repeated idempotency key.
 * Same key + same payload (canonical JSON) returns the same job. Same key + different payload
 * throws IdempotencyConflictError. The key is UNIQUE in the table, so even two racing
 * processes cannot create two jobs for one key.
 */
export function submitJob(store: JobStore, payload: Json, idempotencyKey: string, steps: readonly string[] = DEFAULT_STEPS): SubmitResult {
  if (!idempotencyKey) throw new Error("idempotencyKey is required");
  if (steps.length === 0) throw new Error("a job needs at least one step");
  const body = canonicalJson(payload);
  const hash = sha256(body);
  const r = tx<SubmitResult | { conflict: string }>(store, () => {
    const existing = store.db.prepare("SELECT id, payload_hash, status FROM jobs WHERE idempotency_key = ?").get(idempotencyKey) as
      | { id: string; payload_hash: string; status: JobView["status"] }
      | undefined;
    if (existing) {
      if (existing.payload_hash !== hash) {
        // Logged and committed, then thrown below, so the rejected attempt stays in the log.
        emit(store, existing.id, null, "submit_conflict", { idempotency_key: idempotencyKey, payload });
        return { conflict: existing.id } as const;
      }
      emit(store, existing.id, null, "submit_replayed", { idempotency_key: idempotencyKey, status: existing.status });
      return { job_id: existing.id, created: false, status: existing.status };
    }
    const id = `job_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = Date.now();
    store.db
      .prepare("INSERT INTO jobs (id, idempotency_key, payload_hash, payload, status, run_after, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)")
      .run(id, idempotencyKey, hash, body, now, now, now);
    const ins = store.db.prepare("INSERT INTO steps (job_id, idx, name, status) VALUES (?, ?, ?, 'pending')");
    steps.forEach((name, i) => ins.run(id, i, name));
    emit(store, id, null, "job_submitted", { idempotency_key: idempotencyKey, payload, steps: [...steps], to: "queued" });
    return { job_id: id, created: true, status: "queued" as const };
  });
  if ("conflict" in r) throw new IdempotencyConflictError(idempotencyKey, r.conflict);
  return r;
}

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const parse = (s: string | null) => (s == null ? null : (JSON.parse(s) as Json));

interface JobRow {
  id: string; idempotency_key: string; payload: string; status: JobView["status"]; claims: number;
  lease_owner: string | null; lease_expires_at: number | null; run_after: number; error: string | null;
  result: string | null; created_at: number; updated_at: number;
}
interface StepRow {
  idx: number; name: string; status: "pending" | "running" | "done" | "failed"; attempts: number;
  last_error: string | null; output: string | null; started_at: number | null; finished_at: number | null;
}

/** The public JSON shape of a job, as served by GET /jobs/:id. See JobView in view.ts. */
export function getJob(store: JobStore, jobId: string): JobView | undefined {
  const j = store.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
  if (!j) return undefined;
  const steps = store.db.prepare("SELECT * FROM steps WHERE job_id = ? ORDER BY idx").all(jobId) as unknown as StepRow[];
  const view: JobView = {
    job_id: j.id,
    status: j.status,
    idempotency_key: j.idempotency_key,
    payload: parse(j.payload),
    claims: j.claims,
    lease: j.lease_owner ? { owner: j.lease_owner, expires_at: iso(j.lease_expires_at)! } : null,
    run_after: j.status === "queued" ? iso(j.run_after) : null,
    error: parse(j.error) as JobView["error"],
    result: parse(j.result),
    created_at: iso(j.created_at)!,
    updated_at: iso(j.updated_at)!,
    steps: steps.map((s) => ({
      name: s.name,
      status: s.status,
      attempts: s.attempts,
      last_error: parse(s.last_error) as JobView["steps"][number]["last_error"],
      started_at: iso(s.started_at),
      finished_at: iso(s.finished_at),
    })),
  };
  return JobView.parse(view);
}

export function listEvents(store: JobStore, jobId?: string): StoredEvent[] {
  const rows = (jobId
    ? store.db.prepare("SELECT * FROM events WHERE job_id = ? ORDER BY seq").all(jobId)
    : store.db.prepare("SELECT * FROM events ORDER BY seq").all()) as unknown as { seq: number; ts: number; job_id: string | null; worker: string | null; type: string; data: string }[];
  return rows.map((r) => ({ seq: r.seq, ts: new Date(r.ts).toISOString(), job_id: r.job_id, worker: r.worker, type: r.type, ...(JSON.parse(r.data) as object) }));
}

export function countReports(store: JobStore, jobId?: string): number {
  const r = (jobId
    ? store.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE job_id = ?").get(jobId)
    : store.db.prepare("SELECT COUNT(*) AS n FROM reports").get()) as { n: number };
  return Number(r.n);
}

export function listJobIds(store: JobStore): string[] {
  return (store.db.prepare("SELECT id FROM jobs ORDER BY created_at, rowid").all() as { id: string }[]).map((r) => r.id);
}
