import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedExtractor } from "../src/model/scripted.ts";
import { documentHandlers } from "../src/pipeline.ts";
import { createJobStore, listEvents, type JobStore } from "../src/store.ts";

export const DOCS = join(import.meta.dirname, "..", "data", "documents");

export function tmpStore(): JobStore & { file: string } {
  const file = join(mkdtempSync(join(tmpdir(), "durable-jobs-")), "jobs.db");
  return Object.assign(createJobStore(file), { file });
}

export const handlers = () => documentHandlers({ docsDir: DOCS, extractor: new ScriptedExtractor() });

export const events = (s: JobStore, jobId: string, type?: string) => listEvents(s, jobId).filter((e) => !type || e.type === type);
