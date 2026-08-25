import {
  backgroundBatchBrowserJobsOutSchema,
  backgroundBatchBrowserListOutSchema,
  backgroundBatchBrowserSummarySchema,
  type backgroundBatchIdInputSchema,
  type backgroundBatchJobsInputSchema,
  type backgroundBatchListInputSchema,
  type backgroundDrainInputSchema,
  backgroundDrainOutSchema,
  backgroundJobActionOutSchema,
  type backgroundJobIdInputSchema,
} from "@cubby/schemas/background-jobs";
import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import type { CubbyOperationMeta } from "~/integrations/tanstack-query/operation-meta";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { markFreshReads } from "~/lib/fresh-read-marker";
import * as backgroundBatchBrowser from "~/server/background-batch-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const listBackgroundBatchesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof backgroundBatchListInputSchema>,
  )
  .handler(
    async ({ data, context }) =>
      await backgroundBatchBrowser.listBackgroundBatchesForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const getBackgroundBatchSummaryTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof backgroundBatchIdInputSchema>,
  )
  .handler(
    async ({ data, context }) =>
      await backgroundBatchBrowser.getBackgroundBatchSummaryForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const listBackgroundBatchJobsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof backgroundBatchJobsInputSchema>,
  )
  .handler(
    async ({ data, context }) =>
      await backgroundBatchBrowser.listBackgroundBatchJobsForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const retryBackgroundBatchTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof backgroundBatchIdInputSchema>,
  )
  .handler(
    async ({ data, context }) =>
      await backgroundBatchBrowser.retryBackgroundBatchForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const retryBackgroundJobTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof backgroundJobIdInputSchema>,
  )
  .handler(
    async ({ data, context }) =>
      await backgroundBatchBrowser.retryBackgroundJobForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const cancelBackgroundBatchTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof backgroundBatchIdInputSchema>,
  )
  .handler(
    async ({ data, context }) =>
      await backgroundBatchBrowser.cancelBackgroundBatchForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const drainBackgroundJobsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof backgroundDrainInputSchema>,
  )
  .handler(
    async ({ data, context }) =>
      await backgroundBatchBrowser.drainBackgroundJobsForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const backgroundBatchListOperation = startOperation<
  z.input<typeof backgroundBatchListInputSchema>,
  z.output<typeof backgroundBatchBrowserListOutSchema>
>({
  operation: "background-batch.list",
  transport: (data, { signal, headers }) =>
    listBackgroundBatchesTransport({ data, signal, headers }),
  parse: (result) => backgroundBatchBrowserListOutSchema.parse(result),
});

const backgroundBatchSummaryOperation = startOperation<
  z.input<typeof backgroundBatchIdInputSchema>,
  z.output<typeof backgroundBatchBrowserSummarySchema>
>({
  operation: "background-batch.summary",
  transport: (data, { signal, headers }) =>
    getBackgroundBatchSummaryTransport({ data, signal, headers }),
  parse: (result) => backgroundBatchBrowserSummarySchema.parse(result),
});

const backgroundBatchJobsOperation = startOperation<
  z.input<typeof backgroundBatchJobsInputSchema>,
  z.output<typeof backgroundBatchBrowserJobsOutSchema>
>({
  operation: "background-batch.jobs",
  transport: (data, { signal, headers }) =>
    listBackgroundBatchJobsTransport({ data, signal, headers }),
  parse: (result) => backgroundBatchBrowserJobsOutSchema.parse(result),
});

const backgroundBatchRetryOperation = startOperation<
  z.input<typeof backgroundBatchIdInputSchema>,
  z.output<typeof backgroundJobActionOutSchema>
>({
  operation: "background-batch.retry",
  kind: "mutation",
  transport: (data, { headers }) =>
    retryBackgroundBatchTransport({ data, headers }),
  parse: (result) => backgroundJobActionOutSchema.parse(result),
});

const backgroundJobRetryOperation = startOperation<
  z.input<typeof backgroundJobIdInputSchema>,
  z.output<typeof backgroundJobActionOutSchema>
>({
  operation: "background-job.retry",
  kind: "mutation",
  transport: (data, { headers }) =>
    retryBackgroundJobTransport({ data, headers }),
  parse: (result) => backgroundJobActionOutSchema.parse(result),
});

const backgroundBatchCancelOperation = startOperation<
  z.input<typeof backgroundBatchIdInputSchema>,
  z.output<typeof backgroundJobActionOutSchema>
>({
  operation: "background-batch.cancel",
  kind: "mutation",
  transport: (data, { headers }) =>
    cancelBackgroundBatchTransport({ data, headers }),
  parse: (result) => backgroundJobActionOutSchema.parse(result),
});

const backgroundJobsDrainOperation = startOperation<
  z.input<typeof backgroundDrainInputSchema>,
  z.output<typeof backgroundDrainOutSchema>
>({
  operation: "background-job.drain",
  kind: "mutation",
  transport: (data, { headers }) =>
    drainBackgroundJobsTransport({ data, headers }),
  parse: (result) => backgroundDrainOutSchema.parse(result),
});

export const backgroundBatchListRootKey = () =>
  [["background-batch", "list"]] as const;
export const backgroundBatchSummaryRootKey = () =>
  [["background-batch", "summary"]] as const;
export const backgroundBatchJobsRootKey = () =>
  [["background-batch", "jobs"]] as const;

export const backgroundBatchListQueryOptions = (
  input: z.input<typeof backgroundBatchListInputSchema>,
) =>
  queryOptions({
    queryKey: [...backgroundBatchListRootKey(), { input }] as const,
    meta: backgroundBatchListOperation.meta,
    queryFn: ({ signal }) =>
      backgroundBatchListOperation.call(input, { signal }),
  });

export const backgroundBatchSummaryQueryOptions = (
  input: z.input<typeof backgroundBatchIdInputSchema>,
) =>
  queryOptions({
    queryKey: [
      ...backgroundBatchSummaryRootKey(),
      { batchId: input.batchId },
    ] as const,
    meta: backgroundBatchSummaryOperation.meta,
    queryFn: ({ signal }) =>
      backgroundBatchSummaryOperation.call(input, { signal }),
    staleTime: 0,
  });

export const backgroundBatchJobsQueryOptions = (
  input: z.input<typeof backgroundBatchJobsInputSchema>,
) =>
  queryOptions({
    queryKey: [...backgroundBatchJobsRootKey(), { input }] as const,
    meta: backgroundBatchJobsOperation.meta,
    queryFn: ({ signal }) =>
      backgroundBatchJobsOperation.call(input, { signal }),
  });

const mutationWithFreshRead = <Input, Output>(operation: {
  readonly meta: CubbyOperationMeta;
  call(input: Input): Promise<Output>;
}) =>
  mutationOptions({
    mutationFn: async (input: Input) => {
      const result = await operation.call(input);
      markFreshReads();
      return result;
    },
    meta: operation.meta,
  });

export const backgroundBatchRetryMutationOptions = () =>
  mutationWithFreshRead(backgroundBatchRetryOperation);
export const backgroundJobRetryMutationOptions = () =>
  mutationWithFreshRead(backgroundJobRetryOperation);
export const backgroundBatchCancelMutationOptions = () =>
  mutationWithFreshRead(backgroundBatchCancelOperation);
export const backgroundJobsDrainMutationOptions = () =>
  mutationWithFreshRead(backgroundJobsDrainOperation);
