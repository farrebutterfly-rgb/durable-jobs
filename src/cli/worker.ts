/**
 * Worker process. Configured through the environment so tests and the demo can start it
 * as a real child process and kill it.
 *   DJ_DB                      database path (default .data/jobs.db)
 *   DJ_DOCS                    documents folder (default data/documents)
 *   DJ_FAULTS                  JSON array of fault rules, see src/faults.ts
 *   DJ_LEASE_MS, DJ_MAX_ATTEMPTS, DJ_BACKOFF_MS, DJ_POLL_MS
 *   DJ_UNTIL                   drained (default) | forever
 *   DJ_WORKER_ID
 *   DJ_PAUSE_AFTER_CHECKPOINT  step name: after that step is committed, print PAUSED and freeze
 *   DJ_PAUSE_BEFORE_CHECKPOINT step name: after the handler ran but before its commit, print PAUSED and freeze
 * A frozen worker keeps heartbeating, so its job is only taken over after it is killed.
 */
import { parseFaults, withFaults } from "../faults.ts";
import { formatEvent } from "../format.ts";
import { ScriptedExtractor } from "../model/scripted.ts";
import { documentHandlers } from "../pipeline.ts";
import { createJobStore } from "../store.ts";
import { runWorker, type CheckpointInfo } from "../worker.ts";

const env = process.env;
const num = (v: string | undefined) => (v ? Number(v) : undefined);
const store = createJobStore(env.DJ_DB ?? ".data/jobs.db");
if (env.DJ_QUIET !== "1") store.onEvent = (e) => console.log(formatEvent(e));

const freeze = (where: string, wanted: string | undefined) => (i: CheckpointInfo) => {
  if (i.step !== wanted) return;
  console.log(`PAUSED ${where} job=${i.jobId} step=${i.step} worker=${i.workerId}`);
  return new Promise<void>(() => {});
};

const extractor = new ScriptedExtractor();
const handlers = withFaults(documentHandlers({ docsDir: env.DJ_DOCS ?? "data/documents", extractor }), parseFaults(env.DJ_FAULTS));
const summary = await runWorker(store, handlers, {
  workerId: env.DJ_WORKER_ID,
  leaseMs: num(env.DJ_LEASE_MS),
  maxAttempts: num(env.DJ_MAX_ATTEMPTS),
  pollMs: num(env.DJ_POLL_MS),
  backoff: { baseMs: num(env.DJ_BACKOFF_MS) },
  until: env.DJ_UNTIL === "forever" ? "forever" : "drained",
  hooks: {
    afterCheckpoint: freeze("after_checkpoint", env.DJ_PAUSE_AFTER_CHECKPOINT),
    beforeCheckpoint: freeze("before_checkpoint", env.DJ_PAUSE_BEFORE_CHECKPOINT),
  },
});
console.log(`SUMMARY ${JSON.stringify(summary)}`);
store.close();
