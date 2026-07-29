---
name: purchase-import
description: Reconcile a vendor purchase/order export (Amazon takeout, eBay CSV, Home Depot, Direct Tools Outlet, Gmail receipts) against cubby's expense ledger — matching rows, correcting costs, booking refunds, capturing vendor identifiers, and reconciling a charge against its stated total. Use whenever the user supplies an order-history export, receipts, or a vendor account dump and wants it matched to the ledger, or asks about missing/duplicate/understated purchases or expenses.
---

# Importing a vendor purchase export

Goal: link export lines to `Expense` rows, correct costs, book refunds, capture identifiers.
This file is weighted toward **failure modes** — the happy path is easy, the traps are what cost hours.

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
- **`Purchase` now means ONE vendor transaction** (a charge): `vendorId` (NOT NULL), optional
  `orderId`, `date`, optional `statedTotal`, notes, and its documents. It holds **no** money.
- **`Vendor`** is a real roster (`name` unique, `kind`, `website`, `notes`), not a text column.

**`create_purchase` does not exist any more.** Neither do `get_purchase`, `list_purchases`,
`update_purchase`, `delete_purchases`, `bulk_move_purchases`, `bulk_set_purchase_trade`,
`bulk_set_purchase_cost_type`, or `get_purchase_analytics`. The stale instinct here writes the wrong
entity, so the rename is the guardrail: a call to an old name **hard-errors as an unknown tool** — it
does not silently create a charge where you meant a line. If you see that error, you reached for the
old model; re-read this block.

| Old tool | New tool |
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

Four consequences that bite:

- **`vendor` and `orderId` travel together.** An order id with no vendor is **silently dropped** — an
  order id is only unique *within* a vendor, so alone it can't name a transaction. An
  `update_expense` carrying `orderId` but no `vendor` changes nothing about the row's charge (other
  fields in the same call still write, so this fails quietly). `vendor: null` is different again — an
  explicit *detach* from the charge.
- **`orderId: null` always mints a NEW charge.** So does a `vendor` write with no order id. Re-writing
  `vendor` on a row that already sits on a no-order-id charge therefore moves it to a fresh empty
  charge and orphans the old one (which then reads "stated $X, lines $0"). Set vendor+order once, on
  purpose; don't re-touch it idempotently.
- **To put several lines on ONE no-order-id charge**, create the first line with `vendor`, read
  `purchaseId` off the response, and pass **`purchaseId`** (a `create_expense` field) on the rest. An
  explicit id short-circuits name resolution and is never a guess. With a real `orderId` you don't
  need this — the partial-unique `(vendorId, orderId)` index makes every line of that order land on
  the same charge automatically.
- **Vendor names are matched EXACTLY** (trimmed, not case-folded) and **there is no vendor-merge
  operation in v1**. `Amazon` / `amazon` / `Amazon.com` become three roster rows. Spell a vendor the
  way the ledger already spells it — check the roster before inventing a spelling.

`Vendor` and `Purchase` have **no MCP tools** (`mcp: []`). Read them with SQL; write them through the
web UI or ask the operator. `attach_file` is the one exception — it takes
`entityType: "purchase"`.

## Ground rules

- **Never write an identifier you did not read from the export.** ASINs/SKUs/order numbers are
  plausible-looking strings and a fabricated one is indistinguishable from a real one until it 404s.
  (Two were invented in the 2026-07 Amazon pass; both wrong.)
- **Propose before writing.** Show matches with evidence — model/SKU, price delta, date delta — and
  get per-batch approval. Similarity ranks, it does not verify.
- **Verify writes against the DB**, not the MCP response. `update_product` does not echo `model`.

## Phase 1 — decide how far to trust the export

1. **Prove coverage.** Print min/max date and a per-year count. An eBay CSV once silently held only
   records #259–312, which led to "this tool was never sold". Gaps or a truncated range change every
   conclusion downstream.
2. **Check for per-line prices.** This is the single biggest branch. The Amazon takeout has
   `Unit Price` / `Unit Price Tax` / `Total Amount` per line; Gmail receipts do not. With per-line
   prices you never invent a split. Verify `Total Amount` is per-line, not a repeated order total
   (count multi-line orders whose lines all share one total).
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

