# durable-jobs

Checkpointed background jobs in TypeScript on the built-in `node:sqlite`. A job has three steps (read a document, extract fields, write a local report row). Each step result is committed in a transaction. A worker holds a lease renewed by heartbeats; if the worker process dies, the lease runs out, a new process takes the job over and continues from the last checkpoint instead of starting again. Clients submit with an `Idempotency-Key`, transient errors get bounded retries with backoff, permanent errors end in a readable failed status, and the report row cannot be written twice.

## Quick start

Node 22.13 or later (built-in `node:sqlite`, no native dependencies).

```bash
make install     # npm ci, pinned versions
make demo        # real worker processes, one SIGKILL, no API key, no cost
make test        # 21 tests, 4 of them kill real worker processes
make check       # typecheck + tests + demo
```

Run the pieces by hand:

```bash
make serve                                   # HTTP API on :8787, database .data/jobs.db
curl -s -X POST localhost:8787/jobs -H 'Idempotency-Key: order-1' -d '{"document":"INV-1001.txt"}'
make worker                                  # one worker, exits when the queue is empty
curl -s localhost:8787/jobs/<job_id>
```

Live extraction with a real model (costs money, needs a key, not run in this repo yet):

```bash
export ANTHROPIC_API_KEY=...
make live        # exits with code 2 and a message if the key is missing
```

## What the demo shows

Five jobs, two worker processes. Worker A is frozen right after `extract_fields` is committed and killed with SIGKILL. Worker B waits for A's lease to expire, takes the job over, skips the two finished steps and only runs `write_report`. Excerpt from a real run:

```
  HTTP POST /jobs key=demo-inv-1001 {"document":"INV-1001.txt"} -> 201 {"job_id":"job_e0150d49062b","created":true,...}
  HTTP POST /jobs key=demo-inv-1001 {"document":"INV-1001.txt"} -> 200 {"job_id":"job_e0150d49062b","created":false,...}
  HTTP POST /jobs key=demo-inv-1001 {"document":"INV-1002.txt"} -> 409 {"error":{"code":"IDEMPOTENCY_KEY_REUSED",...}}
worker-A     job_e0150d49062b extract_fields  checkpointed    running -> done  attempt=1
PAUSED after_checkpoint job=job_e0150d49062b step=extract_fields worker=worker-A
  killed worker-A pid=3504 signal=SIGKILL; reports for job_e0150d49062b: 0
...
worker-B     job_e0150d49062b                 lease expired   previous owner worker-A, 53ms ago
worker-B     job_e0150d49062b                 claimed         running -> running claim=2 TAKEOVER
worker-B     job_e0150d49062b read_document   RESUMED         from checkpoint, not re-run (attempts so far 1)
worker-B     job_e0150d49062b extract_fields  RESUMED         from checkpoint, not re-run (attempts so far 1)
worker-B     job_e0150d49062b write_report    started         pending -> running  attempt=1 mode=first_run
worker-B     job_e0150d49062b                 job             running -> succeeded

  INV-1001.txt (killed run)                        succeeded read_document=done/1 extract_fields=done/1 write_report=done/1 reports=1
  INV-1002.txt (2 injected transient faults)       succeeded read_document=done/1 extract_fields=done/3 write_report=done/1 reports=1
  INV-1003.txt (transient fault on every attempt)  failed    ... reports=0  RETRIES_EXHAUSTED: step extract_fields failed 3 times; ...
  INV-1004.txt (totals do not add up)              failed    ... reports=0  TOTAL_MISMATCH: line items sum to 3550 SEK but the invoice states 3950
  INV-9999.txt (file does not exist)               failed    ... reports=0  DOCUMENT_NOT_FOUND: no document named INV-9999.txt
  jobs in table: 5   report rows in table: 2
```

`done/1` is status and number of executions. The full event log (every claim, step start with its mode, checkpoint, failure and status transition) is in `evidence/fixture-*.jsonl`; its first line records code revision, dataset version and Node version.

## How it works

```
 client ──POST /jobs + Idempotency-Key──> submitJob ── one transaction ──> jobs (UNIQUE idempotency_key) + 3 pending steps
        <── 201 new | 200 replay | 409 key reused with another body

 worker loop (one process at a time)
   claim       BEGIN IMMEDIATE; pick queued job (run_after <= now) or running job whose lease expired;
               set lease_owner = me, lease_expires_at = now + lease
   heartbeat   every lease/3: extend the lease while lease_owner = me
   for each step:
     done?     load output from checkpoint, log step_resumed, do not run
     start     tx: fence (lease_owner = me), attempts + 1, log step_started mode = first_run | retry | rerun_after_crash
     run       handler(payload, outputs of earlier steps)
     ok        tx: fence, run commit effect (report INSERT ... ON CONFLICT(job_id) DO NOTHING),
                   step = done + output, last step -> job succeeded         [effect and checkpoint commit together]
     transient tx: step pending, job queued with run_after = now + base * 2^(attempt-1)   (until max attempts)
     permanent tx: step failed, job failed with {code, message, step, attempts}

 crash anywhere ─> heartbeats stop ─> lease expires ─> next claim is a takeover ─> resume at the first step not done
```

