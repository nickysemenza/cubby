# Household finance synthesis

Status: **proposed**. Design agreed 2026-09-22 after a review of the finance
ledger's current state and a grilling pass on scope. Nothing here is
implemented yet. Phase 1 needs no schema change; Phase 2 needs none either.

## 1. Summary

Cubby already records where household money went — line-level `Expense` rows,
project attribution, settlement evidence, and funders derived from account
ownership. What it cannot yet do is *synthesize* that record: slice spend by
product category, show how money flows from funder to project to category, or
project spend forward. This plan adds that read-side layer in two phases.

**Phase 1 — read-side foundations**

- Root product category as an expense analytics dimension, built on the
  existing tax/shipping allocator.
- A historical Sankey: funder → project bucket → root category.
- An estimate-accuracy diagnostic as a Problems detector.
- One-step acceptance of a suggested transfer pair, including same-owner pairs.
- Deep links from contribution-ledger gaps to the place they are fixed.

**Phase 2 — cash-flow projection**

- A `/cash-flow` page and matching MCP read: a monthly forward view built from
  a category run-rate baseline, live project envelopes, dated `future`
  expenses, and URL-state scenarios.

Neither phase adds a money-bearing table, stores a balance, or introduces a
time series. All spend figures remain `SUM(Expense.cost)`.

## 2. Why

Findings from the current dataset that shaped the design:

1. **The household/renovation split already exists** through the Household
   project and import-time triage, but analytics group only by cost type,
   effective trade, project, and vendor. "Food versus supplies versus
   electronics" inside household spend is not queryable, even though almost
   every product-linked line carries a category.
2. **Product category is now a tree** (`ProductCategory.parentId`, a dozen
   roots). The root level is the right grain for spend questions; children are
   drill-down.
3. **Tax and shipping are already allocated** across a purchase's principal
   lines by `expenseProjectAllocationSql`. Category analytics must reuse that
   allocator rather than add a second one.
4. **Estimates and actuals rarely meet.** Most completed projects that carry a
   `costEstimate` have subtree actuals well under a tenth of it; the spend was
   recorded elsewhere. A historical overrun factor computed today would be
   noise, so calibration ships as a diagnostic that finds the misattribution,
   never as a forecast multiplier.
5. **Forward dates are sparse.** Nearly every task due date is in the past,
   only a handful of expenses are marked `future`, and few projects carry an
   end date. A projection cannot rely on task-date phasing.
6. **Funding attribution has visible gaps** (expenses with no allocation path
   to a charge, and accounts with no owner). A flow diagram with an explicit
   Unknown-funder node makes that gap legible and shows it shrink.
7. **Transfer evidence has no one-step accept.** `suggest_financial_transfer_pairs`
   proposes candidates, but recording one takes separate writes, and transfers
   between two accounts with the same owner have no documented treatment.

## 3. Decision log

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | All five candidate items in one plan, two phases. Recurring-outflow detection is folded into the Phase 2 baseline method, not a separate feature. |
| 2 | What the projection answers | Household cash flow ("what will we spend per month"), with project burn as one component. |
| 3 | Calibration | Diagnostic only: a Problems detector plus an estimate/actual column. Never scales a forecast. |
| 4 | Category grain | Root category, drill-down to children. Explicit **Uncategorized** bucket so totals reconcile. |
| 5 | Category money basis | Landed cost: principal plus its allocated share of tax/shipping, via one allocator that carries both project and root category. |
| 6 | Receipt adjustments bucket | Only what the allocator cannot place: ancillary lines on a purchase with no principal line, or with no purchase. |
| 7 | Sankey | Historical, not forecast. Funder → project bucket → root category, on the expense analytics view, sharing the Ledger's filters. |
| 8 | Sankey negatives | Links use gross outflow; refunds/credits reported in a note beneath the chart. |
| 9 | Sankey node caps | Top 8 projects by flow, remainder grouped as "Other projects"; categories at root level plus Uncategorized and Receipt adjustments. |
| 10 | Multi-funder expenses | Split proportionally with the contribution ledger's weights. |
| 11 | Same-owner transfer pairs | Recorded as a normal `LedgerTransfer` with `fromPartyId = toPartyId` for completeness; reported separately as internal moves. |
| 12 | Unowned account in a pair | Refuse, naming the account; ownership must be set first. |
| 13 | Baseline method | Per root category, median of the trailing 12 complete months of landed non-project spend, carried forward flat. Empty months count as $0; categories active in fewer than 3 months fold into Uncategorized. |
| 14 | Envelope placement | Remaining = estimate − actual − committed. Spread evenly from the current month to the project's `endDate` when set and in the future; otherwise **unscheduled**. |
| 15 | Which projects count | `in_progress` by default; `not_started` behind a toggle defaulting off; `planning` only if it has an estimate. A project under an ancestor with an estimate is excluded. |
| 16 | Scenario storage | URL/page state only. Structural presets (horizon, toggles, category subset) are declared views in `view-manifest.ts`; scenario values never enter the repository. `AppSettings` is the upgrade path if URL-only proves annoying. |
| 17 | Scenario shape | `{ label, date, amount, direction: inflow \| outflow, recurrence: once \| monthly, until? }`. Inflows exist only as scenarios; the page never claims to show real income. |
| 18 | Surfaces | Category chart + filter and the Sankey on `expense-analytics-view.tsx`; projection on a new `/cash-flow` route; calibration on the Problems page. |
| 19 | MCP | `get_cash_flow_projection` (read), `accept_financial_transfer_pair` (mutation), category breakdown added to `get_expense_analytics`. Gap deep links are web-only. |
| 20 | Forward Sankey | **Rejected.** Forward figures are baseline, envelopes, and scenarios; a Sankey over them hides timing, which is the point of the page. |

