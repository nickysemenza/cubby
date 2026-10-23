import { searchIndexRepairEventSchema } from "@cubby/schemas/maintenance";
import {
  globalSearchMcpInputSchema,
  globalSearchMcpOut,
  similarEntitiesMcpOut,
} from "@cubby/schemas/mcp";
import {
  similarEntitiesInputSchema,
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

export const searchContract = defineContract(
  "search",
  {
    find: query({
      exposure: "view",
      native: "Search and intents",
      input: searchQueryInputSchema,
      output: searchHitsOut,
    }),
    grouped: query({
      exposure: "view",
      input: searchQueryInputSchema,
      output: searchResultGroupsOut,
    }),
    related: query({
      exposure: "view",
      note: "includeRelated: true runs the same free-text related search",
      input: searchQueryInputSchema,
      output: relatedSearchOutSchema,
    }),
    relatedGrouped: query({
      exposure: "view",
      note: "includeRelated: true runs the same free-text related search",
      input: searchQueryInputSchema,
      output: relatedSearchGroupsOutSchema,
    }),
    // Integrity/repair diagnostics.
    debug: query({
      description:
        "Inspect search-index coverage and query diagnostics for the supplied entity or search term. This is read-only; use request_embedding_refresh only after identifying stale embeddings.",
      readPolicy: "strong",
      input: searchQueryInputSchema,
      output: searchDebugOutSchema,
    }),
    requestEmbeddingRefresh: mutation({
      description:
        "Queue embedding refresh for the selected records or search partition. This schedules model-backed indexing work; inspect search.debug after it finishes.",
      input: requestEmbeddingRefreshInputSchema,
      output: requestEmbeddingRefreshOutSchema,
      invalidates: [],
    }),
    // Agent-facing (MCP `search`).
    /** Lexical hits plus, on request, semantic related hits kept separate. */
    global: query({
      description:
        "Fast name, alias, identifier, and shortcode search across Cubby entities. Pass entityKinds to restrict results. Every hit carries its public shortcode in id, ready for entity_read.get. This lexical lookup never calls an embedding provider. Set includeRelated only when useful; semantic results come back separately and never replace direct matches. For entity-to-entity matching use search.similar.",
      input: globalSearchMcpInputSchema,
      output: globalSearchMcpOut,
    }),
    /** Nearest stored embeddings to one seed; ranks, never verifies. */
    similar: query({
      description:
        "Products whose stored embedding is closest to one product seed — the only active public similarity direction; other declared pairs stay unavailable until their independent backtests pass. Pass the pair key plus the seed's id; results are nearest first with cosine similarity and the resolved source ref. Similarity ranks candidates but never verifies a match. Returns no results when the seed is uncomputed, stale, or embeddings are unavailable.",
      input: similarEntitiesInputSchema,
      output: similarEntitiesMcpOut,
    }),
  },
  { exposure: "capability" },
);

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
