# Spending classification

An Expense records money and owns its spending classification. A Product
Category describes a thing. Product Category mappings connect those two
vocabularies without making a mixed retailer's entire order one category.

The resolver uses an explicit Expense category first, then narrow food/merchant
context, the nearest Product Category mapping, a stored Purchase fallback, and
a selective merchant default. Unresolved values remain unresolved. A blocked
Product Category mapping stops automatic defaults; deliberate Expense and
Purchase choices remain available. Product mappings update historical Expenses
live, while explicit purposes such as Gifts stay in place.

Purchase categories are fallbacks, not summaries. Purchases and Financial
Transactions expose derived single, mixed, partial, unclassified, or
not-applicable summaries. Transaction allocations connect Purchases, not
individual items; transaction summaries therefore show category context without
inventing dollar allocations. Original statement categories remain source
evidence. Legacy Purchase defaults retain their provenance review gap until an
explicit save; API audit provenance alone cannot establish statement origin.

Shared tax, shipping, tips, fees, and ordinary discounts are allocated once to
principal Expense lines in whole cents. The principal Expense ID breaks rounding
ties. Project and Spending Category reports group those same joint allocations;
filtering never changes the full Purchase weights. Unknown shares remain in the
report, and the allocated total equals `SUM(Expense.cost)`. Refund-only baskets
use absolute principal weights; unidentified refund adjustments on a positive
basket remain unknown unless explicitly classified.

Category completeness is independent of pricing and Project completeness. A
known category on an unpriced Expense is still classified. An automatic
adjustment with unknown principal weights can remain partially classified.

## Reviewed changes

Product Category mappings and merchant policies affecting existing Expenses use
`spendingClassification.preview` and `spendingClassification.apply`. The preview
reports classification counts and signed category deltas; apply rechecks its
fingerprint inside a serializable transaction before audited entity writes.
Changes after preview require a fresh review. Web and native views use this same
backend operation; the Swift review session supplies presentation state only.

Merging Spending Categories is keeper-wins: every incoming reference (explicit
Expense categories, Purchase defaults, Financial Transactions, merchant
defaults, Product Category mappings) and every child category moves to the
keeper, whose own name and expectations stay unchanged; the others soft-delete
with an audit trail and redirect to the keeper. A merge refuses when a merged
category is the keeper or one of its ancestors. A merge that moves any live
Expense's effective category runs only as a reviewed `spendingCategoryMerge`
change, and like every reviewed change it refuses when a moved Product-linked
line lands in a `not_allowed` category. The plain `entity.merge` path applies
only merges that move no Expense history, such as folding an unused category.
Both merge paths first lock the keeper and merged categories and refuse one
that is no longer live, so writes referencing them wait for the merge. A writer
that resolved a merged category earlier can still commit its reference
afterward; this race is accepted, the referential-liveness problem reports the
dangling reference, and `problems.repointMergedReferences` moves it to the
survivor.

Splitting an Expense preserves its category when a part omits the field, resets
it when a part supplies null, and stores an explicit category when supplied.
Splits preserve allocation basis and cannot fabricate Product/receipt identity.

## Initial taxonomy and mappings

`apps/web/tooling/spending-classification-seed.ts` previews a curated manifest
without writing. Apply requires that exact preview fingerprint and a real member
actor. It preserves explicit/blocked mappings, refuses ambiguous names/aliases,
and reports category deltas that conserve the ledger. It never
rewrites Expense costs or legacy Purchase/Transaction scalar categories.

Run committed migrations first against the explicit direct target. Inspect the
seed preview and confirm category deltas conserve the ledger before applying it.
Read back schema, audit writes, mappings, and exact ledger cents afterward.
