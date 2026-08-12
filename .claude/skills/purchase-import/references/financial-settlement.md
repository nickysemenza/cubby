# Financial settlement

## Authority and signs

Vendor documents establish Purchase identity, literal stated total, and
Expense detail. Statements establish FinancialTransaction amount, Account,
status, and posted date. Do not overwrite one source's facts with the other.
Vendor-reported card/payment hints are evidence for notes or a future structured
reference; they do not establish a Financial Account identity.

Cubby signs are positive charge/outflow and negative refund/inflow. Monarch
exports invert this for ordinary charges, so normalize before previewing.

**Verify the normalization from the preview's own output, every time.** The
preview does not validate intent: hand it a charge with the wrong sign and it
cheerfully proposes `kind: "refund"` with a matching amount and
`ready_to_create`, because nothing about the row is internally inconsistent. The
amounts still tie out, so this survives a totals check. Before submitting, read
each proposed row back and confirm `kind` is `purchase` for charges and `refund`
for credits, and that the sign matches. Rows pasted into chat frequently arrive
already flipped relative to a raw Monarch export — trust the receipt for what
actually happened, not the sign in the row.

## One card line, several Purchases

A single charge or credit that settles more than one Purchase is ordinary, not
exotic — it is what a return desk produces when several orders go back on one
receipt, and what a statement produces when it combines same-day refunds.

Record it as **one** transaction carrying an `allocations` array:

```
update_financial_transaction(FTX-…, { allocations: [
  { purchaseId: "PUR-9QXK", amount: -8.96 },
  { purchaseId: "PUR-9ZMQ", amount: -7.80 },
]})
```

Allocations must sum to the transaction's amount to the cent and share its sign;
the write path refuses anything else. Mixed signs are unsupported by design — a
charge and a credit are two settlement events, and the statement will show them
as two rows.

`FinancialTransaction.purchaseId` is a derived mirror: non-null only when there
is exactly one allocation, NULL for a split. NULL there means "not exactly one
purchase", never "unsettled" — read `allocations` for the general case.

⚠️ **Superseded: the void-aggregate convention.** Splits used to be faked with
one posted transaction per Purchase, plus the real combined line kept as `void`
to hold the statement hash. Do not do this any more, and do not add new rows in
that shape. It made the database assert card events that never occurred.

## Statement import

Use `preview_financial_statement_import` for normalized client-side Monarch
rows. It is read-only and returns `already_recorded`, `ready_to_create`,
`possible_existing`, `unresolved_account`, or `indistinguishable_duplicate`.

After approval, submit only `ready_to_create` proposed values to
`create_financial_transactions`. Review every result. Source reference
uniqueness makes later full-history imports no-op for unchanged rows; it does
not authorize writing through a conflict.

Resolve an Account by source external ID, source aliases, then one unambiguous
network/last-four candidate. Last four alone is not unique. A provisional
Account is correct when evidence is incomplete; do not invent provider data.

**A receipt's card digits need not match the statement's.** There are two
distinct mechanisms, and the statement row tells you which:

- *Wallet tokenization.* A wallet payment presents a device account number to
  the merchant terminal, so the invoice prints one set of last-four while the
  statement shows the funding card's — an `AplPay` or similar prefix on the
  statement row is the tell.
- *Card reissue or a sibling card on one account.* No wallet prefix, and the
  mismatch is stable across older receipts but absent from newer ones. A
  reissued or replaced card changes the printed last-four while the account
  persists, and the statement is labelled with the account's *current* card, so
  historical rows inherit today's digits. Amex is especially prone to this: the
  card member number and the account differ, and supplementary cards share an
  account.

Either way, treat it as consistent and say so in the note; do not mint a
provisional Account for the digits the receipt printed, and do not reject an
otherwise exact date/amount/vendor match over it. Do not assert *which*
mechanism applies unless the statement supports it — record the vendor-printed
digits as a hint and leave the cause open.

When a second export covers the same window, check the charge in both. Agreement
across two independently-synced sources is cheap corroboration, and it converts
an absence into a usable negative: a charge missing from both, in a window where
both list the vendor's other charges, is real evidence of cash payment rather
than a coverage gap.

An existing transaction can carry the right amount, Account and Purchase and
still leave `settlement_reference` open because it was imported without a source
ref. Re-derive the ref through `preview_financial_statement_import` — a match
returns `possible_existing` with the transaction id — then backfill it with
`update_financial_transactions`. Never create a second transaction to fix this.

The field is **`sourceRefs`**, an array, and on update it replaces the whole
array (read–merge–write when appending). The singular `sourceRef` is accepted
and silently discarded — the write reports success, `sourceRefs` comes back
`[]`, and the gap stays open. Confirm by re-reading the row, or by checking that
the Purchase drops out of `list_purchases({dataStatus:"needs_data"})`.

**`create_financial_transactions` does take `sourceRefs`,** so the backfill pass
above is only for transactions that were created without one — not a mandatory
second step after every create. Verified 2026-08-03: a 304-row backfill passed
`sourceRefs` on create and all 304 persisted, 304 distinct, none empty. Treat a
create + backfill sequence as a smell: it is two writes where one would do, and
the intermediate row is briefly indistinguishable from a genuinely
reference-less import.

