import {
  ingredientResolvableNamesInput,
  ingredientResolveOrCreateResponseOut,
} from "@cubby/schemas/ingredient";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerRouterTool, WRITE_CLOSED } from "./_shared";

export function registerIngredientTools(server: McpServer) {
  registerRouterTool(server, {
    name: "resolve_ingredients",
    description:
      "Batch-resolve a list of ingredient names to IDs in one call: each name is matched to an existing ingredient (case-insensitive, including aliases) or created if missing.",
    inputSchema: ingredientResolvableNamesInput,
    outputSchema: ingredientResolveOrCreateResponseOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) =>
      caller.ingredient
        .resolveOrCreate({ names: params.names })
        .then((results) => ({
          results,
        })),
  });
}
