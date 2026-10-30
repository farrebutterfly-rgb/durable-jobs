import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PermanentError } from "./errors.ts";
import { sha256, type Json } from "./json.ts";
import type { ExtractionModel } from "./model/types.ts";
import type { StepHandler } from "./worker.ts";

/** Body of POST /jobs for the document pipeline. File names only, so a payload cannot point outside the documents folder. */
export const DocumentPayload = z.strictObject({
  document: z.string().regex(/^[A-Za-z0-9_-]+\.txt$/, "a .txt file name inside the documents folder"),
});
export type DocumentPayload = z.infer<typeof DocumentPayload>;

export const InvoiceFields = z.strictObject({
  invoice_number: z.string().min(1),
  supplier: z.string().min(1),
  supplier_email: z.email(),
  issue_date: z.iso.date(),
  due_date: z.iso.date(),
  currency: z.enum(["SEK", "EUR", "USD", "NOK", "DKK"]),
  line_items: z.array(z.strictObject({ description: z.string(), quantity: z.number().int().positive(), unit_price_cents: z.number().int().nonnegative() })).min(1),
  stated_total_cents: z.number().int().nonnegative(),
});
export type InvoiceFields = z.infer<typeof InvoiceFields>;

/**
 * The three-step document job: read_document -> extract_fields -> write_report.
 * write_report's row insert is a commit effect: it runs in the checkpoint transaction and
 * uses ON CONFLICT(job_id) DO NOTHING on a UNIQUE column, so it is idempotent twice over.
 */
export function documentHandlers(opts: { docsDir: string; extractor: ExtractionModel }): StepHandler[] {
  return [
    {
      name: "read_document",
      async run({ payload }) {
        const { document } = DocumentPayload.parse(payload);
        let text: string;
        try {
          text = await readFile(join(opts.docsDir, document), "utf8");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new PermanentError("DOCUMENT_NOT_FOUND", `no document named ${document}`);
          throw e;
        }
        return { output: { document, sha256: sha256(text), chars: text.length, text } };
      },
    },
    {
      name: "extract_fields",
      async run({ outputs }) {
        const doc = outputs.read_document as { text: string };
        const raw = await opts.extractor.extract(doc.text);
        const parsed = InvoiceFields.safeParse(raw);
        if (!parsed.success) {
          const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))];
          throw new PermanentError("EXTRACTION_INCOMPLETE", `missing or invalid fields: ${fields.join(", ")}`);
        }
        const f = parsed.data;
        const computed = f.line_items.reduce((s, l) => s + l.quantity * l.unit_price_cents, 0);
        if (computed !== f.stated_total_cents) {
          throw new PermanentError("TOTAL_MISMATCH", `line items sum to ${computed / 100} ${f.currency} but the invoice states ${f.stated_total_cents / 100}`);
        }
        return { output: { fields: f as unknown as Json, total_cents: computed, extracted_by: opts.extractor.id } };
      },
    },
    {
      name: "write_report",
      run({ jobId, payload, outputs }) {
        const { document } = DocumentPayload.parse(payload);
        const ex = outputs.extract_fields as { fields: InvoiceFields; total_cents: number; extracted_by: string };
        return {
          output: null,
          commit: (db) => {
            const ins = db
              .prepare(
                `INSERT INTO reports (job_id, document, invoice_number, supplier, currency, total_cents, due_date, extracted_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING`,
              )
              .run(jobId, document, ex.fields.invoice_number, ex.fields.supplier, ex.fields.currency, ex.total_cents, ex.fields.due_date, ex.extracted_by, Date.now());
            const row = db.prepare("SELECT id FROM reports WHERE job_id = ?").get(jobId) as { id: number };
            return { report_id: row.id, inserted: ins.changes === 1, invoice_number: ex.fields.invoice_number, total_cents: ex.total_cents, currency: ex.fields.currency };
          },
        };
      },
    },
  ];
}
