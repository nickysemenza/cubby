import { expenseShortcode } from "@cubby/schemas/identifiers";
import {
  confirmInventoryExpenseBeneficiaryInput,
  confirmInventoryExpenseBeneficiaryOut,
  expenseInventoryOwnershipContextInput,
  expenseInventoryOwnershipContextOut,
} from "@cubby/schemas/inventory-ownership";
import * as schemas from "@cubby/schemas/project";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const expenseContract = defineContract("expense", {
  chartData: query({
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
    readPolicy: "strong",
    input: schemas.expenseFiltersSchema,
    output: schemas.expenseMonthlySummaryOut,
  }),
  analyze: query({
    input: schemas.expenseAnalyzeInput,
    output: schemas.expenseAnalyzeOut,
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
    input: expenseInventoryOwnershipContextInput,
    output: expenseInventoryOwnershipContextOut,
  }),
  confirmInventoryBeneficiary: mutation({
    input: confirmInventoryExpenseBeneficiaryInput,
    output: confirmInventoryExpenseBeneficiaryOut,
    invalidates: ["expense"],
  }),
});
