import type { expenseShortcode } from "@cubby/schemas/identifiers";
import * as schemas from "@cubby/schemas/project";
import {
  mutationOptions,
  queryOptions,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  type StartOperation,
  startOperation,
} from "~/integrations/tanstack-query/start-transport";
import { queryKeys } from "~/lib/query-keys";
import * as browser from "~/server/expense-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const chartTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.expenseFiltersSchema>)
  .handler(({ data, context }) =>
    browser.getExpenseChartDataForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const analyticsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.expenseFiltersSchema>)
  .handler(({ data, context }) =>
    browser.getExpenseAnalyticsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const monthlyTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.expenseFiltersSchema>)
  .handler(({ data, context }) =>
    browser.getExpenseMonthlySummaryForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const analyzeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.expenseAnalyzeInput>)
  .handler(({ data, context }) =>
    browser.analyzeExpensesForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const facetsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof schemas.expenseFacetCountsInput>,
  )
  .handler(({ data, context }) =>
    browser.getExpenseFacetCountsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const affinityTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getExpenseTradeAffinityForBrowser({
      request: context.startOperation,
    }),
  );
const chargeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof expenseShortcode>)
  .handler(({ data, context }) =>
    browser.getExpenseChargeContextForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const moveTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.expenseBulkMoveInput>)
  .handler(({ data, context }) =>
    browser.bulkMoveExpensesForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const tradeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.expenseBulkTradeInput>)
  .handler(({ data, context }) =>
    browser.bulkSetExpenseTradeForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const costTypeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof schemas.expenseBulkCostTypeInput>,
  )
  .handler(({ data, context }) =>
    browser.bulkSetExpenseCostTypeForBrowser({
      data,
      request: context.startOperation,
    }),
  );

const chartOperation = startOperation<
  z.input<typeof schemas.expenseFiltersSchema>,
  z.output<typeof schemas.expenseOut>[]
>({
  operation: "expense.chartData",
  transport: (data, o) => chartTransport({ data, ...o }),
  parse: (result) => z.array(schemas.expenseOut).parse(result),
});
const analyticsOperation = startOperation<
  z.input<typeof schemas.expenseFiltersSchema>,
  z.output<typeof schemas.expenseAnalyticsOut>
>({
  operation: "expense.analytics",
  transport: (data, o) => analyticsTransport({ data, ...o }),
  parse: (result) => schemas.expenseAnalyticsOut.parse(result),
});
const monthlyOperation = startOperation<
  z.input<typeof schemas.expenseFiltersSchema>,
  z.output<typeof schemas.expenseMonthlySummaryOut>
>({
  operation: "expense.monthlySummary",
  transport: (data, o) => monthlyTransport({ data, ...o }),
  parse: (result) => schemas.expenseMonthlySummaryOut.parse(result),
});
const analyzeOperation = startOperation<
  z.input<typeof schemas.expenseAnalyzeInput>,
  z.output<typeof schemas.expenseAnalyzeOut>
>({
  operation: "expense.analyze",
  transport: (data, o) => analyzeTransport({ data, ...o }),
  parse: (result) => schemas.expenseAnalyzeOut.parse(result),
});
const facetsOperation = startOperation<
  z.input<typeof schemas.expenseFacetCountsInput>,
  z.output<typeof schemas.expenseFacetCountsOut>
>({
  operation: "expense.facetCounts",
  transport: (data, o) => facetsTransport({ data, ...o }),
  parse: (result) => schemas.expenseFacetCountsOut.parse(result),
});
const affinityOperation = startOperation<
  undefined,
  z.output<typeof schemas.expenseTradeAffinityOut>[]
>({
  operation: "expense.tradeAffinity",
  transport: (_data, o) => affinityTransport(o),
  parse: (result) => z.array(schemas.expenseTradeAffinityOut).parse(result),
});
const chargeOperation = startOperation<
  z.input<typeof expenseShortcode>,
  z.output<typeof schemas.expenseChargeContextOut>
>({
  operation: "expense.chargeContext",
  transport: (data, o) => chargeTransport({ data, ...o }),
  parse: (result) => schemas.expenseChargeContextOut.parse(result),
});
const moveOperation = startOperation<
  z.input<typeof schemas.expenseBulkMoveInput>,
  z.output<typeof schemas.expenseBulkMutationOut>