| File | Role |
| --- | --- |
| `src/store.ts` | Schema, WAL mode, `createJobStore`, `submitJob` (idempotency), `getJob` (public view), events. |
| `src/worker.ts` | `runWorker`: claim, lease, heartbeat, fencing, checkpoints, retries with backoff, hooks. |
| `src/pipeline.ts` | The three step handlers and the payload and field schemas. `write_report` is a commit effect. |
| `src/model/` | `ScriptedExtractor` (deterministic fixture) and `AnthropicExtractor` (live, forced tool call). |
| `src/server.ts` | `node:http` API: `POST /jobs`, `GET /jobs/:id`. |
| `src/view.ts` | zod schemas for the public JSON (`JobView`, `SubmitResponse`, `ApiError`). |
| `src/faults.ts` | Fault injection from `DJ_FAULTS` or code, keyed on the attempt number stored in the database. |
| `src/spawn.ts`, `src/cli/worker.ts` | Worker as a real OS process with pause hooks, used by the demo and the kill tests. |
| `test/crash.test.ts` | SIGKILL after a checkpoint, SIGKILL before a checkpoint, two kills in a row, crash loop bounded. |

## Interface for other projects

```ts
import { createJobStore, submitJob, runWorker, getJob, documentHandlers, ScriptedExtractor, startApiServer } from "durable-jobs"; // src/index.ts

const store = createJobStore(".data/jobs.db");
const { job_id, created } = submitJob(store, { document: "INV-1001.txt" }, "order-1");   // throws IdempotencyConflictError on 409 case
await runWorker(store, documentHandlers({ docsDir: "data/documents", extractor: new ScriptedExtractor() }), { leaseMs: 2000, maxAttempts: 3 });
getJob(store, job_id);  // JobView, same JSON as GET /jobs/:id
```

`runWorker(store, handlers, options)` takes any list of `{ name, run(ctx) => { output, commit? } }` handlers; `commit(db)` runs inside the checkpoint transaction. Throw `TransientError` or `PermanentError` to choose retry behaviour.

`GET /jobs/:id` returns (schema: `JobView` in `src/view.ts`):

```json
{
  "job_id": "job_e0150d49062b",
  "status": "queued | running | succeeded | failed",
  "idempotency_key": "demo-inv-1001",
  "payload": { "document": "INV-1001.txt" },
  "claims": 2,
  "lease": { "owner": "worker-B", "expires_at": "2026-10-30T10:00:01.000Z" },
  "run_after": "ISO time, only while queued for a retry, else null",
  "error": { "code": "RETRIES_EXHAUSTED", "message": "...", "transient": true, "step": "extract_fields", "attempts": 3 },
  "result": { "report_id": 1, "inserted": true, "invoice_number": "INV-1001", "total_cents": 487100, "currency": "SEK" },
  "created_at": "ISO time",
  "updated_at": "ISO time",
  "steps": [
    { "name": "read_document", "status": "pending | running | done | failed", "attempts": 1,
      "last_error": null, "started_at": "ISO time", "finished_at": "ISO time" }
  ]
}
```

`lease`, `error`, `result` and `run_after` are `null` when not applicable. `POST /jobs` returns `{ "job_id", "status", "created" }` with 201 or 200; errors are `{ "error": { "code", "message", "job_id?", "issues?" } }` with 400, 404, 405, 409 or 413.

## What this proves and what it does not

- Proven by tests with real processes: a worker killed with SIGKILL after a checkpoint, or in the middle of a step, is taken over by a new process that resumes from the last saved step; finished steps are not executed again; the report row exists exactly once. Repeated client keys do not create a second job, also under 8 parallel requests.
- Execution is **at-least-once per step**, not exactly-once. A step that was running when its worker died runs again (the log says `rerun_after_crash`). What is made idempotent is the *local* effect: the report row commits in the same transaction as the checkpoint and has `UNIQUE(job_id)`. Nothing here gives exactly-once delivery to an external system; see [DECISIONS.md](DECISIONS.md).
- One worker at a time was tested. The claim uses `BEGIN IMMEDIATE` and every write is fenced on the lease owner, which is the basis for several workers, but parallel workers are not tested and not claimed.
- The extractor in fixtures is a deterministic script over the document text. It proves the job machinery, not extraction quality. The live extractor exists as code and has not been run ([ACCEPTANCE.md](ACCEPTANCE.md)).
- All data is synthetic. See [data/README.md](data/README.md).

Built with AI assistance (Claude); every change is reviewed and run locally.
