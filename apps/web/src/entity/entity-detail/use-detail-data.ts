import type {
  DetailActivityInput,
  MonthlyExpenseSpendInput,
} from "@cubby/schemas/entity-detail-data";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { entityGraph } from "~/integrations/tanstack-query/generated/catalog/entityGraph.gen";

/** Call only when a chart entry in entitySummary[entity].detail.summary is declared. */
export function useMonthlyExpenseSpend(
  input: MonthlyExpenseSpendInput,
  enabled = true,
) {
  return useQuery({
    ...entityGraph.monthlyExpenseSpend.queryOptions(input),
    enabled,
  });
}

export function useDetailActivity(input: DetailActivityInput, enabled = true) {
  return useInfiniteQuery({
    ...cursorQueryOptions(entityGraph.detailActivity, input),
    enabled,
  });
}
