import { expenseShortcode } from "@cubby/schemas/identifiers";
import {
  confirmInventoryExpenseBeneficiaryInput,
  confirmInventoryExpenseBeneficiaryOut,
  expenseInventoryOwnershipContextInput,
  expenseInventoryOwnershipContextOut,
  vendorAttributionDefaultsInput,
  vendorAttributionDefaultsOut,
} from "@cubby/schemas/inventory-ownership";
import * as schemas from "@cubby/schemas/project";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const expenseContract = defineContract(
  "expense",
  {
    chartData: query({
      input: schemas.expenseFiltersSchema,
      output: z.array(schemas.expenseOut),
    }),
    analytics: query({
      exposure: "capability",
      description:
        "Spend aggregates over the expense ledger under the same filters as entity_read.list(expense) (lineKind/costType/trade/projectId/includeSubProjects/future/search/notesSearch/urlSearch/dateFrom/dateTo/costMin/costMax/costPresenceFilter/projectPresenceFilter/vendorId/orderId). Returns summary, byCostType/byTrade/trade x costType, monthly, cumulative, byProject, and byVendor totals over all line kinds. Tax, shipping, and fee lines count under the trade and cost type of the items they were charged on (or their own typed trade); a share with no item to follow reports under trade null. Unfiltered, summary.net = sum(Expense.cost) = sum(byTrade.net) = sum(byCostType.net). A projectId, trade, or costType filter scopes totals to the matching allocation shares, so a split tax line contributes only its matching share here while the ledger lists the whole line. Credits are real (refunds and price adjustments) — net = actual + committed − credits, and cost bounds are signed, so costMax: 0 is the credits-only window. byProject and byVendor are INNER joins and deliberately do NOT sum to summary.net: byProject drops expenses with no project, byVendor rows with no purchase. Read each gap as the size of that unattributed tail, not as a bug.",
      native: "Expense analytics",
      input: schemas.expenseFiltersSchema,
      output: schemas.expenseAnalyticsOut,
    }),
    // The ledger totals strip needs only `analytics.summary`; the full read also
    // runs the eight breakdowns over the same allocation.
    spendSummary: query({
      input: schemas.expenseFiltersSchema,
      output: schemas.expenseAnalyticsSummary,
    }),
    // Home summaries are bounded, single-round-trip reads. Asking the freshness Durable Object first adds another network hop before these short queries.
    monthlySummary: query({
      readPolicy: "strong",
      input: schemas.expenseFiltersSchema,
      output: schemas.expenseMonthlySummaryOut,
    }),
    analyze: query({
      exposure: "capability",
      description:
        'Complete server-side pivot of the expense ledger: `filters` takes the same fields as entity_read.list(expense); `rowDimension` is spendingCategory, trade, costType, month, project, or vendor, with an optional different `columnDimension` (spendingCategory, trade, costType, month). Money is allocation shares: tax, shipping, and fees follow the items they were charged on, and filters never change which item receives an adjustment cent. `spendingCategoryRollup: "root"` buckets a spendingCategory axis by root Spending Category plus `uncategorized` (no category resolved) and `unclassified` (receipt role unresolved), so its buckets reconcile to totals.scope; otherwise rows without a live category fall into reconciliation.tail. `comparison: "previousPeriod"` (needs dateFrom and dateTo, no month axis) adds the immediately preceding equal-length window. Each bucket carries `filter`, the Ledger URL params that select its rows. Returns `status: "too_large"` instead of a grid past 200 rows, 24 month columns, or 1,000 cells. Credits are signed: net = actual + committed − credits.',
      input: schemas.expenseAnalyzeInput,
      output: schemas.expenseAnalyzeOut,
    }),
    flowSankey: query({
      input: schemas.expenseFiltersSchema,
      output: schemas.expenseFlowSankeyOut,
      // Funders come from the contribution ledger (account owners, transfers).
      cache: { tags: [["expense"], ["householdContribution"]] },
    }),
    facetCounts: query({
      input: schemas.expenseFacetCountsInput,
      output: schemas.expenseFacetCountsOut,
    }),
    tradeAffinity: query({
      input: z.undefined(),
      output: z.array(schemas.expenseTradeAffinityOut),
    }),
    chargeContext: query({
      input: expenseShortcode,
      output: schemas.expenseChargeContextOut,
    }),
    inventoryOwnershipContext: query({
      exposure: "capability",
      description:
        "An inventory entry's inherited owner and beneficiary evidence with its evidenceFingerprint, for inventory.confirm_ownership and expenses.confirm_inventory_beneficiary.",
      input: expenseInventoryOwnershipContextInput,
      output: expenseInventoryOwnershipContextOut,
    }),
    /** Beneficiaries/funders last used with a vendor, for prefilling the create form. */
    vendorAttributionDefaults: query({
      note: "Create-form prefill",
      input: vendorAttributionDefaultsInput,
      output: vendorAttributionDefaultsOut,
    }),
    confirmInventoryBeneficiary: mutation({
      exposure: "capability",
      description:
        "Confirm an Expense's beneficiary inherited from an inventory entry, using the evidenceFingerprint its ownership context returned.",
      input: confirmInventoryExpenseBeneficiaryInput,
      output: confirmInventoryExpenseBeneficiaryOut,
      invalidates: ["expense"],
    }),
    /** Rank ledger rows against vendor-export lines; ranks, never verifies or writes. */
    match: query({
      exposure: "capability",
      description:
        "Rank existing ledger rows as candidate matches for lines of a vendor export (an Amazon takeout row, an eBay OrdersReport line, a receipt). Pass up to 200 rows, each with your own `key` plus `date` and a SIGNED `amount`, optionally `label`, `orderId` and `vendor`. Returns, per key, up to `maxCandidatesPerRow` candidates carrying expenseId/name/cost/date/vendorName/orderId/projectName/productName plus the evidence to judge them: `matchedOn` (order_id | amount_date), `dayDelta`, `amountDelta`, `ratio`, `ratioLabel` and `tokenOverlap`; also `unmatched` keys and a summary. " +
        "It RANKS candidates, it does not VERIFY them, and it never writes. Run it BEFORE proposing any new expense, and again over each row you did create (same amount, ±30 days) to catch what slipped through; confirm every match with the user before entity.update(expense) or entity.create(expense). " +
        "Read `tokenOverlap` as a hint and NOTHING more: zero overlap is routine on TRUE matches because this ledger names the THING, not the product (a Festool vacuum is booked as `dust extractor`), and tokenizers miss compound words (`labelmaker` vs 'label maker'). High overlap on a coincidental amount is not evidence either. " +
        "**Below about $20, READ the line descriptions before accepting anything** — small amounts are inside any usable band by construction. Genuine matches cluster at `dayDelta` 0–1; candidates scattered across a ±14d window are usually coincidences. " +
        "`ratioLabel` classifies cost/amount against `taxRate` as exact | plus_tax | pre_tax | other; it LABELS, it does not match. Read the raw `amountDelta` on an `other` — a residual of exactly 9.99 or 12.50 is shipping. " +
        "**Always pass `orderId` when the export line has one — and `vendor` with it.** An order id is only unique WITHIN a vendor. Each candidate reports `vendorMatch`: true (agrees), false (CONFLICTS — almost certainly the wrong row; demoted below every amount+date candidate but still returned), or null (unknown). The order-id arm catches both directions of the aggregate problem — a ledger row may AGGREGATE several export lines, or hold the SPLIT while you search for the total — and ignores the day window on purpose. " +
        "An empty `candidates` list means 'nothing within the window', NOT 'this expense is missing'. Rows with no cost or no date are outside every amount window. Planned (`future: true`) rows are included and flagged. When one ledger row is the best candidate for two export lines it is returned for both — resolve that yourself.",
      input: schemas.expenseMatchInput,
      output: schemas.expenseMatchOut,
      cache: { tags: [] },
    }),
  },
  { exposure: "view", mcpToolGroup: "expenses" },
);
