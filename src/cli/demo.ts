/**
 * Fixture demo, no API key, no cost. Real processes, real SIGKILL:
 *   1. submit a job over HTTP, repeat the request, reuse the key with another body
 *   2. worker A runs it, freezes after extract_fields is checkpointed, gets SIGKILL
 *   3. more jobs: transient faults, retry exhaustion, permanent errors
 *   4. worker B takes over the abandoned job and drains the queue
 *   5. final status of every job and the report row count
 */
import { execSync } from "node:child_process";
import { rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { formatEvent } from "../format.ts";
import { startApiServer } from "../server.ts";
import { spawnWorker } from "../spawn.ts";
import { countReports, createJobStore, listEvents, listJobIds } from "../store.ts";
import { JobView, SubmitResponse } from "../view.ts";

const DATASET = "invoices-v1";
const stamp = new Date().toISOString().slice(0, 10);
const rev = (() => { try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "uncommitted"; } })();
const dbFile = ".data/demo.db";
for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) rmSync(f, { force: true });
mkdirSync("evidence", { recursive: true });
const evidence = `evidence/fixture-${stamp}.jsonl`;
writeFileSync(evidence, JSON.stringify({ type: "session", ts: new Date().toISOString(), code_rev: rev, dataset: DATASET, node: process.version, mode: "fixture", extractor: "fixture:scripted-extractor" }) + "\n");

const store = createJobStore(dbFile);
store.onEvent = (e) => console.log(formatEvent(e));
const api = await startApiServer(store);
const LEASE = "1000";
const workerEnv = { DJ_DB: dbFile, DJ_LEASE_MS: LEASE, DJ_POLL_MS: "50", DJ_BACKOFF_MS: "100", DJ_MAX_ATTEMPTS: "3" };

console.log(`durable-jobs fixture demo  (scripted extractor, no API calls)  rev=${rev}  dataset=${DATASET}  node=${process.version}\n`);

async function post(document: string, key: string) {
  const r = await fetch(`${api.url}/jobs`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ document }) });
  const body = (await r.json()) as unknown;
  console.log(`  HTTP POST /jobs key=${key} {"document":"${document}"} -> ${r.status} ${JSON.stringify(body)}`);
  return { status: r.status, body };
}
const get = async (id: string) => JobView.parse(await (await fetch(`${api.url}/jobs/${id}`)).json());
const steps = (v: JobView) => v.steps.map((s) => `${s.name}=${s.status}/${s.attempts}`).join(" ");

console.log("> 1. submit, repeat, reuse key with a different body");
const first = SubmitResponse.parse((await post("INV-1001.txt", "demo-inv-1001")).body);
await post("INV-1001.txt", "demo-inv-1001");
await post("INV-1002.txt", "demo-inv-1001");

console.log("\n> 2. worker A starts, freezes after extract_fields is checkpointed, then SIGKILL");
const a = spawnWorker({ ...workerEnv, DJ_WORKER_ID: "worker-A", DJ_PAUSE_AFTER_CHECKPOINT: "extract_fields" }, (l) => console.log(l));
await a.waitFor(/^PAUSED/);
let v = await get(first.job_id);
console.log(`  GET /jobs/${first.job_id} -> status=${v.status} lease=${v.lease?.owner} ${steps(v)}`);
a.child.kill("SIGKILL");
const ea = await a.exited;
console.log(`  killed worker-A pid=${a.pid} signal=${ea.signal}; reports for ${first.job_id}: ${countReports(store, first.job_id)}`);

console.log("\n> 3. more jobs while no worker is running");
const ids: Record<string, string> = { "INV-1001.txt (killed run)": first.job_id };
for (const [doc, note] of [["INV-1002.txt", "2 injected transient faults"], ["INV-1003.txt", "transient fault on every attempt"], ["INV-1004.txt", "totals do not add up"], ["INV-9999.txt", "file does not exist"]] as const) {
  ids[`${doc} (${note})`] = SubmitResponse.parse((await post(doc, `demo-${doc}`)).body).job_id;
}

console.log(`\n> 4. worker B starts, waits for worker-A's lease (${LEASE} ms) to run out, drains the queue`);
const faults = [
  { step: "extract_fields", document: "INV-1002.txt", transient_attempts: 2 },
  { step: "extract_fields", document: "INV-1003.txt", always: "transient" },
];
const b = spawnWorker({ ...workerEnv, DJ_WORKER_ID: "worker-B", DJ_FAULTS: JSON.stringify(faults) }, (l) => console.log(l));
const eb = await b.exited;
if (eb.code !== 0) throw new Error(`worker-B exited with ${eb.code}`);

console.log("\n> 5. result");
const summary: string[] = [];
const problems: string[] = [];
for (const [label, id] of Object.entries(ids)) {
  v = await get(id);
  const reports = countReports(store, id);
  summary.push(`  ${label.padEnd(48)} ${v.status.padEnd(9)} ${steps(v).padEnd(60)} reports=${reports}${v.error ? `  ${v.error.code}: ${v.error.message}` : ""}`);
  appendFileSync(evidence, JSON.stringify({ type: "job_summary", label, ...v, report_rows: reports }) + "\n");
  if (reports > 1) problems.push(`${id} has ${reports} report rows`);
  if ((v.status === "succeeded") !== (reports === 1)) problems.push(`${id} status ${v.status} with ${reports} report rows`);
}
const killed = await get(first.job_id);
if (killed.status !== "succeeded" || killed.steps.some((s) => s.attempts !== 1)) problems.push("the killed job did not resume cleanly");
const resumed = listEvents(store, first.job_id).filter((e) => e.type === "step_resumed").map((e) => e.step);
console.log(summary.join("\n"));
console.log(`\n  killed job: resumed from checkpoint [${resumed.join(", ")}], executions per step [${killed.steps.map((s) => s.attempts).join(", ")}], claims=${killed.claims}`);
console.log(`  jobs in table: ${listJobIds(store).length}   report rows in table: ${countReports(store)}`);

for (const e of listEvents(store)) appendFileSync(evidence, JSON.stringify(e) + "\n");
appendFileSync(evidence, JSON.stringify({ type: "demo_check", ok: problems.length === 0, problems }) + "\n");
await api.close();
store.close();
console.log(`\nlog: ${evidence}  (code rev ${rev})  check: ${problems.length === 0 ? "ok" : problems.join("; ")}`);
if (problems.length) process.exit(1);
