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

`entity` runs one create/update at a time. `entity_batch` takes up to 50
create/update commands — any mix of entities — and runs them in request order;
each item succeeds or fails independently and carries the same validation,
side effects and result shape as the single call. `entity bulkUpdate` is the
other multi-row write: one field patch over `ids[]` (≤500) for the few fields
each entity allows. Validate all proposed rows before calling a batch, then
reconcile its ordered results with the approval table.

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
to it — use `entity {action:"merge", entity:"product", …}` for the
consolidation itself rather than hand copying fields and deleting the loser; it moves external ids, inventory,
expenses, images, unit mappings, tasks, project-uses, and wish-candidates onto
the survivor, and sums same-location inventory rather than dropping it. A
retailer may also reuse one SKU for unrelated things — Home Depot files
delivery and fee lines under a SKU it also uses for merchandise — so never infer
identity from a SKU attached to an adjustment line.

For a bogus duplicate Purchase, preview the operation, delete its bogus
Expenses, and re-read it. Delete the Purchase only once it is empty, through
`entity delete purchase`. That operation does NOT refuse a non-empty Purchase:
live Expenses and Financial Transactions are detached (`purchaseId` cleared)
and survive as orphans, so an empty re-read is the guard. Purchase deletion is
identity cleanup, not spend or settlement cleanup.

## Hand-entered rows that duplicate imports

Bulk imports (order-history CSVs, statement backfills) mint line-item copies of
orders that were hand-entered years earlier as one project-tagged aggregate.
Both copies stay live, and the pair is hard to see: the hand row carries the
project and a colloquial title; the import carries products, order id and
vendor with `projectId: null`; amounts differ (hand rows are from-memory
approximations, and CSV lines may be pre-tax) and **dates can be months off** —
a CSV can date an order by its *return* transaction. Check these four possible shapes:

1. **Lump = the order.** Aggregate equals the import's `expenseTotal` or
   `statedTotal` to the cent, *or* CSV lines + tax. Test the flat tie before the
   tax-rate gap (some CSV lines are tax-inclusive), and join on amount as well as
   date. Round hand figures never tie by arithmetic — match contents + date.
2. **Statement-backfill placeholder.** A `"<Vendor> counter purchase — unitemized"`
   Expense on a fresh Purchase reads `financialReconciliation: match` on its own,
   so nothing looks wrong until the real row is attached. Symptom: a vendor whose
   `latestPurchaseDate` equals the date of the row you are about to book.
3. **Empty imported Purchase header** stranding the order id while the money
   sits on a hand-entered Purchase with no `orderId`. Neither an order-id nor a
   search finds it. `entity update purchase` with the stranded id returns
   `PURCHASE_MERGE_ORDER_COLLISION`; delete the empty header first, then move the
   id. Find them with a `NOT EXISTS` scan for purchases with neither live
   Expenses nor transactions.
4. **Lump = a subset** of the order (one item pre-tax; everything but one item
   plus the whole order's tax; one order booked as several lumps on the next
   day). `findDuplicateSpendCandidates` only matches a lump against a purchase's
   full totals, so partial lumps are invisible to it. A recursive-CTE subset-sum
   of a purchase's live lines against unlinked Expenses within ±10 days finds
   them, but is very noisy: confirm vendor agreement, name overlap, and above all
   **settlement** — no charge equal to the lump should exist. A lump with its own
   posted charge needs *linking*, not deleting. Two aggregates can be halves of
   one order split by delivery date with the labels crossed; a buy half and a
   refund half can sit in two different Purchases and net to zero.

When the operator approves deduplication: move the hand row's `projectId` (and its
`costType`/`trade` where the human judgment is better than the import's) onto
the imported rows, preserve its title as `Purchase.displayLabel`, add the
missing tax row when the import is pre-tax, then delete the hand row and record
the dedup in the Purchase notes. **Deleting a duplicate can strip a project** —
move the real lines onto it first. Never label a hand row with a vendor to
"attribute" it: `entity create/update expense` find-or-creates a Purchase, which
mints a phantom order beside the real imported one. Get the order id from the
Gmail confirmation, then decide between link and delete. An order absent from an
import is either a hole or a cancellation — the cancellation email lands seconds
after the confirmation on a double-click; check before assuming either.

