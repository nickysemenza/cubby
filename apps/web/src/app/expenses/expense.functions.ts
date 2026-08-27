import { expenseShortcode } from "@cubby/schemas/identifiers";
import * as schemas from "@cubby/schemas/project";
import { z } from "zod";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const expense = defineOperationDomain("expense", {
  chartData: query({
    input: schemas.expenseFiltersSchema,
    output: z.array(schemas.expenseOut),
    tags: [["expense"], ["expense", "chartData"]],
  }),
  analytics: query({
    input: schemas.expenseFiltersSchema,
    output: schemas.expenseAnalyticsOut,
    tags: [["expense"], ["expense", "analytics"]],
  }),
  monthlySummary: query({
    input: schemas.expenseFiltersSchema,
    output: schemas.expenseMonthlySummaryOut,
    tags: [["expense"], ["expense", "monthlySummary"]],
  }),
  analyze: query({
    input: schemas.expenseAnalyzeInput,
    output: schemas.expenseAnalyzeOut,
    tags: [["expense"], ["expense", "analyze"]],
  }),
  facetCounts: query({
    input: schemas.expenseFacetCountsInput,
    output: schemas.expenseFacetCountsOut,
    tags: [["expense"], ["expense", "facetCounts"]],
  }),
  tradeAffinity: query({
    input: z.undefined(),
    output: z.array(schemas.expenseTradeAffinityOut),
    tags: [["expense"], ["expense", "tradeAffinity"]],
  }),
  chargeContext: query({
    input: expenseShortcode,
    output: schemas.expenseChargeContextOut,
    tags: [["expense"], ["expense", "chargeContext"]],
  }),
  bulkMove: mutation({
    input: schemas.expenseBulkMoveInput,
    output: schemas.expenseBulkMutationOut,
    invalidates: ripple.expense,
  }),
  bulkSetTrade: mutation({
    input: schemas.expenseBulkTradeInput,
    output: schemas.expenseBulkMutationOut,
    invalidates: ripple.expense,
  }),
  bulkSetCostType: mutation({
    input: schemas.expenseBulkCostTypeInput,
    output: schemas.expenseBulkMutationOut,
    invalidates: ripple.expense,
  }),
});
