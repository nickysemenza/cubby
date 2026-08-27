import {
  enqueueEmbeddingBackfillInputSchema,
  enqueueEmbeddingBackfillOutSchema,
} from "@cubby/schemas/background-jobs";
import {
  relatedSearchOutSchema,
  repairSearchDocumentsOutSchema,
  requestEmbeddingRefreshInputSchema,
  requestEmbeddingRefreshOutSchema,
  searchDebugOutSchema,
  searchDocumentMaintenanceSchema,
  searchHitsOut,
  searchQueryInputSchema,
} from "@cubby/schemas/search";
import { z } from "zod";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const search = defineOperationDomain("search", {
  find: query({
    input: searchQueryInputSchema,
    output: searchHitsOut,
    tags: [["search"], ["search", "find"]],
  }),
  documentHealth: query({
    input: z.undefined(),
    output: searchDocumentMaintenanceSchema,
    tags: [["search"], ["search", "documentHealth"]],
  }),
  repairDocuments: mutation({
    input: z.undefined(),
    output: repairSearchDocumentsOutSchema,
    invalidates: [["search"]],
  }),
  related: query({
    input: searchQueryInputSchema,
    output: relatedSearchOutSchema,
    tags: [["search"], ["search", "related"]],
  }),
  debug: query({
    input: searchQueryInputSchema,
    output: searchDebugOutSchema,
    tags: [["search"], ["search", "debug"]],
  }),
  enqueueEmbeddingBackfill: mutation({
    input: enqueueEmbeddingBackfillInputSchema,
    output: enqueueEmbeddingBackfillOutSchema,
    // `["problems"]` too: the Problems page's "missing embeddings" card is the
    // one surface that starts this, and it used to get that invalidation from
    // the per-card hook rather than from the operation.
    invalidates: [["search"], ["background-batch"], ["problems"]],
  }),
  requestEmbeddingRefresh: mutation({
    input: requestEmbeddingRefreshInputSchema,
    output: requestEmbeddingRefreshOutSchema,
    invalidates: [["search"], ["background-batch"]],
  }),
});
