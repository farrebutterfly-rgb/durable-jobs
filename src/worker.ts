import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { describeError, LeaseLostError, type ErrorInfo } from "./errors.ts";
import type { Json } from "./json.ts";
import { emit, tx, type JobStore } from "./store.ts";

export interface StepContext {
  jobId: string;
  step: string;
  /** 1 on the first execution of this step, then 2, 3 ... Read from the database, so it survives restarts. */
  attempt: number;
  payload: Json;
  /** Outputs of the earlier steps, loaded from their checkpoints. */
  outputs: Record<string, Json>;
  workerId: string;
}

export interface StepResult {
  /** Stored as the step checkpoint. */
  output: Json;
  /**
   * Optional local side effect. Runs inside the same transaction that writes the checkpoint,
   * so the effect and "step done" commit together or not at all. Its return value, if any,
   * replaces output as the stored checkpoint.
   */
  commit?: (db: DatabaseSync) => Json | void;
}

export interface StepHandler {
  name: string;
  run(ctx: StepContext): Promise<StepResult> | StepResult;
}

export interface CheckpointInfo {
  jobId: string;
  step: string;
  attempt: number;
  workerId: string;
}

export interface WorkerOptions {
  workerId?: string;
  /** A claimed job belongs to this worker until now + leaseMs, renewed by heartbeats. */
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  /** Executions per step, including the first one and crash re-runs. */
  maxAttempts?: number;
  backoff?: { baseMs?: number; factor?: number; maxMs?: number };
  /** "drained": return when no job is queued or running. "forever": run until signal aborts. */
  until?: "drained" | "forever";
  signal?: AbortSignal;
  /** Test and demo hooks. A hook may return a promise that never resolves to freeze the worker at that point. */
  hooks?: {
    beforeCheckpoint?: (i: CheckpointInfo) => void | Promise<void>;
    afterCheckpoint?: (i: CheckpointInfo) => void | Promise<void>;
  };
}

export interface WorkerSummary {
  workerId: string;
  claims: number;
  stepsRun: number;
  stepsResumed: number;
}

interface ClaimedJob {
  id: string;
  payload: string;
  claims: number;
}

