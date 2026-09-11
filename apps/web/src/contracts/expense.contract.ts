import { expenseShortcode } from "@cubby/schemas/identifiers";
import * as schemas from "@cubby/schemas/project";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

export const expenseContract = defineContract("expense", {
  chartData: query({
    input: schemas.expenseFiltersSchema,
    output: z.array(schemas.expenseOut),
  }),
  analytics: query({
    input: schemas.expenseFiltersSchema,
    output: schemas.expenseAnalyticsOut,
  }),
  monthlySummary: query({
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
});
