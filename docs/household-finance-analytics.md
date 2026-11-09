# Household finance analytics

Read-side answers over the expense ledger: where money went by Spending
Category and project, who funded it, and what monthly spend looks like going
forward. Every figure is computed on read from `SUM(Expense.cost)` through the
joint allocator ([spending classification](spending-classification.md)); no
balance, projection, or scenario is stored, and nothing here is a time series.
Net worth stays gated on amending the trusted-household tenet.

## Category breakdown

`expense.analyze` (MCP `finance_read.analyze`; it exceeds
`entity_read.budget`'s schema) accepts `spendingCategoryRollup: "root"` on
a Spending Category row or column. Buckets are root categories plus two
unresolved buckets that stay distinct so totals reconcile:

- **Uncategorized**: no category resolved, including a Purchase with no
  principal line.
- **Unclassified**: the receipt role is unresolved (`lineKind = unclassified`).

Filters apply to final allocation rows, so they never change which principal
receives an ancillary cent. The analytics view's **Spending by Spending
Category** bars open the Ledger on that root with subcategories included;
**Spending by Cost Type** is the separate materials/tools/services axis.
Transaction-only categories (income, payment artifacts) have no Expense rows
and so never appear.

Product Category is a share-level row or column dimension over the same
allocation relation. Shared tax, shipping, fees and discounts carry their
principal's Product Category; a saved Gifts purpose can therefore appear as
Gifts × Tools. Product Category rows contain only their own category's money.
The mapping editor rolls these disjoint amounts up in integer cents, while
ordinary analytics keep their selected date and other filters. Both category
workspaces use the same allocation totals. Category detail charts show the last
twelve months of incurred Expenses, including descendant classifications and
shared charges through the canonical allocator; they exclude planned Expenses.
Their scope differs from the workspace's all-history, including planned totals.

Named remainder buckets distinguish no Product, a deleted Product, an
uncategorized Product, a deleted Category, an unidentified refund, an unresolved
receipt role, no principal, and unknown allocation weights. Unknown refunds on
positive baskets carry no inferred Product Category. A known Product Category
on an unpriced principal remains known, but its amount is unavailable;
`unpricedCount` marks incomplete dollar totals and is not additive across
allocation buckets. No price or product is invented.

Each bucket carries a Ledger filter over allocation shares. Product Category
filters support exact categories or subtrees, presence and named remainders;
they join the same scope as Spending Category, Project, trade and cost type.
Scoped totals and links therefore retain the bucket's exact cents without
changing Purchase weights. Exclude and Match-all filters retain their ordinary
whole-Expense fallback. The Product Category axis is bounded by the live
taxonomy rather than the generic 200-row limit.

## Money flow

The Sankey runs funder → project bucket → root Spending Category over the
analytics filters.

- Funders are member parties, the household, and Unknown funder, apportioned
  with the contribution ledger's funder cents per Expense before scope
  filtering, so funder totals match the ledger to the cent.
- Project buckets: the Household project, the top 8 other projects, Other
  projects, No project. Categories: the top 8 roots, Other categories,
  Uncategorized, Unclassified. Ranking is by net flow.
- Money is **net per full path**, Credits included, because repayments booked
  as Credits would otherwise inflate gross spend. Paths netting to zero or
  below cannot be drawn; they are listed under the chart, and links plus that
  list reconcile to the filtered net.
- Project → category links open the Ledger. Funder links do not: the Ledger's
  party filter matches explicit attribution rows, not account-derived funders.

A forward Sankey is deliberately absent: it would hide timing, which is the
point of the cash-flow page.

## Cash flow

`/cash-flow` (Finance) and MCP `finance_read.projection` project household-local
months over a 6-, 12-, or 24-month horizon. Inputs live in URL state; there are
no stored presets because the view manifest declares only entity list views.

- **Baseline**: per root category, the mean (trailing total ÷ 12) of the 12
  complete months before the current one, carried forward flat, so it
  reconciles to trailing spend. A median would zero any category idle in more than
  half the months, however large its spend; a one-off spike belongs in a project.
  A share counts when it has no live project or sits on the Household project;
  other project spend is forecast only by envelopes. A category with spend in
  fewer than 3 of the 12 months is **Irregular**, a display grouping:
  `irregular=grouped` (default) shows one Irregular row, `separate` shows each,
  and both sum the same cents.
- **Envelopes**: `in_progress` projects by default, `not_started` behind a
  toggle, `planning` only with an estimate; never the Household project or a
  project under an estimated ancestor. Remaining is
  `max(0, estimate − subtree net spend)`, where net spend already includes
  committed rows and nets credits. It spreads evenly through the project's
  effective end month; past the horizon it is reported as beyond-horizon, and
  a project with no future end is **unscheduled**.
- **Committed** `future` Expenses land in their own month; an overdue one lands
  in the current month, and one past the horizon is reported separately.
- **Scenarios**: up to 20 URL rows
  `{ label, date, amount, direction, recurrence: once | monthly, until? }`.
  Inflows exist only as scenarios; the page never claims to show real income.

## Calibration

The `spend_below_estimate` project attention rule flags a `done` project with
its own positive estimate, no estimated ancestor, and subtree spend below 10%
of the estimate. It means spend was recorded elsewhere or the estimate is
wrong, and never scales a forecast.

Transfer-pair acceptance and internal moves belong to the
[household contribution ledger](household-contribution-ledger.md).
