import { test } from "node:test";
import assert from "node:assert/strict";
import { startApiServer } from "../src/server.ts";
import { runWorker } from "../src/worker.ts";
import { ApiError, JobView, SubmitResponse } from "../src/view.ts";
import { handlers, tmpStore } from "./helpers.ts";

async function withApi(fn: (url: string, s: ReturnType<typeof tmpStore>) => Promise<void>) {
  const s = tmpStore();
  const api = await startApiServer(s);
  try { await fn(api.url, s); } finally { await api.close(); s.close(); }
}
const post = (url: string, body: unknown, key?: string) =>
  fetch(`${url}/jobs`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("POST /jobs: new job 201, same key and body 200 with the same id, other body 409", () =>
  withApi(async (url, s) => {
    const r1 = await post(url, { document: "INV-1001.txt" }, "order-42");
    assert.equal(r1.status, 201);
    const b1 = SubmitResponse.parse(await r1.json());
    assert.equal(r1.headers.get("location"), `/jobs/${b1.job_id}`);
    const r2 = await post(url, { document: "INV-1001.txt" }, "order-42");
    assert.equal(r2.status, 200);
    const b2 = SubmitResponse.parse(await r2.json());
    assert.deepEqual([b2.job_id, b2.created], [b1.job_id, false]);
    const r3 = await post(url, { document: "INV-1002.txt" }, "order-42");
    assert.equal(r3.status, 409);
    const b3 = ApiError.parse(await r3.json());
    assert.deepEqual([b3.error.code, b3.error.job_id], ["IDEMPOTENCY_KEY_REUSED", b1.job_id]);
    assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 1);
  }));

test("parallel duplicate requests still create one job", () =>
  withApi(async (url, s) => {
    const rs = await Promise.all(Array.from({ length: 8 }, () => post(url, { document: "INV-1003.txt" }, "burst")));
    const ids = new Set(await Promise.all(rs.map(async (r) => SubmitResponse.parse(await r.json()).job_id)));
    assert.equal(ids.size, 1);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 201]);
    assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 1);
  }));

test("POST /jobs rejects missing key, bad JSON and invalid payloads", () =>
  withApi(async (url) => {
    const codes = async (r: Response) => [r.status, ApiError.parse(await r.json()).error.code];
    assert.deepEqual(await codes(await post(url, { document: "INV-1001.txt" })), [400, "MISSING_IDEMPOTENCY_KEY"]);
    assert.deepEqual(await codes(await post(url, "{not json", "k")), [400, "INVALID_JSON"]);
    assert.deepEqual(await codes(await post(url, { document: "../../etc/passwd" }, "k")), [400, "INVALID_PAYLOAD"]);
    assert.deepEqual(await codes(await post(url, { document: "INV-1001.txt", extra: 1 }, "k")), [400, "INVALID_PAYLOAD"]);
  }));

test("GET /jobs/:id returns status and step states; unknown id is 404", () =>
  withApi(async (url, s) => {
    const { job_id } = SubmitResponse.parse(await (await post(url, { document: "INV-1001.txt" }, "k")).json());
    const before = JobView.parse(await (await fetch(`${url}/jobs/${job_id}`)).json());
    assert.equal(before.status, "queued");
    await runWorker(s, handlers());
    const after = JobView.parse(await (await fetch(`${url}/jobs/${job_id}`)).json());
    assert.equal(after.status, "succeeded");
    assert.deepEqual(after.steps.map((x) => x.status), ["done", "done", "done"]);
    assert.deepEqual((after.result as { invoice_number: string; total_cents: number }).total_cents, 487100);
    const nf = await fetch(`${url}/jobs/job_doesnotexist`);
    assert.equal(nf.status, 404);
    assert.equal(ApiError.parse(await nf.json()).error.code, "JOB_NOT_FOUND");
  }));