**Source hierarchy — prefer settlement figures over anything else.** Ranked by trustworthiness:

| Source | Gives you | Trust |
| --- | --- | --- |
| eBay **seller** `OrdersReport` CSV | `Sold For`, `Total Price`, sale date, buyer | settlement — best |
| eBay "You got paid" email | confirmed payment amount | settlement |
| Vendor order confirmation email | order total, per-line prices | ordered, not settled |
| ui.com-style confirmation | *no prices at all* — invoice is a separate download | needs the status page |
| **Marketplace/listing exports** | **asking prices and a "Sold" flag** | **weakest — see Phase 4** |

`~/Documents/personal/backups/random data dumps/` holds both the Amazon takeout and
`eBay-OrdersReport-*.csv`. Check for a seller report before doing any Gmail sweep for disposals: it
is one grep versus twenty subagent minutes, and it carries real numbers.

## Phase 2 — match, strongest key first

| Key | Strength | Notes |
| --- | --- | --- |
| `orderId` (+ `vendor`) | exact | Best. One order is one charge; reconcile cost against it directly. |
| Order id in `notes` prose | exact, legacy | Pre-`orderId` rows. Lift it out as you touch the row — with the vendor in the same call. |
| ASIN / SKU / model in `url` or `model` | proof-grade | Model appearing verbatim in the vendor title is proof. |
| Exact tax-inclusive amount + date | strong *with* a name check | The workhorse; see traps below. |
| Embedding / fuzzy name similarity | hint only | Never auto-apply. |

**Vendor identity hides in four fields, not one.** Before concluding a row has no vendor, check its
resolved `vendor`, plus `url`, `notes` *and* `name`. Pre-roster rows routinely carry a bare store name
as the whole `url` value (`home depot`, `lowes`, `tol nirvana`, `wwe`) or as a short `notes` string or
in the name itself (`woodworker express`, `supplyhouse return`). A 2026-07 sweep lifted 268 + 23 such
rows into the vendor field. Note `url` is rendered as `<a href={url}>` — a marker left there paints a
broken link, so clear it once the vendor is recorded.

An expense with no charge attached (`purchaseId IS NULL`) is exactly "no vendor recorded" —
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
(`purchase.date` is the charge date and `expense.date` is the **ledger** date that drives monthly
buckets and project windows — an invoice dated the 3rd can clear on the 8th, and they're allowed to
differ.)

**Tolerances must be relative, not absolute.** ±$0.25 is sensible at $200 and meaningless at $1: a
$0.93 order (wood screws, net of two returns) matched a $1.00 `5 yd nursery mix` row on amount+date
and had to be reverted. Scale the tolerance to the amount, and **read the line descriptions** before
accepting any match under ~$20.

**Grade every amount+date match by name-token overlap** (drop stopwords, require ≥2 shared tokens).
Validation signal: genuine matches cluster at **0–1 day** delta. If candidates scatter across a ±14d
window, they're coincidences. In the 2026-07 pass, 209 amount matches graded down to 97 real ones.

Tokenizers miss compound words — `labelmaker`/"label maker", `stepstool`/"step stool",
`straightedge`/"straight edges". Sweep the zero-overlap bucket by eye before discarding it.

**Costs are tax-inclusive; the house rate is 8.625%.** Test *all* of these against each row:
`cost == line total`, `cost == order total`, `cost × 1.08625 == line`, `cost × 1.08625 == order`,
and hand-rounded variants (a $599.00 row for a $599.99 unit price). Pre-tax entry is a recurring
bug class — 24 rows in one pass, found four different ways because each hypothesis was tested alone.

## Phase 3 — before proposing any *add*, rule out an existing row

