# Financial settlement

Read the section needed for the current settlement question. All worked amounts
and identifiers below are synthetic; derive live references from authorized reads.

## Default import verification

For every committed account-sync order, including a saved email confirmation,
check settlement before finishing the run. This is routine import work; the
member need not supply transaction or account candidates.

Use `finance.converge` for source-proven genuine purchase payments. Its server
policy checks identity, money, ownership, funding and accepted lineage; inspect
its result rather than treating a nearby candidate or model ranking as proof.
Changed accepted facts and partial/split ambiguity require review. Nonpurchase
financial Emails retain their financial association through `purchase_import.mail_resolve`;
they must not create Purchase spending. Exact aggregate-to-itemized replacement
uses the reconciliation writer and refreshes the automatic booking fingerprint.

1. Read the committed Purchase, its allocations, and existing
   FinancialTransactions. Search Source transaction records with `entity_read.list` or
   `entity_read.search` (`entity: "sourceTransactionRecord"`) by the vendor's known
   descriptors, then verify amount, posted date, account identity, and source
   references. Include matched and ignored rows: a prior disposition or source
   category is a judgment to verify, not proof that the charge is unrelated.
2. Reuse the existing transaction when its evidence agrees. Read every
   allocation and source reference before proposing a missing Purchase link or
   additional reference; preserve unrelated allocations and references. Check
   alternate exports for the same charge before considering creation.
3. For missing or revised statement evidence, use
   [financial-evidence-import](../../financial-evidence-import/SKILL.md).
   Recording evidence lets Cubby's durable work match and book through shared
   rules or publish unresolved decisions. Inspect the receipts and suggestions;
   do not orchestrate record/create/reference/book writes in the client.
4. Report each order's settlement outcome: already matched, awaiting posting,
   awaiting approval, ambiguous, or source evidence absent. For recent charges,
   refunds and transfer counterparts, allow two complete Monday–Friday days after the effective transaction
   date (America/Los_Angeles, no holidays) before investigating absent
   settlement. Friday evidence is still waiting Tuesday and actionable
   Wednesday. Use Purchase date without a transaction, and createdAt only
   for undated evidence; reimports never reset dated age. A provider's pending status
   or the member's confirmation that a leg has not settled keeps it awaiting
   posting beyond that window; age alone never establishes a defect. Recheck
   after posting or when the member requests it, rather than repeatedly asking
   for evidence during the normal delay. Keep conflicting dispositions and
   ambiguous allocations reviewable. In the web settlement review, the member
   can ask for a ranked suggestion across the bounded 20 candidates,
   including differently named/date alternatives; it never settles, and agents keep the deterministic
   candidates. An absent charge is a coverage gap unless
   the source window proves otherwise; an email total alone cannot create one.

## Authority and signs

Vendor documents establish Purchase identity, literal stated total, and
Expense detail. Statements establish FinancialTransaction amount, Account,
status, and posted date. Do not overwrite one source's facts with the other.
Vendor-reported card/payment hints do not establish a Financial Account
identity; once the funding account is known, they belong in that account's
`cardNumbers` (below), not in notes.

