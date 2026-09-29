import {
  globalSearchMcpInputSchema,
  globalSearchMcpOut,
  similarEntitiesMcpOut,
} from "@cubby/schemas/mcp";
import { similarEntitiesInputSchema } from "@cubby/schemas/search";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

import { findSimilarEntitiesWorkflow } from "~/server/operations/semantic-similarity.server";
import {
  findRelatedSearchHits,
  findSearchHits,
} from "~/server/services/search.service";

import { READ_ONLY_CLOSED, registerRouterTool } from "./_shared";

const RELATED_NOT_REQUESTED: z.output<
  typeof globalSearchMcpOut
>["relatedStatus"] = "not_requested";

export function registerSearchTools(server: McpServer) {
  registerRouterTool(server, {
    name: "global_search",
    description:
      "Fast name, alias, identifier, and shortcode search across Cubby entities. Pass entityKinds to restrict results. Every hit carries its public shortcode in id, ready for get_*/update_* tools. This lexical lookup never calls an embedding provider. Set includeRelated to true only when useful; semantic results are returned separately and never replace direct matches. For entity-to-entity matching use find_similar_entities instead.",
    inputSchema: globalSearchMcpInputSchema,
    outputSchema: globalSearchMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (context, params) => {
      const { includeRelated, ...query } = params;
      const results = await findSearchHits(context.db, query);

      if (!includeRelated) {
        return {
          results,
          related: [],
          relatedStatus: RELATED_NOT_REQUESTED,
        };
      }

      const relatedResult = await findRelatedSearchHits(context.db, query);
      const primaryKeys = new Set(
        results.map((result) => `${result.entityKind}:${result.id}`),
      );
      return {
        results,
        related: relatedResult.results.filter(
          (result) => !primaryKeys.has(`${result.entityKind}:${result.id}`),
        ),
        relatedStatus: relatedResult.status,
      };
    },
  });

  registerRouterTool(server, {
    name: "find_similar_entities",
    description:
      "Find products whose stored embedding is closest to one product seed. This is the only active public similarity direction; other declared pairs remain unavailable until their independent backtests pass. Pass the pair key plus the seed's id; results are nearest first with cosine similarity and the resolved source ref. Similarity ranks candidates but never verifies a match. Returns no results when the seed is uncomputed, stale, or embeddings are unavailable.",
    inputSchema: similarEntitiesInputSchema,
    outputSchema: similarEntitiesMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: (context, params) => findSimilarEntitiesWorkflow(context.db, params),
  });
}
