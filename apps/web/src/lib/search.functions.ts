import {
  enqueueEmbeddingBackfillInputSchema,
  enqueueEmbeddingBackfillOutSchema,
} from "@cubby/schemas/background-jobs";
import {
  relatedSearchGroupsOutSchema,
  relatedSearchOutSchema,
  repairSearchDocumentsOutSchema,
  requestEmbeddingRefreshInputSchema,
  requestEmbeddingRefreshOutSchema,
  searchDebugOutSchema,
  searchDocumentMaintenanceSchema,
  searchHitsOut,
  searchQueryInputSchema,
  searchResultGroupsOut,
} from "@cubby/schemas/search";
import { z } from "zod";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const search = defineOperationDomain("search", {
  find: query({
    input: searchQueryInputSchema,
    output: searchHitsOut,
    tags: [["search", "find"]],
  }),
  grouped: query({
    input: searchQueryInputSchema,
    output: searchResultGroupsOut,
    tags: [["search", "grouped"]],
  }),
  documentHealth: query({
    input: z.undefined(),
    output: searchDocumentMaintenanceSchema,
    tags: [["search", "documentHealth"]],
  }),
  repairDocuments: mutation({
    input: z.undefined(),
    output: repairSearchDocumentsOutSchema,
    invalidates: ripple.search,
  }),
  related: query({
    input: searchQueryInputSchema,
    output: relatedSearchOutSchema,
    tags: [["search", "related"]],
  }),
  relatedGrouped: query({
    input: searchQueryInputSchema,
    output: relatedSearchGroupsOutSchema,
    tags: [["search", "relatedGrouped"]],
  }),
  debug: query({
    input: searchQueryInputSchema,
    output: searchDebugOutSchema,
    tags: [["search", "debug"]],
  }),
  enqueueEmbeddingBackfill: mutation({
    input: enqueueEmbeddingBackfillInputSchema,
    output: enqueueEmbeddingBackfillOutSchema,
    // `["problems"]` too: the Problems page's "missing embeddings" card is the
    // one surface that starts this, and it used to get that invalidation from
    // the per-card hook rather than from the operation.
    invalidates: ripple.searchBackgroundBatchProblems,
  }),
  requestEmbeddingRefresh: mutation({
    input: requestEmbeddingRefreshInputSchema,
    output: requestEmbeddingRefreshOutSchema,
    invalidates: ripple.searchBackgroundBatch,
  }),
});
