import type { ExtractionModel } from "./types.ts";

/**
 * Deterministic fixture extractor. It reads the labelled lines and line items of the synthetic
 * invoices with regular expressions; every value comes from the document text, nothing is
 * hard-coded per file. A field that is not in the text is left out, so the schema check fails
 * the same way it would for a model that could not find it.
 * This proves the job machinery. It proves nothing about how well a real model extracts.
 */
export class ScriptedExtractor implements ExtractionModel {
  readonly id = "fixture:scripted-extractor";

  async extract(text: string): Promise<unknown> {
    const label = (name: string) => text.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "mi"))?.[1];
    const cents = (s: string) => Math.round(Number(s) * 100);
    const items = [...text.matchAll(/^\s{2,}(.+?)\s{2,}(\d+) x (\d+(?:\.\d{1,2})?)\s*$/gm)].map((m) => ({
      description: m[1]!,
      quantity: Number(m[2]),
      unit_price_cents: cents(m[3]!),
    }));
    const total = label("Total due");
    const out: Record<string, unknown> = {
      invoice_number: label("Invoice number"),
      supplier: label("Supplier"),
      supplier_email: label("Supplier email"),
      issue_date: label("Issue date"),
      due_date: label("Due date"),
      currency: label("Currency"),
      line_items: items,
      stated_total_cents: total === undefined ? undefined : cents(total),
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }
}
