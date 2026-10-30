# Data provenance

Everything in `documents/` is synthetic and was written by hand for this repo on 2026-10-30. Dataset version: `invoices-v1`.

| File | Purpose |
| --- | --- |
| `INV-1001.txt` | Normal invoice, SEK. Used for the kill and resume run. |
| `INV-1002.txt` | Normal invoice, EUR. Used with injected transient faults. |
| `INV-1003.txt` | Normal invoice, SEK. Used for retry exhaustion. |
| `INV-1004.txt` | Stated total (3950.00) does not match the line items (3550.00): permanent `TOTAL_MISMATCH`. |
| `INV-1005.txt` | No due date: permanent `EXTRACTION_INCOMPLETE`. |

Supplier names are invented. Every email uses the reserved `.example` domain (RFC 2606) and cannot reach anyone. No real invoices, companies or people are represented.
