---
name: purchase-import
description: Reconcile vendor orders, receipts, and financial statements against Cubby's Expenses, Purchases, FinancialAccounts, and FinancialTransactions. Use when the user supplies order exports, receipts, statement rows, or vendor account dumps and wants source coverage checked, rows deduplicated, spend lines matched, settlement evidence recorded, refunds handled, or financial reconciliation verified.
---

# Importing a vendor purchase export

Goal: link export lines to `Expense` rows, correct costs, book refunds, capture identifiers.
This file is weighted toward **failure modes** — the happy path is easy, the traps are what cost hours.

## Begin with the computed completeness queue

Start an existing-data audit with `list_purchases({ dataStatus: "needs_data" })`; narrow with
`dataGap` when useful. Every Purchase and Product MCP response carries a live `dataQuality` summary:
`status`, exact `gaps`, and explicit `exceptions`. Completeness is computed on every read, never
stored as a flag. Adding evidence, enriching a field, or recording a legitimate exception removes
the corresponding gap immediately.

Purchase gaps cover date, order id, stated total, primary document, empty/unpriced Expenses,
paperwork mismatch, and settlement source-reference coverage. Product manufacturer/category/model,
Amazon ASIN, and exact external-id collision gaps roll up into every linked Purchase while retaining
the Product's `targetType: "product"` and `PRD-` shortcode as `targetId`. Purchase-owned
exceptions use `targetType: "purchase"` and the Purchase's `PUR-` shortcode. Deduplicate and
act on exceptions by `(targetType, targetId, check)`, because several linked Products may expose
the same check. Use
`search_products({ dataStatus: "needs_data" })` for the Product-only queue.

`set_data_exception` records negative knowledge for one applicable check and requires a substantive
note; it replaces an existing exception for that check on the targeted entity and returns that
target's output. `clear_data_exception` removes exactly that targeted acknowledgement and also
returns the targeted output. Exceptions are for facts that were not issued, are unavailable/not applicable,
have insufficient detail, or for an expected mismatch — never a shortcut around searching sources
that are still available.

## Financial settlement workflow

Vendor documents control Purchase identity, literal `statedTotal`, and Expense
lines. Statements and card/bank exports control `FinancialTransaction` amount,
account, status, and posting date. Do not let either source overwrite the
other's authority.

1. Establish source coverage and deduplicate source rows before writing.
2. Propose matches first; use `match_expenses` for vendor order/line evidence.
3. Resolve an account by source external ID, then source aliases, then one
   unambiguous network/last-four candidate. Last four alone is not unique. Create
   a provisional `FAC-` account when the evidence is only `Visa ····3692`.
4. Normalize statement signs to Cubby: positive is a charge/outflow; negative is
   a refund/inflow. A Monarch negative charge becomes positive here.
5. Search `list_financial_transactions` by source/reference before creating.
   When statement data arrives for an expected refund, update that entry to
   `posted` and append its source reference (read–merge–write arrays).
6. Link each truthful settlement entry to its original `PUR-` Purchase. A
   Purchase may have installments, split tender, shipment billing, and refunds;
   do not create a second Purchase for a refund. A transaction spanning several
   Purchases stays unlinked until allocation support exists.
7. Verify the Purchase financial reconciliation. FinancialTransaction amounts
   are evidence only: never create, alter, or net Expenses from them.

Examples: `PUR-4W2J` keeps the literal $60.56 vendor total, a +$60.56 posted
charge, and a −$9.07 refund on the same Purchase (match at $51.49). Ferguson
deposit plus balance is two Transactions on one Purchase; Amazon split shipment
billing is several charge Transactions on one order; split tender links two
accounts to one Purchase; a store-credit refund is a negative stored-value
Transaction on the original Purchase.

## ⚠️ `Purchase` changed meaning — read this before your first write

The flat ledger was split into three entities:

```
Vendor ──< Purchase ──< Expense
             │  └── documents (PurchaseImage → Image)
             └── orderId?, date, statedTotal?
```

- **A ledger line is now an `Expense`.** Everything this skill used to call "a purchase row" — name,
  cost, date, trade, costType, projectId, productId — is an `Expense`. **All money lives on
  `Expense`**; every `SUM(cost)` reads that table alone.
- **`Purchase` now means one vendor order, receipt, or deliberately separate purchase event**: `vendorId` (NOT NULL), optional
  `orderId`, `date`, optional `statedTotal`, notes, and its documents. It holds **no** money.
- **`Vendor`** is a real roster (`name` unique, `website`, `notes`), not a text column.

**`create_purchase` / `get_purchase` / `list_purchases` / `update_purchase` still exist — but they
mean the PURCHASE now, not the ledger line.** The names were reused when `Purchase` was re-pointed. So
the failure mode here is *not* an unknown-tool error: it is writing the wrong entity. What actually
stops you is the schema. `purchaseCreateInput` requires `vendorId` (a `VEN-` shortcode) and has no
`name`/`cost`/`trade`/`costType`, so a stale caller passing the old ledger shape gets a **zod
validation error on `vendorId`**. Read that error as "you reached for the old model" and re-read this
block.

These four are genuinely gone and *do* hard-error as unknown tools: `delete_purchases`,
`bulk_move_purchases`, `bulk_set_purchase_trade`, `bulk_set_purchase_cost_type`, and
`get_purchase_analytics`.

| Old tool | New tool (for a LEDGER LINE) |
| --- | --- |
| `create_purchase` | `create_expense` |
| `get_purchase` | `get_expense` |
| `list_purchases` | `list_expenses` |
| `update_purchase` | `update_expense` |
| `delete_purchases` | `delete_expenses` |
| `bulk_move_purchases` | `bulk_move_expenses` |
| `bulk_set_purchase_trade` | `bulk_set_expense_trade` |
| `bulk_set_purchase_cost_type` | `bulk_set_expense_cost_type` |
| `get_purchase_analytics` | `get_expense_analytics` |

**Your calls otherwise do not change.** `create_expense` / `update_expense` still accept **`vendor`
(a plain name string)** and **`orderId`**, exactly as when they were columns; the repo resolves them
to a `Vendor` + `Purchase`, creating both on first sight. There is no "create the vendor first" step
and no id to look up. `expenseOut` still returns `vendor` and `orderId` (through the join) and now
also returns `purchaseId` + `vendorId`.

Five consequences that bite:

- **`vendor` and `orderId` travel together.** An order id with no vendor is **silently dropped** — an
  order id is only unique *within* a vendor, so alone it can't name a transaction. An
  `update_expense` carrying `orderId` but no `vendor` changes nothing about the row's purchase (other
  fields in the same call still write, so this fails quietly). `vendor: null` is different again — an
  explicit *detach* from the purchase.
- **`orderId: null` always mints a NEW purchase.** So does a `vendor` write with no order id. Re-writing
  `vendor` on a row that already sits on a no-order-id purchase therefore moves it to a fresh empty
  purchase and orphans the old one (which then reads "stated $X, expenses $0"). Set vendor+order once, on
  purpose; don't re-touch it idempotently.
