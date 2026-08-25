import {
  backgroundBatchBrowserSummarySchema,
  type backgroundBatchIdInputSchema,
} from "@cubby/schemas/background-jobs";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import {
  observedStartCall,
  unwrapStartOperationResult,
} from "~/integrations/tanstack-query/start-transport";
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

export const backgroundBatchSummaryQueryOptions = (
  input: z.input<typeof backgroundBatchIdInputSchema>,
) =>
  queryOptions({
    queryKey: [
      ["background-batch", "summary"],
      { batchId: input.batchId },
    ] as const,
    queryFn: ({ signal }) =>
      observedStartCall({
        operation: "background-batch.summary",
        input,
        call: async (headers) =>
          backgroundBatchBrowserSummarySchema.parse(
            unwrapStartOperationResult(
              "background-batch.summary",
              await getBackgroundBatchSummaryTransport({
                data: input,
                signal,
                headers,
              }),
            ),
          ),
      }),
    meta: {
      transport: "start",
      operation: "background-batch.summary",
      observedByTransport: true,
    },
    staleTime: 0,
  });
