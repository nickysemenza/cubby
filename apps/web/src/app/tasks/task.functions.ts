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
import { markFreshReads } from "~/lib/fresh-read-marker";
import { queryKeys } from "~/lib/query-keys";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import * as browser from "~/server/task-browser.server";

const actionableTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof schemas.taskFiltersSchema> | undefined,
  )
  .handler(({ data, context }) =>
    browser.listActionableTasksForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const chartTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.taskFiltersSchema>)
  .handler(({ data, context }) =>
    browser.getTaskChartDataForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const summaryTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getTaskSummaryForBrowser({ request: context.startOperation }),
  );
const boardTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.taskFiltersSchema>)
  .handler(({ data, context }) =>
    browser.getTaskBoardForBrowser({ data, request: context.startOperation }),
  );
const timelineTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.taskFiltersSchema>)
  .handler(({ data, context }) =>
    browser.getTaskTimelineForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const moveTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.taskBulkMoveInput>)
  .handler(({ data, context }) =>
    browser.bulkMoveTasksForBrowser({ data, request: context.startOperation }),
  );
const statusTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.taskBulkStatusInput>)
  .handler(({ data, context }) =>
    browser.bulkSetTaskStatusForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const tradeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.taskBulkTradeInput>)
  .handler(({ data, context }) =>
    browser.bulkSetTaskTradeForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const dueDateTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.taskBulkDueDateInput>)
  .handler(({ data, context }) =>
    browser.bulkSetTaskDueDateForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const reorderTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.taskBulkReorderInput>)
  .handler(({ data, context }) =>
    browser.bulkReorderTasksForBrowser({
      data,
      request: context.startOperation,
    }),
  );

const actionableOperation = startOperation<
  z.input<typeof schemas.taskFiltersSchema> | undefined,
  z.output<typeof schemas.actionableTasksOut>
>({
  operation: "task.listActionable",
  transport: (data, o) => actionableTransport({ data, ...o }),
  parse: (result) => schemas.actionableTasksOut.parse(result),
});
const chartOperation = startOperation<
  z.input<typeof schemas.taskFiltersSchema>,
  z.output<typeof schemas.taskOut>[]
>({
  operation: "task.chartData",
  transport: (data, o) => chartTransport({ data, ...o }),
  parse: (result) => z.array(schemas.taskOut).parse(result),
});
const summaryOperation = startOperation<
  undefined,
  z.output<typeof schemas.taskSummaryOut>
>({
  operation: "task.summary",
  transport: (_data, o) => summaryTransport(o),
  parse: (result) => schemas.taskSummaryOut.parse(result),
});
const boardOperation = startOperation<
  z.input<typeof schemas.taskFiltersSchema>,
  z.output<typeof schemas.taskBoardOut>
>({
  operation: "task.board",
  transport: (data, o) => boardTransport({ data, ...o }),
  parse: (result) => schemas.taskBoardOut.parse(result),
});
const timelineOperation = startOperation<
  z.input<typeof schemas.taskFiltersSchema>,
  z.output<typeof schemas.taskTimelineOut>
>({
  operation: "task.timeline",
  transport: (data, o) => timelineTransport({ data, ...o }),
  parse: (result) => schemas.taskTimelineOut.parse(result),
});

const moveOperation = startOperation<
  z.input<typeof schemas.taskBulkMoveInput>,
  z.output<typeof schemas.taskBulkMutationOut>
>({
  operation: "task.bulkMove",
  kind: "mutation",
  transport: (data, o) => moveTransport({ data, ...o }),
  parse: (result) => schemas.taskBulkMutationOut.parse(result),
});
const statusOperation = startOperation<
  z.input<typeof schemas.taskBulkStatusInput>,
  z.output<typeof schemas.taskBulkMutationOut>
>({
  operation: "task.bulkSetStatus",
  kind: "mutation",
  transport: (data, o) => statusTransport({ data, ...o }),
  parse: (result) => schemas.taskBulkMutationOut.parse(result),
});
const tradeOperation = startOperation<
  z.input<typeof schemas.taskBulkTradeInput>,
  z.output<typeof schemas.taskBulkMutationOut>