- **To put several Expenses on ONE no-order-id Purchase**, create the first Expense with `vendor`, read
  `purchaseId` off the response, and pass **`purchaseId`** (a `create_expense` field) on the rest. An
  explicit id short-circuits name resolution and is never a guess. With a real `orderId` you don't
  need this — the partial-unique `(vendorId, orderId)` index makes every Expense for that order land on
  the same purchase automatically.
- **Vendor names are matched EXACTLY** (trimmed, not case-folded) and **there is no vendor-merge
  operation in v1**. `Amazon` / `amazon` / `Amazon.com` become three roster rows. Spell a vendor the
  way the ledger already spells it — check the roster before inventing a spelling. Note the roster
  spelling often differs from the letterhead: the ledger says `Lutz Plumbing` where the invoice reads
  *Lutz Bath & Kitchen*, `CabinetParts` where the email header reads *CabinetParts.com*. Follow the
  roster. (`update_vendor` renaming IS safe — purchases reference by id, nothing is re-keyed and no
  spend moves — but that's a deliberate roster decision, not something to do mid-import.)

  **When the vendor is genuinely NEW, seed it with `create_vendor` rather than letting the write
  mint it.** "Follow the roster" assumes a roster row exists; `list_vendors` returning zero hits is
  the case it doesn't cover. Resolving a name through `create_expense`/`update_expense` does create
  the vendor, but leaves `website` and `notes` **null** — a bare row that tells the next pass nothing
  and gives the UI no link. One `create_vendor` call with `name` + `website` first, then the expense
  write resolves onto it by exact name. Take the spelling from the sender/letterhead (`Osmo Oil`,
  from `info@osmowoodoil.com`, website `https://osmowoodoil.com`) — you are *defining* the roster
  spelling here, and nothing in v1 can merge a near-duplicate away later, so it is worth the extra
  call to make it deliberate rather than incidental.
- **A purchase minted this way has NO `date`.** Resolving `vendor` + `orderId` through `update_expense`
  creates the `Purchase` with `date: null`; it does not inherit the expense's date. Every purchase
  created this way in the 2026-07-31 pass came back dateless and needed a follow-up
  `update_purchase`. Set `date` (and `statedTotal`) on the purchase right after the write that minted
  it — a dateless purchase falls out of every `dateFrom`/`dateTo` filter on `list_purchases`.

**`Vendor` and `Purchase` have a full MCP toolset.** You do not need SQL or the web UI to read the
roster, open a purchase, or set a `statedTotal`:

| | Vendor | Purchase |
| --- | --- | --- |
| read | `list_vendors`, `get_vendor` | `list_purchases`, `get_purchase` |
| write | `create_vendor`, `update_vendor` | `create_purchase`, `update_purchase` |

- `list_vendors` is where a `vendorId` comes from — `list_expenses`, `list_purchases` and
  `create_purchase` all filter/write by vendor **id**, and since the shortcode cutover a `VEN-`
  shortcode is the only form they accept (a uuid is now a zod error, not a fallback). It also returns
  `purchaseCount` and `spend` per vendor.

- **`productId` is a `PRD-` shortcode on every write you make.** As of the 2026-07-31 shortcode
  cutover, `expenseCreateShape.productId` (`packages/schemas/src/project.ts:808`),
  `splitExpenseInput`'s `parts[].productId` (`packages/schemas/src/purchase.ts:235`) and
  `expenseMcpOut.productId` (`project.ts:1357`) are all `productShortcode` — so the `productId` you
  read off an expense goes straight back into the next `update_expense` / `split_expense`. Round-trip
  it freely. *(Earlier revisions of this file said the opposite — that these took a branded uuid and
  must not be round-tripped. That was true before the cutover and is now exactly backwards: a uuid is
  a zod error on those fields.)*

  ⚠️ **The one place still on uuid is the FILTER, and it is unreachable.**
  `expenseFilterFields.productId` (`project.ts:866`) and `taskFilterFields.subjectProductId`
  (`project.ts:549`) were missed by the cutover — those field blocks are standalone objects that
  don't spread `expenseFields`/`taskFields`, so the create/output overrides skipped them. Since
  `productMcpOut.id` (`product.ts:625`) is a `PRD-` code, **no MCP surface hands out a product uuid at
  all**, so there is currently no value you can pass. Don't burn time trying to filter expenses or
  tasks by product over MCP — get there via `get_product` → the product's own expenses, or fall back
  to amount+date via `match_expenses`.

  The boundary test named "split_expense takes its expenseId/projectId/productId by shortcode"
  passes no `productId`, so it does not actually cover the split path — don't read it as proof.
- `list_purchases` filters on `vendorId`, `orderId`, `search` (substring on order id),
  `dateFrom`/`dateTo`, `orderIdPresenceFilter`, `statedTotalPresenceFilter`, `dataStatus`, and
  `dataGap`. Prefer the computed queue over reconstructing completeness from individual presence
  filters.
- **Delete is deliberately withheld for both.** Deleting a vendor refuses while live purchases point at
  it; deleting a purchase nulls `purchaseId` on real money. Those stay UI-only.
- `attach_file` files Purchase evidence — it takes the purchase's **`PUR-` shortcode as `entityId`**,
  **no `entityType`**, and a required `documentKind`. Use `reclassify_purchase_document` when an
  existing attachment was classified incorrectly. See the size trap in Phase 4 before trying to
  attach a PDF.

## Ground rules

- **Never write an identifier you did not read from the export.** ASINs/SKUs/order numbers are
  plausible-looking strings and a fabricated one is indistinguishable from a real one until it 404s.
  (Two were invented in the 2026-07 Amazon pass; both wrong.)
- **Propose before writing.** Show matches with evidence — model/SKU, price delta, date delta — and
  get per-batch approval. Similarity ranks, it does not verify.
- **Verify writes against the DB**, not only the mutation response. Product MCP responses now
  include `model`, external ids, and computed `dataQuality`, so the verification read should show
  the gap disappearing.

### Product-enrichment handoff

When a purchase source reveals a product UPC/EAN/GTIN, manufacturer model,
Amazon ASIN, retailer SKU, or canonical product URL, capture it on the product
using the existing `model` and `upc` fields plus the typed
`patch_product_external_ids` workflow in
Phase 4. After the financial import is reconciled, invoke `$product-enrichment`
to find one verified cover image and fill other exact-variant metadata. Product
research must not delay or block expense, purchase, or settlement reconciliation.

## Phase 1 — decide how far to trust the export

1. **Prove coverage.** Print min/max date and a per-year count. An eBay CSV once silently held only
   records #259–312, which led to "this tool was never sold". Gaps or a truncated range change every
   conclusion downstream.
2. **Check for per-line prices.** This is the single biggest branch. The Amazon takeout has
   `Unit Price` / `Unit Price Tax` / `Total Amount` per line; Gmail receipts do not. With per-line
   prices you never invent a split. Verify `Total Amount` is per-line, not a repeated order total
   (count multi-line orders whose lines all share one total).

   **Then decide whether a printed price is UNIT or EXTENDED, by arithmetic — never by eye.** A
   receipt showing `2 x Widget … $1.61` may mean $1.61 each or $1.61 for both, and the layout rarely
   says. Sum the lines both ways and see which lands near the order total. CabinetParts order
   `F3380366` reads as **$52.60** taken as line totals against a **$121.43** order — a gap far too
   large for tax and shipping — but **$96.60** as unit x qty, leaving a plausible $24.83. Getting
   this backwards understates an order by half and quietly corrupts every per-item basis you derive
   from it. An all-qty-1 order (CabinetParts `F3359420`) is immune, which is exactly why the trap
   only shows up on the orders you didn't check.
3. **Dedupe refund/return rows.** Amazon's `Refund Details.csv` repeats refund events — 33 of 164
   rows in the 2026-07 export, an 18% overstatement. Dedupe on
   `(order, amount, refund date, quantity, reason, disbursement type)` *before summing anything*.
   `Returns Status.csv` duplicates far worse (8× per event).
4. **Drop `Order Status == 'Cancelled'` and `$0` lines** from the match pool. A cancelled same-day
   twin produced a false match; $0 lines are free replacements, not purchases.
5. **Parse money defensively** — amounts ≥ $1,000 contain commas (`1,099.77`); a naive `float()`
   silently yields 0.0 and excludes every expensive line.
6. **Establish the source's date coverage before treating absence as evidence.** "No email for it, so
   it didn't happen" is only valid inside the window the source actually covers. Facebook Marketplace
   sends nothing from `facebookmail.com` (that domain is login codes only); commerce mail comes from
   `noreply@marketplace.facebook.com` and `commerce-no-reply@support.facebook.com`, and in this
   mailbox the earliest is **2026-05**. A "no Marketplace sale email exists" inference about a 2025-11
   order is therefore worthless, while the same inference about 2026-07 is solid. State the window
   explicitly whenever you argue from silence.

**Source authority — do not collapse these layers.**

| Source | Gives you | Trust |
| --- | --- | --- |
| **Card / bank statement** | **what actually cleared, and when — charges AND refunds** | financial settlement evidence; does not change the vendor total or Expense lines |
| eBay **seller** `OrdersReport` CSV | `Sold For`, `Total Price`, sale date, buyer | settlement — best of the per-vendor sources |
| eBay "You got paid" email | confirmed payment amount | settlement |
| Vendor order confirmation email | order total, per-line prices | ordered, not settled |
| ui.com-style confirmation | *no prices at all* — invoice is a separate download | needs the status page |
| **Marketplace/listing exports** | **asking prices and a "Sold" flag** | **weakest — see Phase 4** |

**Statements prove whether settlement landed, not what the vendor order said.**
Use them to create or update FinancialTransactions, including expected refunds;
keep vendor receipts as the source for Purchase identity, stated totals, tax,
shipping, products, and project attribution.

Getting it: **Monarch's MCP has been paused since at least 2026-07** ("a data portability question
raised by one of our partners"), so `GetTransactions` returns a notice, not data — do not plan a
verification around it. Ask the operator to paste the rows instead; the export format is
`date,merchant,category,account,original_statement,,amount,,owner,` with **charges negative and
credits positive**.

`~/Documents/personal/backups/random data dumps/purchases/` holds the exports — note the
`purchases/` subdirectory, one level below where this file used to point. Currently:
`amazon-orders-july-27-2026/`, `eBay-OrdersReport-*.csv`, the Home Depot
`Purchase_History_*.csv`, and `Facebook marketplace order history.pdf`. Check for a seller report
before doing any Gmail sweep for disposals: it is one grep versus twenty subagent minutes, and it
carries real numbers.

### Sweep outward to discover Purchases that do not exist

An inward Cubby query cannot find a missing entity. Establish the coverage window for each Gmail
search, receipt folder, PDF set, or vendor export, then extract vendor, order/receipt id, order date,
literal total, and available line labels/prices. Check cancellations and refund sources before
matching. Send the batch through `match_expenses` with vendor, orderId, date, signed amount, and
label, then classify each source record as an exact Purchase match, strong Expense candidate,
possible aggregate/split match, or `unrecorded_purchase_candidate`.

A zero-match result is only a candidate. Before proposing creation, repeat exact vendor+order-id and
amount+date checks, inspect plausible aggregate names and split siblings, inspect refund/return
exports, exclude cancelled and zero-dollar records, and confirm the Project from both its date
window and semantic fit. State the source coverage window and evidence in every proposal. Never
create automatically. Unlinked FinancialTransactions are secondary discovery signals and never
create or alter Expenses.

## Phase 2 — match, strongest key first

| Key | Strength | Notes |
| --- | --- | --- |
| `orderId` (+ `vendor`) | exact | Best. One order is one purchase; reconcile cost against it directly. |
| Order id in `notes` prose | exact, legacy | Pre-`orderId` rows. Lift it out as you touch the row — with the vendor in the same call. |
| ASIN / SKU / model in `url` or `model` | proof-grade | Model appearing verbatim in the vendor title is proof. |
| Exact tax-inclusive amount + date | strong *with* a name check | The workhorse; see traps below. |
| Embedding / fuzzy name similarity | hint only | Never auto-apply. |

The bottom three rows are what **`match_expenses`** automates — pass `orderId` and it uses the top
row too, in the same call. Reach for it rather than issuing a query per line.

**Vendor identity hides in four fields, not one.** Before concluding a row has no vendor, check its
resolved `vendor`, plus `url`, `notes` *and* `name`. Pre-roster rows routinely carry a bare store name
as the whole `url` value (`home depot`, `lowes`, `tol nirvana`, `wwe`) or as a short `notes` string or
in the name itself (`woodworker express`, `supplyhouse return`). A 2026-07 sweep lifted 268 + 23 such
rows into the vendor field. Note `url` is rendered as `<a href={url}>` — a marker left there paints a
broken link, so clear it once the vendor is recorded.

`list_expenses` searches all four: `search` matches the NAME (and takes several terms, which **OR** —
pass `["dust","vacuum"]` when guessing at synonyms), while **`notesSearch`** and **`urlSearch`** are
separate substring filters on those two columns. So the marker sweep is
`urlSearch: "home depot"` + `vendorPresenceFilter: "none"`, not a scan.

It also has **`costMin`/`costMax`** — inclusive, **signed** dollar bounds. `costMax: 0` is the
credits worklist; `costMin: 500` + `vendorPresenceFilter: "none"` is the big-ticket vendorless
worklist. A row with no cost recorded falls out of any cost window, so use
`costPresenceFilter: "none"` to find those instead.

An expense with no purchase attached (`purchaseId IS NULL`) is exactly "no vendor recorded" —
`purchase.vendorId` is NOT NULL, so the two can't disagree. That's the
`vendorPresenceFilter: "none"` worklist.

**A shorthand marker may name the BRAND, not the seller.** `action machining` looked like a vendor;
the unions were Action Machining *brand*, bought from **Buy Action Products**. Confirm the marker
against the actual receipt before promoting it to a vendor — and remember that promoting it *creates
a roster row* with that exact spelling, which nothing in v1 can merge away. Some markers resolve to
nothing at all — `central` ($100, pipes) survived every search and was left null rather than guessed
into `Central Builders`, an unrelated vendor already in the ledger. Leaving it null is the right
answer.

**Order dates can disagree by timezone.** An Acme confirmation email headed "Order Date: Nov 27" was
sent at 03:59 UTC — 19:59 PT on the 27th — while Acme's own record and its shipping mail both say
Nov 28. Not a conflict worth resolving twice: prefer the vendor's own order record and note why.
(`purchase.date` is the purchase date and `expense.date` is the **ledger** date that drives monthly
buckets and project windows — an invoice dated the 3rd can clear on the 8th, and they're allowed to
differ.)

### Don't hand-roll the amount+date sweep — `match_expenses` does it

**`match_expenses` is the tool for this whole phase.** Pass up to 200 export lines at once, each with
your own `key`, a `date`, a **signed** `amount`, and — whenever the line has them — `orderId`,
`label` and `vendor`. It returns ranked candidates per key and never writes anything.

It exists because the sweep is not expressible as a search, and every hand-rolled version of it has
gone wrong in the same few ways. Those traps are now encoded in the tool, but you still have to read
its output correctly:

- **Tolerances are relative, not absolute** — ±$0.25 is sensible at $200 and meaningless at $1. The
  tool matches on one window (10% below for pre-tax entry, 15% above for tax and fees, with a $1
  absolute floor) and reports `amountDelta` / `ratio` / `ratioLabel` so you can judge each hit.
  ⚠️ **Below about $20 the band contains almost anything — read the line descriptions.** A $0.93 order
  (wood screws, net of two returns) matched a $1.00 `5 yd nursery mix` row and had to be reverted.
  The tool *will* return that candidate; no tolerance setting excludes it while staying usable, and
  only you can tell the two apart.
- **`tokenOverlap` grades, it never filters.** Zero overlap is routine on true matches — that is the
  whole reason this phase exists. And tokenizers miss compound words (`labelmaker`/"label maker",
  `stepstool`/"step stool", `straightedge`/"straight edges"), so sweep the zero-overlap bucket by eye
  before discarding it.
- **`dayDelta` is supporting vendor-export evidence, never a required rule.** Genuine vendor-order
  matches often cluster near the Expense date, but invoices, shipping, and ledger dates can differ.
  Do not use date proximity to accept or reject a statement settlement match; FinancialTransactions
  have their own transaction and posting dates.
- **Costs are tax-inclusive; the house rate is 8.625%** — but do **not** hand-test discrete
  hypotheses (`cost`, `cost × 1.08625`, `cost ÷ 1.08625`, order-total). That is what failed before:
  pre-tax entry was a recurring bug class (24 rows in one pass, found four separate ways *because
  each hypothesis was tested alone*), and no hypothesis covers an ADDITIVE fee at all. `ratioLabel`
  classifies each hit as `exact` | `plus_tax` | `pre_tax` | `other` instead — and on an `other`, read
  the raw `amountDelta`: a residual of exactly `9.99` or `12.50` is shipping, which a
  hypothesis check would have silently rejected. Hand-rounded variants (a $599.00 row for a $599.99
  unit price) land inside the window rather than needing their own rule.
- **The tax BASE is not always the whole subtotal — freight is often exempt.** Lutz invoice `1207`
  states subtotal $2,030.75 and tax $170.41. Checking 8.625% against that subtotal computes $175.15
  and reads as a $4.74 error; the rate is actually charged on the $1,975.75 of *goods*, with the
  $55.00 freight untaxed ($1,975.75 x 0.08625 = $170.41 to the cent). Before calling a tax figure
  wrong, try the subtotal **minus shipping/freight** as the base. Ferguson does the opposite —
  $2,025.50 tax charged at order level with $0 freight — so neither is the default. When you find
  one, write the base into the purchase notes: a later pass will re-derive the "discrepancy" and try
  to fix it.
- **Always pass `orderId` when the line has one** — see the mirror trap in Phase 3. That arm ignores
  the day window on purpose.

Planned (`future: true`) rows come back flagged, not filtered — an export line often turns out to be
one. And when one ledger row is the best candidate for two export lines, it is returned for both;
resolve that yourself rather than assuming a one-to-one assignment.

## Phase 3 — before proposing any *add*, rule out an existing row

**Keyword search cannot do this. The ledger names the *thing*, not the product.** Searching
`festool`/`vacuum`/`vac` for a "Festool Vacuum" product found nothing, so a row was added — but a
`dust extractor` row for the identical amount and date had existed since 2024. Zero shared tokens.
The same trap hid a Bosch miter saw booked as `chop saw`. **The only filter that works is amount +
date across the whole ledger, ignoring names entirely** — which is exactly what **`match_expenses`**
does. Run it before every add, and again as a post-hoc check over each newly created row (same
amount, ±30 days) to catch what slipped through.

An empty `candidates` list means "nothing within the window", **not** "this expense is missing" — an
aggregate row covering your line can sit at an amount no formula relates to yours (see below).

`find_similar_entities` (`expense_to_product`) is the right *candidate generator* for the separate
question of which product a line refers to, but its own docs warn the scores rank without verifying —
never auto-link.


This is the trap that survives every automated filter. A ledger row often **aggregates several
export lines** at an amount that reconciles to nothing:

- `network rack and equipment` $244.11 = 6 lines, exact
- `umbrella and stand` $301.19 = order total ÷ 1.08625 (pre-tax)
- `string lights & wire & eyebolt` $103.20 vs a $120.21 order — **no formula at all**

Only the *name* matched that last one, and it reached a written proposal as two new rows before being
caught. So: for each candidate add, look for a same-window ledger row whose **name plausibly covers
the item**, independent of amount. Subset-sum checks help but generate false positives of their own (a
4-line combo once "explained" a ZipWall as a book).

Also confirm the row's own notes don't name a different vendor — one row reading
`home depot WN22422541` was set to Amazon on an amount+one-token match.

**The mirror trap: the ledger may hold the SPLIT while you search for the AGGREGATE.** Phase 3 above
guards against adding components when a combined row exists. The reverse also happens and defeats the
amount+date check completely, because the total you are searching for *appears nowhere*. B&H order
`1121197219` was already booked as two sibling rows ($203.36 AP + $102.91 switch); an amount+date
search for its $306.27 order total found nothing, so a duplicate aggregate was created and had to be
deleted. **Whenever the export line has an order id, pass it as `match_expenses`' `orderId`** — that
arm catches both directions in one shot, and amount+date catches neither reliably. A candidate coming
back with `matchedOn: "order_id"` is telling you it found the row by identifier rather than by guess,
which is why it outranks every amount hit; that arm also ignores the day window, since a purchase's
lines can sit weeks from the order date. Post-split this is stronger, not weaker: both sibling lines
hang off one `Purchase`, so the group is a parent link rather than a two-column string match, and
`statedTotal` can hold the $306.27 the search was looking for.

⚠️ **A card or bank statement is settlement evidence, not an Expense import.** Normalize each
statement row into a FinancialTransaction, deduplicate it by source reference, and link it to a
Purchase only when vendor/order evidence identifies one truthful purchase event. Do not require the
statement amount to equal one Expense or even the Purchase's aggregate Expense total: installments,
split tender, shipment billing, refunds, and store credit legitimately produce several settlement
rows. An unmatched statement row remains an unlinked FinancialTransaction; it does not prove that
spend is missing and must never create or mutate an Expense automatically.

**Check the refund file before adding ANY expense — not just when reconciling.** This is the single
most expensive omission found so far. A 2026-07-28 pass added rows whose notes read *"order had no
ledger row at all"*, having read `Order History.csv` and never opened `Refund Details.csv`. Eight of
those orders had been refunded and the refunds were never booked: Level Lock+ $357.38 and a Huepar
rotary laser $339.14 **refunded in full**, a Schlage deadbolt $344.21, a Rollo printer $193.98, a
UAP-AC-PRO $150.43 ("Accidental order"), plus partials — **$1,413.96 of phantom spend, three of them
for items never actually owned.** Two tells that should have prompted the check: the product had no
inventory entry, and the "purchase" was for something the operator had no memory of.

Distinguish `Reversal Reason` when you find one: `Customer return` means the item is gone (expect no
inventory); `Account adjustment` is a price credit on an item **kept** (reduces basis only, do not
treat as a disposal). And a refund needs **no row at all** when it offsets a line that was never
booked — an Eagle gas can, a disco spotlight — because buy and refund net to zero.

**"Explained" means *nothing to add* — not *nothing to do*.** This is a second, subtler failure of
the same phase. A row identified as an aggregate match is correctly excluded from the *missing*
list, and then routinely forgotten. It still needs:

1. **`vendor` + `orderId`**, like any other matched row (in the same call — see the split warning
   above). Skipping this is self-defeating: the row never gets a `Purchase`, so the Phase 5
   reconciliation and every per-purchase query are blind to exactly the rows most likely to hide an
   error.
2. **A line itemization in `notes`**, so the next pass recognises it as an aggregate instead of
   re-deriving it (or re-proposing its components as missing).
3. **Splitting into sibling lines** where the components are separately tracked products — one
   expense per product, summing to the original total, all hanging off the same purchase.
   `productId` is single-valued, so an unsplit aggregate can never link more than one product, and
   any product in inventory whose only expense is inside an aggregate has **no cost basis at all**.
   This is `split_expense` now (below) — not a row-naming convention.

Real case, now **closed** — read it for the shape of the failure, not as an open item. A
`scaffolding` $434.47 row was correctly identified as covering a 2-line MetalTech order and then
dropped; months later both MetalTech products still sat in inventory with no cost basis at all. The
2026-07 pass finished it: that row is gone, replaced by `MetalTech Baker scaffold` $282.41 and
`MetalTech 6ft guardrail system` $152.06 (summing to $434.47), each carrying its own `productId`,
both on one purchase for Amazon order `113-3195277-6006629`. Don't go hunting for the $434.47 row.

Treat the aggregate bucket as a worklist, not a dead end. There is no query for "is this row an
aggregate" — that's a judgement about whether a name covers more than one thing — so measure the
proxies rather than trusting a remembered count. As of **2026-07-30** the ledger holds **1112**
expenses, of which **193** have no purchase attached (`vendorPresenceFilter: "none"`) and **557** no
order id (`orderIdPresenceFilter: "none"`). Re-run those two filters instead of quoting these
numbers back: they are a snapshot, and the point of having the filters is that a fresh one costs a
single call.

## Phase 4 — writing

- Set `vendor` **and `orderId`** on every row you touch, in one call. `orderId` is the vendor's own
  order/receipt id, free text, unique per vendor — `111-1234567-1234567`, `WN63446464`, `DT640921`,
  `#11334`. This is what resolves the row onto a `Purchase`; putting the id only in `notes` leaves
  Phase 5 and every per-purchase query blind to everything you import.
- `notes` carries the *human-readable* provenance, not the identifier: itemize the lines for
  aggregate rows so the row is never re-flagged as missing, and note anything odd (a cancelled twin
  order, a line deliberately left unbooked). Append to substantive notes; replace bare markers like
  `"amazon"`. Legacy rows store the id as `"<Vendor> order <ID>"` prose — lift it out (with the
  vendor) when you touch them.
- **Record the purchase's `statedTotal` and attach its invoice.** These are the two things the purchase
  exists for, and they turn "do the three Expenses sum to $431.24?" from a reconstructed `GROUP BY` into
  a single-row comparison:
  - `statedTotal` is what the paperwork *claims*, in dollars. It is **never summed into spend** —
    spend is always `SUM(expense.cost)` — and a mismatch is frequently correct (a partial refund
    reduces an Expense without changing what the purchase paperwork stated). Nothing rejects a write over it and
    nothing back-computes a cost from it. **`update_purchase` is how you set it** (`create_purchase`
    can carry it too) — no web-UI detour, and no reason to leave it blank on a purchase you imported.

    **The one real carve-out: paperwork that states no total.** Some eBay order emails print an item
    price and nothing else — no tax line, no order total — while the ledger row is tax-inclusive.
    Recording the $60.99 item price against a $66.25 row would flag that purchase in
    `purchasesNotReconciling` forever as a false positive. Leave `statedTotal` null when the source
    genuinely never stated one, and say so in the expense notes so the next pass doesn't "finish the
    job". `statedTotalPresenceFilter: "none"` is a worklist, not a defect list.

    ⚠️ **Check the actual email before invoking this — eBay's confirmations are not uniform.** The
    2024-01-22 Bosch 11255VSR order (`15-11083-32845`) carries a full "Order total" block: Subtotal
    $120.00 / Shipping Free / Sales tax $10.35 / *Total charged to amex x-2002* $130.35. That is a
    stated total and belongs on the purchase. The carve-out is about what a *particular* email prints,
    not a property of the vendor — applying it by vendor name leaves recordable totals on the floor.
    When you do record one from an email that breaks the pattern, say so in the purchase notes, or the
    next pass will "restore" the null.
  - The PDF invoice / receipt photo now has a home: `attach_file` with
    `entityId: <the PUR- shortcode from the expense row>`, `contentType: "application/pdf"`, and the
    evidence's `documentKind`.
    **There is no `entityType` field** — the prefix picks the entity. One `Image` can be filed
    against several purchases (a statement covering both).

    Primary evidence is exactly `order_confirmation`, `sales_order`, `invoice`, or `receipt`.
    `payment_receipt`, `credit_memo`, `return_authorization`, `quote`, `estimate`, `contract`,
    `statement`, `specification`, and `other` remain useful evidence but do not satisfy the
    `primary_document` check.

    ⚠️ **You probably cannot do this from the main loop.** `data` wants base64, and a perfectly
    ordinary one-page receipt blows the context: a 71KB PDF is **94,684 base64 characters**, which
    `Read` truncates (~22k chars delivered, and the full file is billed near 90k tokens *in* before
    the same payload is echoed *out* in the tool call). Don't try to page through it and reassemble —
    a mis-stitched receipt is worse than none. Either hand the upload to a subagent, which pipes the
    bytes straight into `attach_file` without them landing in the conversation, or ask the operator
    to drag the file onto the purchase in the UI. `url` is the only cheap path, and only when the file
    is already on a public http(s) URL — do not upload a private receipt somewhere to manufacture one.
    Filing the document is optional for financial reconciliation, but required for computed
    completeness unless `primary_document` is explicitly excepted. **Never hold up verified numbers
    on an attachment.**
- Per-purchase queries are one row each now — no reconstructing groups from `(vendor, orderId)` strings,
  and **no SQL**:
  - **Purchases whose Expenses don't add up to the stated paperwork total** is
    `list_problems` with `type: "purchasesNotReconciling"`. It returns vendor name, `orderId`, date,
    `statedTotal`, `expenseTotal` and `expenseCount` per offending purchase, ordered by the size of the
    discrepancy (largest first — a $400 gap before a $2 one). This is the server-side detector
    `findPurchasesNotReconciling`; it applies the shared `RECONCILIATION_TOLERANCE` rather than a
    hand-typed `0.01`, so it can't drift from what the rest of the app calls a match. A **soft** flag:
    a worklist, not an error list.
  - **Every multi-expense Purchase** (aggregates, split siblings, buy/return pairs) comes off
    `list_purchases`, which returns `expenseCount` and `expenseTotal` on every row.
    `statedTotalPresenceFilter: "none"` is the purchases-with-nothing-to-reconcile-against worklist.
  - **The Expenses of one Purchase** are `list_expenses` filtered by that purchase's `purchaseId` — the exact
    scope, needing no `vendorId`/`orderId` cross-reference.
- Canonical product link: `https://www.amazon.com/dp/<ASIN>`.
- Vendor identifiers for a *product* go in **`ProductExternalId`**
  (`source`/`kind`/`externalId`/`url`) — never a new column, never `Product.model` (that's
  manufacturer identity). Use `patch_product_external_ids` to upsert or explicitly remove only the
  named `(source, kind)` slots; preserve everything else. `update_product.externalIds` remains a
  whole-set replacement for compatibility. New sources are normalized to trimmed lowercase while
  `externalId` remains case-sensitive. Existing `legacy_unspecified` rows stay that way unless the
  evidence explicitly establishes a typed replacement.

  Product MCP outputs include `model`. Use `modelPresenceFilter: "none"` for the missing-model
  worklist. `externalIdSource` plus `externalIdPresenceFilter` exposes source-specific identity gaps;
  for example `{ externalIdSource: "amazon", externalIdPresenceFilter: "none" }` finds Products
  without an Amazon external id. Before writing identifiers, call
  `find_product_external_id_collisions` with 1–100 exact
  `identifiers: [{ source, kind, externalId }]`. Read each ordered `missing`, `unique`, or
  `collision` result and its live Product owners; deleted owners never count. Do not combine
  `source` and `identifiers` in one call. Source-only and unfiltered calls remain broad advisory
  audits, with collision-only `items`.

  **Some vendors print ONLY their own code, and it encodes the real model.** Ferguson never shows a
  manufacturer model number — its order confirmation and its bid both list `WGR366`, `SCL3050USTR`,
  `BSHX78CM5N`. Those are the maker's models with a brand letter prefixed (and, for Sub-Zero, the
  slashes stripped): `GR366`, `CL3050U/S/T/R`, `SHX78CM5N`, each confirmed against the manufacturer.
  So: put the vendor code in `externalIds` **and** recover the real model with one web check per
  item — don't leave `model` empty and don't write the decoded guess unverified. The check earns its
  keep: `CL3050U**ID**/S/T/R` is the internal-dispenser variant, and only the absent `ID` tells you
  which unit was actually bought. Contrast a distributor like Lutz, which prints genuine
  manufacturer part numbers (`K50-102-ST-SN`, `9611-K50-SN`) that go straight into `model`.
