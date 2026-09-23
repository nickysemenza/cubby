# Financial settlement

Read the section needed for the current settlement question. All worked amounts
and identifiers below are synthetic; derive live references from authorized reads.

## Authority and signs

Vendor documents establish Purchase identity, literal stated total, and
Expense detail. Statements establish FinancialTransaction amount, Account,
status, and posted date. Do not overwrite one source's facts with the other.
Vendor-reported card/payment hints do not establish a Financial Account
identity; once the funding account is known, they belong in that account's
`cardNumbers` (below), not in notes.

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
  id: "FTX-TEST", data: { allocations: [
    { purchaseId: "PUR-TSTA", amount: -10.00 },
    { purchaseId: "PUR-TSTB", amount: -5.00 },
  ] } } })
```

Allocations must sum to the transaction's amount to the cent and share its sign;
the write path refuses anything else. Mixed signs are unsupported by design — a
charge and a credit are two settlement events, and the statement will show them
as two rows.

`FinancialTransaction.purchaseId` is a derived mirror: non-null only when there
is exactly one allocation, NULL for a split. NULL there means "not exactly one
purchase", never "unsettled" — read `allocations` for the general case.

## Statement import

Use `preview_financial_statement_import` for normalized client-side Monarch
rows. It is read-only and returns `already_recorded`, `ready_to_create`,
`possible_existing`, `unresolved_account`, or `indistinguishable_duplicate`.

After approval, submit only `ready_to_create` proposed values to
`entity create financialTransaction` (or `entity_batch`). Review every result. Source reference
uniqueness makes later full-history imports no-op for unchanged rows; it does
not authorize writing through a conflict.

Resolve an Account by source external ID, source aliases, then one unambiguous
network/last-four candidate across every account's `cardNumbers` (`entity list
financialAccount {filters:{last4}}` searches them all). Last four alone is not
unique. A provisional Account is correct when evidence is incomplete; do not
invent provider data.

**An account's digits are a dated history, not one number.** `cardNumbers`
holds every last-four the account has presented: the `primary` card the
statement labels it with (a reissue is an older primary with `validTo`, and only
one primary may be open-ended), `wallet_token` device numbers, `supplementary`
sibling cards, `physical_card` gift-card instances, or `unknown` for attested
digits nothing explains yet. Settlement matching and the statement preview read
this list, so a receipt only auto-settles against digits registered there.

**A receipt's card digits need not match the statement's.** There are two
distinct mechanisms, and the statement row tells you which:

- *Wallet tokenization.* A wallet payment presents a device account number to
  the merchant terminal, so the invoice prints one set of last-four while the
  statement shows the funding card's — an `AplPay` or similar prefix on the
  statement row is the tell, though many providers (Monarch included) drop it.
- *Card reissue or a sibling card on one account.* No wallet prefix, and the
  mismatch is stable across older receipts but absent from newer ones. A
  reissued or replaced card changes the printed last-four while the account
  persists, and the statement is labelled with the account's *current* card, so
  historical rows inherit today's digits. Amex is especially prone to this: the
  card member number and the account differ, and supplementary cards share an
  account.

Either way: first look the digits up across `cardNumbers`. If they are absent
and the statement row identifies the funding account (date, amount, vendor),
`entity update financialAccount` that account with the digits appended —
`wallet_token` when the statement or provider confirms a wallet, a dated
`primary` when the mismatch is a reissue, `unknown` when the cause is open —
with a `note` citing the receipt. Do not mint a provisional Account for the
digits the receipt printed, do not leave them as prose in notes, and do not
reject an otherwise exact date/amount/vendor match over them.

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
above is only for transactions created without one. Include refs in the initial
create when available; a create-plus-backfill sequence adds an unnecessary write
and briefly leaves the transaction indistinguishable from a reference-less import.

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

Three reconciliation traps:

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
  visually similar Unicode characters can differ while retaining the same byte
  length, changing the identity hash and fabricating a second statement row. MCP
  is the write path for ordinary imports, where a few hundred rows is
  unremarkable; a backfill big enough that a model cannot carry it is a one-off
  migration script, not a reason to fork the write path permanently. Reconcile
  afterwards either way with `find_statement_row_drift` — a row present in the
  ledger but absent from every export is the signature.

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
rather than positive.

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
parameters per order, so any target value can be made to "close exactly".
Take earnings from the marketplace, never from a calculation.

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

Synthetic example: orders A and B earn -$30 and -$20, with a +$5 label
charged separately for A. The payout is -$55, allocated as -$35 to A and
-$20 to B. Allocate the separate +$5 label to A; its two slices net to
-$30. Allocating earnings directly would sum to -$50 and fail validation.

**Resolve a payout's orders by `Purchase.orderId`, not by note prose.** eBay sale
Purchases are keyed by the eBay order number, which is exactly what a payout note
cites, so the order id is a direct lookup. Notes claiming that an order is
unrecorded can be stale; check its identity before creating a new Purchase and
correct an obsolete note when touching that record.

A label bought against an already-open payout is deducted from a *different*
payout than the one carrying its order. Where eBay charged that leg to the bank
separately it is its own transaction and allocates cleanly. Where it was netted
inside the payout, the truthful split needs an opposite-signed allocation, which
the same-sign rule forbids — leave that payout unallocated rather than putting the
whole amount on one order, which over-settles it and under-settles the other.

An older allocation may truthfully record bank movement while differing from
final earnings because a label settled elsewhere. Preserve evidence-backed
allocations; do not fit numbers or unallocate solely to quiet a mismatch
detector. Document any unresolved cross-payout leg without inventing a
transaction for it.

## Card exports: signs, coverage, and what they cannot prove

- Monarch: negative = charge, positive = credit; `Original Statement` carries the
  store number, and its `Id` column is a usable external id. Copilot: **sign
  inverted** (positive = charge), carries the account mask directly. Mint-era
  exports: unsigned amount with a `Transaction Type` column, card named by
  *product* with no last-four, and no external id — rows sourced from them get
  no `sourceRef`. Combine overlapping exports only after establishing their
  source coverage;
  different files may each carry only one leg of a charge/credit pair.
- Copilot posts on posting date, Monarch on transaction date, so one event
  appears 1–3 days apart in each; dedupe on vendor + amount within ~5 days.
- **Absence from every export is not evidence a charge did not happen** — a
  vendor-confirmed receipt can be missing from every file inside the covered
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
  the statement does not carry. Map to the statement row, then register the
  digits on that account's `cardNumbers` so the next receipt settles itself.
- When vendor histories require another account owner's unavailable login,
  the statement rows can remain in scope without being enrichable. Stamp
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
  are wrong often enough to bury modelled spend** — a durable-goods purchase can be
  classified as a recurring expense. When two providers
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
- Shapes that defeat amount matching: split tender (card +
  gift card, so no row equals the total); per-shipment billing (N legs summing
  to the order); store-fulfilled legs under the store descriptor; several
  refunds from **different orders** posting as one credit, grouped by card, not
  by return visit (retire the merged row and graft its hash onto the largest
  constituent — a merged row spanning orders can never link to one Purchase);
  a discount posting as a separate credit; a tax-rounding gap between recorded and
  printed lines; a synthesized aggregate booked from an order header facing two real
  statement legs (prefer the statement rows). Sum before concluding a mismatch,
  and check the vendor's tender strip before concluding a row is missing.
- When the constituents of a merged credit are already booked as vendor legs,
  linking the merged row as another leg double-counts the refund.

## Reading a settlement gap

Comparing posted refunds against negative Expenses finds returned-but-unbooked
money, but most nonzero gaps are benign. Check these causes:

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
  possible even when the arithmetic closes. Scrape
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
the one debited; keep one stored-value account per vendor **per owner**, with
`providerVendorId` set to the vendor and `ledgerPartyId` to the member whose
balance it is (null only for a card the household shares), and record each
physical card as a `physical_card` entry in `cardNumbers` rather than one
account per card. A unique index allows one live account per provider and
owner. To find the account a gift-card leg drew on, list `financialAccount`
filtered by `providerVendorId` = the purchase's vendor and `ledgerPartyId` =
the member of the purchase's vendor account; with no vendor account and more
than one candidate, ask rather than pick. Where a vendor's phone/online support
does nothing, a physical return desk can recall the original receipt and issue
the refund directly.
