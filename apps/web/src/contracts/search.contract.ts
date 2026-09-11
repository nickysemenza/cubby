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

import { defineContract, mutation, query } from "~/contracts/define";

export const searchContract = defineContract("search", {
  find: query({
    input: searchQueryInputSchema,
    output: searchHitsOut,
  }),
  grouped: query({
    input: searchQueryInputSchema,
    output: searchResultGroupsOut,
  }),
  documentHealth: query({
    input: z.undefined(),
    output: searchDocumentMaintenanceSchema,
  }),
  repairDocuments: mutation({
    input: z.undefined(),
    output: repairSearchDocumentsOutSchema,
  }),
  related: query({
    input: searchQueryInputSchema,
    output: relatedSearchOutSchema,
  }),
  relatedGrouped: query({
    input: searchQueryInputSchema,
    output: relatedSearchGroupsOutSchema,
  }),
  debug: query({
    input: searchQueryInputSchema,
    output: searchDebugOutSchema,
  }),
  enqueueEmbeddingBackfill: mutation({
    input: enqueueEmbeddingBackfillInputSchema,
    output: enqueueEmbeddingBackfillOutSchema,
  }),
  requestEmbeddingRefresh: mutation({
    input: requestEmbeddingRefreshInputSchema,
    output: requestEmbeddingRefreshOutSchema,
  }),
});
