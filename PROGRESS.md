# Progress

## 2026-10-30, session 1

Done: store (jobs, steps, reports, events; WAL), idempotent submit, worker with leases, heartbeats, fencing, checkpoints, bounded retries with backoff, commit effects; three-step document pipeline with scripted extractor; live extractor code; HTTP API; fault injection; worker as a separate process with pause hooks; 21 tests including four that SIGKILL real worker processes; fixture demo with evidence; docs.

Not done: live run (needs `ANTHROPIC_API_KEY`), concurrent workers, external side effects with an outbox.

Next: a test with two concurrent worker processes on one database; then decide whether agent-api-sdk calls this API over HTTP or imports `src/index.ts`.
