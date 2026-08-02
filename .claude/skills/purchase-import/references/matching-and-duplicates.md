# Matching and duplicates

## Source coverage

Establish the source window and row count before treating a missing record as
evidence. Verify whether amount columns are unit or extended values by checking
multi-quantity orders against an order total. Drop cancelled and zero-dollar
rows from a purchase match pool; deduplicate refund data before summing it.

## Match before write

Use `match_expenses` for up to 200 export rows. Supply date, signed amount,
label, vendor, and order ID where available. It ranks candidates only.

- Treat zero token overlap as normal: the ledger can name a thing differently
  from the vendor description.
- Treat small-dollar and wide date-window matches as hypotheses, not proof.
- Pass vendor with order ID because retailer order IDs are not globally unique.
- Re-run matching around rows you create to catch a duplicate that escaped the
  first pass.

## Generic mutation batches

`create_products`, `update_products`, `create_expenses`, `update_expenses`,
`update_tasks`, `create_financial_transactions`, and
`update_financial_transactions` process at most 50 items in request order.
Each item succeeds or fails independently. Validate all proposed rows before
calling a batch, then reconcile its ordered results with the approval table.

Do not retry a whole batch blindly. Retry only failed indices after correcting
the cause, and re-read a row when the failure may reflect a concurrent write.

## Duplicate identity

Use exact identifiers, never names, as duplicate evidence. Before adding an
external ID, call `find_product_external_id_collisions` with the exact source,
kind, and value. A collision is a stop-and-review condition. Same-name items
from different manufacturers are usually separate Products.
