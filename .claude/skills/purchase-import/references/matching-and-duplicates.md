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
An ingest approval persists across pagination or a 50-item technical boundary;
stop only when new ambiguity, conflict, deletion, Product promotion, or
receiving changes the decision.

## Duplicate identity

Use exact identifiers, never names, as duplicate evidence. Before adding an
external ID, call `find_product_external_id_collisions` with the exact source,
kind, and value. A collision is a stop-and-review condition. Same-name items
from different manufacturers are usually separate Products.

Exact identifiers only prove a duplicate when both records carry the *same kind*
of identifier. One retailer routinely issues several — Home Depot has both a
store `retailer_sku` and an `internet_number` — and a Product holding one will
not be found by a lookup on the other, so an id-only search reports "no match"
on an item you already own. When the incoming id kind is absent from the
catalog, fall back to a name search that returns **several** candidates and
treat a near-exact hit as a duplicate to resolve, not a new Product: a
single-best-match search silently hides the real duplicate behind a
similarly-named different size. Prefer consolidating onto the record that
already carries images, model, price, or expenses, then add the missing id kind
to it — use `merge_products` for the consolidation itself rather than hand
copying fields and deleting the loser; it moves external ids, inventory,
expenses, images, unit mappings, tasks, project-uses, and wish-candidates onto
the survivor, and sums same-location inventory rather than dropping it. A
retailer may also reuse one SKU for unrelated things — Home Depot files
delivery and fee lines under a SKU it also uses for merchandise — so never infer
identity from a SKU attached to an adjustment line.

For a bogus duplicate Purchase, preview the operation, delete its bogus
Expenses, and re-read it. Delete the Purchase only once it is empty, through
`delete_empty_purchases`; that guarded operation must refuse live Expenses and
Financial Transactions. Purchase deletion is identity cleanup, not spend or
settlement cleanup.
