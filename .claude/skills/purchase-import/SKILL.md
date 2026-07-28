---
name: purchase-import
description: Reconcile a vendor purchase/order export (Amazon takeout, eBay CSV, Home Depot, Direct Tools Outlet, Gmail receipts) against cubby's Purchase ledger — matching rows, correcting costs, booking refunds, and capturing vendor identifiers. Use whenever the user supplies an order-history export, receipts, or a vendor account dump and wants it matched to the ledger, or asks about missing/duplicate/understated purchases.
---

# Importing a vendor purchase export

Goal: link export lines to `Purchase` rows, correct costs, book refunds, capture identifiers.
This file is weighted toward **failure modes** — the happy path is easy, the traps are what cost hours.

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

## Phase 2 — match, strongest key first

| Key | Strength | Notes |
| --- | --- | --- |
| `Purchase.orderId` (+ `vendor`) | exact | Best. Reconcile cost vs that order directly. |
| Order id in `notes` prose | exact, legacy | Pre-`orderId` rows. Lift it into the column as you touch the row. |
| ASIN / SKU / model in `url` or `model` | proof-grade | Model appearing verbatim in the vendor title is proof. |
| Exact tax-inclusive amount + date | strong *with* a name check | The workhorse; see traps below. |
| Embedding / fuzzy name similarity | hint only | Never auto-apply. |

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

This is the trap that survives every automated filter. A ledger row often **aggregates several
export lines** at an amount that reconciles to nothing:

- `network rack and equipment` $244.11 = 6 lines, exact
- `umbrella and stand` $301.19 = order total ÷ 1.08625 (pre-tax)
- `string lights & wire & eyebolt` $103.20 vs a $120.21 order — **no formula at all**

Only the *name* matched that last one, and it reached a written proposal as two new purchases before
being caught. So: for each candidate add, look for a same-window ledger row whose **name plausibly
covers the item**, independent of amount. Subset-sum checks help but generate false positives of
their own (a 4-line combo once "explained" a ZipWall as a book).

Also confirm the row's own notes don't name a different vendor — one row reading
`home depot WN22422541` was set to Amazon on an amount+one-token match.

## Phase 4 — writing

- Set `vendor` **and `orderId`** on every row you touch. `orderId` is the vendor's own order/receipt
  id, free text, scoped by `vendor` — `111-1234567-1234567`, `WN63446464`, `DT640921`, `#11334`.
  This is the field the reconciliation in Phase 5 and the duplicate/aggregate queries below read;
  putting the id only in `notes` leaves them blind to everything you import.
- `notes` carries the *human-readable* provenance, not the identifier: itemize the lines for
  aggregate rows so the row is never re-flagged as missing, and note anything odd (a cancelled twin
  order, a line deliberately left unbooked). Append to substantive notes; replace bare markers like
  `"amazon"`. Legacy rows store the id as `"<Vendor> order <ID>"` prose — lift it into `orderId`
  when you touch them.
- With `orderId` set, these become one-liners rather than heuristics:
  ```sql
  -- every multi-row order (aggregate rows, split siblings, buy/return pairs)
  SELECT vendor, "orderId", count(*), sum(cost) FROM "Purchase"
  WHERE "deletedAt" IS NULL AND "orderId" IS NOT NULL
  GROUP BY vendor, "orderId" HAVING count(*) > 1;
  ```
- Canonical product link: `https://www.amazon.com/dp/<ASIN>`.
- Vendor identifiers go in **`ProductExternalId`** (`source`/`externalId`/`url`) — never a new
  column, never `Product.model` (that's manufacturer identity). `externalIds` **replaces the whole
  set**, so read-then-merge. Partial unique index on `(productId, source)` = one id per source.
- **Refund handling**, by shape:
  - Full return → negative row at full price, same `trade`, `projectId: null`.
  - Partial refund on a multi-item order → **reduce the purchase cost** to the kept items. (Operator
    chose this 11/11 in 2026-07; it fits materials orders better than the tool-lifecycle negative-row
    convention, which is for a tool leaving the collection.)
  - Buy-and-return where **neither** side is in the ledger → nets to zero, do nothing. This is most
    of any refund file (85 of 115 orders in one pass).
- Only add a purchase when the **project is known** — date inside a project's purchase window *and*
  a semantic fit. Check project windows first; a project's last activity date tells you if it's live.
- Non-tool/household items stay out of the project ledger unless the operator says otherwise. Ask
  per item; never bulk-add books, clothing, or consumables.

## Phase 5 — reconcile

Once `orderId` is populated, run the exact check: join every row on `(vendor, orderId)` and compare
its cost against that order's total and its individual lines. In the 2026-07 pass this flagged
**3 mismatches out of 162** — and caught a purchase recorded at $49.51 that was really $123.51, whose
derived net had been reported as a $4.51 gain when it was a $78.51 loss. This check is worth far more
than any further fuzzy sweeping, and it only works on rows whose id is in the **column** — a row
whose id lives only in `notes` prose is invisible to it.

## Diminishing returns

High-yield findings come first: the pre-tax class, duplicates, mis-recorded aggregates, missing
purchases. What remains is a long tail of sub-$50 corrections on closed projects. Check materiality
against total ledger spend before spending more time — and say so plainly rather than grinding on.
