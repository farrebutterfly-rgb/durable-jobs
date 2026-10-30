import type { StoredEvent } from "./store.ts";

/** One readable console line per event. The JSONL evidence keeps the full event. */
export function formatEvent(e: StoredEvent): string {
  const who = (e.worker ?? "api").padEnd(12);
  const job = (e.job_id ?? "").padEnd(16);
  const step = typeof e.step === "string" ? e.step.padEnd(15) : "".padEnd(15);
  const err = e.error as { code?: string; message?: string } | undefined;
  switch (e.type) {
    case "job_submitted": return `${who} ${job} ${step} submitted       key=${e.idempotency_key} -> queued`;
    case "submit_replayed": return `${who} ${job} ${step} replayed        key=${e.idempotency_key} (same body, same job)`;
    case "submit_conflict": return `${who} ${job} ${step} conflict        key=${e.idempotency_key} (different body, rejected)`;
    case "worker_started": return `${who} ${"".padEnd(16)} ${step} worker up       pid=${e.pid} lease=${e.lease_ms}ms max_attempts=${e.max_attempts}`;
    case "worker_stopped": return `${who} ${"".padEnd(16)} ${step} worker done     claims=${e.claims} steps_run=${e.steps_run} steps_resumed=${e.steps_resumed}`;
    case "lease_expired": return `${who} ${job} ${step} lease expired   previous owner ${e.previous_owner}, ${e.expired_ms_ago}ms ago`;
    case "job_claimed": return `${who} ${job} ${step} claimed         ${e.from} -> ${e.to} claim=${e.claim}${e.takeover ? " TAKEOVER" : ""}`;
    case "step_resumed": return `${who} ${job} ${step} RESUMED         from checkpoint, not re-run (attempts so far ${e.attempts_so_far})`;
    case "step_started": return `${who} ${job} ${step} started         ${e.from} -> running  attempt=${e.attempt} mode=${e.mode}${e.mode === "rerun_after_crash" ? "  RE-RUN" : ""}`;
    case "step_checkpointed": return `${who} ${job} ${step} checkpointed    running -> done  attempt=${e.attempt}`;
    case "step_failed": return `${who} ${job} ${step} failed          ${err?.code}: ${err?.message}${e.will_retry ? `  retry in ${e.backoff_ms}ms` : "  no retry"}`;
    case "job_transition": return `${who} ${job} ${step} job             ${e.from} -> ${e.to}${e.reason ? ` (${e.reason})` : ""}${err ? `  ${err.code}` : ""}`;
    case "lease_lost": return `${who} ${job} ${step} lease lost      ${e.message}`;
    default: return `${who} ${job} ${step} ${e.type}`;
  }
}