**Keyword search cannot do this. The ledger names the *thing*, not the product.** Searching
`festool`/`vacuum`/`vac` for a "Festool Vacuum" product found nothing, so a row was added — but a
`dust extractor` row for the identical amount and date had existed since 2024. Zero shared tokens.
The same trap hid a Bosch miter saw booked as `chop saw`. **The only filter that works is amount +
date across the whole ledger, ignoring names entirely** — run it before every add, and again as a
post-hoc check over each newly created row (same amount, ±30 days) to catch what slipped through.
`find_similar_entities` (`expense_to_product`) is the right *candidate generator*, but its own docs
warn the scores rank without verifying — never auto-link.


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
deleted. **Whenever the export line has an order id, query `orderId` first** — it catches both
directions in one shot, and amount+date catches neither reliably. Post-split this is stronger, not
weaker: both sibling lines hang off one `Purchase`, so the group is a parent link rather than a
two-column string match, and `statedTotal` can hold the $306.27 the search was looking for.

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
   reconciliation and every per-charge query are blind to exactly the rows most likely to hide an
   error.
2. **A line itemization in `notes`**, so the next pass recognises it as an aggregate instead of
   re-deriving it (or re-proposing its components as missing).
3. **Splitting into sibling lines** where the components are separately tracked products — one
   expense per product, summing to the original total, all hanging off the same charge.
   `productId` is single-valued, so an unsplit aggregate can never link more than one product, and
   any product in inventory whose only expense is inside an aggregate has **no cost basis at all**.
   This is `splitExpense` now (below) — not a row-naming convention.

Real case: `scaffolding` $434.47 was correctly identified as covering a 2-line MetalTech order and
then dropped. Months later both MetalTech products still sat in inventory with zero purchases, and
**11 of 14** aggregate rows had neither a vendor nor an `orderId`. Treat the aggregate bucket as a
worklist, not a dead end.

## Phase 4 — writing

- Set `vendor` **and `orderId`** on every row you touch, in one call. `orderId` is the vendor's own
  order/receipt id, free text, unique per vendor — `111-1234567-1234567`, `WN63446464`, `DT640921`,
  `#11334`. This is what resolves the row onto a `Purchase`; putting the id only in `notes` leaves
  Phase 5 and every per-charge query blind to everything you import.
- `notes` carries the *human-readable* provenance, not the identifier: itemize the lines for
  aggregate rows so the row is never re-flagged as missing, and note anything odd (a cancelled twin
  order, a line deliberately left unbooked). Append to substantive notes; replace bare markers like
  `"amazon"`. Legacy rows store the id as `"<Vendor> order <ID>"` prose — lift it out (with the
  vendor) when you touch them.
- **Record the charge's `statedTotal` and attach its invoice.** These are the two things the charge
  exists for, and they turn "do the three lines sum to $431.24?" from a reconstructed `GROUP BY` into
  a single-row comparison:
  - `statedTotal` is what the paperwork *claims*, in dollars. It is **never summed into spend** —
    spend is always `SUM(expense.cost)` — and a mismatch is frequently correct (a partial refund
    reduces a line without changing what the charge stated). Nothing rejects a write over it and
    nothing back-computes a cost from it. There is no MCP tool for it in v1: set it in the web UI, or
    hand the operator the list.
  - The PDF invoice / receipt photo now has a home: `attach_file` with
    `entityType: "purchase"`, `entityId: <purchaseId from the expense row>`, `contentType:
    "application/pdf"`. One `Image` can be filed against several charges (a statement covering both).
- Per-charge queries are one row each now — no reconstructing groups from `(vendor, orderId)` strings:
  ```sql
  -- charges whose lines don't add up to what the charge said it was
  SELECT v.name, p."orderId", p.date, p."statedTotal",
         count(e.id) AS lines, coalesce(sum(e.cost), 0) AS lines_total
  FROM "Purchase" p
  JOIN "Vendor" v ON v.id = p."vendorId" AND v."deletedAt" IS NULL
  LEFT JOIN "Expense" e ON e."purchaseId" = p.id AND e."deletedAt" IS NULL
  WHERE p."deletedAt" IS NULL AND p."statedTotal" IS NOT NULL
  GROUP BY v.name, p.id, p."orderId", p.date, p."statedTotal"
  HAVING abs(p."statedTotal" - coalesce(sum(e.cost), 0)) > 0.01;

  -- every multi-line charge (aggregates, split siblings, buy/return pairs):
  -- same query, HAVING count(e.id) > 1 and no statedTotal predicate.
  ```
  The same worklist exists server-side as `purchase.notReconciling` (a soft flag — a read, never a
  write path).
