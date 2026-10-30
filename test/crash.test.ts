import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnWorker } from "../src/spawn.ts";
import { countReports, getJob, listEvents, submitJob } from "../src/store.ts";
import { events, tmpStore } from "./helpers.ts";

/**
 * These tests start the worker as a real OS process, freeze it at a hook, SIGKILL it,
 * start a fresh process and check what the second one did.
 */
const LEASE = "600";
const env = (file: string, extra: Record<string, string> = {}) => ({ DJ_DB: file, DJ_LEASE_MS: LEASE, DJ_POLL_MS: "25", DJ_BACKOFF_MS: "30", ...extra });

test("SIGKILL after extract_fields is checkpointed: new process resumes, finished steps are not re-run, one report", async () => {
  const s = tmpStore();
  const { job_id } = submitJob(s, { document: "INV-1001.txt" }, "crash-1");

  const a = spawnWorker(env(s.file, { DJ_WORKER_ID: "worker-A", DJ_PAUSE_AFTER_CHECKPOINT: "extract_fields" }));
  await a.waitFor(/^PAUSED after_checkpoint/);
  // While A is alive its heartbeats keep the lease, well past one lease period.
  await sleep(Number(LEASE) * 2);
  let v = getJob(s, job_id)!;
  assert.equal(v.lease?.owner, "worker-A");
  assert.deepEqual(v.steps.map((x) => x.status), ["done", "done", "pending"]);

  a.child.kill("SIGKILL");
  const ea = await a.exited;
  assert.equal(ea.signal, "SIGKILL");
  assert.equal(countReports(s, job_id), 0);

  const b = spawnWorker(env(s.file, { DJ_WORKER_ID: "worker-B" }));
  const eb = await b.exited;
  assert.equal(eb.code, 0);

  v = getJob(s, job_id)!;
  assert.equal(v.status, "succeeded");
  assert.deepEqual(v.steps.map((x) => x.attempts), [1, 1, 1], "every step executed exactly once across both processes");
  assert.equal(v.claims, 2);
  assert.equal(countReports(s, job_id), 1);

  const evB = events(s, job_id).filter((e) => e.worker === "worker-B");
  assert.ok(evB.some((e) => e.type === "lease_expired" && e.previous_owner === "worker-A"));
  assert.ok(evB.some((e) => e.type === "job_claimed" && e.takeover === true));
  assert.deepEqual(evB.filter((e) => e.type === "step_resumed").map((e) => e.step), ["read_document", "extract_fields"]);
  assert.deepEqual(evB.filter((e) => e.type === "step_started").map((e) => [e.step, e.mode]), [["write_report", "first_run"]]);
  assert.ok(b.lines.some((l) => /extract_fields\s+RESUMED/.test(l)), "console log marks resumed steps");
  s.close();
});

test("SIGKILL inside write_report before its checkpoint: the step re-runs, the report is still written once", async () => {
  const s = tmpStore();
  const { job_id } = submitJob(s, { document: "INV-1002.txt" }, "crash-2");
  const a = spawnWorker(env(s.file, { DJ_WORKER_ID: "worker-A", DJ_PAUSE_BEFORE_CHECKPOINT: "write_report" }));
  await a.waitFor(/^PAUSED before_checkpoint/);
  a.child.kill("SIGKILL");
  await a.exited;
  assert.equal(getJob(s, job_id)!.steps[2]?.status, "running");

  const b = spawnWorker(env(s.file, { DJ_WORKER_ID: "worker-B" }));
  assert.equal((await b.exited).code, 0);
  const v = getJob(s, job_id)!;
  assert.equal(v.status, "succeeded");
  assert.deepEqual(v.steps.map((x) => x.attempts), [1, 1, 2]);
  const started = events(s, job_id, "step_started").filter((e) => e.worker === "worker-B");
  assert.deepEqual(started.map((e) => [e.step, e.mode]), [["write_report", "rerun_after_crash"]]);
  assert.ok(b.lines.some((l) => /write_report\s+started.*RE-RUN/.test(l)), "console log marks re-run steps");
  assert.equal(countReports(s, job_id), 1);
  assert.equal(countReports(s), 1);
  s.close();
});

test("two kills in a row on the same job, third process finishes it, still one report", async () => {
  const s = tmpStore();
  const { job_id } = submitJob(s, { document: "INV-1003.txt" }, "crash-3");
  const a = spawnWorker(env(s.file, { DJ_WORKER_ID: "worker-A", DJ_PAUSE_AFTER_CHECKPOINT: "read_document" }));
  await a.waitFor(/^PAUSED/);
  a.child.kill("SIGKILL");
  await a.exited;
  const b = spawnWorker(env(s.file, { DJ_WORKER_ID: "worker-B", DJ_PAUSE_BEFORE_CHECKPOINT: "write_report" }));
  await b.waitFor(/^PAUSED/);
  b.child.kill("SIGKILL");
  await b.exited;
  const c = spawnWorker(env(s.file, { DJ_WORKER_ID: "worker-C" }));
  assert.equal((await c.exited).code, 0);
  const v = getJob(s, job_id)!;
  assert.equal(v.status, "succeeded");
  assert.equal(v.claims, 3);
  assert.deepEqual(v.steps.map((x) => x.attempts), [1, 1, 2]);
  assert.equal(countReports(s), 1);
  const takeovers = listEvents(s, job_id).filter((e) => e.type === "lease_expired").map((e) => `${e.previous_owner}->${e.worker}`);
  assert.deepEqual(takeovers, ["worker-A->worker-B", "worker-B->worker-C"]);
  s.close();
});

test("crash loop in one step is bounded: repeated kills spend the attempt budget and the job fails readably", async () => {
  const s = tmpStore();
  const { job_id } = submitJob(s, { document: "INV-1001.txt" }, "crash-4");
  for (const id of ["A", "B"]) {
    const w = spawnWorker(env(s.file, { DJ_WORKER_ID: `worker-${id}`, DJ_MAX_ATTEMPTS: "2", DJ_PAUSE_BEFORE_CHECKPOINT: "extract_fields" }));
    await w.waitFor(/^PAUSED/);
    w.child.kill("SIGKILL");
    await w.exited;
  }
  const c = spawnWorker(env(s.file, { DJ_WORKER_ID: "worker-C", DJ_MAX_ATTEMPTS: "2" }));
  assert.equal((await c.exited).code, 0);
  const v = getJob(s, job_id)!;
  assert.equal(v.status, "failed");
  assert.equal(v.error?.code, "RETRIES_EXHAUSTED");
  assert.match(v.error!.message, /started 2 times without finishing/);
  assert.equal(countReports(s), 0);
  s.close();
});