The ref is a **content hash of the statement row** (account, date, amount,
original statement), so it is only stable for a row that has settled. Do not
attach one to a `pending` credit: pending rows can post on a later date, the
hash changes with the date, and the row then fails to match its own statement
line on the next import — the exact duplicate this field exists to prevent.
Attach it when the row posts. The pending row and the row that replaces it are
two distinct `StatementRow`s, linked with `supersededByExternalId` — written by
an agent, never inferred — which drops the predecessor off the worklist without
discarding the evidence that it existed.

## The statement ledger

Provider rows are recorded verbatim with `record_statement_rows`, and drift is a
query rather than a pipeline rebuilt each session. It is not an importer: it
resolves no account, links no Purchase, creates no transaction, and makes no
match.

`list_statement_rows({matchState:"unmatched"})` is the worklist — a provider row
with no live transaction carrying its source ref. To close one, append that ref
to the right transaction with `update_financial_transaction` (read–merge–write
on `sourceRefs`); the row flips to `matched` on the next read, with no write to
the row itself. `update_statement_rows` takes a `{filter}` selector for the long
tail that will never match; `disposition: "ignored"` requires BOTH a reason and
a note, enforced by a CHECK.

Three traps, each found the hard way:

- **Submit `providerAmount` charges-negative, always.** Monarch signs charges
  negative, but Copilot signs them positive, Mint leaves them unsigned with the
  sign in a `Transaction Type` column, and Apple Card signs them positive. The
  identity hash is computed over `providerAmount`, so submitting an
  un-normalized export does not merely flip a sign — it mints a second identity
  for a charge already recorded.
- **Account aliases resolve per source.** A `copilot` row will not resolve
  against an account carrying only a `monarch` alias. Add the provider's aliases
  before ingesting it, or every row lands unresolved.
- **Never bulk-load rows through a model.** Transcribing evidence corrupts it:
  one pass silently rewrote `🪝` (U+1FA9D) as `🦝` (U+1F99D) — same byte length,
  different hash — storing a fabricated statement line beside the real one. Use
  a script that reads the file directly (`apps/web/scripts/ingest-statement-rows.ts`)
  and reconcile afterwards against the source
  (`apps/web/scripts/audit-statement-rows.ts`); a row present in the ledger but
  absent from every export is the signature.

## Purchases and refunds

Link truthful charge, installment, split-tender, and refund transactions to the
original Purchase. A refund document number is evidence, not a new order. One
that settles several Purchases carries an `allocations` array — see "One card
line, several Purchases" above.

Keep refund Expenses on the original Purchase. Preserve the vendor's original
stated total and record refund settlement separately. A reconciliation mismatch
is an investigation cue, not a reason to rewrite spend or paperwork.

For a posted transaction, retain a truthful source reference whenever available.
Without one, the Purchase may remain flagged for missing `settlement_reference`;
do not manufacture a reference to clear that gap.

## Sale proceeds

A disposal is a Purchase whose Expenses are negative. Book it at the
marketplace's own **order earnings** figure — not the item price. Earnings are
what actually reached the account; item price, buyer-paid shipping, transaction
fee, shipping label and ad fee belong in the note, not in separate rows.
Marketplace-collected sales tax is excluded entirely: the marketplace remits it,
so it was never seller money. Set `statedTotal` to the same earnings figure. A
sale line is an exit like any other: its `productQuantity` is `−|units sold|`
(EXP-GW5X), never positive.

The payout is `kind: "income"` and links to the sale Purchase; linked income
must be negative. It is **not** a `refund` — that means "the vendor gave money
back for goods I returned", it feeds `postedRefundTotal`, and a sale Purchase
separately needs `refund` for real refunds issued to *buyers*.

**Never derive a payout from the item price.** Two mechanisms make it
unfalsifiable, and both are invisible in bank rows and payout emails:

- *Promoted-listing ad fees* are charged per item, on some listings and not
  others, and are not implied by anything else on the order.
- *Shipping labels cross payout boundaries.* A label is deducted from whichever
  payout is open when it is bought, which is often not the payout carrying its
  order — so a single-order payout may still not equal that order's earnings.

Fee arithmetic with an unknown label and an unknown ad fee has two free
parameters per order, so any target value can be made to "close exactly". Two
independent fee models were built this way and both were wrong while appearing
precise. Take earnings from the marketplace, never from a calculation.

**Payout emails do not itemize their orders** — they carry only a total and a
payout id. The Seller Hub payout-detail page does itemize, and Payments →
Earnings lists per-order earnings directly; prefer those over reconstructing
composition from dates and ratios.

A payout that settles several Purchases carries one `allocations` row per order
(see above), each amount being that order's own earnings, alongside the verified
per-order arithmetic in the note.

**Resolve a payout's orders by `Purchase.orderId`, not by note prose.** eBay sale
Purchases are keyed by the eBay order number, which is exactly what a payout note
cites, so the order id is a direct lookup. Older notes assert a sale is "NOT
recorded in Cubby"; most of those are stale — 31 of 33 order ids cited across
FAC-4KED resolve to live Purchases. Check the id before believing the sentence,
and correct it when you touch the row.

A label bought against an already-open payout is deducted from a *different*
payout than the one carrying its order. Where eBay charged that leg to the bank
separately it is its own transaction and allocates cleanly. Where it was netted
inside the payout, the truthful split needs an opposite-signed allocation, which
the same-sign rule forbids — leave that payout unallocated rather than putting the
whole amount on one order, which over-settles it and under-settles the other.
