/** One job through the real model. Needs ANTHROPIC_API_KEY, costs money. Not part of make check. */
import { formatEvent } from "../format.ts";
import { AnthropicExtractor } from "../model/anthropic.ts";
import { documentHandlers } from "../pipeline.ts";
import { createJobStore, getJob, listEvents, submitJob } from "../store.ts";
import { runWorker } from "../worker.ts";
import { writeFileSync, appendFileSync } from "node:fs";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Live runs call the real API and cost money; `make demo` does not.");
  process.exit(2);
}
const document = process.argv[2] ?? "INV-1001.txt";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const store = createJobStore(`.data/live-${stamp}.db`);
store.onEvent = (e) => console.log(formatEvent(e));
const extractor = new AnthropicExtractor();
const { job_id } = submitJob(store, { document }, `live-${stamp}`);
await runWorker(store, documentHandlers({ docsDir: "data/documents", extractor }));
const v = getJob(store, job_id)!;
const file = `evidence/live-${stamp}.jsonl`;
writeFileSync(file, JSON.stringify({ type: "session", ts: new Date().toISOString(), dataset: "invoices-v1", node: process.version, mode: "live", extractor: extractor.id }) + "\n");
for (const e of listEvents(store)) appendFileSync(file, JSON.stringify(e) + "\n");
appendFileSync(file, JSON.stringify({ type: "job_summary", ...v }) + "\n");
console.log(`\n${v.status}: ${JSON.stringify(v.error ?? v.result)}\nlog: ${file}`);
store.close();