## 4. Phase 1 — read-side foundations

### 4.1 Category key on the allocator

`expenseProjectAllocationSql` (`apps/web/src/server/repo/expense-project-allocation.ts`)
distributes ancillary cents across a purchase's live principal lines and emits
`(expenseId, projectId, attributedCents, basis)`. Extend each output row with
`rootCategoryId`: the root of the receiving principal line's
`Product.categoryId`, resolved through a recursive walk of
`ProductCategory.parentId`. A principal with no product, or a product with no
category, yields `null`, which consumers render as Uncategorized. Ancillary
rows the allocator cannot place keep a distinguishable basis so consumers can
render Receipt adjustments.

The weight CTE's rule stays intact: the denominator sees every live principal
in the purchase, and filters apply only to final rows. Category must not change
which principal receives a cent.

### 4.2 Category analytics and filter

- `expenseAnalytics` (`apps/web/src/server/repo/expense/analytics.ts`) gains a
  `byRootCategory` breakdown over the allocator rows, with children available
  for drill-down.
- The expense filter fields (`packages/schemas/src/project.ts`) gain
  `productCategoryId`, matching the selected node and its descendants. The
  analytics view already syncs its filters with the Ledger view, so a category
  click writes back to the Ledger.
- `expense-analytics-view.tsx` gets a root-category breakdown chart next to the
  trade and vendor charts.
- `get_expense_analytics` returns the same breakdown.

### 4.3 Historical Sankey

A new read, `expenseFlowSankey(filters)`, returns nodes and gross-outflow
links for the current Ledger filters:

1. **Funder**: each member party, the household party (joint accounts), and
   Unknown funder. Derived with the contribution ledger's allocation
   (`apps/web/src/server/repo/household-contribution/allocation.ts`), split by
   its weights.
2. **Project bucket**: the Household project, the top 8 other projects by flow,
   Other projects, and No project.
3. **Root category**: from 4.1, plus Uncategorized and Receipt adjustments.

Render with `@nivo/sankey` (same 0.99 line as the existing Nivo packages). A
link click applies the corresponding funder/project/category filters to the
Ledger. A note under the chart states the refund/credit total excluded from
links.

### 4.4 Estimate-accuracy detector

A Problems detector for completed projects whose estimate is far from their
recorded spend: `status = done`, `costEstimate > 0`, no ancestor with its own
estimate, and subtree actual below 10% of the estimate. Each finding links to
the project. It reuses `loadProjectSubtreeRollups`
(`apps/web/src/server/repo/project/subtree.ts`) so subtree semantics match the
budget strip. The finding means "spend was recorded elsewhere or the estimate
is wrong"; the detector does not guess which.

### 4.5 Accept a transfer pair

New repo mutation in `apps/web/src/server/repo/ledger-transfer.ts`, exposed as
`accept_financial_transfer_pair` and a web action on suggestion rows:

- Input: the outflow and inflow `FinancialTransaction` ids from a suggestion.
- Preconditions, each refused with the raw reason: opposite signs, equal
  absolute amounts, different accounts, both accounts owned, neither
  transaction already carrying `ledgerTransferId`.
- Effect, in one database transaction: create a `LedgerTransfer` from the
  outflow account's owner to the inflow account's owner, dated the earlier of
  the two transaction dates, then set `ledgerTransferId` on both transactions.
  The existing one-positive/one-negative evidence indexes enforce the pairing.

Same-owner pairs are accepted and produce a transfer with
`fromPartyId = toPartyId`.

### 4.6 Reporting same-owner transfers

`householdContributionLedger`
(`apps/web/src/server/repo/household-contribution/reports.ts`) excludes
`fromPartyId = toPartyId` rows from `transfersSent`/`transfersReceived` and
adds a per-party `internalTransfers { count, amount }`. Position is unaffected
either way (sent and received cancel), but excluding them keeps the sent and
received totals meaningful. `transferNet` and the reconciliation checks are
unchanged.

### 4.7 Gap deep links

On the household contribution page:

| Gap code | Link target |
|---|---|
| `missing_funders` | Financial-transactions list filtered to unallocated charges near the expense's date and amount |
| `funder_account_unowned` | The account's detail page, where the Owner picker lives |
| `beneficiary_assumed_household` | None — a status, not a worklist |

## 5. Phase 2 — cash-flow projection

### 5.1 Read model

`cashFlowProjection(input)` in a new `apps/web/src/server/repo/cash-flow.ts`.
Months are household-local (`householdLocalDate`).

Input:

- `horizonMonths`: 6, 12, or 24 (default 12)
- `includeNotStarted`: boolean (default false)
- `categoryIds`: optional root-category subset
- `scenarios`: up to 20 scenario rows (decision 17)

Output:

- `months[]`, each with `baseline` by root category, `envelopes` by project,
  `committed`, `scenarioOutflow`, `scenarioInflow`, and `net`
- `unscheduled[]`: project, estimate, subtree actual, committed, remaining,
  end date, and an estimate-accuracy flag from 4.4
- `totals`: horizon outflow, unscheduled total, beyond-horizon envelope
  remainder, net after scenarios

### 5.2 Baseline

Over the trailing 12 complete months (current partial month excluded), take
landed spend from allocator rows that are not attributed to any project other
than the Household project, and not `future`. Group by root category; each
category's monthly figure is the median of its 12 values, with empty months
counted as $0. A category active in fewer than 3 of the 12 months folds into
Uncategorized. Project spend is excluded from the baseline so envelopes are the
only forecast for project work.

### 5.3 Envelopes

For each counted project (decision 15), remaining =
`max(0, estimate − subtree actual − subtree committed)`. If `endDate` is after
the current month, spread remaining evenly from the current month through the
end month; months past the horizon go to the beyond-horizon total. If `endDate`
is missing or in the past, the project goes to `unscheduled`.

### 5.4 Committed rows

`future = true` expenses land in their own month. A committed row dated before
the current month lands in the current month, labelled overdue. Committed rows
are already subtracted from envelope remaining, so they are never counted twice.

### 5.5 Scenarios and presets

Scenario rows live in the URL as a compact, zod-validated search param. The
page edits them inline; bookmarking is how a scenario set is saved. Structural
presets — horizon, the not-started toggle, category subsets — are declared
views in `apps/web/src/entities/view-manifest.ts`. Scenario amounts and dates
are never committed to the repository.

### 5.6 Page

Route `/cash-flow`:

- Monthly stacked bars for the horizon: baseline by root category, scheduled
  envelopes, committed rows, outflow scenarios. Inflow scenarios render below
  the axis; a net line sits on top.
- Headline figures: horizon outflow, unscheduled total, net after scenarios.
- The unscheduled envelopes table beneath the chart.
- Every segment links to its source: a baseline category opens the Ledger
  filtered to that category and window; an envelope opens the project.

### 5.7 MCP

`get_cash_flow_projection` takes the same input as the page, scenarios
included, and returns the read model unchanged.

## 6. Invariants

- Spend remains `SUM(Expense.cost)`. The allocator redistributes ancillary
  cents among lines of the same purchase and never creates or drops money; the
  category breakdown, Sankey, and baseline all reconcile to the filtered net.
- No stored balance, projection, or scenario. Every Phase 2 figure is computed
  on read.
- Nothing here adds a time-series table or touches net worth; that remains
  gated on amending the trusted-household tenet.

## 7. Validation

Focused repo integration tests, each for a regression the type system cannot
catch:

- Allocator: the category key never changes which principal receives an
  ancillary cent; category totals reconcile to project totals for the same
  filters.
- Baseline: median with empty months counted as zero; the fewer-than-3-months
  fold; project spend excluded.
- Envelopes: subtree-estimate exclusion; even spread to `endDate`; the
  unscheduled and beyond-horizon remainders; committed rows not double-counted.
- Accept pair: a refused precondition persists nothing; partial evidence never
  persists; same-owner pairs are accepted.
- Ledger report: same-owner transfers are excluded from sent/received and
  appear in `internalTransfers`; positions are unchanged.
- Sankey: link totals reconcile to gross filtered outflow; multi-funder splits
  follow ledger weights.

No tests for chart rendering.

## 8. Documentation to change when code lands

- `README.md` capabilities: the Financial accounts section gains category
  analytics, the Sankey, transfer-pair acceptance, and the cash-flow page.
- `docs/todos.md`: remove the "Household cash-flow projection" entry once
  Phase 2 ships.

## 9. Later, enabled by this plan

- **Series detection.** Per-vendor or per-product recurrence (subscriptions,
  regular grocery runs) as a sharper baseline than a category median.
- **Calibration as a multiplier.** Once the detector's findings are worked down
  and completed projects carry real subtree actuals, an estimate-accuracy factor
  can scale envelopes.
- **Persisted scenarios** in `AppSettings`, if URL-only proves limiting.
- **Recorded income.** Unlinked `income` transactions would replace scenario
  inflows with real ones.
