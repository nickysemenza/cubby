# Duplicate bookkeeping

A member's interactive import or Burn-down session may resolve an obvious
duplicate without another confirmation. This permission covers source-proven
duplicates, not financial guesses. Pi and other agent Runs keep their approval
and audit restrictions; use public writers and honor their refusals.

Before changing anything, read both full records, their original evidence,
linked expenses, source claims, settlement allocations and delete/merge
connections. Establish the exact survivor and the expected changes. Shared
amounts, dates, merchant names, thread membership or similar descriptions alone
do not establish duplicate money. Conflicting evidence or an unknown project,
owner, tender, quantity or net amount needs a concrete member decision.

## Purchases

Merge with `entity.merge purchase` when original evidence identifies the same
vendor, account and exact order or transaction, the survivor is unambiguous,
and every expense and payment leg is accounted for. Contractor progress payments
and other deliberately separate transactions remain separate Purchases even
when they share an order or project. Distinct shipments, refunds and adjustments
may belong to one Purchase while representing different money: preserve those
legs. A Purchase merge moves expenses and
settlement allocations; it does not deduplicate booked money. If both Purchases
book the same money, settle the duplicate expenses through the rule below and
verify allocations before proceeding. Honor cross-vendor and order-identity
refusals rather than changing identifiers to force a merge. Order ids compare
normalized (label, case and leading `#` removed), so `Trip ID: X` and `x` are
one identity, and the survivor keeps the id without its label. A merge still
refuses when two Purchases of that identity each hold lines, because folding
would keep both line sets; converge them instead.

When two accepted source documents imported one order twice (a pre-payment
notice and its receipt, both itemizing the same lines), read both originals,
then call `purchase_import.converge_duplicate_source_order` with the receipt's
Purchase as survivor. In one transaction it moves the duplicate's accepted
source orders onto the survivor, binds each duplicate line to a survivor line of
the same amount (the best valid one-to-one assignment within each amount,
preferring the same booking facts, then title, then role; a tie between two
assignments refuses; the survivor keeps its own description) and retires it, then folds the
rest through the Purchase merge. A booking code, spending category or trade
only the duplicate line holds moves onto its survivor line. It refuses
different Vendors, vendor accounts or order ids; Purchases without the same order id whose
source Emails share no thread and date; lines with no survivor line of the same amount; a line whose Product,
Project, quantity, party attribution, booking code, category or trade
conflicts with the survivor's, or a category the survivor's non-principal line cannot hold; financially claimed lines; and a duplicate with
no accepted source. Those stay review work. `already_applied` means this
command already retired the duplicate's lines; a duplicate a plain merge
folded in is refused for review. Replaying the duplicate's Email reaches the
survivor without new spending.

When owned originals explicitly connect a draft invoice to its paid order,
follow the [invoice identity correction contract](../../../../docs/import-evidence-convergence.md#invoice-to-paid-order-identity-correction).
The generic merge refusal still applies. An authorized maintenance correction
needs a reviewed atomic procedure preserving source bindings and durable
identity; the maintenance exception alone does not supply those guarantees.

## Expenses

Expense has no merge operation. Direct `entity.delete expense` cleanup is
limited to redundant Expenses with no ledger source claims and no other
source-owned references requiring transfer. Read the full record and incoming
delete connections first, and establish from original evidence that the same
money is fully represented by the survivor's line or itemized lines. A legacy lump and
an imported itemization qualify only when their common source is established,
the full signed sum agrees, and attribution is settled. Preserve project,
party cents, source evidence and any real payment or quantity history through
the supported writers before retiring the duplicate.

For a claimed or otherwise source-owned Expense, use an atomic reviewed
reconciliation or transfer that preserves the claim and survivor linkage in
the same transaction. `entity.delete expense` retires its ledger source claims;
deleting first and reattaching later leaves an interruption window. If no
supported writer can preserve the required evidence atomically, leave the
duplicate open and report the missing operation. Never clear a claim, delete
and recreate it in separate requests, or bypass a refusal to force cleanup.

Afterward, read back every affected record. Verify the intended duplicate is
retired or redirects to its survivor, retained sources and links survive,
`SUM(Expense.cost)` changes only by the proven redundant booking, payment
allocations still match real transactions, and stock has not been received or
removed. Report the removed duplicates and remaining unknowns.

Product duplicates use the shared
[exact-variant identity rule](../../product-enrichment/references/product-identity.md).
Other entity kinds require their own supported merge contract and proof of the
same underlying identity; this rule does not authorize merging accounts,
owners or transactions merely because their names or amounts match.