- **Which Expenses get a product — and which never do.** A `Product` is a purchasable item **or a
  `misc:` placeholder** (`repo/product/index.ts`), so the bar is lower than "a specific SKU". Two
  classes never get one:
  - **A service or labor Expense** (`costType: "services"` — hauling, drywall, install labor,
    delivery/freight). There is no object. `Expense.productId` is an **acquisition** edge that the
    net-cost and owned/sold-window derivations read, so a labor Expense hung off a product silently
    inflates that product's basis. Work *about* a product is `Task.subjectProductId` instead — the
    furnace is modelled correctly today as `Bryant 801S gas furnace` (materials, productized) plus
    `furnace replacement labor` (services, not). Zero services rows carry a product; keep it that way.
    This is a rule, not a constraint — `costType` is an operator-assigned reporting dimension and is
    inconsistent in places (`countertop deposit` is materials, `2nd half of countertop` is services,
    same vendor, same slab), so don't refuse a write over it, just don't make the link.
  - **An installment or progress payment** (`hotel payment 3/11`, `wedding planner 2 of 4`,
    `retaining wall 2/2`). That grouping belongs to the purchase and the project.

  Everything else gets one, **after unbundling**. A bundle (`wall materials, strut stuff`) and an
  aggregate credit (`lowes returns` −$77.46) are *un-split imports*, not a kind of thing — split them
  per Phase 3 and each part takes its own product. Two shapes that look like exceptions and aren't:
  - **A receipt-identified commodity material is a Product.** Lumber, plywood, sheet goods, tubing,
    and fittings do not need a consumer brand to be productized when the receipt gives a stable,
    repeatable specification. Dimensions, grade, treatment, finish, profile, and similar purchasing
    distinctions define the generic Product; different meaningful specifications are different
    Products. For example, `Douglas Fir 2x4 STD/BTR S4S`, `1/4-in 4x8 AC exterior plywood`, and
    `15/32-in 4x8 CDX Struct 1 plywood` are three Products. Use `generic` as the manufacturer when no
    maker is stated, put the printed vendor code in `externalIds`, and acknowledge `product_model` as
    `not_applicable` when the material genuinely has no manufacturer model. Never copy the vendor code
    into `model` merely to clear completeness.

    **Only an unspecified or heterogeneous bulk bucket stays UNLINKED** — a row named merely
    `plywood`, `metal tubing`, `pvc fittings`, or `assorted clamps` when the evidence cannot recover
    consistent dimensions/grade/SKUs. `misc:` products (`isMiscProduct`,
    `packages/shared/src/constants.ts`) are an **inventory** convenience — a heterogeneous pile on a
    shelf, exempted from `findProductsMissingPrice` and carried as `miscNoPrice` in the location
    valuation — and remain deliberately **not** an expense-link target: hanging a $171 clamp run off a
    $5 `assorted clamps` bucket makes "net cost" mean two different things depending on the product.
    See *Bucket products do NOT get product links* in `docs/todos.md`. Unbundle into receipt-identified
    products where the evidence allows; otherwise leave the row unlinked.
  - **A sample of one identified material is that product** (`walnut wood samples` → the walnut you
    then order); a mixed sample bag is a bucket and follows the rule above.
  - **A subscription is one product with N recurring expenses.** `chief architect monthly` (9 rows,
    $1,791), `cutlist optimizer` (5) and `autocad lt` (4) are the ledger's highest-frequency names and
    are all productless, so the "how often, how much" question they exist to answer has nowhere to
    land. Keep the *schedule* off the product — the product is the license, the payments are the
    expenses, exactly as 11 progress payments are 11 purchases.

  ⚠️ **A mis-minted product is close to permanent.** Any product carrying an expense is *by
  construction* invisible to `findOrphanedProducts` — `Expense.productId` has role `acquisition`,
  which retains — and refuses deletion with `PRODUCT_HAS_EXPENSES`. So a duplicate you create here
  will never appear on the Problems page and Delete won't take it; the operator has to unlink the
  expense by hand first. Mint from a **receipt line's own key** (SKU/ASIN/part number), never from a
  name match — `find_similar_entities` ranks, it does not verify. Where the receipt has no line
  items, leave the row unsplit and productless rather than guessing a product into existence.
