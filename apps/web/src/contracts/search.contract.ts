import { searchIndexRepairEventSchema } from "@cubby/schemas/maintenance";
import {
  relatedSearchGroupsOutSchema,
  relatedSearchOutSchema,
  requestEmbeddingRefreshInputSchema,
  requestEmbeddingRefreshOutSchema,
  searchDebugOutSchema,
  searchHitsOut,
  searchQueryInputSchema,
  searchResultGroupsOut,
} from "@cubby/schemas/search";
import { z } from "zod";

import {
  defineContract,
  mutation,
  query,
  subscription,
} from "~/contracts/define";

export const searchContract = defineContract("search", {
  find: query({
    input: searchQueryInputSchema,
    output: searchHitsOut,
  }),
  grouped: query({
    input: searchQueryInputSchema,
    output: searchResultGroupsOut,
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
  requestEmbeddingRefresh: mutation({
    input: requestEmbeddingRefreshInputSchema,
    output: requestEmbeddingRefreshOutSchema,
  }),
});

/**
 * Audit + repair the search index as one cancellable stream: orphaned
 * documents retired, missing/stale projections rebuilt, embedding refreshes
 * published. The done event carries this run's counters.
 */
export const searchStreamsContract = defineContract("search", {
  repairIndex: subscription({
    input: z.undefined(),
    event: searchIndexRepairEventSchema,
  }),
});
