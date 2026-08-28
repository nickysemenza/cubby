import { expenseShortcode } from "@cubby/schemas/identifiers";
import * as schemas from "@cubby/schemas/project";
import { z } from "zod";

import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const expense = defineOperationDomain("expense", {
  chartData: query({
    input: schemas.expenseFiltersSchema,
    output: z.array(schemas.expenseOut),
    tags: [["expense", "chartData"]],
  }),
  analytics: query({
    input: schemas.expenseFiltersSchema,
    output: schemas.expenseAnalyticsOut,
    tags: [["expense", "analytics"]],
  }),
  monthlySummary: query({
    input: schemas.expenseFiltersSchema,
    output: schemas.expenseMonthlySummaryOut,
    tags: [["expense", "monthlySummary"]],
  }),
  analyze: query({
    input: schemas.expenseAnalyzeInput,
    output: schemas.expenseAnalyzeOut,
    tags: [["expense", "analyze"]],
  }),
  facetCounts: query({
    input: schemas.expenseFacetCountsInput,
    output: schemas.expenseFacetCountsOut,
    tags: [["expense", "facetCounts"]],
  }),
  tradeAffinity: query({
    input: z.undefined(),
    output: z.array(schemas.expenseTradeAffinityOut),
    tags: [["expense", "tradeAffinity"]],
  }),
  chargeContext: query({
    input: expenseShortcode,
    output: schemas.expenseChargeContextOut,
    tags: [["expense", "chargeContext"]],
  }),
});
