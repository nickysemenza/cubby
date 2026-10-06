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

export const expenseContract = defineContract("expense", {
  chartData: query({
    mcp: { omit: "client_view" },
    input: schemas.expenseFiltersSchema,
    output: z.array(schemas.expenseOut),
  }),
  analytics: query({
    native: "Expense analytics",
    input: schemas.expenseFiltersSchema,
    output: schemas.expenseAnalyticsOut,
  }),
  // Home summaries are bounded, single-round-trip reads. Asking the freshness Durable Object first adds another network hop before these short queries.
  monthlySummary: query({
    mcp: { omit: "client_view" },
    readPolicy: "strong",
    input: schemas.expenseFiltersSchema,
    output: schemas.expenseMonthlySummaryOut,
  }),
  analyze: query({
    mcp: {
      omit: "agent_twin",
      twin: "expense.analytics",
      note: "The aggregate explorer's pivot; project_overview.expense_analytics serves agent aggregates",
    },
    input: schemas.expenseAnalyzeInput,
    output: schemas.expenseAnalyzeOut,
  }),
  facetCounts: query({
    mcp: { omit: "client_view" },
    input: schemas.expenseFacetCountsInput,
    output: schemas.expenseFacetCountsOut,
  }),
  tradeAffinity: query({
    mcp: { omit: "client_view" },
    input: z.undefined(),
    output: z.array(schemas.expenseTradeAffinityOut),
  }),
  chargeContext: query({
    mcp: { omit: "client_view" },
    input: expenseShortcode,
    output: schemas.expenseChargeContextOut,
  }),
  inventoryOwnershipContext: query({
    mcp: { omit: "client_view" },
    input: expenseInventoryOwnershipContextInput,
    output: expenseInventoryOwnershipContextOut,
  }),
  /** Beneficiaries/funders last used with a vendor, for prefilling the create form. */
  vendorAttributionDefaults: query({
    mcp: { omit: "client_view", note: "Create-form prefill" },
    input: vendorAttributionDefaultsInput,
    output: vendorAttributionDefaultsOut,
  }),
  confirmInventoryBeneficiary: mutation({
    mcp: {
      omit: "human_approval",
      note: "A person confirms the inherited beneficiary",
    },
    input: confirmInventoryExpenseBeneficiaryInput,
    output: confirmInventoryExpenseBeneficiaryOut,
    invalidates: ["expense"],
  }),
  /** Rank ledger rows against vendor-export lines; ranks, never verifies or writes. */
  match: query({
    http: false,
    input: schemas.expenseMatchInput,
    output: schemas.expenseMatchOut,
    cache: { tags: [] },
  }),
});