**Before adding a purchase, check amount + date across the WHOLE ledger
regardless of name** — the ledger names the thing, not the product ("dust
extractor" vs a vacuum's product name share zero tokens). And check by
`orderId`: the ledger may hold the SPLIT while you add the AGGREGATE. Keyword
search cannot rule out an existing row. A comparison against *one* candidate
order that fails does not clear an aggregate; only an exhaustive order-id
collision check does. When a prior dedup's `displayLabel` does not describe the
keeper's actual contents, that merge was wrong.

A backfill note saying "was missing from the ledger" is a red flag: check
whether a hand-entered aggregate on the same project already covered it. A
hand-entered row in the pre-import tail may duplicate an itemized record;
establish which case applies before importing.

## Attribution by siblings — adjustments only

To attribute an unassigned Expense from its order siblings: **non-principal
lines (tax, shipping, fee, discount, adjustment) and returns always follow
their order** — an order-level adjustment has no independent identity. **Never
sweep principal lines by sibling agreement.** Mixed orders are the norm, and
unanimous siblings often mean the household lines were simply never triaged.
Writing into the Household project converts "untriaged" into "triaged as not
project work", which is a real claim.

The operator decides the project per batch, by *which project was actually
accruing on the transaction date*, not by item type — verify with
`get_expense_analytics` scoped to the candidate project and window before
proposing one. Purchases cluster a few days before a project's pinned window
(materials bought ahead), so −15 d..+5 d is normal.

Project notes may carry an imported shopping table with retailer URLs; those
identifiers usually resolve to Products that already exist, already enriched,
so the work is attribution, not creation. A Home Depot URL slug carries the
`retailer_sku` *and* the internet number — grep both slots. Two false-positive
shapes: a comparison/research list where nothing was bought, and a different
model than the one linked. Gear a project *displaces* rarely appears in its
shopping list — search by product and manufacturer too, and check whether a
project's sale rows have stranded buys.

## Search before you create

- **Unlinked is not absent.** A recipe line with no price path means the
  ingredient has no Product linked, not that no Product exists; a
  `LEFT JOIN Product ON ingredientId` only sees linked ones. Search the catalog
  by name and alias (`global_search` with `entityTypes: ["product"]`, or
  `entity search product` with `limit` ≥ 10 — a small limit has missed an
  exact-name hit) before creating anything. Linking brings derived price and
  history; creating splits one ingredient's history across rows.
- `list expense` filtered by `productId` cannot see the unlinked buys you are
  hunting; search by name/model and by the vendor's other purchases, and grep
  notes for "no product yet".
- **Read the notes on a row before calling it a defect.** Typed columns alone
  may omit the evidence explaining an intentional value.
- Same-name generics from different stores are different Products (own SKU,
  packer, price basis); do not flag them as merge candidates. Same-name items
  from different manufacturers likewise.
- Model numbers one digit apart are usually distinct SKUs (Milwaukee PACKOUT
  wall plates: 8485/8486/8487/8496/8497 are five products). Search by
  `modelFilter`, never by name — retailer import titles routinely omit the
  family name — before treating any model number as a typo.
- Trigram similarity finds obvious matches but happily pairs an M12 tool with a
  Ryobi one, or sibling grits and gauges; a second pass matching the product's
  `model` against the row name is the only evidence strong enough to link on.
  A duplicate may match by **model** without any distinctive word in common.
- A `PRODUCT_ALREADY_EXISTS` / identifier collision from a write is a duplicate
  detector — read the conflict, don't route around it.
- Productless spend can include services and deposits; split by `costType` before
  calling it a backlog. Sale rows whose category never gets a Product (trading
  cards, books, personal apparel, in-box accessories, loose PC components) take
  the sentinel `Orphan-exit sweep <date>: intentionally productless.` plus the
  reason, and name any near-miss product deliberately not linked. Big-ticket
  sold-and-gone items DO get sell-only Products; their `net = -1` is the honest
  record that the acquisition predates ledger coverage.
