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

export const searchContract = defineContract("search", {
  find: query({
    mcp: { omit: "agent_twin", twin: "search.global" },
    native: "Search and intents",
    input: searchQueryInputSchema,
    output: searchHitsOut,
  }),
  grouped: query({
    mcp: { omit: "agent_twin", twin: "search.global" },
    input: searchQueryInputSchema,
    output: searchResultGroupsOut,
  }),
  related: query({
    mcp: {
      omit: "agent_twin",
      twin: "search.global",
      note: "includeRelated: true runs the same free-text related search",
    },
    input: searchQueryInputSchema,
    output: relatedSearchOutSchema,
  }),
  relatedGrouped: query({
    mcp: {
      omit: "agent_twin",
      twin: "search.global",
      note: "includeRelated: true runs the same free-text related search",
    },
    input: searchQueryInputSchema,
    output: relatedSearchGroupsOutSchema,
  }),
  // Integrity/repair diagnostics.
  debug: query({
    mcp: { omit: "operator_maintenance" },
    readPolicy: "strong",
    input: searchQueryInputSchema,
    output: searchDebugOutSchema,
  }),
  requestEmbeddingRefresh: mutation({
    mcp: { omit: "operator_maintenance" },
    input: requestEmbeddingRefreshInputSchema,
    output: requestEmbeddingRefreshOutSchema,
    invalidates: [],
  }),
  // Agent-facing (MCP `search`): off the HTTP API.
  /** Lexical hits plus, on request, semantic related hits kept separate. */
  global: query({
    http: false,
    input: globalSearchMcpInputSchema,
    output: globalSearchMcpOut,
  }),
  /** Nearest stored embeddings to one seed; ranks, never verifies. */
  similar: query({
    http: false,
    input: similarEntitiesInputSchema,
    output: similarEntitiesMcpOut,
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
