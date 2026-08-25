import {
  type enqueueEmbeddingBackfillInputSchema,
  enqueueEmbeddingBackfillOutSchema,
} from "@cubby/schemas/background-jobs";
import {
  relatedSearchOutSchema,
  repairSearchDocumentsOutSchema,
  type requestEmbeddingRefreshInputSchema,
  requestEmbeddingRefreshOutSchema,
  searchDebugOutSchema,
  searchDocumentMaintenanceSchema,
  searchHitsOut,
  type searchQueryInputSchema,
} from "@cubby/schemas/search";
import {
  mutationOptions,
  queryOptions,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import type { CubbyOperationMeta } from "~/integrations/tanstack-query/operation-meta";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { markFreshReads } from "~/lib/fresh-read-marker";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import * as browser from "~/server/search-browser.server";

const findTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof searchQueryInputSchema>)
  .handler(({ data, context }) =>
    browser.findSearchHitsForBrowser({ data, request: context.startOperation }),
  );
const documentHealthTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.inspectSearchDocumentHealthForBrowser({
      request: context.startOperation,
    }),
  );
const repairDocumentsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.repairSearchDocumentsForBrowser({
      request: context.startOperation,
    }),
  );
const relatedTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof searchQueryInputSchema>)
  .handler(({ data, context }) =>
    browser.findRelatedSearchHitsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const debugTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof searchQueryInputSchema>)
  .handler(({ data, context }) =>
    browser.inspectSearchDebugForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const enqueueEmbeddingBackfillTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof enqueueEmbeddingBackfillInputSchema>,
  )
  .handler(({ data, context }) =>
    browser.enqueueEmbeddingBackfillForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const requestEmbeddingRefreshTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof requestEmbeddingRefreshInputSchema>,
  )
  .handler(({ data, context }) =>
    browser.requestEmbeddingRefreshForBrowser({
      data,
      request: context.startOperation,
    }),
  );

const defineQuery = <I, O>(
  operation: string,
  transport: (
    input: I,
    options: { signal?: AbortSignal; headers: HeadersInit },
  ) => Promise<unknown>,
  schema: z.ZodType<O>,
) =>
  startOperation<I, O>({
    operation,
    transport: transport as never,
    parse: (result) => schema.parse(result),
  });
const defineMutation = <I, O>(
  operation: string,
  transport: (input: I, options: { headers: HeadersInit }) => Promise<unknown>,
  schema: z.ZodType<O>,
) =>
  startOperation<I, O>({
    operation,
    kind: "mutation",
    transport: transport as never,
    parse: (result) => schema.parse(result),
  });

const findOperation = defineQuery(
  "search.find",
  (data: z.input<typeof searchQueryInputSchema>, { signal, headers }) =>
    findTransport({ data, signal, headers }),
  searchHitsOut,
);
const documentHealthOperation = defineQuery(
  "search.documentHealth",
  (_: undefined, { signal, headers }) =>
    documentHealthTransport({ signal, headers }),
  searchDocumentMaintenanceSchema,
);
const repairDocumentsOperation = defineMutation(
  "search.repairDocuments",
  (_: undefined, { headers }) => repairDocumentsTransport({ headers }),
  repairSearchDocumentsOutSchema,
);
const relatedOperation = defineQuery(
  "search.related",
  (data: z.input<typeof searchQueryInputSchema>, { signal, headers }) =>
    relatedTransport({ data, signal, headers }),
  relatedSearchOutSchema,
);
const debugOperation = defineQuery(
  "search.debug",
  (data: z.input<typeof searchQueryInputSchema>, { signal, headers }) =>
    debugTransport({ data, signal, headers }),
  searchDebugOutSchema,
);
const enqueueEmbeddingBackfillOperation = defineMutation(
  "search.enqueueEmbeddingBackfill",
  (data: z.input<typeof enqueueEmbeddingBackfillInputSchema>, { headers }) =>
    enqueueEmbeddingBackfillTransport({ data, headers }),
  enqueueEmbeddingBackfillOutSchema,
);
const requestEmbeddingRefreshOperation = defineMutation(
  "search.requestEmbeddingRefresh",
  (data: z.input<typeof requestEmbeddingRefreshInputSchema>, { headers }) =>
    requestEmbeddingRefreshTransport({ data, headers }),
  requestEmbeddingRefreshOutSchema,
);

export const searchFindQueryOptions = (
  input: z.input<typeof searchQueryInputSchema>,
) =>
  queryOptions({
    queryKey: [["search", "find"], { input, type: "query" }] as const,
    meta: findOperation.meta,
    queryFn: ({ signal }) => findOperation.call(input, { signal }),
  });
export const searchDocumentHealthQueryOptions = () =>
  queryOptions({
    queryKey: [["search", "documentHealth"], { type: "query" }] as const,
    meta: documentHealthOperation.meta,
    queryFn: ({ signal }) =>
      documentHealthOperation.call(undefined, { signal }),
  });
export const searchRelatedQueryOptions = (
  input: z.input<typeof searchQueryInputSchema>,
) =>
  queryOptions({
    queryKey: [["search", "related"], { input, type: "query" }] as const,
    meta: relatedOperation.meta,
    queryFn: ({ signal }) => relatedOperation.call(input, { signal }),
  });
export const searchDebugQueryOptions = (
  input: z.input<typeof searchQueryInputSchema>,
) =>
  queryOptions({
    queryKey: [["search", "debug"], { input, type: "query" }] as const,
    meta: debugOperation.meta,
    queryFn: ({ signal }) => debugOperation.call(input, { signal }),
  });
const mutation = <I, O>(
  key: string,
  operation: { meta: CubbyOperationMeta; call(input: I): Promise<O> },
  options?: UseMutationOptions<O, Error, I>,
) =>
  mutationOptions({
    mutationKey: [["search", key]] as const,
    meta: operation.meta,
    mutationFn: async (input: I) => {
      const result = await operation.call(input);
      markFreshReads();
      return result;
    },
    ...options,
  });
export const searchRepairDocumentsMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof repairSearchDocumentsOutSchema>,
    Error,
    undefined
  >,
) => mutation("repairDocuments", repairDocumentsOperation, options);
export const searchEnqueueEmbeddingBackfillMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof enqueueEmbeddingBackfillOutSchema>,
    Error,
    z.input<typeof enqueueEmbeddingBackfillInputSchema>
  >,
) =>
  mutation(
    "enqueueEmbeddingBackfill",
    enqueueEmbeddingBackfillOperation,
    options,
  );
export const searchRequestEmbeddingRefreshMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof requestEmbeddingRefreshOutSchema>,
    Error,
    z.input<typeof requestEmbeddingRefreshInputSchema>
  >,
) =>
  mutation(
    "requestEmbeddingRefresh",
    requestEmbeddingRefreshOperation,
    options,
  );
export const enqueueEmbeddingBackfill = (
  input: z.input<typeof enqueueEmbeddingBackfillInputSchema>,
) => enqueueEmbeddingBackfillOperation.call(input);
