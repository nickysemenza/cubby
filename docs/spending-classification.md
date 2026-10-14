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
ties. Project, Spending Category, trade, and cost type reports group those same
joint allocations: each share carries its principal's trade and cost type,
unless the adjustment names its own trade, which claims the whole charge at the
adjustment's own cost type. A share with no principal reports under no trade
and the adjustment's own cost type. Filtering never changes the full Purchase
weights. Unknown shares remain in the
report, and the allocated total equals `SUM(Expense.cost)`. Refund-only baskets
use absolute principal weights; unidentified refund adjustments on a positive
basket remain unknown unless explicitly classified. A basket whose principals
are all priced at $0 (an award ticket) splits adjustments evenly across them;
one unpriced principal leaves the shares unknown.

An Expense with an unresolved receipt role uses `lineKind = unclassified`.
Receipt-role quality is assessed only for incurred lines; planned lines are not expected to have receipt evidence.
Its signed amount appears once in unresolved allocations and remains in ledger,
Purchase, and vendor totals. It is not distributed using principal weights and
cannot inherit Product, Project, or spending-category assignments. A Purchase
with unresolved roles has incomplete allocation classification until those
roles are resolved. Explicit receipt roles remain authoritative; automatic
classification accepts only a confident Decision result. Uncertainty remains
unclassified, while a model failure fails the operation. Settlement booking waits
until existing vendor receipt roles are resolved, preventing an unresolved
amount from being booked again. An abstention with explicit role-dependent
assignments refuses the write instead of dropping that intent. An inferred
positive discount on a forward receipt stays unresolved; explicit source roles
can represent signed reversals and corrections. Detaching a Purchase preserves unresolved
Expenses and their signed amounts without inventing inherited attribution.

Category completeness is independent of pricing and Project completeness. A
known category on an unpriced Expense is still classified. An automatic
adjustment with unknown principal weights can remain partially classified.

## Reviewed changes

Product Category mappings and merchant policies affecting existing Expenses use
`spendingClassification.preview` and `spendingClassification.apply`. The preview
reports classification counts and signed category deltas; apply rechecks its
fingerprint inside a serializable transaction before audited entity writes.
The fingerprint covers classification policy and every Expense the change can
reach: those reading a changed override, Product, Product Category subtree,
merchant, or merged category, plus the other lines of their Purchases. A change
to policy or to one of those Expenses, including one that newly comes into
reach, requires a fresh review; an edit to any other Expense does not. Only
those Expenses are resolved before and after; household totals come from one
aggregated allocation pass. Web and native views use this same
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
that is no longer live. A write racing a merge may still leave a reference to
the merged-away category, which the Problems page's dangling-reference check
reports for a person to fix; a concurrent Expense edit and merge may deadlock,
in which case PostgreSQL aborts one and the person retries.

Splitting an Expense preserves its category when a part omits the field, resets
it when a part supplies null, and stores an explicit category when supplied.
Web and native split editors let each part set an explicit receipt role or ask for a Decision; an abstention can be resolved by selecting a role before retrying.
Splits preserve allocation basis and cannot fabricate Product/receipt identity.
