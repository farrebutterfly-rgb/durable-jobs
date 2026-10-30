import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ZodType } from "zod";
import { IdempotencyConflictError } from "./errors.ts";
import type { Json } from "./json.ts";
import { DocumentPayload } from "./pipeline.ts";
import { getJob, submitJob, type JobStore } from "./store.ts";

const MAX_BODY = 64 * 1024;

export interface ApiOptions {
  /** Validates the POST /jobs body. Defaults to the document pipeline payload. */
  payloadSchema?: ZodType;
  steps?: readonly string[];
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
const fail = (res: ServerResponse, status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  send(res, status, { error: { code, message, ...extra } });

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * POST /jobs       body: payload JSON, header Idempotency-Key (required)
 *                  201 new job, 200 replay of the same key and body, 409 same key with another body
 * GET  /jobs/:id   200 JobView (see view.ts), 404 unknown id
 */
export function createApiServer(store: JobStore, opts: ApiOptions = {}): Server {
  const schema = opts.payloadSchema ?? DocumentPayload;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (url.pathname === "/jobs") {
        if (req.method !== "POST") return fail(res, 405, "METHOD_NOT_ALLOWED", "use POST /jobs");
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || key.length === 0 || key.length > 200) {
          return fail(res, 400, "MISSING_IDEMPOTENCY_KEY", "send an Idempotency-Key header (1 to 200 characters)");
        }
        const raw = await readBody(req);
        if (raw === null) return fail(res, 413, "BODY_TOO_LARGE", `body over ${MAX_BODY} bytes`);
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return fail(res, 400, "INVALID_JSON", "body is not valid JSON"); }
        const parsed = schema.safeParse(body);
        if (!parsed.success) return fail(res, 400, "INVALID_PAYLOAD", "payload failed validation", { issues: parsed.error.issues });
        try {
          const r = submitJob(store, parsed.data as Json, key, opts.steps);
          return send(res, r.created ? 201 : 200, r, { location: `/jobs/${r.job_id}` });
        } catch (e) {
          if (e instanceof IdempotencyConflictError) return fail(res, 409, "IDEMPOTENCY_KEY_REUSED", e.message, { job_id: e.existingJobId });
          throw e;
        }
      }
      const m = url.pathname.match(/^\/jobs\/([A-Za-z0-9_-]+)$/);
      if (m) {
        if (req.method !== "GET") return fail(res, 405, "METHOD_NOT_ALLOWED", "use GET /jobs/:id");
        const job = getJob(store, m[1]!);
        return job ? send(res, 200, job) : fail(res, 404, "JOB_NOT_FOUND", `no job ${m[1]}`);
      }
      return fail(res, 404, "NOT_FOUND", "routes: POST /jobs, GET /jobs/:id");
    } catch (e) {
      return fail(res, 500, "INTERNAL", (e as Error).message);
    }
  });
}

export async function startApiServer(store: JobStore, port = 0, opts: ApiOptions = {}) {
  const server = createApiServer(store, opts);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const { port: p } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${p}`, server, close: () => new Promise<void>((r) => server.close(() => r())) };
}
