import {
  type relatedBranchInput,
  relatedBranchOutput,
  type relatedOptionsInput,
  relatedOptionsOutput,
  type relatedPreviewInput,
  relatedPreviewOutput,
  type relatedSummaryInput,
  relatedSummaryOutput,
} from "@cubby/schemas/related-view";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import type { StartOperationId } from "~/lib/start-operation-observability";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import * as browser from "~/server/related-data-browser.server";

const previewsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((value: unknown) => value as z.input<typeof relatedPreviewInput>)
  .handler(({ data, context }) =>
    browser.loadRelatedPreviewsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const branchTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((value: unknown) => value as z.input<typeof relatedBranchInput>)
  .handler(({ data, context }) =>
    browser.loadRelatedBranchForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const optionsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((value: unknown) => value as z.input<typeof relatedOptionsInput>)
  .handler(({ data, context }) =>
    browser.loadRelatedOptionsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const summaryTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((value: unknown) => value as z.input<typeof relatedSummaryInput>)
  .handler(({ data, context }) =>
    browser.loadRelatedSummaryForBrowser({
      data,
      request: context.startOperation,
    }),
  );

const operation = <I, O>(
  name: string,
  transport: (options: {
    data: I;
    signal?: AbortSignal;
    headers?: HeadersInit;
  }) => Promise<
    import("~/server/start-operation.contract").StartOperationResult<O>
  >,
  schema: z.ZodType<O>,
) =>
  startOperation<I, O>({
    operation: `relatedData.${name}` as StartOperationId,
    transport: (data, { signal, headers }) =>
      transport({ data, signal, headers }),
    parse: (value) => schema.parse(value),
  });
const previews = operation("previews", previewsTransport, relatedPreviewOutput);
const branch = operation("branch", branchTransport, relatedBranchOutput);
const options = operation("options", optionsTransport, relatedOptionsOutput);
const summary = operation("summary", summaryTransport, relatedSummaryOutput);

const query = <I, O>(
  name: string,
  input: I,
  op: {
    meta: object;
    call(input: I, options: { signal: AbortSignal }): Promise<O>;
  },
) =>
  queryOptions({
    queryKey: [["relatedData", name], { input, type: "query" }] as const,
    meta: op.meta as never,
    queryFn: ({ signal }) => op.call(input, { signal }),
  });
export const relatedDataPreviewsQueryOptions = (
  input: z.input<typeof relatedPreviewInput>,
) => query("previews", input, previews);
export const relatedDataBranchQueryOptions = (
  input: z.input<typeof relatedBranchInput>,
) => query("branch", input, branch);
export const relatedDataOptionsQueryOptions = (
  input: z.input<typeof relatedOptionsInput>,
) => query("options", input, options);
export const relatedDataSummaryInfiniteQueryOptions = (
  input: z.input<typeof relatedSummaryInput>,
) => {
  const { offset: _offset, ...scope } = input;
  return infiniteQueryOptions({
    queryKey: [
      ["relatedData", "summary"],
      { input: { ...scope, offset: 0 }, type: "query" },
      "__infinite__",
    ] as const,
    initialPageParam: input.offset ?? 0,
    queryFn: ({ pageParam, signal }) =>
      summary.call({ ...input, offset: pageParam }, { signal }),
    getNextPageParam: (page) => page.nextOffset ?? undefined,
  });
};
