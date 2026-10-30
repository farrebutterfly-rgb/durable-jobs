import { z } from "zod";

/**
 * Public JSON contract for GET /jobs/:id. P8 (agent-api-sdk) builds its typed client on this.
 * Timestamps are ISO 8601 strings in UTC. Changing this shape is a breaking change.
 */
const ErrorShape = z.object({
  code: z.string(),
  message: z.string(),
  transient: z.boolean(),
});

export const StepView = z.object({
  name: z.string(),
  status: z.enum(["pending", "running", "done", "failed"]),
  /** How many times the handler was started. A finished step that was never re-run has 1. */
  attempts: z.number().int().nonnegative(),
  last_error: ErrorShape.nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});

export const JobView = z.object({
  job_id: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  idempotency_key: z.string(),
  payload: z.unknown(),
  /** How many times a worker has claimed the job (first run, retries, takeovers after a crash). */
  claims: z.number().int().nonnegative(),
  lease: z.object({ owner: z.string(), expires_at: z.string() }).nullable(),
  /** Earliest time a worker may pick the job up again; set only while queued (retry backoff). */
  run_after: z.string().nullable(),
  error: ErrorShape.extend({ step: z.string(), attempts: z.number().int() }).nullable(),
  /** Output of the last step once status is succeeded. */
  result: z.unknown(),
  created_at: z.string(),
  updated_at: z.string(),
  steps: z.array(StepView),
});
export type JobView = z.infer<typeof JobView>;

export const SubmitResponse = z.object({
  job_id: z.string(),
  status: JobView.shape.status,
  created: z.boolean(),
});

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), job_id: z.string().optional(), issues: z.array(z.unknown()).optional() }),
});
