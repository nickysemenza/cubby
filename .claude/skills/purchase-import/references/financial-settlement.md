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
entity({ command: { action: "update", entity: "financialTransaction",
  id: "FTX-…", data: { allocations: [
    { purchaseId: "PUR-9QXK", amount: -8.96 },
    { purchaseId: "PUR-9ZMQ", amount: -7.80 },
  ] } } })
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
`entity create financialTransaction` (or `entity_batch`). Review every result. Source reference
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
`entity update financialTransaction`. Never create a second transaction to fix this.

The field is **`sourceRefs`**, an array, and on update it replaces the whole
array (read–merge–write when appending). The singular `sourceRef` is accepted
and silently discarded — the write reports success, `sourceRefs` comes back
`[]`, and the gap stays open. Confirm by re-reading the row, or by checking that
the Purchase drops out of `entity list purchase` with `filters:{dataStatus:"needs_data"}`.

**`entity create financialTransaction` does take `sourceRefs`,** so the backfill pass
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
to the right transaction with `entity update financialTransaction` (read–merge–write
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
  different hash — storing a fabricated statement line beside the real one. MCP
  is the write path for ordinary imports, where a few hundred rows is
  unremarkable; a backfill big enough that a model cannot carry it is a one-off
  migration script, not a reason to fork the write path permanently. Reconcile
  afterwards either way with `apps/web/scripts/audit-statement-rows.ts` — a row
  present in the ledger but absent from every export is the signature.

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
(see above), alongside the verified per-order arithmetic in the note. Each amount
is that order's **contribution to this transaction** — which equals its earnings
only when no label crossed a payout boundary. Allocate the contribution, not the
earnings: where a label settled in a different transaction, that transaction
carries its own slice and the Purchase reconciles across both.

FTX-SZ2R is the worked example. Its two orders earned -$44.58 and -$41.90, but
the payout is -$96.87, because the edging plate's $10.39 label was charged to the
bank separately. Allocating earnings gives -$86.48 and is rejected. The truthful
set is the contributions -$54.97 and -$41.90; the label leg (FTX-SSVR, +$10.39)
then allocates to PUR-TUXP, whose two slices net to its -$44.58 earnings.

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

Six FAC-4KED payouts predate that rule and are already allocated whole to one
order: FTX-RR5W/PUR-QF9Y, FTX-4QU2/PUR-KS4H, FTX-FBUP/PUR-JJWT, FTX-8C9F/PUR-YTQV,
FTX-P94H/PUR-EXXD, FTX-DWRR/PUR-3NHY. **Leave them.** Each delta is a stray label
(-6.90, -6.87, -6.68, +6.68, -1.38, -1.22) and no separate bank leg exists for any
of them, so there is nothing to allocate the offset to. The allocation is still
true as a statement of what the bank moved toward that order; the mismatch is the
gap between bank movement and final earnings, which diverge precisely when a label
settles elsewhere. Do not "fix" these by fitting numbers, and do not unallocate
them — that would destroy a true fact to quiet a detector. They are expected to
show in the settlement-mismatch Problems section permanently.

## Card exports: signs, coverage, and what they cannot prove

- Monarch: negative = charge, positive = credit; `Original Statement` carries the
  store number, and its `Id` column is a usable external id. Copilot: **sign
  inverted** (positive = charge), carries the account mask directly. Mint-era
  exports: unsigned amount with a `Transaction Type` column, card named by
  *product* with no last-four, and no external id — rows sourced from them get
  no `sourceRef`. Merge Copilot and Monarch: they cover different cards and
  different eras, and each often has only one leg of a charge/credit pair.
- Copilot posts on posting date, Monarch on transaction date, so one event
  appears 1–3 days apart in each; dedupe on vendor + amount within ~5 days.
- **Absence from every export is not evidence a charge did not happen** — real
  vendor-confirmed receipts have been missing from all files inside the covered
  window. Grep the raw amount across every file; when nothing turns up, record
  the vendor-printed tender hint in the Purchase notes and leave it unsettled.
- Aggregators sometimes double-represent a return as an extra charge+refund
  pair; when a card export and the vendor's charge history disagree, the vendor
  page is authoritative for what was owed.
- Two people holding the same card product from one issuer is far likelier than
  an exotic reissue chain. Before attaching an alias or merging accounts on a
  name resemblance, run the **overlap test**: two descriptors that share ~100%
  of date+amount rows are one account through two export vintages; two that
  share zero rows over a long concurrent window are two cards. Recurring
  subscriptions at different prices on different billing days are the sharpest
  discriminator. Cubby has no restore — a wrong account merge is permanent.
- **A last-four printed by a vendor is never grounds for a new account.** Apple
  Pay device numbers, reissued cards and vendor display tokens all print digits
  the statement does not carry. Map to the statement row.
- Another household member's card rows are in scope but unenrichable: their
  vendor histories sit behind logins the operator does not have. Stamp
  `accountId` for ownership and leave the rows `open`/`unmatched` — that is the
  correct resting state, not a backlog. Never disposition them `ignored`, and do
  not write a per-row note explaining the blocker.

## Re-importing a newer provider export

- It is a **delta-only** job. Dedup is on `(source, externalId)` globally, so
  declare `rowCountDeclared` = the delta count (or `list_statement_imports`
  reports an unfinished chunked ingest). Compute `statementRowExternalId` with
  `apps/web/src/server/repo/statement-row-identity.ts` — import it, never
  reimplement — and ask the DB which ids exist; a column-wise CSV diff does not
  work across export vintages. `StatementImport.fingerprint` is the sha256 of
  the file. Exclude `$0.00` placeholder rows (they re-present as new forever).
  Verify afterwards: any stored row whose hash is absent from the source file is
  fabricated.
- **The descriptor firm-up mints a second identity.** A pending row re-observed
  with a fuller descriptor after posting (`THE HOME DEPOT #NNNN` →
  `THE HOME DEPOT #NNNN 800-… CA`, `AMAZON MKTPLACE PMTS` → `AMAZON MKTPL*…`)
  hashes differently on the same account/date/amount. Detect with a self-join on
  (accountDescriptor, statementDate, providerAmount) across imports; set
  `supersededByExternalId` on the thinner row, and where a transaction already
  carries the old ref, **append the new ref to that same transaction**.
- Disposition by `sourceCategory` is a first pass only. **Provider categories
  are wrong often enough to bury modelled spend** — a storage-crate vendor filed
  as Clothing, a vehicle purchase filed as fuel/parking. When two providers
  disagree on a category, the ignore is suspect. Sweep the ignored tail **by
  amount** as well as by merchant: no plausible fuel charge is five figures, and
  a bare `Check` has no payee to triage on. Ask of each row "is this an
  acquisition?", not "does the category sound modelled?".

## Orphan transactions and twins

- A statement import leaves orphan transactions (no allocation, `notes` null,
  the real descriptor, a `v1:<hash>` sourceRef). **Their `transactionDate` is
  NULL** — only `postedDate` is set — so any `transactionDateFrom/To` filter
  silently excludes exactly the rows still needing a match, and `vendorSearch`
  resolves through the linked purchase, so an unlinked row has no vendor either.
  **Hunt unmatched settlement by amount + account with no date or vendor
  predicate**, or via Transactions → "Not linked to a purchase". Dedupe on
  `COALESCE(transactionDate, postedDate)`, and allow **±3 days** — vendor charge
  history and the statement disagree on a leg's date routinely.
- **To settle from an orphan, LINK it** (set allocations and `transactionDate`
  on the existing row). Creating a fresh transaction beside a live orphan is
  what manufactures twins.
- A twin pair is a *linked* row (purchase, reasoning, readable vendor ref) and an
  *orphan* (true descriptor, dedupe hash). Neither dominates: **delete the
  orphan first, then graft its `v1:` hash onto the linked row's `sourceRefs`**
  — refs are globally unique, so grafting while the orphan is live fails with a
  source-ref conflict. Deleting the orphan without grafting throws the hash
  away and the next sync recreates it. Deleted rows' hashes stay readable via
  `deletedAt IS NOT NULL`.
- Shapes that defeat amount matching, all seen for real: split tender (card +
  gift card, so no row equals the total); per-shipment billing (N legs summing
  to the order); store-fulfilled legs under the store descriptor; several
  refunds from **different orders** posting as one credit, grouped by card, not
  by return visit (retire the merged row and graft its hash onto the largest
  constituent — a merged row spanning orders can never link to one Purchase);
  a discount posting as a separate credit; a penny gap that is our tax line, not
  theirs; a synthesized aggregate booked from an order header facing two real
  statement legs (prefer the statement rows). Sum before concluding a mismatch,
  and check the vendor's tender strip before concluding a row is missing.
- When the constituents of a merged credit are already booked as vendor legs,
  linking the merged row as another leg double-counts the refund.

## Reading a settlement gap

Comparing posted refunds against negative Expenses finds returned-but-unbooked
money, but most nonzero gaps are benign. Causes, in order of frequency:

1. **Repriced / net-settled.** The credit was applied by reducing the original
   Expense, so `statedTotal − net expense` equals the refund exactly. Also the
   shape of a multi-leg settlement (five charges − one credit = the booked
   expense).
2. **Tax-basis mismatch (Home Depot).** Item lines booked pre-tax, card refund
   tax-inclusive; the returned item's tax was never booked as spend either, so
   there is nothing to credit back. Do not book refunded-tax rows here.
3. **Expected-not-posted.** Filter on `status = 'posted'`.
4. **Import twins — the real defect.** Settled refunds exactly 2× booked credits.
   Fix is delete-then-graft.

- **An unmatched credit has three causes — check in this order:** already
  netted into the Expenses with only the settlement pair missing (most common);
  the whole order missing from Cubby; a genuine missing refund on an existing
  purchase (rarest). Never assume it belongs to the nearest purchase by
  vendor+date — the charge side of the export disambiguates.
- `statedTotal` holding a **net** is a tell: whenever it equals the expense
  total on a purchase that had a return, suspect the refunded tax is missing.
- Linking an orphan credit can *create* a double-count when the Purchase already
  carries the same refund from another source. Check first.
- The itemisation detector (`statedTotal − Σ expenses > 0.5`) needs two
  exclusions: a negative Expense line (a booked return) **and** a negative
  allocation (a refund settled on the card side only). Equivalently, a purchase
  whose allocations ≈ its expenses is fine. What survives both is usually a
  **cancelled line whose `statedTotal` still holds the pre-cancellation
  figure** — nothing goes negative anywhere, so the stated total is the only
  field carrying the old number. Fix it there and note the original.
- `statedTotal − expenseTotal` is not the open-gap measure; add back posted
  refunds, or a worklist triples. Cubby's `reconciliation` field gets this
  right; raw SQL against the two totals does not. A fully-cancelled order
  (`statedTotal $0.00` with real legs) still false-positives — read
  `reconciliation`.
- **eBay: split by sign before judging it.** Sales have no vendor order total
  (null `statedTotal` is correct) and settle through payouts, not card charges.
- **Apple: not a matching problem.** If no Apple charge exists in the statement
  ledger at all, the fix is a statement import.

## Multi-charge attribution

- **Amazon: the charge→order ledger is the only arbiter.** A subset of charges
  that sums exactly to `statedTotal`, uniquely in its window, is still not
  evidence — grocery orders bill in many small legs and coincidental sums are
  common; every audited subset-sum match was wrong. Scrape
  `/cpe/yourpayments/transactions` (20 rows per POST page; render results into
  the DOM and read with `get_page_text`, since `javascript_tool` truncates
  returns), join free transactions to charges on (amount, date ±6 d) to get the
  **order id**, then order id → Purchase. Query *all* purchases, not just
  zero-allocation ones — most wins are extra shipment legs on partially-settled
  orders, and refund-only purchases complete to net zero when the charge lands.
  Re-run the audit (group `orderId → [amounts]`, diff against Cubby) after any
  matching pass; it is cheap. The scraper's dedupe key collapses identical
  same-day charges on one order, so "Amazon < Cubby" on a same-amount pair may
  be dedupe loss.
- **Home Depot multi-charge matches are trustworthy**: legs cluster within a
  week, so a same-week set summing to `statedTotal` is good evidence. HD has no
  charge→order ledger; use `expenses vs net settlement`, not either against
  `statedTotal` (returns net both sides down together).
- A charge that **predates its order** falsifies the match by itself; a 1–3 day
  lead is posting noise, a week is a wrong purchase date. A gift-card line means
  the card charge is *not* the stated total. Marketplace vs first-party
  descriptors (`AMAZON MKTPL` vs `Amazon.com`) break same-day ties; `Sold by:` on
  the invoice explains multi-seller multi-charge orders. When identical charges
  stay indistinguishable, pick, and say the pick is arbitrary in the note. Never
  attach a charge that exactly equals an already fully-posted total — the twin
  belongs to an order Cubby never booked. Prefer the candidate purchase that
  still carries a shortfall, then nearest date, one charge per purchase; tips
  skip the shortfall test.
- Recurring same-price purchases are the whole source of ambiguity; nearest
  date resolves them, with the arbitrariness written into the note.
- Link in batches of 25, not 50 — 50 exceeds the MCP response timeout, and the
  writes still land on a timeout, so re-query before resending. Read existing
  `notes` and append; never write allocations via direct SQL (the write path
  enforces the sum invariant and fires audit/data-quality side effects).
- Never report a raw unsettled count as a gap: purchases predating statement
  coverage cannot ever settle, and free charges exceeding unmatched purchases
  means some belong to orders never booked — not a bipartite matching problem.

## Vendor account pages beat inference

An expected refund that never arrives, a cancelled order, and gift-card tender
all present identically in statement data — an amount that will not reconcile.
Only the vendor account distinguishes them. A cancelled order is not a return:
the goods never arrived, so the fix is an offsetting `— cancelled` Expense
credit to zero the spend (keeping `productQuantity` clear on the charge lines so
no phantom unit enters the derived-price sample), with the outstanding money as
`status: "expected"` refunds per funding account, and a matching posted draw for
any gift-card leg. A stored-value refund may come back on a different card than
the one debited; keep one generic stored-value account per vendor with
`last4: null` rather than pinning it. Where a vendor's phone/online support
does nothing, a physical return desk can recall the original receipt and issue
the refund directly.
