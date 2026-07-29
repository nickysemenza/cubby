import { globalSearchMcpOut, similarEntitiesMcpOut } from "@cubby/schemas/mcp";
import {
  globalSearchInputSchema,
  similarEntitiesInputSchema,
} from "@cubby/schemas/search";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getCaller,
  READ_ONLY_CLOSED,
  registerMcpTool,
  registerRouterTool,
} from "./_shared";

export function registerSearchTools(server: McpServer) {
  registerMcpTool(server, {
    name: "global_search",
    description:
      "Fuzzy name search across every indexed entity in one call — products, inventory entries, locations, recipes, ingredients, cookbooks, meals, and the household tracker (projects, tasks, expenses). Ranked hybrid of lexical (exact/substring/trigram) and semantic matching; pass mode: 'lexical' to skip the embedding call for a faster, name-only pass. Each hit returns entityType + id, so this is the way to turn a name into an ID before calling get_*/update_* tools. For entity-to-entity matching (which product does this expense refer to?) use find_similar_entities instead.",
    inputSchema: globalSearchInputSchema.shape,
    outputSchema: globalSearchMcpOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.search.global({
        query: params.query,
        limit: params.limit,
        mode: params.mode,
      });
      return { results: result };
    },
  });

  registerRouterTool(server, {
    name: "find_similar_entities",
    description:
      "Find the entities whose stored embedding is closest to one seed entity's, along an allowlisted direction: expense_to_product (which product does this expense line refer to?), product_to_product / ingredient_to_ingredient (duplicate hunting), recipe_to_recipe (related recipes). Pass the pair key plus the seed's id; returns each neighbour with its cosine `similarity`, nearest first, and echoes the resolved `source` ref. " +
      "WARNING — these scores RANK candidates, they do not VERIFY them. Nearest-neighbour always returns something, even when the correct answer is 'no match', and rank does not track correctness: in a real backfill a WRONG match (an M18 Hackzall for 'm18 angle grinder', cosine distance 0.326) scored BETTER than a CORRECT one (a TS 55 Track Saw for 'festool track saw', 0.353) — so a high score is not evidence, and a lower-ranked hit can be the right one. Never auto-apply, auto-link, or bulk-write a result. Read each candidate's name and details, confirm every match with the user, and be willing to conclude that none of them match. " +
      "Returns an empty result set when the seed has no embedding yet or embeddings are not configured — that is 'unknown', not 'nothing is similar'.",
    inputSchema: similarEntitiesInputSchema.shape,
    outputSchema: similarEntitiesMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.search.similar(params),
  });
}