- **`create_product` has no `model` field** — create, then `update_product` to set `model`,
  `category`, `expectedQuantity`, `tags` and `externalIds`. Budget two calls per product.

  **`category` is not optional in practice.** A null category is deliberately read as *potentially
  food* so uncategorized groceries keep their unit-coverage grading (`packages/shared/src/category-theme.ts`),
  which means a tool left uncategorized lands in `findProductsWithoutMappings` demanding
  weight/volume/calorie coverage it can never have. The taxonomy includes `software` for licenses and
  subscriptions; services/labor still do not become Products.
- **Tag a durable and its consumables with the same value** (`subzero-fridge`, `ews-under-sink`,
  `wolf-hood-36`); `category` distinguishes them (`household` vs `supplies`). This is how a filter
  finds its fridge when neither name shares a token. And put a maintenance task's `subjectProductId`
  on the **durable asset, not the consumable** — the schema is explicit that "a product can
  accumulate a chronological history of many tasks", which only makes sense for the thing that
  persists. Point "replace fridge water filter" at the filter and the fridge's own page shows no
  service history at all.
- **Splitting an Expense** is **`split_expense`**: pass the `expenseId` and ≥2 parts, each with its own
  `name`/`cost`/`costType`/`trade`/`projectId`/`productId`. The parts land on the same purchase, the
  original is soft-deleted, and the purchase's `statedTotal` is **seeded from the original cost** when
  it had none — so the parts have something to reconcile against. A deliberately mismatched sum is
  displayed, never rejected. This **replaces the `(combo, saw portion)` row-naming convention** that
  used to encode splits in row names; don't write those names any more. It refuses on an expense with
  no purchase attached — record the vendor first, with `update_expense`.

  Do **not** fake it with `create_expense` per part plus `delete_expenses` on the original (the old
  MCP workaround). That hand-rolled path loses the `statedTotal` seeding and the shared-purchase
  guarantee, which are the two things making the split worth doing.

  **Splitting off a receipt's line extensions? Allocate the add-ons — they don't all share a base.**
  Ledger costs are tax-inclusive while a receipt's line extensions are pre-tax, so parts copied
  straight off the lines undershoot the original and leave a phantom gap against `statedTotal`.
  Spread each add-on over the lines it was actually assessed on, which is **not** always all of them:
  on Golden State Lumber's Sales Order 41287100, sales tax (8.625%) applied to the whole subtotal
  *including the $50 delivery charge*, while the 1% CA lumber products assessment applied to the
  lumber only. Derive each rate from the receipt (`add-on ÷ its base`) instead of assuming the house
  8.625% covers everything — a rate that comes out absurd means you guessed the wrong base. Round
  each part to cents last and put any leftover penny on the largest part, so the parts sum to the
  original exactly. A delivery/freight line is its own part: `costType: "services"`,
  `trade: "logistics"`, not `materials`.

  ⚠️ **The split soft-deletes the original — and its `notes` go with it.** Phase 3 tells you to write
  a line itemization onto an aggregate row; splitting that row then buries the itemization on a
  deleted record. **Put invoice-level narrative on the PURCHASE (`update_purchase` notes) before you
  split**, and give each part only what is specific to it. The purchase is the right home anyway: it is
  what the paperwork describes, it survives every future re-split, and it is where the tax base and
  stated total already live.

  Allocate tax per line and the rounding will not close: Lutz `1207`'s six goods lines sum to $170.40
  of tax against a stated $170.41. Put the odd cent on the largest line and say which one carries it,
  rather than leaving the parts a cent short of the purchase.
