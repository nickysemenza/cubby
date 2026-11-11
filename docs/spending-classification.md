# Spending classification

An Expense records money and owns its spending classification. A Product
Category describes a thing. Product Category mappings connect those two
vocabularies without making a mixed retailer's entire order one category.

Reports use Spending Categories whether a Purchase has item lines or only a
lump amount. Without item evidence, classify only as specifically as the known
purchase evidence supports; a mixed retailer's name alone does not establish
its basket contents. Keep unresolved money visible in totals.

Later itemization can refine historical allocation when the resulting lines have
no explicit category override. A lump's saved category is currently copied to
its replacement principal lines, so those lines retain it until a reviewed reset;
uncertain assignment origin is not permission to discard the saved choice.
Classification changes preserve money. Explicit Expense purposes remain
authoritative: a drill bought as a gift stays a tool in the Product catalog and
Gifts in spending. A Purchase category remains a fallback, not an overriding
purpose for every item. Receipt detail is not required to participate in
high-level analytics.

Keep Product Categories and Spending Categories distinct. Maintain mappings at
the broadest applicable Product Category and inherit the nearest mapping down
its branch, with narrower assignments and blocks expressing exceptions.

The resolver uses an explicit Expense category first, then narrow food/merchant
context, the nearest Product Category mapping, a stored Purchase fallback, and
a selective merchant default. The merchant default covers productless principal
lines at grocery, restaurant and coffee-shop Vendors, and every principal line,
including lines that link a Product, at a `single_category` Vendor, whose
purchases all belong to its default category. A Vendor default is a live input,
never copied onto Purchases or Expenses, so a profile or default change moves
every Expense that reads it. Unresolved values remain unresolved. A blocked
Product Category mapping stops automatic defaults; deliberate Expense and
Purchase choices remain available. Product mappings update historical Expenses
live, while explicit purposes such as Gifts stay in place. A newly resolved
category also brings that category's Product expectation and stock-tracking
inheritance to the line, so a classification change can change itemization
coverage; the reviewed preview reports money only.

The Expense category resolver owns SQL eligibility, chosen categories, and
ordered explanation evidence. Explanations retain assigned but inapplicable
alternatives and the full ancestry hidden by an override, and read their
fallback source from that same choice relation in the operation's transaction
snapshot. Merchant eligibility uses the Expense's stored Product reference;
a soft-deleted Product does not turn the line into a productless purchase.
Allocation, filtering, and grouping select the chosen UUID directly; only
explanation reads build the evidence ladder and fallback/source provenance JSON.
Bulk allocations resolve their selected principal lines together, sharing one
ancestry catalog and joining category policy once across the batch, including
draft changes. The resolver uses the same depth and cycle guards and choice
policy as scalar resolution; project-only reads omit category resolution.
Scalar Project inheritance skips Project reads when an Expense has no explicit
project or its Purchase has no default. Live explicit assignments still precede
live Purchase defaults, then the household food fallback; deleted assignments do
not block later choices.

Purchase categories are fallbacks, not summaries. Purchases and Financial
Transactions expose derived single, mixed, partial, unclassified, or
not-applicable summaries. Transaction allocations connect Purchases, not
individual items; transaction summaries therefore show category context without
inventing dollar allocations. Transaction itemization explanations reuse the
Purchase evidence policy owner's linked-policy aggregate and single-source rule
over every live linked Purchase; the contributor display limit does not bound
that policy. Reviewed reimbursement still shows linked Purchase alternatives
even though its effective and fallback policy are not expected.
Original statement categories remain source
evidence. Legacy Purchase defaults retain their provenance review gap until an
explicit save; API audit provenance alone cannot establish statement origin.

Shared tax, shipping, tips, fees, and ordinary discounts are allocated once to
principal Expense lines in whole cents. The principal Expense ID breaks rounding
ties. Project, Spending Category, Product Category, trade, and cost type reports
group those same joint allocations: each share carries its principal's Product
Category, trade and cost type,
unless the adjustment names its own trade, which claims the whole charge at the
adjustment's own cost type. A share with no principal reports under no trade
and the adjustment's own cost type, and under the Purchase's own Spending
Category when it has one that did not come from a statement (the rule
principal lines follow); otherwise it is uncategorized, even at a
`single_category` Vendor. Filtering never changes the full Purchase
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

Product Category mappings, parent moves, and Vendor spending defaults use
`spendingClassification.preview` and `spendingClassification.apply`. The preview
reports classification counts and signed category deltas; apply rechecks its
fingerprint inside a serializable transaction before audited entity writes.
The fingerprint covers classification policy and every Expense the change can
reach: those reading a changed override, Product, Product Category subtree,
merchant, or merged category, plus the other lines of their Purchases. A change
to policy or to one of those Expenses, including one that newly comes into
reach, requires a fresh review; an edit to any other Expense does not. Only
those Expenses are resolved before and after; household totals come from one
aggregated allocation pass. Classification review is web-only; native hands
the vendor and category sections off to web.

Parent previews include the moved subtree and reject changes to live Products'
effective Food behavior. These fields are create-only in the generic entity API;
all subsequent changes use review, including when no Expense history exists.
The web **Use item detail** action previews and
clears only selected Expenses' saved category overrides, then resolves them from
item detail and eligible fallbacks; it never changes their money or clears
Purchase defaults. A stale preview and a forbidden feature or category change
surface the owning operation's raw error.

Product Categories and Spending Categories use their ordinary category tables as
one mapping workspace, with Tree and Flat arrangements. Existing Mappings links
(`?view=hierarchy`) open that table. Filters, saved views, matching-row selection
and applicable bulk actions remain owned by the generic list. Tree search keeps
matching rows' ancestors as context; context rows are excluded from
selection. Only rows with children have expand controls. Phone rows retain
ancestor labels and readable mapping provenance beneath their summaries.

Product Categories show one effective Spending Category, its source/state,
subtree Product counts and allocation-based subtree net spending. The inspector's
Product count opens that same branch, including descendants, in Products. Spending
Categories show allocation-based subtree net and incoming mapping counts for
each category itself. Spending is labelled **All history, including planned**;
display filters change visible categories, not this spending or historical
review scope. Parent amounts include descendants and must not be added together.
Household-wide coverage beneath each table keeps named unresolved remainders
visible with canonical Ledger links.

Selecting a row opens the responsive inspector. Product Categories show mapping
provenance, actual Spending Category outcomes and canonical reviewed mapping or
parent edits. Spending Categories show actual contributing Product Category
branches and productless/unresolved evidence, separately from configured
incoming mappings, and retain the existing itemization, Product expectation and
stock policies. The Needs policies queue uses the existing data-gap filters. Configured mappings are defaults, not money outcomes. Complete
ancestry and allocation reads are batched, with no row-level finance queries or
stored spending summaries.

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
the merged-away category, which the Work queue's Problems dangling-reference check
reports for a person to fix; a concurrent Expense edit and merge may deadlock,
in which case PostgreSQL aborts one and the person retries.

Splitting an Expense preserves its category when a part omits the field, resets
it when a part supplies null, and stores an explicit category when supplied.
The web split editor lets each part set an explicit receipt role or ask for a Decision; an abstention can be resolved by selecting a role before retrying.
Splits preserve allocation basis and cannot fabricate Product/receipt identity.
