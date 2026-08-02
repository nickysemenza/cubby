# Financial settlement

## Authority and signs

Vendor documents establish Purchase identity, literal stated total, and
Expense detail. Statements establish FinancialTransaction amount, Account,
status, and posted date. Do not overwrite one source's facts with the other.
Vendor-reported card/payment hints are evidence for notes or a future structured
reference; they do not establish a Financial Account identity.

Cubby signs are positive charge/outflow and negative refund/inflow. Monarch
exports invert this for ordinary charges, so normalize before previewing.

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