- **One invoice spanning trades** (Flow Form Plumbing's $2,516 covering rough-in *and* fixtures) is
  **`link_expenses_to_purchase`** — re-parent existing expenses onto one purchase. It moves no money.
  Explicitly **not** for payment schedules: separate transactions stay separate Purchases, so a
  contractor's 11 progress payments are **11 purchases**, not one. The contract-level rollup is
  `Project`.

  ⚠️ **"Payment schedule" does NOT cover a deposit-plus-balance on a single order.** The distinction
  is whether one document fixes the scope and the total. A contractor's progress payments have no
  such document — that's why they stay separate. Ferguson order `5099637` does: one order
  confirmation, one order number, a fixed line-item list, one total, paid $13,000 on 2024-05-14 and
  $12,734.51 on 2024-06-07. That is **one Purchase with two Expenses**, and the schema agrees — the
  partial-unique `(vendorId, orderId)` index means the order number can only ever live on one purchase,
  so booked as two, *neither* could carry the order id and both were invisible to every per-order
  query. Also note `link_expenses_to_purchase` only re-parents: it leaves the drained purchase behind,
  empty, and purchase deletion is UI-only. To combine, use `merge_purchases` instead — it cleans up
  after itself.
- **Merging purchases** is **`merge_purchases`**, for the ~364 order-less singletons no key could have
  grouped. It refuses across vendors (that would rewrite who was paid) and refuses when both sides
  carry a non-null order id (two real order ids are two real purchase events). Destructive and with no
  inverse — there is deliberately **no `splitPurchase`**, one order being one purchase by construction.
  A user action, never a guess: propose the merge and get an explicit yes.

  **It leaves nothing to clean up.** `foldChargeInto` (`repo/purchase.ts`) soft-deletes the loser
  inside the same transaction — *"this helper only ever soft-deletes `deadId`, so it frees a slot and
  never claims one"* — re-points the expenses with an audit row each, and carries the loser's
  `statedTotal`/`notes`/`date` into any field the survivor lacks (never overwriting; a genuine
  conflict is recorded in the audit row instead). So don't tell the operator they need a UI step
  afterwards. And merging **moves no money between months**: `expense.date` is the ledger date that
  drives the buckets, and only `purchase.date` belongs to the purchase.
- **Refund handling.** Settle *where the credit is filed* before picking a shape — that part is not a
  judgement call:

  **A refund Expense belongs on the original Purchase, keyed to the original `orderId`** — never on a
  new Purchase keyed to the refund document number. Every return in this ledger is filed that
  way (`EXP-JE2A` Huepar laser, `EXP-FC8F` compactor pad, `EXP-6EY8` grinding wheel, `EXP-7FPA` fish
  tape), and a 2026-07-29 pass deliberately backfilled the original order id onto each one *"so this
  row is visible to the (vendor, orderId) refund reconciliation"*. The refund's own document number
  goes in `notes`.

  The refund's settlement is a separate negative FinancialTransaction, but its Expense and settlement
  link both remain on the original Purchase. The refund document number is evidence, not a new order
  identity. This is why a refund must not mint a second Purchase.

  The shapes:
  - Full return of a whole order → negative expense at full price, same `trade`, `projectId: null`, on
    the order's own purchase. Buy and return then net to $0 there — `PUR-3GRN`, `PUR-5MFF` and `PUR-E37R`
    each read `expenseCount: 2, expenseTotal: 0`.
  - **Full return of ONE line within a multi-line order** → book every receipt line *including* the
    returned one, then add a `−$X` credit line for it on the same purchase. Do **not** just omit the
    returned line: the purchase should itemize what the receipt actually listed, and the buy/credit pair
    nets to zero anyway. (Zoro 32401787: a $9.07 threaded rod returned out of a 3-line $60.56 order.)
  - Partial refund on a multi-item order → **reduce the expense cost** to the kept items. (Operator
    chose this 11/11 in 2026-07; it fits materials orders better than the tool-lifecycle negative-row
    convention, which is for a tool leaving the collection.)
  - Buy-and-return where **neither** side is in the ledger → nets to zero, do nothing. This is most
    of any refund file (85 of 115 orders in one pass).

  **`statedTotal` is always the literal vendor-printed total.** Never choose gross/net/null to make
  reconciliation look clean, and never net a refund into this field. Record the original charge and
  refund as separate FinancialTransactions; their projected or posted total reconciles against the
  live Expenses while the Purchase preserves what the vendor document actually printed.
- Only add an expense when the **project is known** — date inside a project's window *and* a semantic
  fit. Check project windows first; a project's last activity date tells you if it's live.
- Non-tool/household items stay out of the project ledger unless the operator says otherwise. Ask
  per item; never bulk-add books, clothing, or consumables.
- **A sale or refund carries the same `projectId` as the expense it offsets — but ONLY if its date
  falls inside that project's window.** The project's true cost is net of what the tool later sold
  for, so attach it where you can. The constraint is that **`Project` dates are DERIVED** (see
  [[project-dates-derived-window]]): with `startDate`/`endDate` null the window rolls up from the
  project's expenses and tasks, so attaching a disposal dated after the project ended silently drags
  its end date forward. A Festool accessory bought 2024-05 for *Kitchen: Cabinetry* and sold 2025-12
  would have extended that finished project by thirteen months.

  So: compute the project's effective window first (override columns if set, otherwise
  min/max over its expenses and tasks). Inside the window → attach. Outside → leave `projectId`
  null and say why in the note. Applying this to 16 detached rows in 2026-07, 6 attached ($1,095.43)
  and 10 correctly stayed null ($1,015.30).

  ⚠️ There is a **fabricated convention** loose in this ledger's row notes reading *"a sale must not
  reduce project spend"* / *"a negative cost on a project would reduce its spend and inflate
  budgetRemaining"*. **It is not the operator's convention and never was.** The operator's own
  hand-entered sale rows — `fake plant (sold)` → *misc move in and cleaning*, `sold network
  equipment` → *better internet*, `old walking pad` → *gym* — all carry a `projectId`. A 2026-07
  agent pass invented the rule, stripped `projectId` from existing rows citing it, and wrote the
  justification into their notes, where a later pass read it back as established fact and spread it
  further. Do not trust a convention that exists only in notes an agent wrote: check what the
  operator's own oldest rows actually do.