- Canonical product link: `https://www.amazon.com/dp/<ASIN>`.
- Vendor identifiers for a *product* go in **`ProductExternalId`** (`source`/`externalId`/`url`) —
  never a new column, never `Product.model` (that's manufacturer identity). `externalIds` **replaces
  the whole set**, so read-then-merge. Partial unique index on `(productId, source)` = one id per
  source.
- **Splitting a line** is `splitExpense` (tRPC `purchase.split`): pass the `expenseId` and ≥2 parts,
  each with its own `name`/`cost`/`costType`/`trade`/`projectId`/`productId`. The parts land on the
  same charge, the original is soft-deleted, and the charge's `statedTotal` is **seeded from the
  original cost** when it had none — so the parts have something to reconcile against. A deliberately
  mismatched sum is displayed, never rejected. This **replaces the `(combo, saw portion)` row-naming
  convention** that used to encode splits in row names; don't write those names any more. It refuses
  on an expense with no charge attached — record the vendor first. There's no MCP tool for it: via
  MCP the equivalent is `create_expense` for each part with the shared `purchaseId`, then
  `delete_expenses` the original.
- **One invoice spanning trades** (Flow Form Plumbing's $2,516 covering rough-in *and* fixtures) is
  `linkExpensesToPurchase` — attach existing expenses to one charge. Explicitly **not** for payment
  schedules: separate charges stay separate purchases, so a contractor's 11 progress payments are
  **11 charges**, not one. The contract-level rollup is `Project`.
- **Merging charges** is `mergePurchases`, for the ~364 order-less singletons no key could have
  grouped. It refuses across vendors (that would rewrite who was paid) and refuses when both sides
  carry a non-null order id (two real order ids are two real transactions). A user action, never a
  guess — and note there is deliberately **no `splitPurchase`**: one order is one charge by
  construction.
- **Refund handling** is unchanged, by shape:
  - Full return → negative expense at full price, same `trade`, `projectId: null`.
  - Partial refund on a multi-item order → **reduce the expense cost** to the kept items. (Operator
    chose this 11/11 in 2026-07; it fits materials orders better than the tool-lifecycle negative-row
    convention, which is for a tool leaving the collection.) The charge's `statedTotal` stays at what
    the vendor stated — do **not** adjust it to match, and do not read the resulting mismatch as an
    error.
  - Buy-and-return where **neither** side is in the ledger → nets to zero, do nothing. This is most
    of any refund file (85 of 115 orders in one pass).
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

**This check does not model refunds — read the row's notes before "correcting" anything it flags.**
An expense whose cost was deliberately reduced to the kept items after a partial refund will fail it
forever. In the 2026-07-28 pass it produced 5 mismatches and **all 5 were false**: four carried notes
documenting the refund, one was an explicit operator decision. A buy-and-return pair (a `$X` line
plus a `-$X` line on the same charge) also nets to zero and trips a naive per-charge sum. Group the
export's lines by order *and check their dates* — a return line booked weeks later will drag a naive
`min(date)`/`first(date)` off by a month and fake a "wrong order id" finding.

Two checks, in order:

1. **Charge vs. its lines** — `statedTotal` against `SUM(expense.cost)`, per the SQL in Phase 4. This
   is now a single-row comparison for every charge that has a stated total, which is the reason to
   record one while you're importing. It is a **soft** flag: a worklist, not an error list.
2. **Charge vs. the export** — for each charge with an `orderId`, compare its lines against that
   order's total and its individual lines in the export. In the 2026-07 pass this flagged
   **3 mismatches out of 162** — and caught a row recorded at $49.51 that was really $123.51, whose
   derived net had been reported as a $4.51 gain when it was a $78.51 loss. Worth far more than any
   further fuzzy sweeping, and it only reaches rows that actually got a `vendor` + `orderId` written
   — a row whose id lives only in `notes` prose is invisible to it.

## Diminishing returns

High-yield findings come first: the pre-tax class, duplicates, mis-recorded aggregates, missing
expenses. What remains is a long tail of sub-$50 corrections on closed projects. Check materiality
against total ledger spend before spending more time — and say so plainly rather than grinding on.
