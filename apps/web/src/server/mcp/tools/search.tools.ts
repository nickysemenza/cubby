import {
  globalSearchMcpInputSchema,
  globalSearchMcpOut,
  similarEntitiesMcpOut,
} from "@cubby/schemas/mcp";
import { similarEntitiesInputSchema } from "@cubby/schemas/search";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCaller, READ_ONLY_CLOSED, registerMcpTool } from "./_shared";

export function registerSearchTools(server: McpServer) {
  registerMcpTool(server, {
    name: "global_search",
    description:
      "Fast name, alias, identifier, and shortcode search across Cubby entities. Pass entityTypes to restrict results. Every hit carries its public shortcode in id, ready for get_*/update_* tools. This lexical lookup never calls an embedding provider. Set includeRelated to true only when useful; semantic results are returned separately and never replace direct matches. For entity-to-entity matching use find_similar_entities instead.",
    inputSchema: globalSearchMcpInputSchema.shape,
    outputSchema: globalSearchMcpOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const { includeRelated, ...query } = params;
      const results = await caller.search.find(query);

      if (!includeRelated) {
        return {
          results,
          related: [],
          relatedStatus: "not_requested" as const,
        };
      }

      const relatedResult = await caller.search.related(query);
      const primaryKeys = new Set(
        results.map((result) => `${result.entityType}:${result.id}`),
      );
      return {
        results,
        related: relatedResult.results.filter(
          (result) => !primaryKeys.has(`${result.entityType}:${result.id}`),
        ),
        relatedStatus: relatedResult.status,
      };
    },
  });

  registerMcpTool(server, {
    name: "find_similar_entities",
    description:
      "Find the entities whose stored embedding is closest to one seed entity's, along an allowlisted direction: expense_to_product (which product does this expense line refer to?), product_to_product / ingredient_to_ingredient (duplicate hunting), recipe_to_recipe (related recipes). Pass the pair key plus the seed's id; returns each neighbour with its cosine similarity, nearest first, and echoes the resolved source ref. Similarity ranks candidates, but does not verify them: inspect each candidate and be willing to conclude that none match. Returns no results when the seed has no embedding yet or embeddings are unavailable.",
    inputSchema: similarEntitiesInputSchema.shape,
    outputSchema: similarEntitiesMcpOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      return await caller.search.similar(params);
    },
  });
}