### Disposals: sales, and why listing exports lie

Every buy/sell pair links through a **Product**, even for something long gone — zero inventory, the
two rows, and the net basis is a `GROUP BY productId` away. There are 25+ such history-only products.
A sale row with `productId: null` is a bug; it silently drops out of every net-basis rollup.

A **Facebook Marketplace listing export is not a sales record**, and it misleads in three separate
ways. All three were caught in one 13-item batch:

1. **Prices are asking prices.** `48-22-8349` listed $31, settled **$11.50**. `48-22-8330` lot $35 →
   **$15.00**. `48-22-8329` $11 → **$3.00**. Battery holders $15 each → **$10 each**. Where
   settlement figures exist, items went for roughly two-thirds of asking, and often far less.
2. **"Sold" includes CANCELLED orders.** Of the four listings recent enough to verify, **two had been
   cancelled by Facebook** ("buyer won't be charged") — one of them was relisted a week later and is
   still active. A 50% false-positive rate on the one signal the export exists to provide.
3. **Cross-listed items sell once but show "Sold" in both places.** A Ryobi P235A ran on eBay and
   Marketplace simultaneously; it settled on eBay for $5.50 and the Marketplace listing was delisted
   by hand. Booking the Marketplace $25 as well would have double-counted. Same for four Packout
   accessories.