>({
  operation: "task.bulkSetTrade",
  kind: "mutation",
  transport: (data, o) => tradeTransport({ data, ...o }),
  parse: (result) => schemas.taskBulkMutationOut.parse(result),
});
const dueDateOperation = startOperation<
  z.input<typeof schemas.taskBulkDueDateInput>,
  z.output<typeof schemas.taskBulkMutationOut>
>({
  operation: "task.bulkSetDueDate",
  kind: "mutation",
  transport: (data, o) => dueDateTransport({ data, ...o }),
  parse: (result) => schemas.taskBulkMutationOut.parse(result),
});
const reorderOperation = startOperation<
  z.input<typeof schemas.taskBulkReorderInput>,
  z.output<typeof schemas.taskBulkMutationOut>
>({
  operation: "task.bulkReorder",
  kind: "mutation",
  transport: (data, o) => reorderTransport({ data, ...o }),
  parse: (result) => schemas.taskBulkMutationOut.parse(result),
});

export const taskListActionableQueryOptions = (
  input: z.input<typeof schemas.taskFiltersSchema> | undefined,
) =>
  queryOptions({
    queryKey: [[...queryKeys.task.all, "listActionable"], input] as const,
    queryFn: ({ signal }) => actionableOperation.call(input, { signal }),
    meta: actionableOperation.meta,
  });
export const taskChartDataQueryOptions = (
  input: z.input<typeof schemas.taskFiltersSchema>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.task.all, "chartData"], input] as const,
    queryFn: ({ signal }) => chartOperation.call(input, { signal }),
    meta: chartOperation.meta,
  });
export const taskSummaryQueryOptions = () =>
  queryOptions({
    queryKey: [[...queryKeys.task.all, "summary"]] as const,
    queryFn: ({ signal }) => summaryOperation.call(undefined, { signal }),
    meta: summaryOperation.meta,
  });
export const taskBoardQueryOptions = (
  input: z.input<typeof schemas.taskFiltersSchema>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.task.all, "board"], input] as const,
    queryFn: ({ signal }) => boardOperation.call(input, { signal }),
    meta: boardOperation.meta,
  });
export const taskTimelineQueryOptions = (
  input: z.input<typeof schemas.taskFiltersSchema>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.task.all, "timeline"], input] as const,
    queryFn: ({ signal }) => timelineOperation.call(input, { signal }),
    meta: timelineOperation.meta,
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
    mutationKey: [...queryKeys.task.all, key],
    mutationFn: async (input: I) => {
      const result = await operation.call(input);
      markFreshReads();
      return result;
    },
    meta: operation.meta,
    ...options,
  });
export const taskBulkMoveMutationOptions = (
  options?: MutationOverrides<
    z.input<typeof schemas.taskBulkMoveInput>,
    z.output<typeof schemas.taskBulkMutationOut>
  >,
) => mutation(moveOperation, "bulkMove", options);
export const taskBulkSetStatusMutationOptions = (
  options?: MutationOverrides<
    z.input<typeof schemas.taskBulkStatusInput>,
    z.output<typeof schemas.taskBulkMutationOut>
  >,
) => mutation(statusOperation, "bulkSetStatus", options);
export const taskBulkSetTradeMutationOptions = (
  options?: MutationOverrides<
    z.input<typeof schemas.taskBulkTradeInput>,
    z.output<typeof schemas.taskBulkMutationOut>
  >,
) => mutation(tradeOperation, "bulkSetTrade", options);
export const taskBulkSetDueDateMutationOptions = (
  options?: MutationOverrides<
    z.input<typeof schemas.taskBulkDueDateInput>,
    z.output<typeof schemas.taskBulkMutationOut>
  >,
) => mutation(dueDateOperation, "bulkSetDueDate", options);
export const taskBulkReorderMutationOptions = (
  options?: MutationOverrides<
    z.input<typeof schemas.taskBulkReorderInput>,
    z.output<typeof schemas.taskBulkMutationOut>
  >,
) => mutation(reorderOperation, "bulkReorder", options);
