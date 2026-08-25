import {
  backgroundBatchBrowserSummarySchema,
  type backgroundBatchIdInputSchema,
} from "@cubby/schemas/background-jobs";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import * as backgroundBatchBrowser from "~/server/background-batch-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

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

const backgroundBatchSummaryOperation = startOperation<
  z.input<typeof backgroundBatchIdInputSchema>,
  z.output<typeof backgroundBatchBrowserSummarySchema>
>({
  operation: "background-batch.summary",
  transport: (data, { signal, headers }) =>
    getBackgroundBatchSummaryTransport({ data, signal, headers }),
  parse: (result) => backgroundBatchBrowserSummarySchema.parse(result),
});

export const backgroundBatchSummaryQueryOptions = (
  input: z.input<typeof backgroundBatchIdInputSchema>,
) =>
  queryOptions({
    queryKey: [
      ["background-batch", "summary"],
      { batchId: input.batchId },
    ] as const,
    meta: backgroundBatchSummaryOperation.meta,
    queryFn: ({ signal }) =>
      backgroundBatchSummaryOperation.call(input, { signal }),
    staleTime: 0,
  });