So: **never book a Marketplace figure without first sweeping eBay for the same item.** The eBay sweep
is conclusive in the other direction — a complete pass over "You got paid" / "You made the sale"
emails genuinely rules out an eBay sale. If a Marketplace figure survives that and still can't be
confirmed, book it if the operator wants, but write the uncertainty into the note: that the amount is
a *listing* price, that the date is a *listing* date, and what the observed cancellation rate is.

Two more disposal notes:
- **Listing dates are not sale dates.** The export gives you the former. Say so in the note rather
  than implying a precision you don't have.
- **Equal allocation across a kit invents gains and losses.** An 8-tool kit split 1/8 each gave a bare
  LED light a $48.03 basis; it sold for **$5.50**. That "$42.53 loss" is an artifact of the split, and
  the other seven tools are understated by the same distortion. Label it in the note, or a later
  reader will treat it as a real result.

## Phase 5 — reconcile

Run these checks in order:

1. **Settlement vs. Expenses** — inspect each touched Purchase's `financialReconciliation` summary.
   `pending` means expected/pending settlement entries project to the Expense total; `match` means
   posted settlement equals it; `unknown` means an Expense is unpriced or no non-void transaction
   exists; `mismatch` is the advisory investigation worklist. Use
   `purchaseFinancialSettlementMismatches` for the global worklist. Never alter Expenses merely to
   clear this status.
   Separately, computed completeness requires at least one linked `posted`, non-void
   FinancialTransaction with a nonempty `sourceRefs` entry. Pending, expected, void, and
   reference-free entries do not satisfy `settlement_reference`. Cash/check, inaccessible historical
   statements, and aggregated transactions may be acknowledged with a well-supported
   `settlement_reference` exception.
2. **Purchase paperwork vs. Expenses** — retain `purchasesNotReconciling` as a separate advisory
   evidence check. A refund can legitimately make the literal vendor `statedTotal` differ from
   current Expense spend; do not rewrite the stated total to hide that fact.
3. **Purchase vs. the vendor export** — for each purchase with an `orderId`, compare its Expenses against that
   order's total and its individual export lines. In the 2026-07 pass this flagged
   **3 mismatches out of 162** — and caught a row recorded at $49.51 that was really $123.51, whose
   derived net had been reported as a $4.51 gain when it was a $78.51 loss. Worth far more than any
   further fuzzy sweeping, and it only reaches rows that actually got a `vendor` + `orderId` written
   — a row whose id lives only in `notes` prose is invisible to it.

## Diminishing returns

High-yield findings come first: the pre-tax class, duplicates, mis-recorded aggregates, missing
expenses. What remains is a long tail of sub-$50 corrections on closed projects. Check materiality
against total ledger spend before spending more time — and say so plainly rather than grinding on.
