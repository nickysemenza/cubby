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
refusals rather than changing identifiers to force a merge.

## Expenses

Expense has no merge operation. Retire only the redundant booking with
`entity.delete expense` once original evidence proves that the same money is
fully represented by the survivor's line or itemized lines. A legacy lump and
an imported itemization qualify only when their common source is established,
the full signed sum agrees, and attribution is settled. Preserve project,
party cents, source evidence and any real payment or quantity history through
the supported writers before retiring the duplicate. Source-backed financial
changes use reviewed reconciliation when the writer requires it; a refusal
is not permission to strip a source claim or bypass the guard.

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
