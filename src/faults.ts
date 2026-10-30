import { z } from "zod";
import { PermanentError, TransientError } from "./errors.ts";
import type { StepHandler } from "./worker.ts";

/**
 * Fault injection, configured with DJ_FAULTS (JSON array) or passed in code.
 * Rules use the step attempt number from the database, so "fail the first 2 attempts"
 * means the same thing across worker restarts.
 */
export const FaultRule = z.strictObject({
  step: z.string(),
  /** Only jobs whose payload.document equals this. */
  document: z.string().optional(),
  /** Throw a TransientError on attempts 1..N, then let the step run. */
  transient_attempts: z.number().int().positive().optional(),
  /** Throw on every attempt. */
  always: z.enum(["transient", "permanent"]).optional(),
  /** Extra latency before the step runs (heartbeats keep the lease alive meanwhile). */
  delay_ms: z.number().int().nonnegative().optional(),
});
export type FaultRule = z.infer<typeof FaultRule>;

export function parseFaults(json: string | undefined): FaultRule[] {
  if (!json) return [];
  return z.array(FaultRule).parse(JSON.parse(json));
}

export function withFaults(handlers: StepHandler[], rules: FaultRule[]): StepHandler[] {
  if (rules.length === 0) return handlers;
  return handlers.map((h) => ({
    name: h.name,
    async run(ctx) {
      const doc = (ctx.payload as { document?: string } | null)?.document;
      for (const r of rules.filter((r) => r.step === h.name && (!r.document || r.document === doc))) {
        if (r.delay_ms) await new Promise((res) => setTimeout(res, r.delay_ms));
        if (r.always === "permanent") throw new PermanentError("INJECTED_PERMANENT", `injected permanent fault in ${h.name}`);
        if (r.always === "transient") throw new TransientError("INJECTED_TRANSIENT", `injected transient fault in ${h.name} (attempt ${ctx.attempt})`);
        if (r.transient_attempts && ctx.attempt <= r.transient_attempts) {
          throw new TransientError("INJECTED_TRANSIENT", `injected transient fault in ${h.name} (attempt ${ctx.attempt} of ${r.transient_attempts} planned failures)`);
        }
      }
      return h.run(ctx);
    },
  }));
}
