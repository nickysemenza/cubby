# Household finance synthesis

Status: **in progress** under
[#2347](https://github.com/nickysemenza/cubby/issues/2347). Refreshed
2026-10-17 onto Spending Category after a second grilling pass. No schema
change or migration is needed.

## 1. Summary

Cubby records where household money went at line level: `Expense` rows,
project attribution, settlement evidence, and funders derived from account
ownership. A bank or aggregator feed sees a mixed retailer order as one charge;
Cubby splits it into food, renovation, supplies and so on. This plan turns that
record into answers:

- Where did money go, by Spending Category and by project?
- Who paid for it?
- What will we spend per month going forward?

Delivered already (#1443 and follow-ups): the `SpendingCategory` tree, the
joint tax/shipping allocator that carries both project and Spending Category
(`expenseJointAllocationSql`), the `spendingCategoryId` filter with
`includeSubSpendingCategories`, and the `expense.analyze` pivot.

Remaining, in one PR:

1. A root-level Spending Category breakdown on the expense analytics view, read
   through `expense.analyze`, which becomes an MCP read.
2. A `spend_below_estimate` project attention rule.
3. One-step acceptance of a suggested transfer pair, with same-owner pairs
   reported as internal moves.
4. A historical Sankey: funder → project bucket → Spending Category.
5. A `/cash-flow` page and `finance_read.cash_flow` MCP read.

All spend figures remain `SUM(Expense.cost)`. Nothing adds a money-bearing
table, stores a balance, or introduces a time series.

## 2. Decision log

| #   | Decision                  | Choice                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Category taxonomy         | Spending Category, not Product Category. Views over `Expense` show only categories with Expense rows, so transaction-only categories need no flag.                                                                                                                                                                  |
| 2   | Category grain            | Root Spending Category everywhere; children are reached through Ledger filters with subcategories included.                                                                                                                                                                                                         |
| 3   | Unresolved buckets        | **Uncategorized**: no category resolved (null `spendingCategoryId`, including a Purchase with no principal line). **Unclassified**: receipt role unresolved (`lineKind = unclassified`). No other bucket.                                                                                                           |
| 4   | Breakdown read            | `expense.analyze` with a root roll-up option on the `spendingCategory` dimension, not a second breakdown on `expenseAnalytics`. `expense.analyze` leaves `deferred_capability` and becomes the MCP read `spending_classification_read.analyze` (it exceeds `project_overview`'s schema budget).                     |
| 5   | Cost type label           | The existing cost-type donut is titled **Spending by Cost Type**; the new section is **Spending by Spending Category**.                                                                                                                                                                                             |
| 6   | Calibration               | A project attention rule `spend_below_estimate`: `done`, `costEstimate > 0`, no ancestor with its own estimate, subtree spend below 10% of the estimate. Diagnostic only; it never scales a forecast.                                                                                                               |
| 7   | Transfer-pair accept      | A kernel command exposed as `finance.accept_transfer_pair` and an Accept action on suggestion rows (transfer-pair read and work queue).                                                                                                                                                                             |
| 8   | Same-owner pairs          | Recorded as a `LedgerTransfer` with `fromPartyId = toPartyId`: an **internal move**. The contribution ledger reports internal moves apart from transfers sent and received.                                                                                                                                         |
| 9   | Unowned account in a pair | Refuse, naming the account; ownership must be set first.                                                                                                                                                                                                                                                            |
| 10  | Sankey basis              | Net per funder → project → category path, Credits included. Paths that net to zero or below are omitted from links and listed under the chart.                                                                                                                                                                      |
| 11  | Sankey caps               | Top 8 projects and top 8 categories by flow; the rest are grouped as Other projects / Other categories. No project and Uncategorized/Unclassified stay distinct nodes.                                                                                                                                              |
| 12  | Multi-funder expenses     | Split by the contribution ledger's funder weights; Unknown funder is an explicit node.                                                                                                                                                                                                                              |
| 13  | Baseline                  | Per root category, median of the trailing 12 complete months of landed spend not attributed to a project other than the Household project, excluding `future`; empty months count as $0. Carried forward flat.                                                                                                      |
| 14  | Irregular categories      | A category with spend in fewer than 3 of the 12 months is **Irregular** and carries its mean (whole-cent trailing total ÷ 12), since its median is almost always $0. `irregular=grouped\|separate` (default grouped) shows them as one row or their own rows; both sum the same figures, so they reconcile exactly. |
| 15  | Envelopes                 | Remaining = `max(0, estimate − subtree net spend)` (`spent`: actual + committed − credits), spread evenly from the current month to a future `endDate`; otherwise **unscheduled**.                                                                                                                                  |
| 16  | Which projects count      | `in_progress` by default; `not_started` behind a toggle defaulting off; `planning` only with an estimate. A project under an ancestor with an estimate is excluded.                                                                                                                                                 |
| 17  | Scenarios                 | URL state only, `{ label, date, amount, direction: inflow \| outflow, recurrence: once \| monthly, until? }`, up to 20. Inflows exist only as scenarios. Structural presets are declared views.                                                                                                                     |
| 18  | Forward Sankey            | Rejected: a Sankey over forecast figures hides timing, which is the point of the page.                                                                                                                                                                                                                              |
| 19  | Gap deep links            | Dropped. The household page already links each gap to its expense; no bulk-fix need exists.                                                                                                                                                                                                                         |
| 20  | Sankey renderer           | `@nivo/sankey` at the installed Nivo version, as a specialized renderer inside `Visualization`, lazy-loaded.                                                                                                                                                                                                        |

## 3. Category breakdown

`expenseAnalyzeInput` gains an option that rolls the `spendingCategory` row or
column dimension up to root categories through `hierarchyDescendantsSql`.
Uncategorized and Unclassified are distinct buckets, and the buckets reconcile
to the filtered net. The weight rule stays intact: filters apply to final
allocation rows and never change which principal receives an ancillary cent.

`expense-analytics-view.tsx` adds **Spending by Spending Category** with
`RankedBarBreakdown`. A bar click opens the Ledger filtered to that category
with subcategories included.

## 4. Attention rule

`spend_below_estimate` joins `stalled`, `missing_budget`, and
`blocked_no_next_action` in `apps/web/src/server/domains/project/repo/attention.ts`,
reusing `loadProjectSubtreeRollups` so subtree semantics match the budget
strip. The finding means "spend was recorded elsewhere or the estimate is
wrong"; it does not guess which.

## 5. Transfer pairs

`finance.accept_transfer_pair` takes the outflow and inflow
`FinancialTransaction` ids from a suggestion. Preconditions, each refused as
data with the raw reason: opposite signs, equal absolute amounts, different
accounts, both accounts owned, neither transaction already carrying
`ledgerTransferId`. In one database transaction it creates a `LedgerTransfer`
from the outflow account's owner to the inflow account's owner, dated the
earlier transaction date, then sets `ledgerTransferId` on both transactions.

`householdContributionLedger` excludes internal moves from
`transfersSent`/`transfersReceived` and reports a per-party
`internalMoves { count, amount }`. Positions are unchanged.

## 6. Sankey

`expenseFlowSankey(filters)` returns nodes and net links for the analytics
filters: funder (member parties, household, Unknown funder, split by
contribution-ledger weights) → project bucket (Household, top 8, Other
projects, No project) → root Spending Category (top 8, Other categories,
Uncategorized, Unclassified). Non-positive paths are returned separately and
listed under the chart. A link click applies its project and category filters
to the Ledger. Funder links are not filterable: the Ledger's party filter
matches explicit attribution rows, not account-derived funders.

## 7. Cash-flow projection

`cashFlowProjection(input)` lives under
`apps/web/src/server/domains/cash-flow/`. Months are household-local.

Input: `horizonMonths` (6, 12, 24; default 12), `includeNotStarted` (default
false), `irregular` (`grouped` default), optional root `categoryIds`, and up to
20 scenarios.

Output: `months[]` with baseline by category, envelopes by project, committed,
scenario outflow and inflow, and net; `unscheduled[]` with each project's
estimate, actual, committed, remaining, and end date; `totals` with horizon outflow, unscheduled total,
beyond-horizon envelope remainder, and net after scenarios.

Baseline months are the 12 complete household months before the current one.
A share counts when it has no live project or sits on the standing Household
project (its own rows only). Root `categoryIds` narrow the
baseline only and refuse a non-root code. Each figure is rounded to a whole
cent per category, and the Irregular row is the sum of those cents.

Envelopes exclude the Household project and need a positive own estimate. An
envelope's end date is the project's effective end (explicit `endDate`, else
the derived content end); a date after today spreads the remainder evenly from
the current month through its month, extra cents first; months past the horizon
become `beyondHorizon`.

Committed `future` expenses land in their own month; one dated before the
current month lands in the current month as overdue, and one past the horizon
is reported as `committedBeyondHorizon`. Envelope remaining subtracts the
subtree's net spend, which already includes committed rows and nets credits, so
nothing is counted twice and a refund restores the envelope. Scenarios outside the
horizon are ignored; a monthly one starting earlier begins in the current month.

The `/cash-flow` route sits in the Finance domain: monthly stacked bars
(baseline, envelopes, committed, outflow scenarios; inflow scenarios below the
axis; a net line), headline totals, an unscheduled table, inline scenario
editing, and links from each segment to its source.
Structural presets are not declared views: the view manifest declares only
entity list views, so `/cash-flow` keeps its presets in URL state.

## 8. Invariants

- Spend remains `SUM(Expense.cost)`; breakdown, Sankey, and baseline reconcile
  to the filtered net (the Sankey after its listed non-positive paths).
- No stored balance, projection, or scenario; every figure is computed on read.
- No time-series table or net worth; that stays gated on amending the
  trusted-household tenet.

## 9. Validation

Focused integration tests for failures the type system cannot catch:

- Root roll-up reconciles to the filtered net, with distinct Uncategorized and
  Unclassified buckets, and never changes ancillary placement.
- Attention: the rule fires on the subtree threshold and respects the
  estimated-ancestor exclusion.
- Accept pair: each refused precondition persists nothing; a same-owner pair
  becomes an internal move; the ledger excludes it from sent/received with
  positions unchanged.
- Sankey: link totals plus listed non-positive paths reconcile to the filtered
  net; multi-funder splits follow ledger weights.
- Cash flow: median with empty months as zero; the Irregular rule in both
  modes; project spend excluded; envelope spread, unscheduled and beyond-horizon
  remainders; committed rows not double-counted.

No tests for chart rendering.

## 10. Later

- **Series detection**: per-vendor or per-product recurrence as a sharper
  baseline than a category median.
- **Calibration as a multiplier** once `spend_below_estimate` findings are
  worked down.
- **Persisted scenarios** in `AppSettings` if URL-only proves limiting.
- **Recorded income** replacing scenario inflows.
