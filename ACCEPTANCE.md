# Acceptance

Checked 2026-10-30 on Node 22.23.4, Linux x64. Fixture runs only (scripted extractor). One worker process at a time. "Not run" means not run, not passed.

| # | Criterion (from the plan) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | The process is stopped after a saved step and a new process continues the job | Passed | `test/crash.test.ts`: SIGKILL after `extract_fields` checkpoint, SIGKILL inside `write_report` before its checkpoint, two kills in a row then a third process; demo step 2 and 4 in `evidence/fixture-2026-10-30.jsonl` (`lease_expired`, `job_claimed takeover=true`, `step_resumed`) |
| 2 | A repeated client key does not create two separate jobs | Passed | `test/store.test.ts` (same key same body, key order ignored; same key other body rejected); `test/api.test.ts` (201 then 200 with the same id, 409 for another body, 8 parallel requests give one job); demo step 1 |
| 3 | Transient errors get bounded retries; permanent errors get a readable final status | Passed | `test/worker.test.ts`: 2 transient faults then success with backoff 30, 60 ms; always-transient ends `RETRIES_EXHAUSTED` after 3 attempts with message; `DOCUMENT_NOT_FOUND`, `TOTAL_MISMATCH`, `EXTRACTION_INCOMPLETE` fail after 1 attempt; crash loop ends `RETRIES_EXHAUSTED` (`test/crash.test.ts`); demo jobs INV-1002, INV-1003, INV-1004, INV-9999 |
| 4 | The local report row is not duplicated in the tested interruption cases | Passed | Every crash test asserts `countReports == 1` (or 0 for the failed one); `test/store.test.ts` replays the write effect and tries a raw duplicate INSERT (rejected by `UNIQUE`); demo check `report rows in table: 2` for 2 succeeded jobs |
| 5 | The log shows job id, step, status transitions and error cause, and tells resumed steps from re-run steps | Passed | `events` table, exported to `evidence/`; `step_started.mode` is `first_run`, `retry` or `rerun_after_crash`; `step_resumed` for skipped finished steps; asserted in `test/crash.test.ts` (both in events and console lines) |
| Show | Create job, kill process, restart, show final result, count report rows | Passed | `make demo`, output excerpt in README, log in `evidence/` |
| Live | One job through a real model (`make live`) | **Not run.** No API key in the build environment. The command exits with code 2 and a clear message without a key. | would write `evidence/live-*.jsonl` |

Extra checks beyond the plan: lease fencing (a worker that lost its lease cannot checkpoint), heartbeats keep a frozen but alive worker's lease, missing handler fails the job instead of hanging, request validation (missing key, bad JSON, path-like document names, unknown fields), WAL mode on.

## Open gaps

- Only one worker process at a time was tested. Concurrent workers are designed for (`BEGIN IMMEDIATE`, fencing) but not verified.
- No external side effects. Exactly-once delivery to an external system is not provided and not claimed.
- No live model run.
- Not yet tried by a second person from a clean checkout.
