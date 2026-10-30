# Decisions

**At-least-once execution, idempotent local effect. Not exactly-once.** A step runs, then its result is committed. If the process dies between the two, the work is lost and the step runs again; there is no way around that window without the effect itself being transactional. So the guarantee is: every step runs at least once until it is checkpointed, and a checkpointed step is never run again by this system. The one local side effect, the report row, is written *inside* the checkpoint transaction (a `commit` effect) and the table has `UNIQUE(job_id)` with `ON CONFLICT DO NOTHING`. Either the row and "step done" both commit or neither does, and even a duplicated or buggy worker cannot add a second row. For an effect outside the database (an email, a payment, a webhook) none of this holds: the step could run twice and the remote side would see two calls. That needs an idempotency key honoured by the receiver, or an outbox table plus a deduplicating consumer. Neither is built or claimed here.

**SQLite via `node:sqlite`, WAL mode.** Zero native dependencies, installs anywhere Node 22 runs, and it is a real transactional store with real file locking between processes. WAL lets the API read while a worker writes. `busy_timeout` handles short lock waits. The module is still marked experimental in Node 22; the warning is silenced in the npm scripts, not hidden from the docs.

**Leases with heartbeats, not "running means taken".** A claim sets `lease_owner` and `lease_expires_at`; the worker renews every lease/3. Status `running` with an expired lease means the owner is gone, and the next claim is a takeover (logged as `lease_expired` + `job_claimed takeover=true`). A frozen but alive worker keeps its lease, which the kill test checks before killing.

**Fencing on every write.** Each step-start and checkpoint transaction first runs `UPDATE jobs ... WHERE lease_owner = me`. If another worker has taken the job, the update matches nothing, the transaction rolls back and the commit effect never runs. Tested with a simulated takeover mid-step.

**`BEGIN IMMEDIATE` for claims and submits.** Taking the write lock at the start means two processes cannot both read the same job as claimable, and two identical POSTs cannot both miss the existing key. The 8-parallel-requests test covers submit; the `UNIQUE(idempotency_key)` constraint is the backstop.

**Idempotency key semantics.** Same key and same body (canonical JSON, key order ignored) returns the existing job with 200. Same key with another body is 409, because silently returning a job for different input hides a client bug. The rejected attempt is still logged. Keys never expire in this version.

**Retry policy.** `TransientError` and unknown errors retry with exponential backoff (`base * 2^(attempt-1)`, capped); `PermanentError` fails at once. A retry releases the job (`queued` with `run_after`) instead of sleeping while holding the lease, so the worker can do other jobs meanwhile. Attempts count every start of a step, including starts that were cut off by a crash, so a step that kills its worker every time also runs out of budget (tested: two kills, then `RETRIES_EXHAUSTED`). No jitter, so tests and the demo are deterministic; with many workers you would add it.

**Log as a table.** Events are rows written in the same transaction as the state change they describe, so the log cannot claim a checkpoint that was rolled back. Each step start says `first_run`, `retry` or `rerun_after_crash`; a skipped finished step says `step_resumed`. The demo exports the table to `evidence/`.

**Real processes in tests.** The crash tests spawn `src/cli/worker.ts`, freeze it with an env-controlled hook at an exact point (after a checkpoint, or after the handler but before its checkpoint), and send SIGKILL from outside. Killing in-process (throwing, aborting) would not prove that state on disk is enough to resume.

**Fault injection keyed on stored attempts.** `DJ_FAULTS` rules like "fail attempts 1..2 of extract_fields" read the attempt number from the database, so the same rule means the same thing after a restart.

**Scripted extractor.** Regexes over the synthetic invoice text; every field and the total come from the document. The pipeline still validates with zod and checks that line items add up to the stated total, so a bad document fails permanently with a cause (`TOTAL_MISMATCH`, `EXTRACTION_INCOMPLETE`). The live extractor uses the same zod schema as a forced tool-call schema; API 429/5xx become transient errors.

**Not done on purpose.** Several concurrent workers (designed for, not tested), job cancellation, key expiry, priority queues, external side effects with an outbox, a dead-letter queue beyond the `failed` status. Each is a real feature; none is needed to show restart recovery and idempotent local writes.