>({
  operation: "expense.bulkMove",
  kind: "mutation",
  transport: (data, o) => moveTransport({ data, ...o }),
  parse: (result) => schemas.expenseBulkMutationOut.parse(result),
});
const tradeOperation = startOperation<
  z.input<typeof schemas.expenseBulkTradeInput>,
  z.output<typeof schemas.expenseBulkMutationOut>
>({
  operation: "expense.bulkSetTrade",
  kind: "mutation",
  transport: (data, o) => tradeTransport({ data, ...o }),
  parse: (result) => schemas.expenseBulkMutationOut.parse(result),
});
const costTypeOperation = startOperation<
  z.input<typeof schemas.expenseBulkCostTypeInput>,
  z.output<typeof schemas.expenseBulkMutationOut>
>({
  operation: "expense.bulkSetCostType",
  kind: "mutation",
  transport: (data, o) => costTypeTransport({ data, ...o }),
  parse: (result) => schemas.expenseBulkMutationOut.parse(result),
});

export const expenseChartDataQueryOptions = (
  input: z.input<typeof schemas.expenseFiltersSchema>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.expense.all, "chartData"], input] as const,
    queryFn: ({ signal }) => chartOperation.call(input, { signal }),
    meta: chartOperation.meta,
  });
export const expenseAnalyticsQueryOptions = (
  input: z.input<typeof schemas.expenseFiltersSchema>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.expense.all, "analytics"], input] as const,
    queryFn: ({ signal }) => analyticsOperation.call(input, { signal }),
    meta: analyticsOperation.meta,
  });
export const expenseMonthlySummaryQueryOptions = (
  input: z.input<typeof schemas.expenseFiltersSchema>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.expense.all, "monthlySummary"], input] as const,
    queryFn: ({ signal }) => monthlyOperation.call(input, { signal }),
    meta: monthlyOperation.meta,
  });
export const expenseAnalyzeQueryOptions = (
  input: z.input<typeof schemas.expenseAnalyzeInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.expense.all, "analyze"], input] as const,
    queryFn: ({ signal }) => analyzeOperation.call(input, { signal }),
    meta: analyzeOperation.meta,
  });
export const expenseFacetCountsQueryOptions = (
  input: z.input<typeof schemas.expenseFacetCountsInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.expense.all, "facetCounts"], input] as const,
    queryFn: ({ signal }) => facetsOperation.call(input, { signal }),
    meta: facetsOperation.meta,
  });
export const expenseTradeAffinityQueryOptions = () =>
  queryOptions({
    queryKey: [[...queryKeys.expense.all, "tradeAffinity"]] as const,
    queryFn: ({ signal }) => affinityOperation.call(undefined, { signal }),
    meta: affinityOperation.meta,
  });
export const expenseChargeContextQueryOptions = (
  input: z.input<typeof expenseShortcode>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.expense.all, "chargeContext"], input] as const,
    queryFn: ({ signal }) => chargeOperation.call(input, { signal }),
    meta: chargeOperation.meta,
  });

type MutationOverrides<I, O> = Omit<
  UseMutationOptions<O, Error, I, unknown>,
  "mutationFn" | "mutationKey"
>;
const mutation = <I, O>(
  operation: StartOperation<I, O>,
  key: string,
  options?: MutationOverrides<I, O>,
) =>
  mutationOptions({
    mutationKey: [...queryKeys.expense.all, key],
    mutationFn: async (input: I) => {
      const result = await operation.call(input);
      return result;
    },
    meta: operation.meta,
    ...options,
  });
export const expenseBulkMoveMutationOptions = (
  options?: MutationOverrides<
    z.input<typeof schemas.expenseBulkMoveInput>,
    z.output<typeof schemas.expenseBulkMutationOut>
  >,
) => mutation(moveOperation, "bulkMove", options);
export const expenseBulkSetTradeMutationOptions = (
  options?: MutationOverrides<
    z.input<typeof schemas.expenseBulkTradeInput>,
    z.output<typeof schemas.expenseBulkMutationOut>
  >,
) => mutation(tradeOperation, "bulkSetTrade", options);
export const expenseBulkSetCostTypeMutationOptions = (
  options?: MutationOverrides<
    z.input<typeof schemas.expenseBulkCostTypeInput>,
    z.output<typeof schemas.expenseBulkMutationOut>
  >,
) => mutation(costTypeOperation, "bulkSetCostType", options);
