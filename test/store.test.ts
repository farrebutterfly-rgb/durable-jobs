import { test } from "node:test";
import assert from "node:assert/strict";
import { IdempotencyConflictError } from "../src/errors.ts";
import { countReports, getJob, submitJob, tx } from "../src/store.ts";
import { runWorker } from "../src/worker.ts";
import { JobView } from "../src/view.ts";
import { events, handlers, tmpStore } from "./helpers.ts";

test("same idempotency key and same body returns the same job, key order does not matter", () => {
  const s = tmpStore();
  const a = submitJob(s, { document: "INV-1001.txt", tag: { x: 1, y: 2 } }, "key-1");
  const b = submitJob(s, { tag: { y: 2, x: 1 }, document: "INV-1001.txt" }, "key-1");
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.job_id, a.job_id);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 1);
  s.close();
});

test("same idempotency key with a different body is rejected and creates nothing", () => {
  const s = tmpStore();
  const a = submitJob(s, { document: "INV-1001.txt" }, "key-1");
  assert.throws(() => submitJob(s, { document: "INV-1002.txt" }, "key-1"), (e: unknown) => e instanceof IdempotencyConflictError && e.existingJobId === a.job_id);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 1);
  assert.equal(events(s, a.job_id, "submit_conflict").length, 1);
  s.close();
});

test("a new job has three pending steps and a valid public view", () => {
  const s = tmpStore();
  const { job_id } = submitJob(s, { document: "INV-1001.txt" }, "k");
  const v = getJob(s, job_id)!;
  assert.doesNotThrow(() => JobView.parse(v));
  assert.equal(v.status, "queued");
  assert.deepEqual(v.steps.map((x) => [x.name, x.status, x.attempts]), [["read_document", "pending", 0], ["extract_fields", "pending", 0], ["write_report", "pending", 0]]);
  s.close();
});

test("report write is idempotent: running the commit effect twice leaves one row", async () => {
  const s = tmpStore();
  const { job_id } = submitJob(s, { document: "INV-1001.txt" }, "k");
  await runWorker(s, handlers());
  assert.equal(countReports(s, job_id), 1);
  // Replay the write_report effect directly, as a buggy or duplicated worker would.
  const h = handlers().find((x) => x.name === "write_report")!;
  const outputs = { extract_fields: JSON.parse((s.db.prepare("SELECT output FROM steps WHERE job_id = ? AND name = 'extract_fields'").get(job_id) as { output: string }).output) };
  const r = await h.run({ jobId: job_id, step: "write_report", attempt: 2, payload: { document: "INV-1001.txt" }, outputs, workerId: "dup" });
  const second = tx(s, () => r.commit!(s.db)) as { inserted: boolean };
  assert.equal(second.inserted, false);
  assert.equal(countReports(s, job_id), 1);
  // And the UNIQUE constraint holds even for a plain INSERT that skips ON CONFLICT.
  assert.throws(() => s.db.prepare("INSERT INTO reports (job_id, document, invoice_number, supplier, currency, total_cents, due_date, extracted_by, created_at) VALUES (?, 'x', 'x', 'x', 'SEK', 1, '2026-01-01', 'x', 0)").run(job_id), /UNIQUE/);
  s.close();
});

test("extracted fields are computed from the document text", async () => {
  const s = tmpStore();
  const { job_id } = submitJob(s, { document: "INV-1002.txt" }, "k");
  await runWorker(s, handlers());
  const row = s.db.prepare("SELECT invoice_number, supplier, currency, total_cents, due_date FROM reports WHERE job_id = ?").get(job_id) as Record<string, unknown>;
  // 38 x 4.75 + 6 x 42.00 + 1 x 115.00 = 547.50 EUR
  assert.deepEqual({ ...row }, { invoice_number: "INV-1002", supplier: "Hamnkranen Logistik AB", currency: "EUR", total_cents: 54750, due_date: "2026-11-04" });
  s.close();
});

test("store opens in WAL mode with foreign keys on", () => {
  const s = tmpStore();
  assert.equal((s.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.equal((s.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
  s.close();
});
