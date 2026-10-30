/**
 * The "model" in the extract_fields step. It turns document text into candidate fields.
 * Its output is untrusted: the pipeline validates it with a zod schema and checks the
 * arithmetic before anything is checkpointed.
 */
export interface ExtractionModel {
  /** Shown in logs and stored on the report row, so fixture and live output are never confused. */
  readonly id: string;
  extract(text: string): Promise<unknown>;
}
