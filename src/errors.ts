/**
 * Step handlers signal how a failure should be treated by throwing one of these.
 * Anything else thrown by a handler is treated as transient (bounded retries), on the
 * reasoning that an unknown failure is more often a flaky dependency than bad input,
 * and the retry budget still ends it.
 */
export class TransientError extends Error {
  readonly transient = true;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TransientError";
  }
}

export class PermanentError extends Error {
  readonly transient = false;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

/** Same idempotency key, different request body. The HTTP layer maps this to 409. */
export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string, readonly existingJobId: string) {
    super(`Idempotency-Key "${idempotencyKey}" was already used for job ${existingJobId} with a different body`);
    this.name = "IdempotencyConflictError";
  }
}

/** This worker no longer holds the job's lease; another worker may own it now. */
export class LeaseLostError extends Error {
  constructor(readonly jobId: string, readonly workerId: string) {
    super(`worker ${workerId} lost the lease on ${jobId}`);
    this.name = "LeaseLostError";
  }
}

export interface ErrorInfo {
  code: string;
  message: string;
  transient: boolean;
}

export function describeError(e: unknown): ErrorInfo {
  if (e instanceof TransientError || e instanceof PermanentError) return { code: e.code, message: e.message, transient: e.transient };
  const message = e instanceof Error ? e.message : String(e);
  return { code: "UNCLASSIFIED", message, transient: true };
}