Cubby signs are positive charge/outflow and negative refund/inflow. Evidence
normalization and raw provider signs are owned by
[financial-evidence-import](../../financial-evidence-import/SKILL.md#normalize-and-record).
Statements establish only the status/date semantics they actually expose;
unknown status remains unknown.

## Free rewards and purchased credit

Free rewards and coupons are signed negative Expenses with `lineKind=discount`,
the receipt description, and retained receipt evidence. Gross $201.57 less a
free $5 reward means $196.57 incurred spend and payment. Purchased store credit
or gift cards are tender, not a discount. Check whether line amounts or the
net receipt total already include the reward before adding a negative line;
never count it twice. Retain literal stated totals. Correct a total only when
the receipt establishes the correction; leave ambiguous evidence unresolved.

## One card line, several Purchases

A single charge or credit that settles more than one Purchase is ordinary, not
exotic — it is what a return desk produces when several orders go back on one
receipt, and what a statement produces when it combines same-day refunds.

Record it as **one** transaction carrying an `allocations` array:

```
finance({ action: "allocate_settlement", transactionId: "FTX-TEST",
  priorAllocations: [], allocations: [
    { purchaseId: "PUR-TSTA", amount: -10.00 },
    { purchaseId: "PUR-TSTB", amount: -5.00 },
  ] })
```

Pass the complete allocation graph just read as `priorAllocations`; the example
starts with an unallocated transaction. Preserve every unrelated existing edge
in the proposed graph. A stale graph refuses without replacing newer links.

Allocations must sum to the transaction's amount to the cent and share its sign;
the write path refuses anything else. Mixed signs are unsupported by design — a
charge and a credit are two settlement events, and the statement will show them
as two rows.

`FinancialTransaction.purchaseId` is a derived mirror: non-null only when there
is exactly one allocation, NULL for a split. NULL there means "not exactly one
purchase", never "unsettled" — read `allocations` for the general case.

## Financial evidence intake

Use [financial-evidence-import](../../financial-evidence-import/SKILL.md) for
Monarch MCP and statement files, including historical backfill, replay, source
revisions and qualified withdrawals. It owns coverage proof and client parsing;
Cubby owns scheduling, matching and booking. Each observation and genuine
occurrence remains distinct until reconciled. Equal date/amount/description,
provider category, or a historical content hash does not establish charge
identity or authorize propagating a match or disposition.

## Account identity for settlement review

Resolve an Account by source external ID, source aliases, then one unambiguous
network/last-four candidate across every account's `cardNumbers` (`entity_read.list
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

- _Wallet tokenization._ A wallet payment presents a device account number to
  the merchant terminal, so the invoice prints one set of last-four while the
  statement shows the funding card's — an `AplPay` or similar prefix on the
  statement row is the tell, though many providers (Monarch included) drop it.
- _Card reissue or a sibling card on one account._ No wallet prefix, and the
  mismatch is stable across older receipts but absent from newer ones. A
  reissued or replaced card changes the printed last-four while the account
  persists, and the statement is labelled with the account's _current_ card, so
  historical rows inherit today's digits. Amex is especially prone to this: the
  card member number and the account differ, and supplementary cards share an
  account.

Either way: first look the digits up across `cardNumbers`. If they are absent
and the statement row identifies the funding account (date, amount, vendor),
`entity.update financialAccount` that account with the digits appended —
`wallet_token` when the statement or provider confirms a wallet, a dated
`primary` when the mismatch is a reissue, `unknown` when the cause is open —
with a `note` citing the receipt. Do not mint a provisional Account for the
digits the receipt printed, do not leave them as prose in notes, and do not
reject an otherwise exact date/amount/vendor match over them.

### Working the backlog through Transaction suggestions

Recording rows starts a routine Sweep that turns each unmatched charge into
one Transaction suggestion (`suggestions.list` with `family:
"statement_transaction"`; `groups: "account_month"` adds per account × month
sections with clean counts); `run.sweep {families: [{family:
"statement_transaction"}]}` reruns it after hand edits to transactions or
accounts, and `run.work_snapshot` follows its Steps. Burn the backlog group by group,
filtering a group with `where {account: {in: [FAC-…]}, month: {in: [YYYY-MM]}}`:

1. Accept `clean: true` suggestions in batches of up to 100 with
   `suggestions.reviews`: verdict `correct`, intent `apply`,
   `expectedFingerprint` (the row's `fingerprint`), and `application {kind:
   "statement_transaction", action: <recommended>}`; an attach also names
   `transactionId`, the first candidate. For transfer/card-payment creates use
   the opposite-leg rule in step 5. Other creates are clean only when at least
   two of `create.votes` (category `rule`, model `label`, merchant `history`)
   name its kind and none disagrees, and `create.counterparty` is a business
   (on a stored-value account such as a payment app, history must say so). A
   card benefit, statement credit or issuer promotion is an `adjustment`, not a
   `refund` (a merchant giving money back for returned goods), even when it
   names the merchant of the purchase it offsets; merchant history is kept per
   direction, so a couple of corrected credits teach it.
2. Read every other suggestion before choosing. An attach candidate's model
   `label` is advisory — confirm the descriptors yourself, and below about $20
   read both. Attach to a different candidate, tick `fields`, override the
   kind, or create anyway (`rejectedCandidateIds` listing every candidate) as
   verdict `wrong` with `correction {present: true, value: <the same
   application>}`.
3. A charge with `siblings` has a same-amount charge from another export: the
   pair may be one charge whose descriptor firmed up. Supersede the thinner row
   (generic `entity.update` on `sourceTransactionRecord`, setting
   `supersededByRowId` to the reviewed successor record ID) before creating
   either. A `claimed` candidate already settles another charge from the same
   source, so it is never clean: attach only when this row is that charge
   re-exported under a new descriptor; two visits for the same amount are two
   creates.
4. A person counterparty is never clean. An outgoing payment to a person is
   your share of a shared cost: create it as `purchase` and set the merchant.
   An incoming one is a repayment: create it, then book it with
   `finance.book_transaction` as `economicRole: "reimbursement"`.
5. A `transfer` names the member's own balance account a cash-out or funding
   descriptor points at (Venmo-style and payout balances are `stored_value`;
   PayPal is read like a card). Review the `transfer_pair` family on the global
   Suggestions page or through `suggestions.list`; find pairs with
   `run.sweep {families: [{family: "transfer_pair"}]}`. Accept using verdict
   `correct`, intent `apply`, `expectedFingerprint` and `application {kind:
   "transfer_pair"}`. It creates missing statement-backed legs and accepts the
   pair atomically. The family and statement creates share the
   [opposite-leg clean policy](../../../../docs/adr/0016-shared-assessments-and-feedback.md#transfer-pair-suggestions-2026-10-19).
   Cross-owner pairs always need review and record a LedgerTransfer.
   An ATM withdrawal moves money into the `cash` account of the bank
   account's owner (a household checking's cash is the household's), so it is
   an internal move. Cash has no statement: review the proposal to create its
   full-amount leg on the owner's unique cash account, or enter the leg by hand.
   A proposed cash leg is never clean. Record the known ATM fee separately as a
   `fee` on cash; never infer a fee amount. Settle cash spending from that
   account against its Purchase.
   A cash account never reconciles: cash spent and not remembered stays as an
   unexplained balance on purpose. Never invent spending to close it, and never
   settle a Purchase from cash without evidence that the cash paid it.
   Review unresolved overlapping exports before creating a leg; confirmed
   observations must share one FinancialTransaction. Amount and nearby dates
   alone cannot establish charge identity.
6. Dismiss charges that should never become transactions with verdict
   `dismissed` and suppression `{scope: "statement_transaction", candidateKey:
   "<source>:<chargeKey>", fingerprint}`; prefer `disposition: "ignored"` with a
   reason when the whole row must never become a transaction, because that also
   settles every observation. Every real charge is in scope, consumer spend
   included: ignore only duplicates of another export's row, pre-Cubby rows and
   mis-parsed lines, never `not_modeled`.

A refusal (evidence changed, a live candidate, a stale hold, an attach with
several candidates and no named `transactionId`) writes nothing. Labelling
republishes a suggestion under a new assessment id, so a stale-Assessment
error means re-list the group and review the replacement. Explicit pending-to-posted evidence can support a reviewed supersession.
Disappearance requires the complete scope and explicit source confirmation in
[financial-evidence-import](../../financial-evidence-import/SKILL.md#withdrawals).
Age or absence from a later export alone does not authorize voiding a hold.

## Purchases and refunds

Link truthful charge, installment, split-tender, and refund transactions to the
original Purchase. A refund document number is evidence, not a new order. One
that settles several Purchases carries an `allocations` array — see "One card
line, several Purchases" above.

Keep refund Expenses on the original Purchase. Preserve the vendor's original
stated total and record refund settlement separately. A reconciliation mismatch
is an investigation cue, not a reason to rewrite spend or paperwork.

An updated order confirmation that lowers the total after the charge, followed
by a matching partial refund, is a refund, not a re-itemization. Keep the
original lines and stated total. Add the removed item as a negative line and
any recomputed discount as a positive `discount` line, both dated on the update
and cited to the updated Email, then allocate both the original charge and the
refund to the Purchase. For example, a $3 item dropped from a $116 order with a
10% discount refunds $2.70: −$3.00 for the item and +$0.30 for the smaller
discount. The Purchase then reads `refund_adjusted`, with its settlement
matching.

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
separately needs `refund` for real refunds issued to _buyers_.

**Never derive a payout from the item price.** Two mechanisms make it
unfalsifiable, and both are invisible in bank rows and payout emails:

- _Promoted-listing ad fees_ are charged per item, on some listings and not
  others, and are not implied by anything else on the order.
- _Shipping labels cross payout boundaries._ A label is deducted from whichever
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

A label bought against an already-open payout is deducted from a _different_
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

## Source coverage during settlement review

Use the financial-evidence skill's account/window coverage proof before treating
an absent source record as a withdrawal. A vendor receipt can establish a real
Purchase while its payment remains outside available statement coverage. Keep
that gap explicit; never invent a cash payment or merge accounts from name or
last-four resemblance. Overlapping sources are corroboration to review, not
permission to collapse equal-looking purchases. Provider categories remain
advisory and cannot hide real consumer spending.

## Orphan transactions and twins

- A statement-backed transaction may have no Purchase allocation. Its
  `transactionDate` can be NULL when only a posted date was provided, so a `transactionDateFrom/To` filter
  silently excludes exactly the rows still needing a match, and `vendorSearch`
  resolves through the linked purchase, so an unlinked row has no vendor either.
  **Hunt unmatched settlement by amount + account with no date or vendor
  predicate**, or via Transactions → "Not linked to a purchase". Dedupe on
  `COALESCE(transactionDate, postedDate)`, and allow **±3 days** — vendor charge
  history and the statement disagree on a leg's date routinely.
- **To settle from an orphan, LINK it** (set allocations and `transactionDate`
  on the existing row). Creating a fresh transaction beside a live orphan is
  what manufactures twins.
- A linked transaction and an unallocated statement-backed transaction may be
  twins or separate real charges. Keep all observations and source references;
  use the shared reconciliation writer or explicit duplicate bookkeeping review
  to resolve accepted identity. Financial intake does not delete transactions
  and graft historical hashes between them.
- Shapes that defeat amount matching: split tender (card +
  gift card, so no row equals the total); per-shipment billing (N legs summing
  to the order); store-fulfilled legs under the store descriptor; several
  refunds from **different orders** posting as one credit, grouped by card, not
  by return visit (retain one credit with allocations across those Purchases);
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
   Verify identity and resolve through explicit duplicate bookkeeping review.

- **An unmatched credit has three causes — check in this order:** already
  netted into the Expenses with only the settlement pair missing (most common);
  the whole order missing from Cubby; a genuine missing refund on an existing
  purchase (rarest). Never assume it belongs to the nearest purchase by
  vendor+date — the charge side of the export disambiguates.
- `statedTotal` holding a **net** is a tell: whenever it equals the expense
  total on a purchase that had a return, suspect the refunded tax is missing.
- Linking an orphan credit can _create_ a double-count when the Purchase already
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

Rule for every vendor: only evidence that ties a charge to an order — a vendor
payment ledger naming the order, payment lines retained on the order page, or a
receipt carrying the card and amount — settles automatically, and only when
the whole payment set is unique. A subset that sums to `statedTotal`, a
same-week cluster, the nearest date, or a model ranking is a candidate for
review, never a settlement by itself.

Before proposing any charge for an order, read the charge account's `notes`
and the order's payment method. Cubby refuses an allocation whose account
conflicts with the order (`settlement_party_conflict`: the account's people on
the charge date do not include the order's member — its vendor account's
member, else its `purchaserOverrideId`, else the one member whose mailbox holds
its accepted or linked Email, never the card-derived purchaser; an order with
no known member never conflicts;
`settlement_tender_conflict`: the account is not among the order's paying
accounts — its `paymentAccounts` links, else those derived from payment
evidence). A refusal is evidence, not an obstacle: move to the order the
account paid. Use `finance.allocate_settlement` with `acknowledgeConflicts`
only for a confirmed shared card or gift, and say why in the note. A charge one
cent off is a near miss, never "exact"; a unique amount+date match is a
candidate for review, never a settlement.

- **Amazon: the charge→order ledger is the only arbiter.** A subset of charges
  that sums exactly to `statedTotal`, uniquely in its window, is still not
  evidence — grocery orders bill in many small legs and coincidental sums are
  possible even when the arithmetic closes. In an interactive session, scrape
  `/cpe/yourpayments/transactions` (20 rows per POST page; render results into
  the DOM and read with `get_page_text`, since `javascript_tool` truncates
  returns), join free transactions to charges on (amount, date ±6 d) to get the
  **order id**, then order id → Purchase. An agent run uses the payment evidence
  retained with its captures instead. Query _all_ purchases, not just
  zero-allocation ones — most wins are extra shipment legs on partially-settled
  orders, and refund-only purchases complete to net zero when the charge lands.
  Re-run the audit (group `orderId → [amounts]`, diff against Cubby) after any
  matching pass; it is cheap. The scraper's dedupe key collapses identical
  same-day charges on one order, so "Amazon < Cubby" on a same-amount pair may
  be dedupe loss.
- **Home Depot legs cluster within a week**, so a same-week set summing to
  `statedTotal` is a strong candidate to propose, but it still needs review
  because HD has no charge→order ledger. Compare `expenses vs net settlement`,
  not either against `statedTotal` (returns net both sides down together).
- A charge that **predates its order** falsifies the match by itself; a 1–3 day
  lead is posting noise, a week is a wrong purchase date. A gift-card line means
  the card charge is _not_ the stated total. Marketplace vs first-party
  descriptors (`AMAZON MKTPL` vs `Amazon.com`) break same-day ties; `Sold by:` on
  the invoice explains multi-seller multi-charge orders. When identical charges
  stay indistinguishable, leave them unresolved for review rather than picking
  one. Never attach a charge that exactly equals an already fully-posted total —
  the twin belongs to an order Cubby never booked. When proposing, rank the
  candidate purchase that still carries a shortfall first, then nearest date,
  one charge per purchase; tips skip the shortfall test.
- Recurring same-price purchases are the whole source of ambiguity; nearest
  date only orders the proposal, and the reviewer chooses.
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
the order's member (as for `settlement_party_conflict`); with no known member
and more than one candidate, ask rather than pick.

Record what paid each order line as `tender` on payment evidence: `card` with
`cardLastFour` when shown, `stored_value` for gift card, account balance or
store credit, `unknown` otherwise. A gift-card line is never a card with no
digits. Amazon `Order History.csv` → `Payment Method Type` (parsed locally, as
every export is):

| `Payment Method Type`                   | Payment lines                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `Gift Certificate/Card`                 | one `stored_value` line for the total                                             |
| `Visa - 2505`                           | one `card` line, `cardLastFour: "2505"`                                           |
| `Gift Certificate/Card and Visa - 2505` | `stored_value` + `card` lines; amounts from the order page's **Gift Card Amount** |
| `Not Available`                         | `unknown`                                                                         |

When evidence cannot name the account (two cards share a last four, or no
stored-value account exists for that vendor and member), link the paying
account with `entity.link` relation `paymentAccounts`; any link replaces the
derived accounts. Where a vendor's phone/online support
does nothing, a physical return desk can recall the original receipt and issue
the refund directly.
