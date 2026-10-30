import { test } from "node:test";
import assert from "node:assert/strict";
import { TransientError } from "../src/errors.ts";
import { withFaults } from "../src/faults.ts";
import { countReports, getJob, submitJob } from "../src/store.ts";
import { runWorker, type StepHandler } from "../src/worker.ts";
import { events, handlers, tmpStore } from "./helpers.ts";

const fast = { leaseMs: 500, pollMs: 20, backoff: { baseMs: 30 } };

test("transient errors are retried with growing backoff and the job then succeeds", async () => {
  const s = tmpStore();
  const { job_id } = submitJob(s, { document: "INV-1001.txt" }, "k");
  await runWorker(s, withFaults(handlers(), [{ step: "extract_fields", transient_attempts: 2 }]), { ...fast, maxAttempts: 3 });
  const v = getJob(s, job_id)!;
  assert.equal(v.status, "succeeded");
  assert.deepEqual(v.steps.map((x) => x.attempts), [1, 3, 1]);
  const fails = events(s, job_id, "step_failed");
  assert.deepEqual(fails.map((e) => e.backoff_ms), [30, 60]);
  assert.ok(fails.every((e) => e.will_retry === true));
  // read_document was checkpointed once and resumed on each retry, never re-run.
  assert.equal(events(s, job_id, "step_started").filter((e) => e.step === "read_document").length, 1);
  assert.equal(events(s, job_id, "step_resumed").filter((e) => e.step === "read_document").length, 2);
  assert.deepEqual(events(s, job_id, "step_started").filter((e) => e.step === "extract_fields").map((e) => e.mode), ["first_run", "retry", "retry"]);
  assert.equal(countReports(s, job_id), 1);
  s.close();
});

test("retry exhaustion ends in a readable failed status and no report", async () => {
  const s = tmpStore();
  const { job_id } = submitJob(s, { document: "INV-1001.txt" }, "k");
  await runWorker(s, withFaults(handlers(), [{ step: "extract_fields", always: "transient" }]), { ...fast, maxAttempts: 3 });
  const v = getJob(s, job_id)!;
  assert.equal(v.status, "failed");
  assert.equal(v.error?.code, "RETRIES_EXHAUSTED");
  assert.equal(v.error?.step, "extract_fields");
  assert.equal(v.error?.attempts, 3);
  assert.match(v.error!.message, /failed 3 times; last error INJECTED_TRANSIENT/);
  assert.deepEqual(v.steps.map((x) => x.status), ["done", "failed", "pending"]);
  assert.equal(v.lease, null);
  assert.equal(countReports(s, job_id), 0);
  s.close();
});

test("permanent errors fail at once with the cause, no retries", async () => {
  const s = tmpStore();
  const missing = submitJob(s, { document: "INV-9999.txt" }, "a").job_id;
  const mismatch = submitJob(s, { document: "INV-1004.txt" }, "b").job_id;
  const incomplete = submitJob(s, { document: "INV-1005.txt" }, "c").job_id;
  await runWorker(s, handlers(), fast);
  const e = (id: string) => getJob(s, id)!.error!;
  assert.deepEqual([e(missing).code, e(missing).attempts, e(missing).step], ["DOCUMENT_NOT_FOUND", 1, "read_document"]);
  assert.deepEqual([e(mismatch).code, e(mismatch).attempts], ["TOTAL_MISMATCH", 1]);
  assert.match(e(mismatch).message, /sum to 3550 SEK but the invoice states 3950/);
  assert.deepEqual([e(incomplete).code, e(incomplete).message], ["EXTRACTION_INCOMPLETE", "missing or invalid fields: due_date"]);
  assert.equal(countReports(s), 0);
  s.close();
});

test("unclassified errors count as transient and are still bounded", async () => {
  const s = tmpStore();
  const { job_id } = submitJob(s, { document: "INV-1001.txt" }, "k");
  const hs = handlers().map((h): StepHandler => (h.name === "read_document" ? { name: h.name, run: () => { throw new Error("socket hang up"); } } : h));
  await runWorker(s, hs, { ...fast, maxAttempts: 2 });
  const v = getJob(s, job_id)!;
  assert.equal(v.error?.code, "RETRIES_EXHAUSTED");
  assert.equal(v.steps[0]?.last_error?.code, "UNCLASSIFIED");
  s.close();
});

test("a worker without a handler for a step fails the job instead of hanging", async () => {
  const s = tmpStore();
  const { job_id } = submitJob(s, { document: "INV-1001.txt" }, "k");
  await runWorker(s, handlers().slice(0, 2), fast);
  assert.equal(getJob(s, job_id)!.error?.code, "NO_HANDLER");
  s.close();
});

test("a worker that lost its lease cannot checkpoint (fencing)", async () => {
  const s = tmpStore();
  const { job_id } = submitJob(s, { document: "INV-1001.txt" }, "k");
  const hs = handlers().map((h): StepHandler =>
    h.name !== "extract_fields" ? h : {
      name: h.name,
      async run(ctx) {
        // Simulate another worker taking the job over while this one is still working.
        s.db.prepare("UPDATE jobs SET lease_owner = 'intruder' WHERE id = ?").run(ctx.jobId);
        return h.run(ctx);
      },
    });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  await runWorker(s, hs, { ...fast, until: "forever", signal: ac.signal });
  const v = getJob(s, job_id)!;
  assert.equal(v.steps[1]?.status, "running", "checkpoint must not be written");
  assert.equal(v.lease?.owner, "intruder");
  assert.equal(events(s, job_id, "lease_lost").length, 1);
  assert.equal(countReports(s), 0);
  s.close();
});

test("TransientError from a handler is retried; job records each attempt", async () => {
  const s = tmpStore();
  const { job_id } = submitJob(s, { document: "INV-1003.txt" }, "k");
  let n = 0;
  const hs = handlers().map((h): StepHandler => (h.name === "write_report" ? { name: h.name, run: (ctx) => { if (++n === 1) throw new TransientError("DISK_BUSY", "try again"); return h.run(ctx); } } : h));
  await runWorker(s, hs, fast);
  const v = getJob(s, job_id)!;
  assert.equal(v.status, "succeeded");
  assert.equal(v.steps[2]?.attempts, 2);
  assert.equal(countReports(s, job_id), 1);
  s.close();
});