interface StepRow {
  idx: number;
  name: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  output: string | null;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/**
 * Run jobs from the store, one at a time, with the given step handlers.
 * Every step result is checkpointed in a transaction; a job whose lease expired (worker died)
 * is taken over and resumed from its last checkpoint. Execution is at-least-once per step:
 * a step that was running when the worker died runs again. Local effects are made idempotent
 * by committing them with the checkpoint and by unique keys.
 */
export async function runWorker(store: JobStore, handlers: StepHandler[], opts: WorkerOptions = {}): Promise<WorkerSummary> {
  const workerId = opts.workerId ?? `w-${process.pid}-${randomUUID().slice(0, 4)}`;
  const leaseMs = opts.leaseMs ?? 2000;
  const heartbeatMs = opts.heartbeatMs ?? Math.max(50, Math.floor(leaseMs / 3));
  const pollMs = opts.pollMs ?? 100;
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseMs = opts.backoff?.baseMs ?? 200;
  const factor = opts.backoff?.factor ?? 2;
  const maxMs = opts.backoff?.maxMs ?? 5000;
  const until = opts.until ?? "drained";
  const byName = new Map(handlers.map((h) => [h.name, h]));
  const summary: WorkerSummary = { workerId, claims: 0, stepsRun: 0, stepsResumed: 0 };
  const db = store.db;

  tx(store, () => emit(store, null, workerId, "worker_started", { pid: process.pid, lease_ms: leaseMs, max_attempts: maxAttempts }));

  /** Inside a transaction: throw unless this worker still owns the job. This is the fence. */
  const fence = (jobId: string) => {
    const r = db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'").run(Date.now(), jobId, workerId);
    if (r.changes !== 1) throw new LeaseLostError(jobId, workerId);
  };

  const claim = (): ClaimedJob | undefined =>
    tx(store, () => {
      const now = Date.now();
      const row = db
        .prepare(
          `SELECT id, payload, status, claims, lease_owner, lease_expires_at FROM jobs
           WHERE (status = 'queued' AND run_after <= ?) OR (status = 'running' AND lease_expires_at < ?)
           ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(now, now) as { id: string; payload: string; status: string; claims: number; lease_owner: string | null; lease_expires_at: number | null } | undefined;
      if (!row) return undefined;
      db.prepare("UPDATE jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?, claims = claims + 1, updated_at = ? WHERE id = ?").run(workerId, now + leaseMs, now, row.id);
      if (row.status === "running") {
        emit(store, row.id, workerId, "lease_expired", { previous_owner: row.lease_owner, expired_ms_ago: now - (row.lease_expires_at ?? now) });
        emit(store, row.id, workerId, "job_claimed", { claim: row.claims + 1, takeover: true, from: "running", to: "running" });
      } else {
        emit(store, row.id, workerId, "job_claimed", { claim: row.claims + 1, takeover: false, from: "queued", to: "running" });
      }
      return { id: row.id, payload: row.payload, claims: row.claims + 1 };
    });

  const failJob = (jobId: string, step: StepRow, attempts: number, err: ErrorInfo, code = err.code) =>
    tx(store, () => {
      fence(jobId);
      const now = Date.now();
      db.prepare("UPDATE steps SET status = 'failed', last_error = ?, finished_at = ? WHERE job_id = ? AND idx = ?").run(JSON.stringify(err), now, jobId, step.idx);
      const jobErr = {
        code,
        message: code === "RETRIES_EXHAUSTED" ? `step ${step.name} failed ${attempts} times; last error ${err.code}: ${err.message}` : err.message,
        transient: err.transient,
        step: step.name,
        attempts,
      };
      db.prepare("UPDATE jobs SET status = 'failed', error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(jobErr), now, jobId);
      emit(store, jobId, workerId, "job_transition", { from: "running", to: "failed", step: step.name, error: jobErr });
    });

  async function processJob(job: ClaimedJob) {
    let lost = false;
    const hb = setInterval(() => {
      try {
        const r = db.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'").run(Date.now() + leaseMs, job.id, workerId);
        if (r.changes !== 1) lost = true;
      } catch {
        /* busy: the next beat tries again; the lease is 3 beats long */
      }
    }, heartbeatMs);

    try {
      const payload = JSON.parse(job.payload) as Json;
      const steps = db.prepare("SELECT idx, name, status, attempts, output FROM steps WHERE job_id = ? ORDER BY idx").all(job.id) as unknown as StepRow[];
      const outputs: Record<string, Json> = {};

      for (const [i, step] of steps.entries()) {
        if (lost) throw new LeaseLostError(job.id, workerId);
        const last = i === steps.length - 1;

        if (step.status === "done") {
          outputs[step.name] = JSON.parse(step.output ?? "null") as Json;
          summary.stepsResumed++;
          tx(store, () => emit(store, job.id, workerId, "step_resumed", { step: step.name, from_checkpoint: true, attempts_so_far: step.attempts }));
          continue;
        }

        const handler = byName.get(step.name);
        if (!handler) {
          failJob(job.id, step, step.attempts, { code: "NO_HANDLER", message: `no handler registered for step ${step.name}`, transient: false });
          return;
        }
        if (step.attempts >= maxAttempts) {
          // Budget already spent, for example by repeated crashes in this step.
          failJob(job.id, step, step.attempts, { code: "ATTEMPTS_SPENT", message: `step ${step.name} was started ${step.attempts} times without finishing`, transient: true }, "RETRIES_EXHAUSTED");
          return;
        }

        const attempt = step.attempts + 1;
        const mode = step.attempts === 0 ? "first_run" : step.status === "running" ? "rerun_after_crash" : "retry";
        tx(store, () => {
          fence(job.id);
          db.prepare("UPDATE steps SET status = 'running', attempts = ?, started_at = ? WHERE job_id = ? AND idx = ?").run(attempt, Date.now(), job.id, step.idx);
          emit(store, job.id, workerId, "step_started", { step: step.name, attempt, mode, from: step.status, to: "running" });
        });
        summary.stepsRun++;

        let result: StepResult;
        try {
          result = await handler.run({ jobId: job.id, step: step.name, attempt, payload, outputs: { ...outputs }, workerId });
        } catch (e) {
          const err = describeError(e);
          if (err.transient && attempt < maxAttempts) {
            const backoff = Math.min(maxMs, baseMs * factor ** (attempt - 1));
            tx(store, () => {
              fence(job.id);
              const now = Date.now();
              db.prepare("UPDATE steps SET status = 'pending', last_error = ? WHERE job_id = ? AND idx = ?").run(JSON.stringify(err), job.id, step.idx);
              db.prepare("UPDATE jobs SET status = 'queued', run_after = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(now + backoff, now, job.id);
              emit(store, job.id, workerId, "step_failed", { step: step.name, attempt, error: err, will_retry: true, backoff_ms: backoff, from: "running", to: "pending" });
              emit(store, job.id, workerId, "job_transition", { from: "running", to: "queued", reason: "retry_backoff", run_after_ms: backoff });
            });
          } else {
            tx(store, () => emit(store, job.id, workerId, "step_failed", { step: step.name, attempt, error: err, will_retry: false, from: "running", to: "failed" }));
            failJob(job.id, step, attempt, err, err.transient ? "RETRIES_EXHAUSTED" : err.code);
          }
          return;
        }

        const info = { jobId: job.id, step: step.name, attempt, workerId };
        await opts.hooks?.beforeCheckpoint?.(info);
        if (lost) throw new LeaseLostError(job.id, workerId);
        tx(store, () => {
          fence(job.id);
          const committed = result.commit?.(db);
          const output = committed === undefined ? result.output : committed;
          const now = Date.now();
          db.prepare("UPDATE steps SET status = 'done', output = ?, last_error = NULL, finished_at = ? WHERE job_id = ? AND idx = ?").run(JSON.stringify(output), now, job.id, step.idx);
          emit(store, job.id, workerId, "step_checkpointed", { step: step.name, attempt, from: "running", to: "done" });
          outputs[step.name] = output;
          if (last) {
            db.prepare("UPDATE jobs SET status = 'succeeded', result = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(output), now, job.id);
            emit(store, job.id, workerId, "job_transition", { from: "running", to: "succeeded" });
          }
        });
        await opts.hooks?.afterCheckpoint?.(info);
      }
    } catch (e) {
      if (e instanceof LeaseLostError) {
        tx(store, () => emit(store, job.id, workerId, "lease_lost", { message: e.message }));
        return;
      }
      throw e;
    } finally {
      clearInterval(hb);
    }
  }

  // Earliest moment something may become claimable: a retry's run_after or a lease expiry.
  const active = () =>
    db
      .prepare("SELECT COUNT(*) AS n, MIN(CASE WHEN status = 'queued' THEN run_after ELSE lease_expires_at + 1 END) AS next FROM jobs WHERE status IN ('queued','running')")
      .get() as { n: number; next: number | null };

  while (!opts.signal?.aborted) {
    const job = claim();
    if (job) {
      summary.claims++;
      await processJob(job);
      continue;
    }
    const a = active();
    if (until === "drained" && Number(a.n) === 0) break;
    const wait = a.next != null ? Math.max(10, Math.min(pollMs, a.next - Date.now())) : pollMs;
    await sleep(wait, opts.signal);
  }

  tx(store, () => emit(store, null, workerId, "worker_stopped", { claims: summary.claims, steps_run: summary.stepsRun, steps_resumed: summary.stepsResumed }));
  return summary;
}
