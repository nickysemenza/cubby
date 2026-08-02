# Documents and returns

## Purchase paperwork

Attach original files to the Purchase with `attach_file`, using the Purchase
shortcode and an accurate `documentKind`. Primary evidence is an order
confirmation, sales order, invoice, or receipt. Payment receipts, statements,
returns, and other files remain useful evidence but do not masquerade as a
primary document.

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
Put invoice-level narrative on Purchase notes before splitting, because the
original Expense is soft-deleted.
