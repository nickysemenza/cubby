# Documents and returns

## Purchase paperwork

Attach original files to the Purchase with `attach_file`, using the Purchase
shortcode and an accurate `documentKind`. Use evidence in this order: final
invoice or receipt, credit memo, order acknowledgment, then quote or estimate.
Payment receipts, statements, returns, and other files remain useful evidence
but do not masquerade as a primary document. Pasted email text may support notes
and reconciliation, but is not a file attachment or primary document.

Use `reclassify_purchase_document` when an existing attachment was classified
incorrectly. Do not fabricate a PDF from an email body or structured text just
to clear a data-quality gap; retain source evidence and record a supported
exception when the original cannot be obtained.

## Returns

File refund Expenses and Financial Transactions on the original Purchase.

- Full return: a negative Expense can offset the original line on that Purchase.
- Partial refund on a multi-item order: preserve the actual kept-item cost;
  never change stated total merely to hide the difference.
- A return where neither charge nor refund is in the ledger needs no synthetic
  zero-net entry.

Use `split_expense` rather than hand-creating parts and deleting an aggregate.
Put invoice-level narrative on Purchase notes. Split parts inherit the original
Expense notes when `notes` is omitted; provide a specific note to replace them or
`null` to clear them for one part.

## Variances and credits

Seek the final invoice, receipt, or credit memo before classifying a mismatch.
Keep a retained-goods price correction on the retained Purchase; keep a returned
item and its refund on the original Purchase; keep a general account credit as
settlement evidence until its use is known. When a real variance remains
unexplained, record a clearly labeled productless Expense rather than silently
spreading it across lines. Never rewrite `statedTotal` or allocation merely to
make reconciliation appear clean.
