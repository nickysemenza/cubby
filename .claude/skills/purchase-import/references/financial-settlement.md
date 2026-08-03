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

The field is **`sourceRefs`**, an array, and it replaces the whole array
(read–merge–write when appending). The singular `sourceRef` is accepted and
silently discarded — the write reports success, `sourceRefs` comes back `[]`,
and the gap stays open. `create_financial_transactions` also does not take a
source ref at all, so a created transaction always needs this backfill pass.
Confirm by re-reading the row, or by checking that the Purchase drops out of
`list_purchases({dataStatus:"needs_data"})`.

## Purchases and refunds

Link truthful charge, installment, split-tender, and refund transactions to the
original Purchase. A refund document number is evidence, not a new order.
Transactions spanning several Purchases remain unlinked until allocation exists.

Keep refund Expenses on the original Purchase. Preserve the vendor's original
stated total and record refund settlement separately. A reconciliation mismatch
is an investigation cue, not a reason to rewrite spend or paperwork.

For a posted transaction, retain a truthful source reference whenever available.
Without one, the Purchase may remain flagged for missing `settlement_reference`;
do not manufacture a reference to clear that gap.
